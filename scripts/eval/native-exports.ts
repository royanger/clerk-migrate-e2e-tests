/**
 * The import eval's native exports: the same eval users as provider-exports.ts,
 * seeded the same way, but exported with each provider's own documented tool
 * instead of `clerk migrate export`. Only providers whose documented export
 * differs from the CLI's have one; WorkOS, Auth.js and Better Auth document no
 * export of their own, so the CLI's is the only one there is.
 *
 *   pnpm eval:setup:native-exports                auth0, firebase, supabase
 *   pnpm eval:setup:native-exports -p firebase    one
 *   pnpm eval:setup:native-exports -p clerk       seed the Clerk source, then you export from the Dashboard
 *   pnpm eval:setup:native-exports -p clerk --done   check your download, record it, restore the source
 *
 *   auth0         bulk export job (POST /api/v2/jobs/users-exports), NDJSON, gunzipped
 *   firebase      `firebase auth:export`, JSON and header-less CSV; the hash config the console shows beside it
 *   supabase      `select * from auth.users`, saved as the SQL Editor's "Export to CSV" saves it
 *   clerk         Dashboard → Settings → User exports: no API, so you download it
 *
 * Output: data/provider-exports/native/ (gitignored with the rest), each file
 * with a <file>.made-from.json like provider-exports.ts writes.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { flag, value } from "../lib/args";
import { api, json } from "../lib/auth0";
import { csvObjects, toCsv } from "../lib/csv";
import { run } from "../lib/run";
import { sql } from "../lib/supabase";
import { sourceTarget } from "../lib/targets";
import { EVAL_USERS, exportFile, PROVIDER_EXPORTS, usersFor } from "./provider-exports";

const DIR = "data/provider-exports/native";

/** One eval row each. firebase-csv shares the firebase seed and source IDs with firebase. */
export const NATIVE_EXPORTS: Record<string, { provider: string; file: string }> = {
  auth0: { provider: "auth0", file: "auth0.json" },
  firebase: { provider: "firebase", file: "firebase.json" },
  "firebase-csv": { provider: "firebase", file: "firebase.csv" },
  supabase: { provider: "supabase", file: "supabase.csv" },
  clerk: { provider: "clerk", file: "clerk.csv" },
};
export const nativeFile = (id: string) => join(DIR, NATIVE_EXPORTS[id].file);
/** What Firebase's console shows under Users → ⋮ → Password hash parameters. */
export const FIREBASE_HASH_CONFIG = join(DIR, "firebase.hash-config.json");
const madeFromFile = (file: string) => `${file}.made-from.json`;
const madeFrom = (provider: string) =>
  JSON.stringify({ variation: PROVIDER_EXPORTS[provider], users: createHash("sha256").update(readFileSync(EVAL_USERS)).digest("hex") });
export const nativeStale = (id: string) =>
  !existsSync(madeFromFile(nativeFile(id))) || readFileSync(madeFromFile(nativeFile(id)), "utf8").trim() !== madeFrom(NATIVE_EXPORTS[id].provider);

