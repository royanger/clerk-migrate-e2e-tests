/**
 * Golden answer keys for the import and migration evals: what each provider's
 * export becomes in Clerk when the CLI is used correctly, under given Clerk
 * settings. Keys are filed by those settings, not by answer set, so every set
 * of either eval with the same settings shares one key:
 *   <dest>[-partial]   e.g. D2-partial: Clerk settings D2, --allow-partial
 *
 *   pnpm eval:imports:golden              every settings combination any import/migration set uses × provider
 *   pnpm eval:imports:golden -p auth0     one provider
 *
 * On one Clerk target claimed from the pool, per settings × provider: empty it → those Clerk settings →
 * `clerk migrate import --yes` (with --allow-partial when they say so) →
 * read every user back, check each password signs in → undo.
 *
 * Writes data/provider-exports/golden/<settings>/<provider>.expected.json in the
 * same shape as the custom-source answer keys, so lib/grade.ts grades an
 * agent's import against it unchanged. Users the import rejected become
 * `skip` entries: they must not be in Clerk. Each key records the CLI build
 * it came from; eval:imports warns when the CLI has moved on since.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { User } from "@clerk/backend";
import { value } from "../lib/args";
import { rowIdentifiers, sourceIdOf } from "../lib/identifiers";
import { clerkRun, cliVersion } from "../lib/clerk-run";
import { claimTarget, targetArgs } from "../lib/targets";
import { deleteAllUsers } from "../lib/clerk-source";
import { DESTS, type DestId } from "../lib/clerk-dest";
import type { AnswerKey, Expected } from "../generate-custom-exports";
import { listSets, loadSet, setsDir, type AnswerSet } from "./answers";
import { loadConfig } from "./config";
import { exportFile, PROVIDER_EXPORTS } from "./provider-exports";

export type GoldenKey = AnswerKey & {
  /** e.g. "D2-partial". */
  settings: string;
  dest: DestId;
  allowPartial: boolean;
  cliVersion: string;
  /** sha256 of the export file it was made from. */
  exportSha: string;
  createdAt: string;
};

/** Where an answer set's golden keys live: named for its Clerk settings. */
export const settingsOf = (set: AnswerSet) => `${set.meta.dest}${set.meta.allowPartial ? "-partial" : ""}`;
export const goldenFile = (settings: string, provider: string) => `data/provider-exports/golden/${settings}/${provider}.expected.json`;
export const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** What one Clerk user is, in answer-key form. */
export function toExpected(u: User, passwordVerifies: boolean): Expected {
  const verified = (s?: string) => s === "verified";
  return {
    externalId: u.externalId ?? u.id,
    primaryEmail: u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId && verified(e.verification?.status))?.emailAddress,
    emails: u.emailAddresses.filter((e) => verified(e.verification?.status)).map((e) => e.emailAddress),
    unverifiedEmails: u.emailAddresses.filter((e) => !verified(e.verification?.status)).map((e) => e.emailAddress),
    primaryPhone: u.phoneNumbers.find((p) => p.id === u.primaryPhoneNumberId && verified(p.verification?.status))?.phoneNumber,
    phones: u.phoneNumbers.filter((p) => verified(p.verification?.status)).map((p) => p.phoneNumber),
    unverifiedPhones: u.phoneNumbers.filter((p) => !verified(p.verification?.status)).map((p) => p.phoneNumber),
    username: u.username ?? undefined,
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    banned: u.banned,
    hasPassword: u.passwordEnabled && passwordVerifies,
    publicMetadata: (u.publicMetadata ?? {}) as Record<string, unknown>,
    privateMetadata: (u.privateMetadata ?? {}) as Record<string, unknown>,
    unsafeMetadata: (u.unsafeMetadata ?? {}) as Record<string, unknown>,
  };
}

/** A user the import did not create: it must stay out of Clerk. */
export const skipped = (sourceId: string, reason: string, identifiers: string[] = []): Expected => ({
  externalId: sourceId, skip: reason, identifiers, emails: [], unverifiedEmails: [], phones: [], unverifiedPhones: [],
  banned: false, hasPassword: false, publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {},
});

/** The last line per source ID wins, as the CLI documents. */
export function runUsers(file: string): Map<string, { status: string; reason?: string; error?: string }> {
  const out = new Map<string, { status: string; reason?: string; error?: string }>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const l = JSON.parse(line);
    out.set(String(l.sourceId), l);
  }
  return out;
}

