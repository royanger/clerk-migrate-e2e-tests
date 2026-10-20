/**
 * Slice 6: the gate is gone, and `--reserve-unverified` creates the emails and
 * phones a source never verified as reserved (usable for sign-in, locked to
 * the user) on the create, instead of attaching them unverified after it.
 *
 * The gate checks run with CLERK_EXPERIMENTAL unset, and setting it still does
 * no harm. Every seed user is verified, so the reserve checks unverify the
 * ones they pick.
 */
import type { User } from "@clerk/backend";
import { DESTS } from "../lib/clerk-dest";
import type { SeedUser } from "../lib/users";
import { supabaseId, supabaseRows } from "./files";
import {
  diedBySigint,
  errorOf,
  importFile,
  interruptImport,
  latestLines,
  readRun,
  undo,
  usersWhenSettled,
  want,
  type Check,
  type CliResult,
  type Ctx,
} from "./context";
import { plainUsers, supabaseFile } from "./slice1";

const off = { CLERK_EXPERIMENTAL: "" };
const yes = ["--allow-partial", "--yes", "--json"];
const reserve = "--reserve-unverified";

/** `n` users with a verified email, a verified phone and a password. */
const bothUsers = (ctx: Ctx, n: number, offset = 0) =>
  ctx.seed.users.filter((u) => u.group === "both" && u.hasPassword).slice(offset, offset + n);

const unverifiedEmail = (u: SeedUser): SeedUser => ({ ...u, emailVerified: false });
const unverifiedPhone = (u: SeedUser): SeedUser => ({ ...u, phoneVerified: false });

type Rejects = { sourceId: string; reason: string }[];
const rejectsOf = (dry: CliResult) => (dry.json?.checks?.rejects ?? []) as Rejects;
const reasonFor = (dry: CliResult, u: SeedUser) => rejectsOf(dry).find((r) => r.sourceId === supabaseId(u))?.reason;
const fixLabels = (dry: CliResult) => ((dry.json?.checks?.fixes ?? []) as { label: string }[]).map((f) => f.label);

/** How Clerk holds a seed user's email or phone: the @clerk/backend resources leave `reserved` out, so read the raw JSON. */
function held(users: User[], u: SeedUser, kind: "email" | "phone") {
  const user = users.find((c) => c.externalId === supabaseId(u));
  const raw = user?.raw as Record<string, any> | null | undefined;
  if (!raw) return undefined;
  const list = (kind === "email" ? raw.email_addresses : raw.phone_numbers) as Record<string, any>[];
  const value = kind === "email" ? u.email!.toLowerCase() : u.phone;
  const found = list.find((i) => (kind === "email" ? i.email_address.toLowerCase() : i.phone_number) === value);
  if (!found) return { present: false, reserved: false, verified: false, primary: false };
  const primary = kind === "email" ? raw.primary_email_address_id : raw.primary_phone_number_id;
  return { present: true, reserved: found.reserved === true, verified: found.verification?.status === "verified", primary: primary === found.id };
}

