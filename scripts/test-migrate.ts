/**
 * Live end-to-end test of `clerk migrate` for one provider's variations.
 *
 *   pnpm test:migrate -p better-auth              every variation, each on its own dests
 *   pnpm test:migrate -p better-auth -v B0        one variation
 *   pnpm test:migrate -p better-auth -v B0 -d all against D1–D5
 *   pnpm test:migrate ... --cli <path/to/cli.ts>  a different CLI checkout
 *
 * Per variation × dest (see .testing-plan.md, "The loop"):
 *   source config → reset + seed source → export → reset source → patch Clerk
 *   config → dry run → import → verify → undo
 * The Clerk config is snapshotted first and restored in a finally block.
 *
 * Secrets come from 1Password: `pnpm test:migrate` wraps this in
 * `op run --env-file=op.env`. Nothing reads .env.
 */
import { execFileSync } from "node:child_process";
import { run } from "./lib/run";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createClerkClient, type User } from "@clerk/backend";
import { DESTS, DEST_IDS, DEST_KEYS, type DestId } from "./lib/clerk-dest";
import type { ClerkSummary, TargetName, Variation, VariationModule } from "./lib/variations";
import { pool, withRetry, type SeedUser } from "./lib/users";
import { flag, value } from "./lib/args";

const DEFAULT_CLI = join(
  homedir(),
  "clerk/clk/.clk/features/integrate-migration-tool-into-cli/cli/packages/cli-core/src/cli.ts",
);
const CLI = resolve(value("cli")?.replace(/^~/, homedir()) ?? DEFAULT_CLI);

/**
 * Clerk instances a run can import into. `dev` takes every test except the 10K
 * ones (and is the Clerk-as-source instance too); the other two are 10K only.
 */
const TARGETS = {
  dev: { app: "app_3HYFnu4WUmQ1p5DS301lefhySiO", instance: "ins_3HYFnwsybLbCpZ3iqN5yt4odmrx", key: "CLERK_SECRET_KEY" },
  "10k-dev": { app: "app_3JVnO515SfI9c8lo2l3KskmG7MQ", instance: "ins_3JVnO75emwoOfD4sY7FeE5BDJFi", key: "CLERK_SECRET_KEY_10K_DEV" },
  "10k-prod": { app: "app_3JVnO515SfI9c8lo2l3KskmG7MQ", instance: "ins_3JVszqLLBrKGLYjh7Ag1f4kRGny", key: "CLERK_SECRET_KEY_10K_PROD" },
} as const;
const targetName = (value("target") ?? "dev") as TargetName;
const TARGET = TARGETS[targetName];
if (!TARGET) {
  console.error(`Unknown target "${targetName}". One of ${Object.keys(TARGETS).join(" ")}.`);
  process.exit(2);
}
const SECRET_KEY = process.env[TARGET.key];
/**
 * The CLI assumes a dev instance holds 100 users, because the real limit is not
 * served by any API. The 10K dev instance was raised by Clerk to exactly
 * 10,000 (dashboard: "Max user limits"), the size of data/users-10k.json — so
 * it must start empty, which runOne's guard enforces.
 */
const TARGET_ENV: Record<string, string> =
  targetName === "10k-dev" ? { CLERK_MIGRATE_DEV_USER_LIMIT: process.env.CLERK_MIGRATE_DEV_USER_LIMIT ?? "10000" } : {};
if (!SECRET_KEY) {
  console.error(`${TARGET.key} is not set — is it in op.env?`);
  process.exit(2);
}

/**
 * How each provider is exported: the CLI subcommand, the env it reads, and any
 * extra flags. The CLI reads no .env file, so every credential arrives here.
 */
