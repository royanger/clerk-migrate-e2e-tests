/**
 * Slice 2: `clerk migrate runs`, `clerk migrate undo`, and continuing a
 * stopped import (`--new-run`, adopting in-flight creates). Still file
 * imports: exports arrive in slice 3.
 */
import { supabaseId } from "./files";
import {
  diedBySigint,
  errorOf,
  importFile,
  interruptImport,
  readRun,
  undo,
  want,
  type Check,
  type Ctx,
} from "./context";
import { plainUsers, supabaseFile } from "./slice1";

const yes = ["--allow-partial", "--yes", "--json"];

/**
 * Imports `n` plain users from a fresh file, and returns the run ID.
 *
 * Give every check its own `offset`: the same users make the same file, and a
 * re-run of a file already imported creates nothing.
 */
async function importPlain(ctx: Ctx, name: string, n: number, offset: number) {
  const file = supabaseFile(ctx, name, plainUsers(ctx, n, offset));
  const imp = await importFile(ctx, file, "supabase", yes);
  if (imp.code !== 0 || !imp.json?.run?.id) throw new Error(`import exited ${imp.code}: ${errorOf(imp)}`);
  if (imp.json.result?.created !== n) throw new Error(`import created ${imp.json.result?.created ?? 0} of ${n} (resume: ${imp.json.resume})`);
  await ctx.settledCount(30_000, n);
  return { file, runId: imp.json.run.id as string };
}

const runs = (ctx: Ctx, args: string[] = []) => ctx.cli(["migrate", "runs", ...args, "--json", "--runs-dir", ctx.runsDir]);

