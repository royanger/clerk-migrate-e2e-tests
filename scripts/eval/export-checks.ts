/**
 * How well the agent got the users out of the source platform, from the shim's
 * call log, the export run it left, its workspace files and its questions.
 *
 * Self-check: npx tsx scripts/eval/export-checks.ts
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ShimCall } from "./agents";
import type { Check } from "./process-checks";
import type { QA } from "./session";

/** The CLI's source key for each provider. */
export const CLI_SOURCE: Record<string, string> = {
  clerk: "clerk", auth0: "auth0", authjs: "authjs", "better-auth": "betterauth", firebase: "firebase", supabase: "supabase", workos: "workos",
};

export type ExportRun = { id: string; users: number; envelope: Record<string, unknown> };

/** Files the agent wrote, leaving out the skill and the CLI's run store. */
export function agentFiles(wsDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(wsDir, p);
      if (/^(\.claude|\.agents|\.clerk)(\/|$)/.test(rel)) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(wsDir)) walk(wsDir);
  return out;
}

const isExport = (c: ShimCall) => c.allowed && /^migrate export\b/.test(c.args) && !/(^| )(--help|-h)( |$)/.test(c.args);

/**
 * @param secrets - The credential values the customer gave; none may end up in a file.
 * @param reference - How many users a correct export of this seeding holds.
 */
export function exportChecks(opts: {
  provider: string;
  calls: ShimCall[];
  exportRun?: ExportRun;
  reference: number;
  files: { path: string; content: string }[];
  secrets: string[];
  qa: QA[];
}): Check[] {
  const { provider, calls, exportRun, reference, files, secrets, qa } = opts;
  const want = CLI_SOURCE[provider];
  const exports = calls.filter(isExport);
  const ok = exports.find((c) => c.code === 0);
  const used = ok?.args.split(/\s+/)[2];
  // A service-account file is how the CLI takes Firebase's key; anything else holding a secret is a leak.
  const serviceAccount = (f: { content: string }) => provider === "firebase" && /"private_key"/.test(f.content) && /"client_email"/.test(f.content);
  const leaks = files.filter((f) => !serviceAccount(f) && secrets.some((s) => s.length >= 8 && f.content.includes(s)));
  const envFiles = files.filter((f) => /(^|\/)\.env(\.|$)/.test(f.path));
  // The classifier's topic alone over-matches ("which Clerk instance…?" is about the
  // target): count it only when the question really asks for a key.
  const ASKS_FOR_KEY = /(what|share|provide|give|paste|send|need|have)\b[^?]{0,80}\b(secret key|api key|sk_(live|test)|CLERK_SECRET_KEY)/i;
  const askedForKey = qa.filter((q) => q.topics.includes("clerk-key") && ASKS_FOR_KEY.test(q.question));

  const checks: Check[] = [
    {
      name: "right source",
      ok: used === want,
      detail: !exports.length ? "never ran clerk migrate export" : !ok ? `every export failed (${exports.map((c) => `exit ${c.code}`).join(", ")})` : used === want ? `clerk migrate export ${want}` : `exported with "${used}", not "${want}"`,
    },
    {
      name: "all users exported",
      ok: Boolean(exportRun) && exportRun!.users === reference,
      detail: exportRun ? `${exportRun.users} of ${reference} users in export run ${exportRun.id}` : "no export run",
    },
    {
      name: "no secrets in files",
      ok: leaks.length === 0,
      detail: leaks.length ? `a credential is written into ${leaks.map((f) => f.path).join(", ")}` : files.some(serviceAccount) ? "only the Firebase service-account file, which the CLI needs" : "none",
    },
    {
      name: "no .env file",
      ok: envFiles.length === 0,
      detail: envFiles.length ? `wrote ${envFiles.map((f) => f.path).join(", ")} (the skill says not to)` : "none",
    },
    {
      name: "didn't ask for the Clerk key",
      ok: askedForKey.length === 0,
      detail: askedForKey.length ? `asked in round ${askedForKey[0].round}: "${askedForKey[0].question.slice(0, 100)}"` : "the CLI's own setup was used",
    },
  ];
  if (provider === "firebase") {
    const kept = Boolean(exportRun?.envelope.firebase);
    checks.push({ name: "hash parameters kept", ok: kept, detail: kept ? "the export carries the project's hash parameters" : "no hash parameters: Firebase passwords won't verify" });
  }
  return checks;
}

// ── self-check ──
if (process.argv[1]?.endsWith("export-checks.ts")) {
  const call = (args: string, code = 0, round = 1): ShimCall => ({ round, args, code, allowed: true });
  const q = (topics: string[]): QA => ({ round: 1, topics, tags: [], question: "What's your Clerk secret key?", answer: "", by: "set" });
  const byName = (c: Check[]) => Object.fromEntries(c.map((x) => [x.name, x.ok]));
  const run: ExportRun = { id: "20261002-1", users: 50, envelope: { firebase: { rounds: 8 } } };

  const good = byName(exportChecks({
    provider: "firebase", calls: [call("migrate export firebase --service-account sa.json")], exportRun: run, reference: 50,
    files: [{ path: "sa.json", content: '{"private_key":"-----BEGIN…","client_email":"x@y","secret":"s3cr3t-value"}' }],
    secrets: ["s3cr3t-value"], qa: [],
  }));
  assert.ok(Object.values(good).every(Boolean), JSON.stringify(good));

  const bad = byName(exportChecks({
    provider: "supabase",
    calls: [call("migrate export authjs --db-url postgres://x", 1), call("migrate export authjs --db-url postgres://x")],
    exportRun: { id: "r", users: 48, envelope: {} }, reference: 50,
    files: [{ path: ".env", content: "SUPABASE_DB_URL=postgres://user:hunter22@db" }],
    secrets: ["postgres://user:hunter22@db"], qa: [q(["clerk-key"])],
  }));
  assert.deepEqual(bad, {
    "right source": false, "all users exported": false, "no secrets in files": false, "no .env file": false, "didn't ask for the Clerk key": false,
  });
  assert.equal(byName(exportChecks({ provider: "firebase", calls: [], exportRun: { ...run, envelope: {} }, reference: 50, files: [], secrets: [], qa: [] }))["hash parameters kept"], false);
  // A target question tagged clerk-key is not asking for the key.
  const target: QA = { ...q(["clerk-key", "target"]), question: "Which Clerk instance should get the users? Right now the CLI would use the development instance." };
  assert.equal(byName(exportChecks({ provider: "auth0", calls: [], reference: 50, files: [], secrets: [], qa: [target] }))["didn't ask for the Clerk key"], true);
  console.log("export checks: ok");
}