type Source = {
  cli: string;
  env: () => Record<string, string | undefined>;
  args?: () => string[];
};
const SOURCES: Record<string, Source> = {
  auth0: { cli: "auth0", env: () => ({}) }, // AUTH0_DOMAIN/CLIENT_ID/CLIENT_SECRET pass through
  authjs: {
    cli: "authjs",
    env: () => ({
      AUTHJS_DB_URL: process.env.AUTHJS_TURSO_DATABASE_URL,
      TURSO_AUTH_TOKEN: process.env.AUTHJS_TURSO_DATABASE_TOKEN,
    }),
  },
  "better-auth": {
    cli: "betterauth",
    env: () => ({
      BETTERAUTH_DB_URL: process.env.BA_TURSO_DATABASE_URL,
      TURSO_AUTH_TOKEN: process.env.BA_TURSO_DATABASE_TOKEN,
    }),
  },
  supabase: { cli: "supabase", env: () => ({ SUPABASE_DB_URL: process.env.SUPABASE_CONNECTION_STRING }) },
  firebase: {
    cli: "firebase",
    env: () => ({}),
    // The CLI takes the key as a file. A variation can point the export at a
    // different service account (F1's custom hash role) via
    // FIREBASE_SERVICE_ACCOUNT_FOR_EXPORT; the default is the seeding one.
    args: () => ["--service-account", serviceAccountFile(
      process.env.FIREBASE_SERVICE_ACCOUNT_FOR_EXPORT ?? process.env.FIREBASE_SERVICE_ACCOUNT_JSON!,
    )],
  },
  // WORKOS_API_KEY passes through; -y implies --with-identities, said explicitly here.
  workos: { cli: "workos", env: () => ({}), args: () => ["--with-identities"] },
  // Clerk as a source: export from the same dev instance the import targets
  // (variations/clerk.ts deletes the seed before the import).
  clerk: { cli: "clerk", env: () => ({}), args: () => ["--app", TARGET.app, "--instance", TARGET.instance] },
};

/** Writes a service-account JSON to a private temp file, removed when the run exits. */
function serviceAccountFile(json: string) {
  const file = join(tmpdir(), `sa-${process.pid}-${createHash("sha256").update(json).digest("hex").slice(0, 8)}.json`);
  writeFileSync(file, json, { mode: 0o600 });
  process.once("exit", () => rmSync(file, { force: true }));
  return file;
}

const provider = value("provider");
if (!provider || !SOURCES[provider]) {
  console.error(`Usage: pnpm test:migrate -p <${Object.keys(SOURCES).join("|")}> [-v <id>] [-d <D1..D5|all>]`);
  process.exit(2);
}
const source = SOURCES[provider];
const mod = (await import(`./variations/${provider}.ts`)) as VariationModule;
const { variations } = mod;
const resetSource = mod.reset ?? (() => script("scripts/reset.ts", ["-p", provider!, "-y"]));

const variationId = value("variation");
const destArg = value("dest");
const selected = variationId ? variations.filter((v) => v.id === variationId) : variations;
if (!selected.length) {
  console.error(`No variation "${variationId}" for ${provider}. Have: ${variations.map((v) => v.id).join(" ")}`);
  process.exit(2);
}
if (destArg && destArg !== "all" && !(destArg in DESTS)) {
  console.error(`Unknown dest "${destArg}". One of ${DEST_IDS.join(" ")} or all.`);
  process.exit(2);
}

const clerk = createClerkClient({ secretKey: SECRET_KEY });
const loadSeed = (file: string) =>
  JSON.parse(readFileSync(file, "utf8")) as { seedPassword: string; users: SeedUser[] };
const allUsers = loadSeed("data/users.json");

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
/**
 * Two directories per test run, both named `<stamp>-<provider>-<target>`:
 *   test-results/<run>/  this runner's report, log and per-variation checks
 *   clerk-runs/<run>/    the Clerk CLI's own run store (--runs-dir): every
 *                        export.json, users.ndjson and run.json it wrote
 * report.json names each variation's CLI export and import run, so a report
 * leads straight to its CLI runs.
 */
const runName = `${stamp}-${provider}-${targetName}`;
const runDir = resolve("test-results", runName);
const clerkRunsDir = resolve("clerk-runs", runName);
mkdirSync(runDir, { recursive: true });
mkdirSync(clerkRunsDir, { recursive: true });
const log = (line: string) => {
  console.log(line);
  appendFileSync(join(runDir, "log.txt"), line + "\n");
};

/** Runs the migrate CLI; stdout is JSON under --json, stderr goes to the log. */
async function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const result = await run("bun", [CLI, ...args], {
    // The target's key, so nothing in the CLI can fall back to another instance.
    ...process.env, CLERK_TELEMETRY_DISABLED: "1", CLERK_SECRET_KEY: SECRET_KEY, ...TARGET_ENV, ...env,
  });
  appendFileSync(join(runDir, "log.txt"), `$ clerk ${args.join(" ")}\n${result.stderr}\n`);
  let json: any = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    /* not JSON (config commands print text) */
  }
  return { code: result.code, json, stdout: result.stdout };
}

