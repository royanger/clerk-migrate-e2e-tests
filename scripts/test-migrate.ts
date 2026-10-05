/**
 * Live end-to-end test of `clerk migrate` for one provider's variations.
 *
 *   pnpm test:migrate -p better-auth              every variation, each on its own dests
 *   pnpm test:migrate -p better-auth -v B0        one variation
 *   pnpm test:migrate -p better-auth -v B0 -d all against D1–D5
 *   pnpm test:migrate ... --cli <path/to/cli.ts>  a different CLI checkout
 *   pnpm test:migrate -p auth0 -v A3 --users-file data/users-eval.json --export-to out.json
 *       export only: seed every user in the file through that variation's
 *       source setup, export, save the export file, clean the source up. No
 *       import. (The import eval's provider exports are made this way.)
 *   pnpm test:migrate -p auth0 -v A3 --users-file data/users-eval.json --seed-only
 *       seed only: leave those users in the provider (the migration eval exports
 *       from them). Undo with:
 *   pnpm test:migrate -p auth0 --restore-source
 *       empty the provider and put back its standard users (the variations' afterAll)
 *
 * Takes the provider's lock (scripts/lib/lock.ts) for the whole run.
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
import { clerkRun, cliVersion, DEFAULT_CLI, resolveTargets, TARGETS } from "./lib/clerk-run";
import { copyFileSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { User } from "@clerk/backend";
import { DESTS, DEST_IDS, DEST_KEYS, type DestId } from "./lib/clerk-dest";
import type { ClerkSummary, TargetName, Variation, VariationModule } from "./lib/variations";
import { withRetry, type SeedUser } from "./lib/users";
import { flag, value } from "./lib/args";
import { clerkLock, lockProviders } from "./lib/lock";
import { SOURCE, SOURCE_SECRET_KEY } from "./lib/clerk-source";

const CLI = resolve(value("cli")?.replace(/^~/, homedir()) ?? DEFAULT_CLI);

const targetName = (value("target") ?? "dev") as TargetName;
await resolveTargets();
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
  // From SOURCE: the destination instance itself (Stage 7), or the migration
  // eval's separate source instance, which then needs its own key.
  clerk: {
    cli: "clerk",
    env: () => ({}),
    args: () => ["--app", SOURCE.app, "--instance", SOURCE.instance, ...(SOURCE_SECRET_KEY ? ["--secret-key", SOURCE_SECRET_KEY] : [])],
  },
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

const usersFileOverride = value("usersFile");
const exportTo = value("exportTo");
const seedOnly = flag("seedOnly");
const variationId = value("variation");
if ((exportTo || seedOnly) && !variationId) {
  console.error("--export-to and --seed-only need -v <variation>: the source setup to seed through.");
  process.exit(2);
}
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
const { clerk, cli, settledCount, clerkUsers, verifyPasswords, patchConfig: clerkPatch } = clerkRun({
  cli: CLI, secretKey: SECRET_KEY, log: join(runDir, "log.txt"), env: TARGET_ENV,
});
const log = (line: string) => {
  console.log(line);
  appendFileSync(join(runDir, "log.txt"), line + "\n");
};

/** Runs one of this repo's scripts with the same (op-injected) env. */
async function script(file: string, args: string[], env: Record<string, string> = {}) {
  const result = await run("tsx", [file, ...args], { ...process.env, ...env });
  appendFileSync(join(runDir, "log.txt"), `$ tsx ${file} ${args.join(" ")}\n${result.stdout}${result.stderr}\n`);
  if (result.code !== 0) throw new Error(`${file} ${args.join(" ")} exited ${result.code}`);
}

const target = ["--app", TARGET.app, "--instance", TARGET.instance];

