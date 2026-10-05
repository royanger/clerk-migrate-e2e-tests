/**
 * Makes the import eval's input files: the 50 users in data/users-eval.json,
 * seeded into each provider and exported with `clerk migrate export`, exactly
 * as a customer would get them.
 *
 *   pnpm eval:provider-exports              all seven
 *   pnpm eval:provider-exports -p supabase  one
 *
 * Each export runs through test:migrate's export-only mode, using the
 * variation whose source setup takes the widest mix of users. Output:
 * data/provider-exports/<provider>.json (gitignored: the Firebase one carries
 * the project's password-hash key).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../lib/run";
import { sourceTarget } from "../lib/targets";
import { value } from "../lib/args";

export const PROVIDER_EXPORTS: Record<string, string> = {
  clerk: "C2", // every identifier on; metadata and bans come from the seed user
  auth0: "A3", // Flexible Identifiers, so phone-only users have somewhere to go
  authjs: "J1",
  "better-auth": "B9", // username, phone, admin and 2FA plugins
  firebase: "F8",
  supabase: "S8",
  workos: "W7",
};
/** How a customer would name each provider. */
export const PROVIDER_NAMES: Record<string, string> = {
  clerk: "Clerk", auth0: "Auth0", authjs: "Auth.js", "better-auth": "Better Auth",
  firebase: "Firebase", supabase: "Supabase", workos: "WorkOS",
};

export const exportFile = (provider: string) => `data/provider-exports/${provider}.json`;

/**
 * Password formats a provider cannot hold at all. Those users get the
 * provider's own hash instead, as they would in a real project; the seeders
 * stay strict, so a migration test that asks for one still fails loudly.
 */
const UNSUPPORTED_FORMATS: Record<string, string[]> = { firebase: ["argon2id"] };

/** data/users-eval.json, adjusted for what `provider` can store. */
export function usersFor(provider: string, dir: string): string {
  const drop = UNSUPPORTED_FORMATS[provider];
  if (!drop) return "data/users-eval.json";
  const seed = JSON.parse(readFileSync("data/users-eval.json", "utf8"));
  for (const u of seed.users) if (drop.includes(u.passwordFormat)) delete u.passwordFormat;
  const file = join(dir, `users-${provider}.json`);
  writeFileSync(file, JSON.stringify(seed));
  return file;
}

async function main() {
  // Clerk exports from the separate source instance once evals/targets.json has one; else, as before,
  // from test:migrate's own instance.
  const source = await sourceTarget().catch(() => undefined);
  if (source) Object.assign(process.env, { CLERK_AS_SOURCE_SECRET_KEY: source.secretKey, CLERK_AS_SOURCE_APP: source.app, CLERK_AS_SOURCE_INSTANCE: source.instance });
  const only = value("provider");
  const providers = only ? [only] : Object.keys(PROVIDER_EXPORTS);
  if (only && !PROVIDER_EXPORTS[only]) {
    console.error(`Unknown provider "${only}". One of ${Object.keys(PROVIDER_EXPORTS).join(" ")}`);
    process.exit(2);
  }

  let failed = 0;
  const tmp = mkdtempSync(join(tmpdir(), "eval-exports-"));
  for (const p of providers) {
    const out = exportFile(p);
    const started = Date.now();
    const r = await run("tsx", ["scripts/test-migrate.ts", "-p", p, "-v", PROVIDER_EXPORTS[p], "--users-file", usersFor(p, tmp), "--export-to", out]);
    const secs = Math.round((Date.now() - started) / 1000);
    const ok = r.code === 0 && existsSync(out);
    if (!ok) failed++;
    const users = ok ? JSON.parse(readFileSync(out, "utf8")).users.length : 0;
    console.log(`${ok ? "✓" : "✗"} ${p.padEnd(12)} ${ok ? `${users} users → ${out}` : `exit ${r.code}`}  (${secs}s)`);
    if (!ok) console.log((r.stdout + r.stderr).trim().split("\n").slice(-6).map((l) => `    ${l}`).join("\n"));
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

// Imported for its table by golden.ts and the import runner: only run when called.
if (process.argv[1]?.endsWith("provider-exports.ts")) await main();
