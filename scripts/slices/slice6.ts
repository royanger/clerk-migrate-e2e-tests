/**
 * Slice 6: the gate is gone. Everything runs with CLERK_EXPERIMENTAL unset,
 * and setting it still does no harm.
 */
import { errorOf, importFile, want, type Check } from "./context";
import { plainUsers, supabaseFile } from "./slice1";

const off = { CLERK_EXPERIMENTAL: "" };

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
];