const patchDest = (body: object) => clerkPatch(target, body);

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
  let preCreated: string[] = [];

  try {
    // Guard: the destination has to start empty, or the counts mean nothing.
    // Seeding alone never touches the destination, so it doesn't care what is in it.
    const existing = seedOnly ? 0 : await settledCount();
    if (existing) throw new Error(`Clerk instance already has ${existing} users — run pnpm teardown first`);

    // 1–2. Clean source, then its config, then the seed. Reset first, so it
    // cannot tear down a connection or table the config step just made.
    await resetSource();
    await v.sourceConfig?.();
    // --users-file seeds that file as it is, skipping the variation's own pick.
    const seed = usersFileOverride ? loadSeed(usersFileOverride) : v.usersFile ? loadSeed(v.usersFile) : allUsers;
    const seeded = usersFileOverride ? seed.users : v.users(seed.users);
    // The standard dev instance is capped at 100 users; only 10K runs go past it.
    if (targetName === "dev" && seeded.length > 100)
      throw new Error(`${seeded.length} users is over the dev instance's 100 — use a 10k target`);
    const usersFile = join(dir, "users.json");
    writeFileSync(usersFile, JSON.stringify({ seedPassword: seed.seedPassword, users: seeded }));
    if (v.seed) await v.seed(seeded, seed.seedPassword);
    else await script("scripts/seed.ts", ["-p", provider!, "-r"], { SEED_USERS_FILE: usersFile });
    await mod.afterSeed?.(seeded);
    if (seedOnly) {
      row.notes = [`seeded ${seeded.length} users and left them in ${provider}`];
      return row;
    }

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
    if (exportTo) {
      const exportRun = exp.json.run.id as string;
      mkdirSync(dirname(resolve(exportTo)), { recursive: true });
      copyFileSync(join(clerkRunsDir, exportRun, "export.json"), exportTo);
      row.exportRun = exportRun;
      // Deleted, anonymous or unexportable users can make these differ; say so, don't fail.
      row.notes = [`exported ${row.exported} of ${seeded.length} seeded → ${exportTo}`];
      return row;
    }

    // 5–6. Destination config, then the dry run as the oracle.
    await patchDest(DESTS[dest]);
    const exportRun = exp.json.run.id as string;
    row.exportRun = exportRun;
    preCreated = (await v.beforeImport?.(clerk, seeded)) ?? [];
    const extra = v.importArgs ?? [];
    const dry = await cli(["migrate", "import", exportRun, "--dry-run", "--allow-partial", ...extra, "--json", ...target, ...runsDir]);
    writeFileSync(join(dir, "dry-run.json"), JSON.stringify(dry.json, null, 2));
    if (!dry.json?.checks) throw new Error(`dry run exited ${dry.code} with no checks`);
    row.predicted = dry.json.checks.importable;
    if (v.expectChecks) {
      const exported = JSON.parse(readFileSync(join(clerkRunsDir, exportRun, "export.json"), "utf8")).users as Record<string, unknown>[];
      const byId = new Map(exported.map((r) => [String(r.user_id ?? r.id ?? r.localId ?? r.uid), r]));
      const rejected = (dry.json.checks.rejects as { sourceId: string; reason: string }[]).map((r) => ({ ...r, row: byId.get(r.sourceId) }));
      row.notes.push(...v.expectChecks(dry.json.checks, rejected, seeded, dest, exported).map((n) => `dry run: ${n}`));
    }

    // 7. Import.
    const started = Date.now();
    const imp = await cli(["migrate", "import", exportRun, "--yes", "--allow-partial", ...extra, "--json", ...target, ...runsDir]);
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
    // The count can catch up before the listing does (B7 once counted 40 but
    // listed 38): wait for the listing itself, not just the count.
    const expectedInClerk = (row.created ?? 0) + preCreated.length;
    await settledCount(60_000, expectedInClerk);
    let listed = await clerkUsers();
    for (let i = 0; listed.length !== expectedInClerk && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      listed = await clerkUsers();
    }
    // Users the variation put there itself (collision targets) aren't the import's.
    const users = listed.filter((u) => !preCreated.includes(u.id));
    const summary = summarize(users);
    writeFileSync(join(dir, "clerk-summary.json"), JSON.stringify(summary, null, 2));
    if (summary.total !== row.created) row.notes.push(`Clerk holds ${summary.total}, import said ${row.created}`);
    row.notes.push(...(v.expect?.(summary, seeded, dest, users) ?? []));
    const pw = await verifyPasswords(users, allUsers.seedPassword);
    row.passwords = `${pw.checked - pw.failed.length}/${pw.checked}`;
    if (pw.failed.length) row.notes.push(`${pw.failed.length} passwords did not verify`);

    if (v.reimport) {
      const again = await cli(["migrate", "import", exportRun, "--yes", "--allow-partial", ...extra, "--json", ...target, ...runsDir]);
      if (again.code !== 0 || !again.json?.alreadyImported)
        row.notes.push(`re-import: expected "already imported", got exit ${again.code} ${JSON.stringify(again.json?.result ?? again.json?.error ?? {}).slice(0, 120)}`);
      const after = await settledCount(15_000, users.length + preCreated.length);
      if (after !== users.length + preCreated.length) row.notes.push(`re-import changed the instance: ${users.length + preCreated.length} → ${after} users`);
    }

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
    }
    for (const id of preCreated) await withRetry(() => clerk.users.deleteUser(id), 8).catch(() => row.notes.push(`could not delete pre-created ${id}`));
    if (importRun || preCreated.length) {
      const left = await settledCount().catch(() => -1);
      if (left !== 0) row.notes.push(`!! ${left} users still in the instance after undo`);
    }
  }
  return row;
}