/** Runs one of this repo's scripts with the same (op-injected) env. */
async function script(file: string, args: string[], env: Record<string, string> = {}) {
  const result = await run("tsx", [file, ...args], { ...process.env, ...env });
  appendFileSync(join(runDir, "log.txt"), `$ tsx ${file} ${args.join(" ")}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`${file} ${args.join(" ")} exited ${result.code}`);
}

const target = ["--app", TARGET.app, "--instance", TARGET.instance];

async function patchDest(body: object) {
  const r = await cli(["config", "patch", ...target, "--json", JSON.stringify(body), "--yes"]);
  if (r.code !== 0) throw new Error(`config patch failed (exit ${r.code}); see log.txt`);
}

/**
 * Clerk's user count lags deletes by a few seconds: straight after an undo it
 * can still report users that are gone (seen live: "already has 3 users" after
 * F3's undo, 0 a moment later). Poll for up to a minute before trusting it.
 */
async function settledCount(timeoutMs = 60_000, want = 0) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const n = await withRetry(() => clerk.users.getCount(), 8);
    if (n === want || Date.now() > deadline) return n;
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function clerkUsers(): Promise<User[]> {
  const users: User[] = [];
  for (let offset = 0; ; offset += 500) {
    // Right after an import the instance's rate budget is spent: retry 429s.
    const { data } = await withRetry(() => clerk.users.getUserList({ limit: 500, offset }), 8);
    users.push(...data);
    if (data.length < 500) return users;
  }
}

function summarize(users: User[]): ClerkSummary {
  return {
    total: users.length,
    withPassword: users.filter((u) => u.passwordEnabled).length,
    withUsername: users.filter((u) => u.username).length,
    withPhone: users.filter((u) => u.phoneNumbers.length).length,
    withVerifiedEmail: users.filter((u) =>
      u.emailAddresses.some((e) => e.verification?.status === "verified"),
    ).length,
    banned: users.filter((u) => u.banned).length,
  };
}

/**
 * Every user with a password must actually sign in with the seed password.
 * Past 500 users (the 10K runs) a spread sample of 200 stands in for all of
 * them — 8,500 verify calls would take longer than the import.
 */
async function verifyPasswords(users: User[]) {
  const all = users.filter((u) => u.passwordEnabled);
  const step = all.length > 500 ? Math.ceil(all.length / 200) : 1;
  const withPassword = all.filter((_, i) => i % step === 0);
  const bad: string[] = [];
  await pool(withPassword, 4, async (u) => {
    const ok = await clerk.users
      .verifyPassword({ userId: u.id, password: allUsers.seedPassword })
      .then((r) => r.verified)
      .catch((e) => {
        if (e?.status === 429) throw e; // let pool's retry handle throttling
        return false;
      });
    if (!ok) bad.push(u.id);
  });
  return { checked: withPassword.length, failed: bad };
}

type Row = {
  variation: string;
  dest: DestId;
  status: "pass" | "fail" | "error" | "skipped";
  exported?: number;
  predicted?: number;
  created?: number;
  skipped?: number;
  failed?: number;
  passwords?: string;
  importSeconds?: number;
  /** The Clerk CLI's run IDs, under clerk-runs/<run>/. */
  exportRun?: string;
  importRun?: string;
  notes: string[];
};

async function runOne(v: Variation, dest: DestId): Promise<Row> {
  const row: Row = { variation: v.id, dest, status: "pass", notes: [] };
  if (v.skip) return { ...row, status: "skipped", notes: [v.skip] };
  if (!(v.targets ?? ["dev"]).includes(targetName))
    return { ...row, status: "skipped", notes: [`runs on ${(v.targets ?? ["dev"]).join(", ")} only`] };
  const dir = join(runDir, `${v.id}-${dest}`);
  mkdirSync(dir, { recursive: true });
  const runsDir = ["--runs-dir", clerkRunsDir];
  let importRun: string | undefined;

  try {
    // Guard: the destination has to start empty, or the counts mean nothing.
    const existing = await settledCount();
    if (existing) throw new Error(`Clerk instance already has ${existing} users — run pnpm teardown first`);

    // 1–2. Clean source, then its config, then the seed. Reset first, so it
    // cannot tear down a connection or table the config step just made.
    await resetSource();
    await v.sourceConfig?.();
    const seed = v.usersFile ? loadSeed(v.usersFile) : allUsers;
    const seeded = v.users(seed.users);
    // The standard dev instance is capped at 100 users; only 10K runs go past it.
    if (targetName === "dev" && seeded.length > 100)
      throw new Error(`${seeded.length} users is over the dev instance's 100 — use a 10k target`);
    const usersFile = join(dir, "users.json");
    writeFileSync(usersFile, JSON.stringify({ seedPassword: seed.seedPassword, users: seeded }));
    if (v.seed) await v.seed(seeded, seed.seedPassword);
    else await script("scripts/seed.ts", ["-p", provider!, "-r"], { SEED_USERS_FILE: usersFile });
    await mod.afterSeed?.(seeded);

    // 3. Export.
    const exp = await cli(["migrate", "export", source.cli, ...(source.args?.() ?? []), "--yes", "--json", ...runsDir], source.env());
    if (v.expectExportFailure) {
      if (exp.code === 0) row.notes.push("export succeeded, but this schema should make it fail");
      else row.notes.push(`export refused as expected (exit ${exp.code})`);
      await resetSource();
      row.status = exp.code === 0 ? "fail" : "pass";
      return row;
    }
    if (exp.code !== 0 || !exp.json) throw new Error(`export exited ${exp.code}`);
    writeFileSync(join(dir, "export.json"), JSON.stringify(exp.json, null, 2));
    row.exported = exp.json.users;
    if (row.exported !== seeded.length) row.notes.push(`exported ${row.exported} of ${seeded.length} seeded`);

    // 4. The seed has done its job; the export file is the source of truth now.
    await resetSource();

    // 5–6. Destination config, then the dry run as the oracle.
    await patchDest(DESTS[dest]);
    const exportRun = exp.json.run.id as string;
    row.exportRun = exportRun;
    const dry = await cli(["migrate", "import", exportRun, "--dry-run", "--allow-partial", "--json", ...target, ...runsDir]);
    writeFileSync(join(dir, "dry-run.json"), JSON.stringify(dry.json, null, 2));
    if (!dry.json?.checks) throw new Error(`dry run exited ${dry.code} with no checks`);
    row.predicted = dry.json.checks.importable;

    // 7. Import.
    const started = Date.now();
    const imp = await cli(["migrate", "import", exportRun, "--yes", "--allow-partial", "--json", ...target, ...runsDir]);
    row.importSeconds = Math.round((Date.now() - started) / 1000);
    writeFileSync(join(dir, "import.json"), JSON.stringify(imp.json, null, 2));
    importRun = imp.json?.run?.id;
    row.importRun = importRun;
    if (!imp.json?.result) throw new Error(`import exited ${imp.code} with no result`);
    Object.assign(row, {
      created: imp.json.result.created,
      skipped: imp.json.result.skipped,
      failed: imp.json.result.failed,
    });

    // 8. Verify.
    if (row.created !== row.predicted) row.notes.push(`created ${row.created} ≠ dry-run ${row.predicted}`);
    if (row.failed) row.notes.push(`${row.failed} failed: ${JSON.stringify(imp.json.result.errors)}`);
    // The listing lags creates the same way the count lags deletes (F6 once
    // listed 8 of 10 straight after the import): wait for it to catch up.
    await settledCount(60_000, row.created ?? 0);
    const users = await clerkUsers();
    const summary = summarize(users);
    writeFileSync(join(dir, "clerk-summary.json"), JSON.stringify(summary, null, 2));
    if (summary.total !== row.created) row.notes.push(`Clerk holds ${summary.total}, import said ${row.created}`);
    row.notes.push(...(v.expect?.(summary, seeded, dest, users) ?? []));
    const pw = await verifyPasswords(users);
    row.passwords = `${pw.checked - pw.failed.length}/${pw.checked}`;
    if (pw.failed.length) row.notes.push(`${pw.failed.length} passwords did not verify`);

    if (row.notes.length) row.status = "fail";
    if (row.status === "fail" && exp.json?.run) row.notes.push(`export run ${exp.json.run.id}`);
  } catch (error) {
    row.status = "error";
    row.notes.push(error instanceof Error ? error.message : String(error));
    // "fetch failed" alone says nothing about which call; keep the whole chain.
    appendFileSync(join(runDir, "log.txt"), `!! ${v.id} × ${dest}: ${error instanceof Error ? `${error.stack}\ncause: ${String((error as { cause?: unknown }).cause)}` : String(error)}\n`);
  } finally {
    // 9. Undo, even after a failed verify, so the next run starts empty.
    if (importRun) {
      const undoArgs = ["migrate", "undo", importRun, "--yes", "--json", ...target, ...runsDir];
      let undo = await cli(undoArgs);
      // cli-bugs.md #6: straight after a big import the CLI's instance lookup is
      // rate-limited, falls back to a key fingerprint, and undo refuses with a
      // false "different instance". Record it, let the budget recover, retry.
      for (let wait = 1; undo.code === 2 && /resolved key addresses/.test(JSON.stringify(undo.json)) && wait <= 5; wait++) {
        row.notes.push(`undo refused as a different instance (cli-bugs #6); retrying in ${15 * wait}s`);
        await new Promise((r) => setTimeout(r, 15_000 * wait));
        undo = await cli(undoArgs);
      }
      if (undo.code !== 0) row.notes.push(`undo exited ${undo.code}`);
      const left = await settledCount().catch(() => -1);
      if (left !== 0) row.notes.push(`!! ${left} users still in the instance after undo`);
    }
  }
  return row;
}

