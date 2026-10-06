/**
 * Slice 1: `clerk migrate import <file>` for Clerk and Supabase files, behind
 * CLERK_EXPERIMENTAL=migrate. No export, runs, undo or continuing yet, so each
 * check imports a file from ./files.ts and the runner empties the instance
 * after it.
 *
 * The gate check fails once slice 6 removes the gate: run slice 6's test then.
 */
import { join } from "node:path";
import { DESTS } from "../lib/clerk-dest";
import { clerkUsername } from "../lib/clerk-source";
import { mix } from "../lib/variations";
import type { SeedUser } from "../lib/users";
import { clerkCsv, clerkId, supabaseId, supabaseRows } from "./files";
import {
  diedBySigint,
  errorOf,
  importFile,
  interruptImport,
  latestLines,
  readRun,
  runIds,
  summarize,
  usersWhenSettled,
  want,
  type Check,
  type Ctx,
} from "./context";

const off = { CLERK_EXPERIMENTAL: "" };

/** Writes a Supabase export of `users` and returns its path. */
export const supabaseFile = (ctx: Ctx, name: string, users: SeedUser[]) =>
  ctx.write(name, JSON.stringify(supabaseRows(users, ctx.seed.seedPassword), null, 2));

/** `n` email users with a password: the plainest import there is. */
export const plainUsers = (ctx: Ctx, n: number, offset = 0) =>
  ctx.seed.users.filter((u) => u.group === "email-only" && u.hasPassword).slice(offset, offset + n);