// ── main ──
// Restoring touches only the provider (for Clerk, the source instance), not the destination.
if (flag("restoreSource")) {
  await lockProviders([provider, ...(provider === "clerk" ? [clerkLock(SOURCE.instance)] : [])], `test:migrate -p ${provider} --restore-source`);
  await resetSource();
  await mod.afterAll?.();
  log(`${provider}: emptied and restored to its standard users`);
  process.exit(0);
}
// The source provider and the Clerk instance it imports into, all at once. Seeding
// alone needs only the provider. Clerk as a source also locks its source instance
// (the same lock as the destination's when, as in Stage 7, they are one instance).
const sourceLock = provider === "clerk" ? [clerkLock(SOURCE.instance)] : [];
await lockProviders(
  seedOnly ? [provider, ...sourceLock] : [provider, clerkLock(TARGET.instance), ...sourceLock],
  `test:migrate -p ${provider}${variationId ? ` -v ${variationId}` : ""}${seedOnly ? " --seed-only" : ""}`,
);
const snapshot = seedOnly ? {} : JSON.parse((await cli(["config", "pull", ...target])).stdout);
writeFileSync(join(runDir, "clerk-config-before.json"), JSON.stringify(snapshot, null, 2));
const restore = Object.fromEntries(DEST_KEYS.map((k) => [k, snapshot[k]]));

const rows: Row[] = [];
try {
  for (const v of selected) {
    const dests = exportTo || seedOnly ? (["D1"] as DestId[]) : destArg === "all" ? DEST_IDS : destArg ? [destArg as DestId] : (v.dests ?? ["D1"]);
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
  if (!seedOnly) await patchDest(restore).catch((e) => log(`!! config restore failed: ${e.message}`));
  // --seed-only leaves the seeded users for the caller; --restore-source puts the standard ones back.
  if (!seedOnly) await mod.afterAll?.().catch((e) => log(`!! source restore failed: ${e.message}`));
}

const header = `# ${provider} — ${stamp}\n\nCLI: \`${CLI}\` @ ${cliVersion(CLI)}\n\nCLI runs: \`clerk-runs/${runName}/\`\n\n` +
  `| Variation | Dest | Status | Exported | Predicted | Created | Skipped | Passwords | Import s | Notes |\n|---|---|---|---|---|---|---|---|---|---|\n`;
const body = rows
  .map((r) => `| ${r.variation} | ${r.dest} | ${r.status} | ${r.exported ?? ""} | ${r.predicted ?? ""} | ` +
    `${r.created ?? ""} | ${r.skipped ?? ""} | ${r.passwords ?? ""} | ${r.importSeconds ?? ""} | ${r.notes.join("; ")} |`)
  .join("\n");
writeFileSync(join(runDir, "report.md"), header + body + "\n");
writeFileSync(join(runDir, "report.json"), JSON.stringify({ cli: CLI, version: cliVersion(CLI), rows }, null, 2));
log(`\nReport: ${join(runDir, "report.md")}`);
process.exitCode = rows.every((r) => r.status === "pass" || r.status === "skipped") ? 0 : 1;