function cliVersion() {
  const root = dirname(CLI);
  const git = (...a: string[]) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
  try {
    return `${git("rev-parse", "--short", "HEAD")}${git("status", "--porcelain") ? " (dirty)" : ""}`;
  } catch {
    return "unknown";
  }
}

// ── main ──
const snapshot = JSON.parse((await cli(["config", "pull", ...target])).stdout);
writeFileSync(join(runDir, "clerk-config-before.json"), JSON.stringify(snapshot, null, 2));
const restore = Object.fromEntries(DEST_KEYS.map((k) => [k, snapshot[k]]));

const rows: Row[] = [];
try {
  for (const v of selected) {
    const dests = destArg === "all" ? DEST_IDS : destArg ? [destArg as DestId] : (v.dests ?? ["D1"]);
    for (const dest of dests) {
      log(`\n── ${v.id} × ${dest}: ${v.describe}`);
      const row = await runOne(v, dest);
      rows.push(row);
      log(`   ${row.status}  exported ${row.exported ?? "-"}  predicted ${row.predicted ?? "-"}  ` +
        `created ${row.created ?? "-"}  skipped ${row.skipped ?? "-"}  passwords ${row.passwords ?? "-"}` +
        (row.importSeconds !== undefined ? `  import ${row.importSeconds}s` : ""));
      for (const n of row.notes) log(`   · ${n}`);
    }
  }
} finally {
  await patchDest(restore).catch((e) => log(`!! config restore failed: ${e.message}`));
  await mod.afterAll?.().catch((e) => log(`!! source restore failed: ${e.message}`));
}

const header = `# ${provider} — ${stamp}\n\nCLI: \`${CLI}\` @ ${cliVersion()}\n\nCLI runs: \`clerk-runs/${runName}/\`\n\n` +
  `| Variation | Dest | Status | Exported | Predicted | Created | Skipped | Passwords | Import s | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n`;
const body = rows
  .map((r) => `| ${r.variation} | ${r.dest} | ${r.status} | ${r.exported ?? ""} | ${r.predicted ?? ""} | ` +
    `${r.created ?? ""} | ${r.skipped ?? ""} | ${r.passwords ?? ""} | ${r.importSeconds ?? ""} | ${r.notes.join("; ")} |`)
  .join("\n");
writeFileSync(join(runDir, "report.md"), header + body + "\n");
writeFileSync(join(runDir, "report.json"), JSON.stringify({ cli: CLI, version: cliVersion(), rows }, null, 2));
log(`\nReport: ${join(runDir, "report.md")}`);
process.exitCode = rows.every((r) => r.status === "pass" || r.status === "skipped") ? 0 : 1;
