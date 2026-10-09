/**
 * Live tests for one slice of `clerk migrate` (see slice-prs.md in the CLI
 * feature folder): each slice's PR is tested with its own suite as it lands.
 *
 *   pnpm test:migrate:slice1                       slice 1, with the CLI in DEFAULT_CLI
 *   pnpm test:migrate:slice1 --cli <cli.ts|binary> a slice's own checkout, independent of the setting
 *   pnpm test:migrate:slice1 --only 1.3            one check
 *
 * Run outside 1Password, it re-runs itself under `op run --env-file=op.env`.
 *
 * Clerk instances (evals/targets.json): every slice imports into the target,
 * `evals-1`, and Clerk as a provider is the source, the migrate instance
 * (CLERK_MIGRATE_TESTS_1_*). The target's lock keeps the evals off it, and
 * another run that needs it waits.
 *
 * Slices 1, 2, 5 and 6 run the checks in scripts/slices/ against the target,
 * which must start empty; it is emptied after every check and its auth config
 * restored at the end. Slices 3 and 4a–4e export from live providers, so they
 * run test-migrate.ts's variations for the providers that slice adds, with the
 * same --cli and `-t evals-1`.
 *
 * Every CLI call sets CLERK_EXPERIMENTAL=migrate, which slices 1–5 need.
 *
 * Writes test-results/<stamp>-slice<N>/{report.md,report.json,log.txt}, and the
 * CLI's runs to clerk-runs/<same>/.
 */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { value } from "./lib/args";
import { DESTS, DEST_KEYS } from "./lib/clerk-dest";
import { clerkRun, cliVersion, DEFAULT_CLI } from "./lib/clerk-run";
import { deleteAllUsers } from "./lib/clerk-source";
import { clerkLock, lockProviders } from "./lib/lock";
import { migrateTarget, resolveTarget, targetSpecs } from "./lib/targets";
import type { Check, Ctx } from "./slices/context";

type Slice = { describe: string; checks?: () => Promise<Check[]>; providers?: string[] };

const SLICES: Record<string, Slice> = {
  "1": { describe: "import Clerk and Supabase files", checks: async () => (await import("./slices/slice1")).checks },
  "2": { describe: "runs, undo, continuing a stopped run", checks: async () => (await import("./slices/slice2")).checks },
  "3": { describe: "export clerk, export supabase, import by export run ID", providers: ["clerk", "supabase"] },
  "4a": { describe: "Firebase export and import", providers: ["firebase"] },
  "4b": { describe: "Auth0 export and import", providers: ["auth0"] },
  "4c": { describe: "WorkOS export and import", providers: ["workos"] },
  "4d": { describe: "Better Auth export and import", providers: ["better-auth"] },
  "4e": { describe: "Auth.js export and import", providers: ["authjs"] },
  "5": { describe: "custom sources and migrate sources", checks: async () => (await import("./slices/slice5")).checks },
  "6": { describe: "the gate removed", checks: async () => (await import("./slices/slice6")).checks },
};

const argv = process.argv.slice(2);
const sliceId = argv[0];
const slice = SLICES[sliceId];
if (!slice) {
  console.error(`Usage: tsx scripts/test-slice.ts <${Object.keys(SLICES).join("|")}> [--cli <path>] [--only <check>]`);
  process.exit(2);
}

/** A cli.ts path, or a binary on PATH such as `clerk`. --cli wins over DEFAULT_CLI. */
const cliFlag = value("cli")?.replace(/^~(?=\/|$)/, homedir());
const CLI = cliFlag ? (cliFlag.includes("/") ? resolve(cliFlag) : cliFlag) : DEFAULT_CLI;
if (CLI.includes("/") && !existsSync(CLI)) {
  console.error(`No CLI at ${CLI}. Pass --cli <path to packages/cli-core/src/cli.ts, or a clerk binary>.`);
  process.exit(2);
}
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;

/** Where every slice imports to (see the top). */
const TARGET_NAME = "evals-1";
const targetSpec = targetSpecs().pool.find((t) => t.name === TARGET_NAME)!;

// Secrets come from 1Password.
if (!process.env[targetSpec.keyEnv]) {
  const child = spawnSync("op", ["run", "--env-file=op.env", "--", "tsx", "scripts/test-slice.ts", ...argv], { stdio: "inherit" });
  process.exit(child.status ?? 1);
}

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
const runName = `${stamp}-slice${sliceId}`;
const dir = resolve("test-results", runName);
const runsDir = resolve("clerk-runs", runName);
mkdirSync(dir, { recursive: true });
mkdirSync(runsDir, { recursive: true });
const logFile = join(dir, "log.txt");
const log = (line: string) => {
  console.log(line);
  appendFileSync(logFile, line + "\n");
};

type Row = { id: string; name: string; status: "pass" | "fail" | "error" | "not run"; notes: string[]; seconds?: number };
const rows: Row[] = [];

function report() {
  const header =
    `# Slice ${sliceId}: ${slice.describe} — ${stamp}\n\nCLI: \`${CLI}\` @ ${cliVersion(CLI)}\n\nCLI runs: \`clerk-runs/${runName}/\`\n\n` +
    `| Check | What | Status | Seconds | Notes |\n|---|---|---|---|---|\n`;
  const body = rows.map((r) => `| ${r.id} | ${r.name} | ${r.status} | ${r.seconds ?? ""} | ${r.notes.join("; ").replaceAll("|", "\\|")} |`).join("\n");
  writeFileSync(join(dir, "report.md"), header + body + "\n");
  writeFileSync(join(dir, "report.json"), JSON.stringify({ slice: sliceId, cli: CLI, version: cliVersion(CLI), rows }, null, 2));
  log(`\nReport: ${join(dir, "report.md")}`);
  process.exitCode = rows.every((r) => r.status === "pass") ? 0 : 1;
}

