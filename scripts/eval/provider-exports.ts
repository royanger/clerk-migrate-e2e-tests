/**
 * Makes the import eval's input files: the 50 users in data/users-eval.json,
 * seeded into each provider and exported with `clerk migrate export`, exactly
 * as a customer would get them.
 *
 *   pnpm eval:setup:provider-exports              all seven
 *   pnpm eval:setup:provider-exports -p supabase  one
 *
 * Each export is recorded in <provider>.made-from.json: the eval users and
 * variation it came from. Imports and migrations make a missing export, and
 * offer to remake one whose record no longer matches (prepare.ts).
 *
 * Each export runs through test:migrate's export-only mode, using the
 * variation whose source setup takes the widest mix of users. Output:
 * data/provider-exports/<provider>.json (gitignored: the Firebase one carries
 * the project's password-hash key).
 */
import { createHash } from "node:crypto";
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

export const EVAL_USERS = "data/users-eval.json";
export const exportFile = (provider: string) => `data/provider-exports/${provider}.json`;
const madeFromFile = (provider: string) => `data/provider-exports/${provider}.made-from.json`;

/** What an export is made from: the eval users and the variation. */
const madeFrom = (provider: string) =>
  JSON.stringify({ variation: PROVIDER_EXPORTS[provider], users: createHash("sha256").update(readFileSync(EVAL_USERS)).digest("hex") });

/** True when the export has no record of what it was made from, or was made from something else. */
export const exportStale = (provider: string) =>
  !existsSync(madeFromFile(provider)) || readFileSync(madeFromFile(provider), "utf8").trim() !== madeFrom(provider);

/**
 * Password formats a provider cannot hold at all. Those users get the
 * provider's own hash instead, as they would in a real project; the seeders
 * stay strict, so a migration test that asks for one still fails loudly.
 */
const UNSUPPORTED_FORMATS: Record<string, string[]> = { firebase: ["argon2id"] };

/** Providers where every user has an email, so phone-only users can't exist. */
const EMAIL_REQUIRED = ["workos"];

/** data/users-eval.json, adjusted for what `provider` can store. */
export function usersFor(provider: string, dir: string): string {
  const drop = UNSUPPORTED_FORMATS[provider] ?? [];
  if (!drop.length && !EMAIL_REQUIRED.includes(provider)) return EVAL_USERS;
  const seed = JSON.parse(readFileSync(EVAL_USERS, "utf8"));
  for (const u of seed.users) if (drop.includes(u.passwordFormat)) delete u.passwordFormat;
  if (EMAIL_REQUIRED.includes(provider)) seed.users = seed.users.filter((u: { email: string | null }) => u.email);
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
    else writeFileSync(madeFromFile(p), madeFrom(p) + "\n");
    const users = ok ? JSON.parse(readFileSync(out, "utf8")).users.length : 0;
    console.log(`${ok ? "✓" : "✗"} ${p.padEnd(12)} ${ok ? `${users} users → ${out}` : `exit ${r.code}`}  (${secs}s)`);
    if (!ok) console.log((r.stdout + r.stderr).trim().split("\n").slice(-6).map((l) => `    ${l}`).join("\n"));
  }
  rmSync(tmp, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

// Imported for its table by golden.ts and the import runner: only run when called.
if (process.argv[1]?.endsWith("provider-exports.ts")) await main();