export const checks: Check[] = [
  {
    id: "6.1",
    name: "migrate is listed and runs with CLERK_EXPERIMENTAL unset",
    async run(ctx) {
      const issues: string[] = [];
      const help = await ctx.cli(["--help"], off);
      want(issues, /\bmigrate\b/.test(help.stdout + help.stderr), "`clerk --help` does not list migrate");
      const group = await ctx.cli(["migrate", "--help"], off);
      for (const sub of ["import", "export", "runs", "undo", "sources"])
        want(issues, new RegExp(`\\b${sub}\\b`).test(group.stdout + group.stderr), `\`clerk migrate --help\` does not list ${sub}`);
      const importHelp = await ctx.cli(["migrate", "import", "--help"], off);
      want(issues, importHelp.stdout.includes(reserve), "`clerk migrate import --help` does not list --reserve-unverified");
      const sources = await ctx.cli(["migrate", "sources", "--json"], off);
      want(issues, sources.code === 0, `migrate sources with the gate off: exit ${sources.code}, ${errorOf(sources)}`);
      const stillSet = await ctx.cli(["migrate", "sources", "--json"]);
      want(issues, stillSet.code === 0, `migrate sources with CLERK_EXPERIMENTAL=migrate: exit ${stillSet.code}`);
      return issues;
    },
  },
  {
    id: "6.2",
    name: "an import and its undo with CLERK_EXPERIMENTAL unset",
    async run(ctx) {
      const issues: string[] = [];
      const file = supabaseFile(ctx, "ungated.json", plainUsers(ctx, 5, 150));
      const imp = await importFile(ctx, file, "supabase", ["--yes", "--json"], off);
      want(issues, imp.code === 0 && imp.json?.result?.created === 5, `import: exit ${imp.code}, ${errorOf(imp)}`);
      await ctx.settledCount(30_000, 5);
      const runId = imp.json?.run?.id;
      if (runId) {
        const done = await ctx.cli(["migrate", "undo", runId, "--yes", "--json", ...ctx.target, "--runs-dir", ctx.runsDir], off);
        want(issues, done.code === 0 && (await ctx.settledCount()) === 0, `undo: exit ${done.code}, ${errorOf(done)}`);
      }
      return issues;
    },
  },
  {
    id: "6.3",
    name: "--reserve-unverified: an unverified-only email meets D2's email requirement, and reserved identifiers go on the create",
    async run(ctx) {
      const issues: string[] = [];
      const emailOnly = plainUsers(ctx, 3, 240).map(unverifiedEmail);
      const phoned = bothUsers(ctx, 3, 60).map(unverifiedPhone);
      const users = [...emailOnly, ...phoned];
      const file = supabaseFile(ctx, "reserve-d2.json", users);
      await ctx.patchDest(DESTS.D2);
      try {
        const plain = await importFile(ctx, file, "supabase", ["--dry-run", "--json"]);
        for (const u of emailOnly)
          want(issues, /only has an unverified email/.test(reasonFor(plain, u) ?? ""), `without ${reserve}, ${u.id}: ${reasonFor(plain, u) ?? "not rejected"}`);
        want(issues, fixLabels(plain).some((l) => /email optional/i.test(l)), `without ${reserve}: no "Make Email optional" fix (got: ${fixLabels(plain).join("; ") || "none"})`);

        const dry = await importFile(ctx, file, "supabase", [reserve, "--dry-run", "--json"]);
        want(issues, dry.code === 0 && rejectsOf(dry).length === 0, `with ${reserve}: exit ${dry.code}, rejects ${JSON.stringify(rejectsOf(dry)).slice(0, 200)}`);
        want(issues, !fixLabels(dry).some((l) => /email optional/i.test(l)), `with ${reserve}: still offers ${fixLabels(dry).join("; ")}`);

        const imp = await importFile(ctx, file, "supabase", [reserve, "--yes", "--json"]);
        want(issues, imp.code === 0 && imp.json?.result?.created === users.length, `import: exit ${imp.code}, ${JSON.stringify(imp.json?.result)} (${errorOf(imp)})`);
        const runId = imp.json?.run?.id as string | undefined;
        if (!runId) return [...issues, "the import wrote no run"];
        want(issues, readRun(ctx, runId).reserveUnverified === true, `run.json reserveUnverified: ${readRun(ctx, runId).reserveUnverified}`);

        const inClerk = await usersWhenSettled(ctx, users.length);
        for (const u of emailOnly) {
          const e = held(inClerk, u, "email");
          want(issues, !!e?.reserved && !e.verified && e.primary, `${u.id}'s email: ${JSON.stringify(e)}, expected reserved, unverified and primary`);
        }
        for (const u of phoned) {
          const p = held(inClerk, u, "phone");
          want(issues, !!p?.reserved && !p.verified, `${u.id}'s phone: ${JSON.stringify(p)}, expected reserved and unverified`);
        }
        // Reserved identifiers went on the create, so nothing was left to attach.
        const pending = [...latestLines(ctx, runId).values()].filter((l) => l.pending?.length);
        want(issues, pending.length === 0, `${pending.length} users have identifiers left to attach: ${JSON.stringify(pending.map((l) => l.pending)).slice(0, 200)}`);

        const done = await undo(ctx, runId, ["--yes", "--json"]);
        want(issues, done.code === 0 && (await ctx.settledCount()) === 0, `undo: exit ${done.code}`);
      } finally {
        await ctx.patchDest(DESTS.D1);
      }
      return issues;
    },
  },
  {
    id: "6.4",
    name: "a run keeps its reserve choice: a -y continue stays reserved, and --reserve-unverified on an unreserved run is refused",
    async run(ctx) {
      const issues: string[] = [];
      // An interrupted reserved run, continued with no flag: the rest are reserved too.
      const users = bothUsers(ctx, 20, 70).map(unverifiedEmail);
      const file = supabaseFile(ctx, "reserve-resume.json", users);
      const slow = { CLERK_MIGRATE_RATE_LIMIT: "2", CLERK_MIGRATE_CONCURRENCY_LIMIT: "1" };
      const stopped = await interruptImport(ctx, file, "supabase", 3, slow, [reserve]);
      want(issues, diedBySigint(stopped), `expected exit 130 / SIGINT, got ${stopped.code ?? stopped.signal}`);
      if (!stopped.runId) return [...issues, "the interrupted import wrote no run"];
      want(issues, readRun(ctx, stopped.runId).reserveUnverified === true, `run.json reserveUnverified: ${readRun(ctx, stopped.runId).reserveUnverified}`);
      const again = await importFile(ctx, file, "supabase", yes);
      want(issues, again.json?.resume === "continue" && again.json?.run?.status === "complete", `continue: resume ${again.json?.resume}, status ${again.json?.run?.status} (${errorOf(again)})`);
      const inClerk = await usersWhenSettled(ctx, users.length);
      const unreserved = users.filter((u) => !held(inClerk, u, "email")?.reserved);
      want(issues, unreserved.length === 0, `${unreserved.length} of ${users.length} emails not reserved after a -y continue: ${unreserved.slice(0, 5).map((u) => u.id).join(", ")}`);
      const done = await undo(ctx, stopped.runId, ["--yes", "--json"]);
      want(issues, done.code === 0 && (await ctx.settledCount()) === 0, `undo of the reserved run: exit ${done.code}`);

      // A partial unreserved run: --reserve-unverified on its continue is refused.
      const plain = plainUsers(ctx, 6, 250);
      const collider = await ctx.clerk.users.createUser({ emailAddress: [plain[2].email!], skipPasswordRequirement: true });
      const plainFile = supabaseFile(ctx, "reserve-refused.json", plain);
      const first = await importFile(ctx, plainFile, "supabase", yes);
      const runId = first.json?.run?.id as string | undefined;
      want(issues, first.json?.run?.status === "partial", `first run: ${first.json?.run?.status}, ${errorOf(first)}`);
      if (runId) want(issues, readRun(ctx, runId).reserveUnverified === false, `run.json reserveUnverified: ${readRun(ctx, runId).reserveUnverified}, expected false`);
      await ctx.clerk.users.deleteUser(collider.id);
      await ctx.settledCount(30_000, 5);
      const refused = await importFile(ctx, plainFile, "supabase", [reserve, ...yes]);
      want(issues, refused.code === 2 && /--new-run/.test(errorOf(refused)), `${reserve} on an unreserved run's continue: exit ${refused.code}, ${errorOf(refused)}`);
      want(issues, (await ctx.settledCount(10_000, 5)) === 5, "the refused continue changed the instance");
      if (runId) await undo(ctx, runId, ["--yes", "--json"]);
      return issues;
    },
  },
  {
    id: "6.5",
    name: "--reserve-unverified checks reserved identifiers for duplicates, in the instance and the file",
    async run(ctx) {
      const issues: string[] = [];
      const [inInstance, kept, copy] = bothUsers(ctx, 3, 100);
      await ctx.clerk.users.createUser({ emailAddress: [inInstance.email!], skipPasswordRequirement: true });
      // Each has its own verified phone; only the unverified email is shared.
      const clashesInstance = unverifiedEmail(inInstance);
      const clashesFile = { ...unverifiedEmail(copy), email: kept.email };
      const file = supabaseFile(ctx, "reserve-dupes.json", [clashesInstance, kept, clashesFile]);

      const plain = await importFile(ctx, file, "supabase", ["--dry-run", "--json"]);
      want(issues, rejectsOf(plain).length === 0, `without ${reserve}, an unverified email is attached after the create, so nobody is rejected: ${JSON.stringify(rejectsOf(plain)).slice(0, 200)}`);
      const dry = await importFile(ctx, file, "supabase", [reserve, "--dry-run", "--json"]);
      want(issues, /already used by a user in the instance/.test(reasonFor(dry, clashesInstance) ?? ""), `with ${reserve}, the email the instance holds: ${reasonFor(dry, clashesInstance) ?? "not rejected"}`);
      want(issues, /also used by an earlier user in the file/.test(reasonFor(dry, clashesFile) ?? ""), `with ${reserve}, the email an earlier record holds: ${reasonFor(dry, clashesFile) ?? "not rejected"}`);
      want(issues, !reasonFor(dry, kept), `with ${reserve}, the earlier record: ${reasonFor(dry, kept)}`);
      return issues;
    },
  },
  {
    id: "6.6",
    name: "--reserve-unverified: a reserved email is a way in for a Supabase user whose only provider is off",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 4, 260).map((u) => ({ ...unverifiedEmail(u), hasPassword: false, oauth: ["github"] }));
      // GitHub as the only provider: supabaseRows also lists "email", which is always a way in.
      const rows = supabaseRows(users, ctx.seed.seedPassword).map((r) => ({ ...r, raw_app_meta_data: { provider: "github", providers: ["github"] } }));
      const file = ctx.write("reserve-github.json", JSON.stringify(rows, null, 2));
      const before = (await ctx.cli(["config", "pull", ...ctx.target])).json;
      await ctx.patchDest({ connection_oauth_github: { enabled: false } });
      try {
        const plain = await importFile(ctx, file, "supabase", ["--dry-run", "--json"]);
        for (const u of users)
          want(issues, /github/i.test(reasonFor(plain, u) ?? ""), `without ${reserve}, ${u.id}: ${reasonFor(plain, u) ?? "not rejected"}`);
        const dry = await importFile(ctx, file, "supabase", [reserve, "--dry-run", "--json"]);
        want(issues, dry.code === 0 && rejectsOf(dry).length === 0, `with ${reserve}: exit ${dry.code}, rejects ${JSON.stringify(rejectsOf(dry)).slice(0, 200)}`);
      } finally {
        await ctx.patchDest({ connection_oauth_github: { enabled: before?.connection_oauth_github?.enabled ?? false } });
      }
      return issues;
    },
  },
];