export const checks: Check[] = [
  {
    id: "1.1",
    name: "the gate: hidden and refused without CLERK_EXPERIMENTAL=migrate",
    async run(ctx) {
      const issues: string[] = [];
      const help = await ctx.cli(["--help"], off);
      want(issues, !/\bmigrate\b/.test(help.stdout + help.stderr), "`clerk --help` lists migrate with the gate off");
      const refused = await ctx.cli(["migrate", "import", "x.json", "--mode", "agent"], off);
      want(issues, refused.code === 2, `gate off: expected exit 2, got ${refused.code}`);
      want(issues, refused.stderr.includes("experiment_disabled"), `gate off: no experiment_disabled code (${errorOf(refused)})`);
      const on = await ctx.cli(["--help"]);
      want(issues, /\bmigrate\b/.test(on.stdout + on.stderr), "`clerk --help` leaves migrate out with CLERK_EXPERIMENTAL=migrate");
      return issues;
    },
  },
  {
    id: "1.2",
    name: "Supabase file: dry run, consent, import, then what landed",
    async run(ctx) {
      const issues: string[] = [];
      const seeded = mix({ "email-only": 8, both: 8, "phone-only": 6 })(ctx.seed.users).map((u, i) => ({
        ...u,
        ...(i === 1 && { banned: true }),
        ...(i === 9 && { banned: true }),
        ...(i === 2 && { deleted: true }),
        ...(i === 3 && { hasPassword: false }),
        ...(i === 4 && { metadata: { user: { theme: "dark" } } }),
      }));
      const live = seeded.filter((u) => !u.deleted);
      const deletedId = supabaseId(seeded[2]);
      const file = supabaseFile(ctx, "supabase.json", seeded);

      const dry = await importFile(ctx, file, "supabase", ["--dry-run", "--json"]);
      want(issues, dry.code === 2, `dry run with a reject: expected exit 2, got ${dry.code}`);
      want(issues, dry.json?.dryRun === true, "dry run: no `dryRun: true` in the JSON");
      want(issues, dry.json?.checks?.importable === live.length, `dry run: importable ${dry.json?.checks?.importable}, expected ${live.length}`);
      const rejected = (dry.json?.checks?.rejects ?? []) as { sourceId: string; reason: string }[];
      want(issues, rejected.length === 1 && rejected[0].sourceId === deletedId, `dry run: expected only the soft-deleted user rejected, got ${JSON.stringify(rejected)}`);
      want(issues, (await ctx.settledCount(5_000)) === 0 && runIds(ctx).length === 0, "dry run wrote something");

      const consent = await importFile(ctx, file, "supabase", ["--allow-partial", "--json"]);
      want(issues, consent.code === 2 && consent.json?.consent === "required", `--json without --yes: expected exit 2 and consent required, got ${consent.code} ${JSON.stringify(consent.json)?.slice(0, 120)}`);
      want(issues, (await ctx.settledCount(5_000)) === 0, "--json without --yes created users");

      const imp = await importFile(ctx, file, "supabase", ["--allow-partial", "--yes", "--json"]);
      want(issues, imp.code === 0, `import exited ${imp.code}: ${errorOf(imp)}`);
      const result = imp.json?.result;
      want(issues, result?.created === live.length && result?.skipped === 1, `import: ${JSON.stringify(result)}, expected ${live.length} created and 1 skipped`);
      const runId = imp.json?.run?.id as string | undefined;
      if (!runId) return [...issues, "import JSON has no run"];

      const users = await usersWhenSettled(ctx, live.length);
      const got = summarize(users);
      want(issues, got.total === live.length, `Clerk holds ${got.total}, expected ${live.length}`);
      want(issues, got.banned === live.filter((u) => u.banned).length, `banned: ${got.banned}, expected ${live.filter((u) => u.banned).length}`);
      want(issues, got.withPhone === live.filter((u) => u.phone).length, `phones: ${got.withPhone}, expected ${live.filter((u) => u.phone).length}`);
      want(issues, got.withPassword === live.filter((u) => u.hasPassword).length, `passwords: ${got.withPassword}, expected ${live.filter((u) => u.hasPassword).length}`);
      want(issues, users.every((u) => u.phoneNumbers.every((p) => p.phoneNumber.startsWith("+"))), "a phone landed without its +");
      const lastNames = new Set(users.map((u) => u.lastName));
      const missing = live.filter((u) => u.lastName && !lastNames.has(u.lastName));
      want(issues, missing.length === 0, `${missing.length} last names did not land`);
      want(issues, users.some((u) => (u.unsafeMetadata as { theme?: string }).theme === "dark"), "raw_user_meta_data did not reach unsafe metadata");
      const pw = await ctx.verifyPasswords(users, ctx.seed.seedPassword);
      want(issues, pw.failed.length === 0 && pw.checked > 0, `${pw.failed.length} of ${pw.checked} passwords did not verify`);

      const record = readRun(ctx, runId);
      want(issues, record.kind === "import" && record.status === "partial", `run.json: kind ${record.kind}, status ${record.status}; expected an import, partial`);
      const lines = latestLines(ctx, runId);
      want(issues, lines.get(deletedId)?.status === "skipped", "the soft-deleted user is not recorded as skipped");
      want(issues, [...lines.values()].filter((l) => l.status === "created" && l.clerkId).length === live.length, "not every created user has a created line with its Clerk ID");

      // Slice 1 refuses (they are already in the instance); from slice 2 the run is
      // continued. Either way, nothing new may be created.
      await importFile(ctx, file, "supabase", ["--allow-partial", "--yes", "--json"]);
      want(issues, (await ctx.settledCount(10_000, live.length)) === live.length, "importing the same file again changed the instance");
      return issues;
    },
  },
  {
    id: "1.3",
    name: "Clerk Dashboard CSV: usernames, phones, passwords and a formula-safe TAB",
    async run(ctx) {
      const issues: string[] = [];
      const seeded = mix({ "email-only": 6, both: 6, "phone-only": 4 })(ctx.seed.users);
      const tabbed = seeded[0];
      const file = ctx.write(
        "clerk.csv",
        // The Dashboard puts a TAB before a value that starts with = + - @.
        clerkCsv(seeded, ctx.seed.seedPassword, (u, row) => (u === tabbed ? { ...row, last_name: "\t-Mallory" } : row)),
      );
      const imp = await importFile(ctx, file, "clerk", ["--yes", "--json"]);
      want(issues, imp.code === 0, `import exited ${imp.code}: ${errorOf(imp)}`);
      want(issues, imp.json?.result?.created === seeded.length, `created ${imp.json?.result?.created}, expected ${seeded.length}`);
      const users = await usersWhenSettled(ctx, seeded.length);
      const got = summarize(users);
      const usernames = seeded.filter((u) => clerkUsername(u.username)).length;
      want(issues, got.withUsername === usernames, `usernames: ${got.withUsername}, expected ${usernames}`);
      want(issues, got.withPhone === seeded.filter((u) => u.phone).length, `phones: ${got.withPhone}, expected ${seeded.filter((u) => u.phone).length}`);
      want(issues, users.some((u) => u.lastName === "-Mallory"), "the TAB the Dashboard adds was not stripped from a last name");
      want(issues, users.every((u) => u.externalId?.startsWith("user_")), "a user landed without the Clerk export's ID as its external_id");
      const pw = await ctx.verifyPasswords(users, ctx.seed.seedPassword);
      want(issues, pw.failed.length === 0 && pw.checked === seeded.filter((u) => u.hasPassword).length, `${pw.failed.length} of ${pw.checked} passwords did not verify`);
      return issues;
    },
  },
  {
    id: "1.4",
    name: "checks against a stricter instance (D2: email required) reject phone-only users",
    async run(ctx) {
      const issues: string[] = [];
      const phoneOnly = ctx.seed.users.filter((u) => u.group === "phone-only").slice(0, 3);
      const withEmail = plainUsers(ctx, 4);
      const file = supabaseFile(ctx, "d2.json", [...phoneOnly, ...withEmail]);
      await ctx.patchDest(DESTS.D2);
      try {
        const dry = await importFile(ctx, file, "supabase", ["--dry-run", "--json"]);
        want(issues, dry.code === 2, `dry run with rejects: expected exit 2, got ${dry.code}`);
        const rejects = (dry.json?.checks?.rejects ?? []) as { sourceId: string; reason: string }[];
        for (const u of phoneOnly) {
          const reason = rejects.find((r) => r.sourceId === supabaseId(u))?.reason;
          want(issues, !!reason && /email/i.test(reason), `phone-only ${u.id}: ${reason ?? "not rejected"}`);
        }
        want(issues, dry.json?.checks?.importable === withEmail.length, `importable ${dry.json?.checks?.importable}, expected ${withEmail.length}`);
        want(issues, (dry.json?.checks?.fixes ?? []).length > 0, "no `clerk config patch` fix offered");
        const partial = await importFile(ctx, file, "supabase", ["--dry-run", "--allow-partial", "--json"]);
        want(issues, partial.code === 0, `--dry-run --allow-partial: expected exit 0, got ${partial.code}`);
        const refused = await importFile(ctx, file, "supabase", ["--yes", "--json"]);
        want(issues, refused.code === 2 && refused.json?.refused === true, `rejects without --allow-partial: expected a refusal, got ${refused.code}`);
        want(issues, (await ctx.settledCount(5_000)) === 0, "a refused import created users");
      } finally {
        await ctx.patchDest(DESTS.D1);
      }
      return issues;
    },
  },
  {
    id: "1.5",
    name: "dev instance quota: users past the headroom are rejected, --allow-partial imports up to it",
    async run(ctx) {
      const issues: string[] = [];
      const env = { CLERK_MIGRATE_DEV_USER_LIMIT: "5" };
      const file = supabaseFile(ctx, "quota.json", plainUsers(ctx, 8));
      const dry = await importFile(ctx, file, "supabase", ["--dry-run", "--json"], env);
      const rejects = (dry.json?.checks?.rejects ?? []) as { reason: string }[];
      want(issues, rejects.length === 3 && rejects.every((r) => /5-user limit/.test(r.reason)), `expected 3 rejects over the 5-user limit, got ${JSON.stringify(rejects).slice(0, 200)}`);
      want(issues, dry.json?.checks?.quota?.over === 3, `quota: ${JSON.stringify(dry.json?.checks?.quota)}`);
      const imp = await importFile(ctx, file, "supabase", ["--allow-partial", "--yes", "--json"], env);
      want(issues, imp.json?.result?.created === 5 && imp.json?.result?.skipped === 3, `import: ${JSON.stringify(imp.json?.result)}, expected 5 created and 3 skipped`);
      want(issues, (await ctx.settledCount(30_000, 5)) === 5, "the instance does not hold the 5 users");
      return issues;
    },
  },
  {
    id: "1.6",
    name: "refused before anything is sent: unknown hasher, unknown source, missing file",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 3);
      const before = runIds(ctx).length;
      const rot13 = ctx.write("rot13.csv", clerkCsv(users, ctx.seed.seedPassword, (u, row) => (u === users[0] ? { ...row, password_hasher: "rot13" } : row)));
      const hasher = await importFile(ctx, rot13, "clerk", ["--yes", "--json"]);
      want(issues, hasher.code === 2 && /hasher/i.test(errorOf(hasher)), `unknown hasher: exit ${hasher.code}, ${errorOf(hasher)}`);
      const file = supabaseFile(ctx, "plain.json", users);
      const source = await importFile(ctx, file, "nope", ["--yes", "--json"]);
      want(issues, source.code === 2 && /clerk/.test(errorOf(source)) && /supabase/.test(errorOf(source)), `unknown source: exit ${source.code}, ${errorOf(source)}`);
      const missing = await importFile(ctx, join(ctx.dir, "does-not-exist.json"), "supabase", ["--yes", "--json"]);
      want(issues, missing.code !== 0 && /not found/i.test(errorOf(missing)), `missing file: exit ${missing.code}, ${errorOf(missing)}`);
      want(issues, (await ctx.settledCount(5_000)) === 0, "a refused import created users");
      want(issues, runIds(ctx).length === before, "a refused import wrote a run");
      return issues;
    },
  },
  {
    id: "1.7",
    name: "a user already in the instance is rejected, and nothing is written without --allow-partial",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 4);
      await ctx.clerk.users.createUser({ emailAddress: [users[1].email!], skipPasswordRequirement: true });
      const file = supabaseFile(ctx, "collide.json", users);
      const dry = await importFile(ctx, file, "supabase", ["--dry-run", "--json"]);
      const reason = (dry.json?.checks?.rejects ?? []).find((r: { sourceId: string }) => r.sourceId === supabaseId(users[1]))?.reason;
      want(issues, !!reason && /already/i.test(reason), `the duplicate email: ${reason ?? "not rejected"}`);
      const refused = await importFile(ctx, file, "supabase", ["--yes", "--json"]);
      want(issues, refused.code === 2, `expected a refusal (exit 2), got ${refused.code}`);
      want(issues, (await ctx.settledCount(5_000, 1)) === 1, "a refused import created users");
      return issues;
    },
  },
  {
    id: "1.8",
    name: "--require-password records the users it leaves out as skipped",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 6).map((u, i) => (i < 2 ? { ...u, hasPassword: false } : u));
      const file = supabaseFile(ctx, "require-password.json", users);
      const imp = await importFile(ctx, file, "supabase", ["--require-password", "--yes", "--json"]);
      want(issues, imp.json?.result?.created === 4, `created ${imp.json?.result?.created}, expected 4`);
      const runId = imp.json?.run?.id;
      if (runId) {
        const skipped = [...latestLines(ctx, runId).values()].filter((l) => l.status === "skipped" && /require-password/.test(l.reason ?? ""));
        want(issues, skipped.length === 2, `${skipped.length} users recorded as left out by --require-password, expected 2`);
        want(issues, readRun(ctx, runId).status === "partial", "the run is not partial");
      }
      return issues;
    },
  },
  {
    id: "1.9",
    name: "Ctrl-C stops an import with exit 130, and the run records what it created",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 30);
      const file = supabaseFile(ctx, "interrupt.json", users);
      const stopped = await interruptImport(ctx, file, "supabase", 3, { CLERK_MIGRATE_RATE_LIMIT: "2", CLERK_MIGRATE_CONCURRENCY_LIMIT: "1" });
      want(issues, diedBySigint(stopped), `expected exit 130 / SIGINT, got ${stopped.code ?? stopped.signal}`);
      if (!stopped.runId) return [...issues, "the interrupted import wrote no run"];
      want(issues, !readRun(ctx, stopped.runId).finishedAt, "the interrupted run has a finish time");
      const lines = [...latestLines(ctx, stopped.runId).values()];
      const created = lines.filter((l) => l.status === "created");
      want(issues, created.length >= 3 && created.length < users.length, `${created.length} created lines`);
      // Creates still in flight at the signal may land too, so wait, then list.
      await ctx.settledCount(10_000, created.length);
      const inClerk = new Set((await ctx.clerkUsers()).map((u) => u.id));
      want(issues, created.every((l) => inClerk.has(l.clerkId)), "a created line names a user Clerk does not hold");
      return issues;
    },
  },
];

/** Exported for the later slices, which build on the same files. */
export { clerkId, supabaseId };
