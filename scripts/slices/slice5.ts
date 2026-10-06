/**
 * Slice 5: custom sources (`--source ./file.ts`) and `clerk migrate sources`.
 *
 * Writes its own made-up export and source, so it never reads the source
 * evals' exports or answers.
 */
import { writeFileSync } from "node:fs";
import { bcryptOf } from "./files";
import { errorOf, readRun, runIds, undo, want, type Check, type Ctx } from "./context";
import { plainUsers } from "./slice1";

const BUILT_INS = ["clerk", "auth0", "authjs", "betterauth", "firebase", "supabase", "workos"];

/** A made-up platform's admin export: its own field names, bcrypt where there is a password. */
function acmeExport(ctx: Ctx) {
  const users = [...plainUsers(ctx, 6, 100), ...plainUsers(ctx, 2, 110).map((u) => ({ ...u, hasPassword: false }))];
  const rows = users.map((u) => ({
    acct_ref: `acme-${u.id}`,
    contact: u.email,
    given: u.firstName ?? "Acme",
    family: u.lastName ?? "User",
    ...(u.hasPassword && { pw: bcryptOf(ctx.seed.seedPassword), pw_kind: "bcrypt" }),
  }));
  return { users, file: ctx.write("acme.json", JSON.stringify(rows, null, 2)) };
}

const ACME_SOURCE = `export default {
  key: "acme",
  label: "Acme",
  description: "Acme's admin console export.",
  transformer: {
    acct_ref: "userId",
    contact: "email",
    given: "firstName",
    family: "lastName",
    pw: "password",
    pw_kind: "passwordHasher",
  },
  carries: {
    passwords: { level: "yes", note: "bcrypt digests from the pw column." },
    mfa: { level: "no", note: "Not exported." },
    metadata: { level: "no", note: "Not exported." },
  },
};
`;

/** `--source` takes a path that starts with ./ or ends in .ts: write it under this run's folder. */
const sourceFile = (ctx: Ctx, name: string, body: string) => ctx.write(name, body);

const importWith = (ctx: Ctx, file: string, source: string, flags: string[]) =>
  ctx.cli(["migrate", "import", file, "--source", source, ...flags, ...ctx.target, "--runs-dir", ctx.runsDir]);

export const checks: Check[] = [
  {
    id: "5.1",
    name: "sources lists every built-in, shows one, and refuses an unknown key",
    async run(ctx) {
      const issues: string[] = [];
      const list = await ctx.cli(["migrate", "sources", "--json"]);
      const keys = (list.json?.sources ?? []).map((s: { key: string }) => s.key);
      want(issues, list.code === 0 && BUILT_INS.every((k) => keys.includes(k)), `sources --json: exit ${list.code}, keys ${keys.join(", ")}`);
      const one = await ctx.cli(["migrate", "sources", "supabase", "--json"]);
      want(issues, one.code === 0 && !!one.json?.carries, `sources supabase --json: exit ${one.code}`);
      const unknown = await ctx.cli(["migrate", "sources", "okta", "--json"]);
      want(issues, unknown.code === 2, `sources okta: expected exit 2, got ${unknown.code}`);
      return issues;
    },
  },
  {
    id: "5.2",
    name: "a custom source imports, records its hash, and an edited source is a new source",
    async run(ctx) {
      const issues: string[] = [];
      const { users, file } = acmeExport(ctx);
      const source = sourceFile(ctx, "acme-source.ts", ACME_SOURCE);
      const shown = await ctx.cli(["migrate", "sources", source, "--json"]);
      want(issues, shown.code === 0 && shown.json?.key === "acme", `sources <path>: exit ${shown.code}, ${errorOf(shown)}`);

      const imp = await importWith(ctx, file, source, ["--yes", "--json"]);
      want(issues, imp.code === 0 && imp.json?.result?.created === users.length, `import: exit ${imp.code}, ${JSON.stringify(imp.json?.result)} (${errorOf(imp)})`);
      const runId = imp.json?.run?.id as string | undefined;
      if (!runId) return [...issues, "the import wrote no run"];
      want(issues, /^[0-9a-f]{64}$/.test(readRun(ctx, runId).sourceHash ?? ""), "run.json has no sourceHash for the custom source");
      await ctx.settledCount(30_000, users.length);
      const held = await ctx.clerkUsers();
      const pw = await ctx.verifyPasswords(held, ctx.seed.seedPassword);
      want(issues, pw.checked === 6 && pw.failed.length === 0, `${pw.failed.length} of ${pw.checked} passwords did not verify (expected 6 checked)`);

      const same = await importWith(ctx, file, source, ["--allow-partial", "--yes", "--json"]);
      want(issues, same.json?.alreadyImported === true, `re-run with the same source: ${JSON.stringify(same.json)?.slice(0, 120)}`);
      writeFileSync(source, `${ACME_SOURCE}// edited\n`);
      const edited = await importWith(ctx, file, source, ["--dry-run", "--json"]);
      want(issues, edited.json?.resume === "new", `re-run with an edited source: resume ${edited.json?.resume}, expected new`);

      const done = await undo(ctx, runId, ["--yes", "--json"]);
      want(issues, done.code === 0 && (await ctx.settledCount()) === 0, `undo: exit ${done.code}`);
      return issues;
    },
  },
  {
    id: "5.3",
    name: "a broken custom source is refused before anything is read or sent",
    async run(ctx) {
      const issues: string[] = [];
      const { file } = acmeExport(ctx);
      const before = runIds(ctx).length;
      const noUserId = sourceFile(ctx, "no-user-id.ts", ACME_SOURCE.replace('acct_ref: "userId"', 'acct_ref: "username"'));
      const a = await importWith(ctx, file, noUserId, ["--yes", "--json"]);
      want(issues, a.code === 2 && /userId/.test(errorOf(a)), `no userId mapping: exit ${a.code}, ${errorOf(a)}`);
      const clash = sourceFile(ctx, "clash.ts", ACME_SOURCE.replace('key: "acme"', 'key: "clerk"'));
      const b = await importWith(ctx, file, clash, ["--yes", "--json"]);
      want(issues, b.code === 2 && /built-in/.test(errorOf(b)), `key clashing with a built-in: exit ${b.code}, ${errorOf(b)}`);
      const missing = await importWith(ctx, file, "./nope-source.ts", ["--yes", "--json"]);
      want(issues, missing.code !== 0 && /No source file/.test(errorOf(missing)), `missing source file: exit ${missing.code}, ${errorOf(missing)}`);
      want(issues, (await ctx.settledCount(5_000)) === 0 && runIds(ctx).length === before, "a refused source wrote users or a run");
      return issues;
    },
  },
];