/** Free Supabase projects pause after a week idle; wake it before an export. */
async function wakeSupabase() {
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  const api = `https://api.supabase.com/v1/projects/${ref}`;
  const headers = { authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}` };
  for (let i = 1; i <= 40; i++) {
    const { status } = (await (await fetch(api, { headers })).json()) as { status?: string };
    if (status === "ACTIVE_HEALTHY") return true;
    if (i === 1 && status === "INACTIVE") {
      log("Supabase project is paused; requesting a restore");
      await fetch(`${api}/restore`, { method: "POST", headers });
    }
    log(`Supabase status: ${status} (waiting)`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
  return false;
}

log(`Slice ${sliceId}: ${slice.describe}\nCLI: ${CLI} @ ${cliVersion(CLI)}`);

if (slice.providers) {
  // test-migrate.ts takes the provider and Clerk instance locks itself.
  // Clerk as a provider exports from the migrate instance, by its own key.
  const sourceKey = (await migrateTarget()).secretKey;
  for (const provider of slice.providers) {
    const started = Date.now();
    if (provider === "supabase" && !(await wakeSupabase())) {
      rows.push({ id: provider, name: `test:migrate -p ${provider}`, status: "not run", notes: ["Supabase project never became healthy"] });
      continue;
    }
    log(`\n=== test:migrate -p ${provider} --cli ${CLI}`);
    const code = await new Promise<number>((done) =>
      spawn("tsx", ["scripts/test-migrate.ts", "-p", provider, "--cli", CLI, "-t", TARGET_NAME], {
        stdio: "inherit",
        env: { ...process.env, CLERK_AS_SOURCE_SECRET_KEY: sourceKey },
      }).on("exit", (c) => done(c ?? 1)),
    );
    rows.push({
      id: provider,
      name: `test:migrate -p ${provider}`,
      status: code === 0 ? "pass" : "fail",
      notes: code === 0 ? [] : [`exit ${code}; see test-results/*-${provider}-${TARGET_NAME}/report.md`],
      seconds: Math.round((Date.now() - started) / 1000),
    });
  }
  report();
  process.exit();
}

const TARGET = await resolveTarget(targetSpec);
const secretKey = TARGET.secretKey;
const helpers = clerkRun({ cli: CLI, secretKey, log: logFile });
const target = ["--app", TARGET.app, "--instance", TARGET.instance];
const ctx: Ctx = {
  cliPath: CLI,
  dir,
  runsDir,
  target,
  seed: JSON.parse(readFileSync("data/users.json", "utf8")),
  clerk: helpers.clerk,
  cli: helpers.cli,
  cliEnv: (extra = {}) => ({
    ...process.env,
    CLERK_TELEMETRY_DISABLED: "1",
    CLERK_SECRET_KEY: secretKey,
    CLERK_EXPERIMENTAL: "migrate",
    ...extra,
  }),
  settledCount: helpers.settledCount,
  clerkUsers: helpers.clerkUsers,
  verifyPasswords: helpers.verifyPasswords,
  patchDest: (body) => helpers.patchConfig(target, body),
  write: (name, content) => {
    const file = join(dir, "files", name);
    mkdirSync(join(dir, "files"), { recursive: true });
    writeFileSync(file, content);
    return file;
  },
  log,
};

const checks = (await slice.checks!()).filter((c) => !only || c.id === only);
if (!checks.length) {
  console.error(`No check "${only}" in slice ${sliceId}.`);
  process.exit(2);
}

await lockProviders([clerkLock(TARGET.instance)], `test:migrate:slice${sliceId}`);
const snapshot = JSON.parse((await ctx.cli(["config", "pull", ...target])).stdout);
writeFileSync(join(dir, "clerk-config-before.json"), JSON.stringify(snapshot, null, 2));
try {
  await ctx.patchDest(DESTS.D1);
  for (const check of checks) {
    log(`\n── ${check.id}: ${check.name}`);
    const row: Row = { id: check.id, name: check.name, status: "pass", notes: [] };
    rows.push(row);
    const started = Date.now();
    // Guard: the instance has to start empty, or the counts mean nothing.
    const existing = await ctx.settledCount();
    if (existing) {
      row.status = "not run";
      row.notes.push(`the dev instance holds ${existing} users: run pnpm teardown`);
      log(`   not run: ${row.notes[0]}`);
      break;
    }
    try {
      row.notes = await check.run(ctx);
      if (row.notes.length) row.status = "fail";
    } catch (error) {
      row.status = "error";
      row.notes.push(error instanceof Error ? error.message : String(error));
      appendFileSync(logFile, `!! ${check.id}: ${error instanceof Error ? error.stack : String(error)}\n`);
    } finally {
      // Every check leaves the instance as it found it: empty. A check's own undo
      // usually has; the listing lags deletes, so a user it already removed can
      // still be listed (and then 404), so settle first and retry.
      let left = await ctx.settledCount(15_000).catch(() => -1);
      for (let i = 0; i < 3 && left !== 0; i++) {
        await deleteAllUsers(ctx.clerk).catch((e) => appendFileSync(logFile, `!! emptying the instance: ${e.message}\n`));
        left = await ctx.settledCount().catch(() => -1);
      }
      if (left !== 0) row.notes.push(`!! ${left} users still in the instance`);
    }
    row.seconds = Math.round((Date.now() - started) / 1000);
    log(`   ${row.status} (${row.seconds}s)`);
    for (const note of row.notes) log(`   · ${note}`);
  }
} finally {
  const restore = Object.fromEntries(DEST_KEYS.map((k) => [k, snapshot[k]]));
  await ctx.patchDest(restore).catch((e) => log(`!! config restore failed: ${e.message}`));
}
report();