/** The rows of a native export, for the golden key's skipped users. */
export function nativeRows(id: string): Record<string, unknown>[] {
  // Firebase's CSV has no header row; its JSON twin has the same users under the same IDs.
  const file = nativeFile(id === "firebase-csv" ? "firebase" : id);
  const text = readFileSync(file, "utf8");
  if (file.endsWith(".csv")) return csvObjects(text);
  if (text.trimStart().startsWith("{\"users\"")) return JSON.parse(text).users;
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * Firebase's hash parameters as the CLI's import reads them from the
 * environment, so a native Firebase file imports with its passwords.
 */
export function firebaseHashEnv(): Record<string, string> {
  const c = JSON.parse(readFileSync(FIREBASE_HASH_CONFIG, "utf8"));
  return {
    CLERK_FIREBASE_SIGNER_KEY: c.base64_signer_key,
    CLERK_FIREBASE_SALT_SEPARATOR: c.base64_salt_separator,
    CLERK_FIREBASE_ROUNDS: String(c.rounds),
    CLERK_FIREBASE_MEM_COST: String(c.mem_cost),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Auth0's bulk export job with its default fields, as the Dashboard's Export Users runs it. */
async function auth0(): Promise<void> {
  const job = await api<{ id: string }>("/jobs/users-exports", json("POST", { format: "json" }));
  for (const deadline = Date.now() + 5 * 60_000; Date.now() < deadline; await sleep(2000)) {
    const j = await api<{ status: string; location?: string }>(`/jobs/${job.id}`);
    if (j.status === "failed") throw new Error(`Auth0 export job ${job.id} failed`);
    if (j.status !== "completed") continue;
    const body = Buffer.from(await (await fetch(j.location!)).arrayBuffer());
    // The download is <tenant>.json.gz; the customer unzips it to <tenant>.json.
    writeFileSync(nativeFile("auth0"), body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body);
    return;
  }
  throw new Error(`Auth0 export job ${job.id} didn't finish in 5 minutes`);
}

// ponytail: pinned for reproducibility; bump on purpose when Firebase changes auth:export.
const FIREBASE_TOOLS = "firebase-tools@15.33.0";

async function firebase(tmp: string): Promise<void> {
  const key = join(tmp, "service-account.json");
  writeFileSync(key, process.env.FIREBASE_SERVICE_ACCOUNT_JSON!);
  chmodSync(key, 0o600);
  const project = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON!).project_id as string;
  for (const id of ["firebase", "firebase-csv"]) {
    const r = await run("npx", ["-y", FIREBASE_TOOLS, "auth:export", nativeFile(id), "--project", project], {
      ...process.env, GOOGLE_APPLICATION_CREDENTIALS: key,
    }, { timeoutMs: 5 * 60_000 });
    if (r.code !== 0) throw new Error(`firebase auth:export ${NATIVE_EXPORTS[id].file} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  }
  // The console's hash config is the project's, which the CLI's own export reads too.
  const envelope = exportFile("firebase");
  if (!existsSync(envelope)) throw new Error(`no ${envelope} to take the hash config from: run pnpm eval:setup:provider-exports -p firebase`);
  writeFileSync(FIREBASE_HASH_CONFIG, JSON.stringify({ algorithm: "SCRYPT", ...JSON.parse(readFileSync(envelope, "utf8")).firebase }, null, 2) + "\n");
  chmodSync(FIREBASE_HASH_CONFIG, 0o600);
}

/** The SQL Editor runs the query through the Management API and writes the result grid as CSV. */
async function supabase(): Promise<void> {
  writeFileSync(nativeFile("supabase"), toCsv(await sql("select * from auth.users")));
}

const testMigrate = (args: string[]) => run("tsx", ["scripts/test-migrate.ts", ...args]);

/** Seeds `provider`, runs its native export, restores it. */
async function make(provider: string, tmp: string): Promise<void> {
  const seed = await testMigrate(["-p", provider, "-v", PROVIDER_EXPORTS[provider], "--users-file", usersFor(provider, tmp), "--seed-only"]);
  if (seed.code !== 0) throw new Error(`seeding exited ${seed.code}: ${(seed.stdout + seed.stderr).trim().split("\n").slice(-3).join(" | ")}`);
  try {
    if (provider === "auth0") await auth0();
    if (provider === "firebase") await firebase(tmp);
    if (provider === "supabase") await supabase();
  } finally {
    const restore = await testMigrate(["-p", provider, "--restore-source"]);
    if (restore.code !== 0) console.log(`  !! restore exited ${restore.code}: run pnpm test:migrate -p ${provider} --restore-source`);
  }
}

async function main() {
  // As provider-exports.ts: Clerk seeds the separate source app, not test:migrate's own instance.
  const source = await sourceTarget();
  Object.assign(process.env, { CLERK_AS_SOURCE_SECRET_KEY: source.secretKey, CLERK_AS_SOURCE_APP: source.app, CLERK_AS_SOURCE_INSTANCE: source.instance });
  mkdirSync(DIR, { recursive: true });
  const only = value("provider");
  const tmp = mkdtempSync(join(tmpdir(), "eval-native-"));

  if (only === "clerk") {
    const file = nativeFile("clerk");
    if (flag("done")) {
      const rows = existsSync(file) ? csvObjects(readFileSync(file, "utf8")) : [];
      if (!rows.length || !("password_digest" in rows[0])) throw new Error(`${file} is missing or isn't a Dashboard user export (no password_digest column)`);
      writeFileSync(madeFromFile(file), madeFrom("clerk") + "\n");
      await testMigrate(["-p", "clerk", "--restore-source"]);
      console.log(`✓ clerk        ${rows.length} users → ${file}; source restored`);
    } else {
      const seed = await testMigrate(["-p", "clerk", "-v", PROVIDER_EXPORTS.clerk, "--users-file", usersFor("clerk", tmp), "--seed-only"]);
      if (seed.code !== 0) throw new Error(`seeding exited ${seed.code}`);
      console.log(`Seeded the Clerk source app: development instance ${source.instance}.
1. Dashboard → that app → Settings → User exports → Export users, then Download.
2. Save it as ${file}
3. Run: pnpm eval:setup:native-exports -p clerk --done`);
    }
    rmSync(tmp, { recursive: true, force: true });
    return;
  }

  const providers = only ? [only] : ["auth0", "firebase", "supabase"];
  let failed = 0;
  for (const p of providers) {
    const ids = Object.keys(NATIVE_EXPORTS).filter((id) => NATIVE_EXPORTS[id].provider === p);
    if (!ids.length) {
      console.error(`No native export for "${p}". One of auth0 firebase supabase clerk`);
      process.exit(2);
    }
    const started = Date.now();
    try {
      await make(p, tmp);
      for (const id of ids) {
        writeFileSync(madeFromFile(nativeFile(id)), madeFrom(p) + "\n");
        console.log(`✓ ${id.padEnd(12)} ${nativeRows(id).length} users → ${nativeFile(id)}  (${Math.round((Date.now() - started) / 1000)}s)`);
      }
    } catch (e) {
      failed++;
      console.log(`✗ ${p.padEnd(12)} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("native-exports.ts")) await main();