async function main() {
  const cfg = loadConfig();
  // One build per distinct settings combination across both evals' sets.
  const combos = new Map<string, { dest: DestId; allowPartial: boolean; usedBy: string[] }>();
  for (const kind of ["imports", "migrations"] as const) {
    for (const name of listSets(setsDir(kind))) {
      const set = loadSet(name, setsDir(kind));
      const key = settingsOf(set);
      const c = combos.get(key) ?? { dest: set.meta.dest as DestId, allowPartial: Boolean(set.meta.allowPartial), usedBy: [] };
      c.usedBy.push(`${kind}/${name}`);
      combos.set(key, c);
    }
  }
  const providers = value("provider") ? [value("provider")!] : Object.keys(PROVIDER_EXPORTS);
  const seedPassword = JSON.parse(readFileSync("data/users-eval.json", "utf8")).seedPassword as string;
  const work = mkdtempSync(join(tmpdir(), "eval-golden-"));
  // Any pool target will do: golden keys depend on the Clerk settings, which the build sets.
  const { target: t, release } = await claimTarget("eval:imports:golden");
  const clerk = clerkRun({ cli: cfg.cli, secretKey: t.secretKey, log: join(work, "clerk.log") });
  const target = targetArgs(t);
  const patch = (body: object) => clerk.patchConfig(target, body);
  const version = cliVersion(cfg.cli);
  console.log(`CLI ${version} · Clerk target ${t.name} · log ${join(work, "clerk.log")}`);
  if (await clerk.settledCount()) await deleteAllUsers(clerk.clerk);
  let failed = 0;
  try {
    for (const [settings, { dest, allowPartial, usedBy }] of combos) {
      if (!DESTS[dest]) throw new Error(`${usedBy.join(", ")}: dest "${dest}" is not one of ${Object.keys(DESTS).join(" ")}`);
      console.log(`${settings} (used by ${usedBy.join(", ")})`);
      await patch(DESTS[dest]);
      for (const provider of providers) {
        const file = exportFile(provider);
        const label = `${settings.padEnd(11)} ${provider.padEnd(12)}`;
        if (!existsSync(file)) {
          console.log(`✗ ${label} no export: run pnpm eval:provider-exports -p ${provider}`);
          failed++;
          continue;
        }
        const runs = join(work, `${settings}-${provider}`);
        let importRun: string | undefined;
        try {
          const existing = await clerk.settledCount();
          if (existing) throw new Error(`instance already has ${existing} users: run pnpm teardown`);
          const imp = await clerk.cli([
            "migrate", "import", file, "--yes", "--json", ...(allowPartial ? ["--allow-partial"] : []), ...target, "--runs-dir", runs,
          ]);
          importRun = imp.json?.run?.id;
          if (!imp.json?.result) throw new Error(`import exited ${imp.code}: ${JSON.stringify(imp.json?.error ?? imp.json).slice(0, 300)}`);
          const created = imp.json.result.created as number;
          await clerk.settledCount(60_000, created);
          let users = await clerk.clerkUsers();
          for (let i = 0; users.length !== created && i < 20; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            users = await clerk.clerkUsers();
          }
          const pw = await clerk.verifyPasswords(users, seedPassword);
          const bad = new Set(pw.failed);
          const lines = runUsers(join(runs, importRun!, "users.ndjson"));
          const rows = new Map((JSON.parse(readFileSync(file, "utf8")).users as Record<string, unknown>[]).map((r) => [sourceIdOf(r), r]));
          const key: GoldenKey = {
            source: provider,
            seedPassword,
            metadataPlacement: "strict",
            settings,
            dest,
            allowPartial,
            cliVersion: version,
            exportSha: sha256(file),
            createdAt: new Date().toISOString(),
            users: [
              ...users.map((u) => toExpected(u, !bad.has(u.id))),
              ...[...lines].filter(([, l]) => l.status !== "created").map(([id, l]) => skipped(id, l.reason ?? l.error ?? l.status, rowIdentifiers(rows.get(id)))),
            ],
          };
          mkdirSync(dirname(goldenFile(settings, provider)), { recursive: true });
          writeFileSync(goldenFile(settings, provider), JSON.stringify(key, null, 2) + "\n");
          const unverifiable = users.filter((u) => u.passwordEnabled && bad.has(u.id)).length;
          console.log(`✓ ${label} ${created} created, ${key.users.length - users.length} skipped, ${pw.checked - pw.failed.length}/${pw.checked} passwords sign in` +
            (unverifiable ? `  ⚠ ${unverifiable} have a password that does not sign in` : ""));
        } catch (error) {
          failed++;
          console.log(`✗ ${label} ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (importRun) {
            const undo = await clerk.cli(["migrate", "undo", importRun, "--yes", "--json", ...target, "--runs-dir", runs]);
            const left = await clerk.settledCount();
            if (undo.code !== 0 || left) console.log(`  !! undo exited ${undo.code}, ${left} users left: run pnpm teardown`);
          }
        }
      }
    }
  } finally {
    release();
  }
  // Kept on failure: clerk.log there says what the CLI did.
  if (!failed) rmSync(work, { recursive: true, force: true });
  else console.log(`Work folder kept: ${work}`);
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1]?.endsWith("golden.ts")) await main();