export const checks: Check[] = [
  {
    id: "2.1",
    name: "runs lists every run and shows one in full",
    async run(ctx) {
      const issues: string[] = [];
      const { runId } = await importPlain(ctx, "runs.json", 5, 200);
      const list = await runs(ctx);
      const listed = (list.json?.runs ?? []).find((r: { id: string }) => r.id === runId);
      want(issues, list.code === 0 && listed?.state === "complete", `runs: exit ${list.code}, ${runId} listed as ${listed?.state ?? "missing"}`);
      const show = await runs(ctx, [runId]);
      want(issues, show.json?.run?.counts?.created === 5, `runs ${runId}: counts ${JSON.stringify(show.json?.run?.counts)}`);
      const unknown = await runs(ctx, ["20990101-000000-ffff"]);
      want(issues, unknown.code === 2, `runs <unknown id>: expected exit 2, got ${unknown.code}`);
      return issues;
    },
  },
  {
    id: "2.2",
    name: "undo: dry run, consent, delete, and a second undo refused",
    async run(ctx) {
      const issues: string[] = [];
      const { runId } = await importPlain(ctx, "undo.json", 5, 210);
      const dry = await undo(ctx, runId, ["--dry-run", "--json"]);
      want(issues, dry.code === 0 && (await ctx.settledCount(5_000, 5)) === 5, `undo --dry-run: exit ${dry.code}, or it deleted users`);
      const consent = await undo(ctx, runId, ["--json"]);
      want(issues, consent.code === 2 && consent.json?.consent === "required", `undo --json without --yes: exit ${consent.code}`);
      const done = await undo(ctx, runId, ["--yes", "--json"]);
      want(issues, done.code === 0 && done.json?.result?.deleted === 5, `undo: exit ${done.code}, ${JSON.stringify(done.json?.result)}`);
      want(issues, (await ctx.settledCount()) === 0, "users are left after undo");
      want(issues, readRun(ctx, runId).status === "undone", `the import is ${readRun(ctx, runId).status}, not undone`);
      const again = await undo(ctx, runId, ["--yes", "--json"]);
      want(issues, again.code === 2, `a second undo: expected exit 2, got ${again.code}`);
      return issues;
    },
  },
  {
    id: "2.3",
    name: "re-running a complete import does nothing; --new-run starts over",
    async run(ctx) {
      const issues: string[] = [];
      const { file, runId } = await importPlain(ctx, "rerun.json", 4, 220);
      const again = await importFile(ctx, file, "supabase", yes);
      want(issues, again.code === 0 && again.json?.alreadyImported === true, `re-run: exit ${again.code}, ${JSON.stringify(again.json)?.slice(0, 150)}`);
      const fresh = await importFile(ctx, file, "supabase", ["--new-run", "--yes", "--json"]);
      want(issues, fresh.code === 2, `--new-run with every user already in: expected a refusal, got ${fresh.code}`);
      want(issues, (await ctx.settledCount(10_000, 4)) === 4, "a re-run changed the instance");
      const done = await undo(ctx, runId, ["--yes", "--json"]);
      want(issues, done.code === 0, `undo exited ${done.code}`);
      return issues;
    },
  },
  {
    id: "2.4",
    name: "a partial run is continued: the user that was skipped is imported, in the same run",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 6, 10);
      const collider = await ctx.clerk.users.createUser({ emailAddress: [users[2].email!], skipPasswordRequirement: true });
      const file = supabaseFile(ctx, "partial.json", users);
      const first = await importFile(ctx, file, "supabase", yes);
      const runId = first.json?.run?.id;
      want(issues, first.json?.result?.created === 5 && first.json?.run?.status === "partial", `first run: ${JSON.stringify(first.json?.result)}, ${first.json?.run?.status}`);
      await ctx.clerk.users.deleteUser(collider.id);
      await ctx.settledCount(30_000, 5);
      const second = await importFile(ctx, file, "supabase", yes);
      want(issues, second.json?.resume === "continue" && second.json?.run?.id === runId, `second run: resume ${second.json?.resume}, run ${second.json?.run?.id} (first was ${runId})`);
      want(issues, second.json?.result?.created === 1, `second run created ${second.json?.result?.created}, expected 1`);
      want(issues, runId && readRun(ctx, runId).status === "complete", "the continued run is not complete");
      const held = await ctx.clerkUsers();
      want(issues, held.some((u) => u.externalId === supabaseId(users[2])), "the skipped user was not imported");
      if (runId) await undo(ctx, runId, ["--yes", "--json"]);
      return issues;
    },
  },
  {
    id: "2.5",
    name: "an interrupted run is continued with no duplicates",
    async run(ctx) {
      const issues: string[] = [];
      const users = plainUsers(ctx, 25, 20);
      const file = supabaseFile(ctx, "resume.json", users);
      const stopped = await interruptImport(ctx, file, "supabase", 3, { CLERK_MIGRATE_RATE_LIMIT: "2", CLERK_MIGRATE_CONCURRENCY_LIMIT: "1" });
      want(issues, diedBySigint(stopped), `expected exit 130 / SIGINT, got ${stopped.code ?? stopped.signal}`);
      const again = await importFile(ctx, file, "supabase", yes);
      want(issues, again.json?.resume === "continue" && again.json?.run?.id === stopped.runId, `re-run: resume ${again.json?.resume}, run ${again.json?.run?.id} (interrupted ${stopped.runId})`);
      want(issues, again.json?.run?.status === "complete", `the continued run is ${again.json?.run?.status}`);
      await ctx.settledCount(30_000, users.length);
      const held = await ctx.clerkUsers();
      const ids = held.map((u) => u.externalId);
      want(issues, held.length === users.length && new Set(ids).size === ids.length, `Clerk holds ${held.length} users (${new Set(ids).size} distinct source IDs), expected ${users.length}`);
      if (stopped.runId) {
        const done = await undo(ctx, stopped.runId, ["--yes", "--json"]);
        want(issues, done.code === 0 && (await ctx.settledCount()) === 0, `undo of the continued run: exit ${done.code}`);
      }
      return issues;
    },
  },
  {
    id: "2.6",
    name: "undo of an interrupted run also deletes the creates it never heard back from",
    async run(ctx) {
      const issues: string[] = [];
      const file = supabaseFile(ctx, "undo-interrupted.json", plainUsers(ctx, 25, 50));
      const stopped = await interruptImport(ctx, file, "supabase", 3, { CLERK_MIGRATE_RATE_LIMIT: "2", CLERK_MIGRATE_CONCURRENCY_LIMIT: "1" });
      if (!stopped.runId) return ["the interrupted import wrote no run"];
      await new Promise((r) => setTimeout(r, 5000)); // let in-flight creates land
      const done = await undo(ctx, stopped.runId, ["--yes", "--json"]);
      want(issues, done.code === 0, `undo exited ${done.code}: ${errorOf(done)}`);
      want(issues, (await ctx.settledCount()) === 0, "users are left after undoing the interrupted run");
      return issues;
    },
  },
];
