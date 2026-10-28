/**
 * Golden answer keys for the import and migration evals: what each provider's
 * export becomes in Clerk when the CLI is used correctly, under given Clerk
 * settings. Keys are filed by those settings, not by answer set, so every set
 * of either eval with the same settings shares one key:
 *   <dest>[-partial][-reserved]   e.g. D2-partial: Clerk settings D2, --allow-partial;
 *                                 -reserved adds --reserve-unverified
 *
 *   pnpm eval:setup:golden              every settings combination any import/migration set uses × provider
 *   pnpm eval:setup:golden -p auth0     one provider
 *   pnpm eval:setup:golden --native     the native exports (native-exports.ts), for the imports-native sets
 *
 * On one Clerk target claimed from the pool, per settings × provider: empty it → those Clerk settings →
 * `clerk migrate import --yes` (with --allow-partial and --reserve-unverified when they say so) →
 * read every user back, check each password signs in → undo.
 *
 * Writes data/provider-exports/golden/<settings>/<provider>.expected.json in the
 * same shape as the custom-source answer keys, so lib/grade.ts grades an
 * agent's import against it unchanged. Users the import rejected become
 * `skip` entries: they must not be in Clerk. Each key records the CLI build
 * it came from. Imports and migrations build a provider's keys when one is
 * missing, and offer to rebuild them once the CLI or the export moves on (prepare.ts).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { User } from "@clerk/backend";
import { flag, value } from "../lib/args";
import { rowIdentifiers, sourceIdOf } from "../lib/identifiers";
import { clerkRun, cliVersion } from "../lib/clerk-run";
import { claimTarget, targetArgs } from "../lib/targets";
import { deleteAllUsers } from "../lib/clerk-source";
import { DESTS, withBaseline, type DestId } from "../lib/clerk-dest";
import type { AnswerKey, Expected } from "../generate-custom-exports";
import { listSets, loadSet, setsDir, type AnswerSet } from "./answers";
import { loadConfig } from "./config";
import { firebaseHashEnv, nativeFile, nativeRows, NATIVE_EXPORTS } from "./native-exports";
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
export const settingsOf = (set: AnswerSet) =>
  `${set.meta.dest}${set.meta.allowPartial ? "-partial" : ""}${set.meta.reserveUnverified ? "-reserved" : ""}`;
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
  const combos = new Map<string, { dest: DestId; allowPartial: boolean; reserveUnverified: boolean; usedBy: string[] }>();
  const native = flag("native");
  for (const kind of native ? (["imports-native"] as const) : (["imports", "migrations"] as const)) {
    for (const name of listSets(setsDir(kind))) {
      const set = loadSet(name, setsDir(kind));
      const key = settingsOf(set);
      const c = combos.get(key) ?? {
        dest: set.meta.dest as DestId, allowPartial: Boolean(set.meta.allowPartial), reserveUnverified: Boolean(set.meta.reserveUnverified), usedBy: [],
      };
      c.usedBy.push(`${kind}/${name}`);
      combos.set(key, c);
    }
  }
  const only = value("provider");
  // A native export has no envelope to name its source, and Firebase's hash parameters come from the console:
  // both are passed as a customer would.
  const inputs = native
    ? Object.entries(NATIVE_EXPORTS).filter(([id, e]) => !only || only === id || only === e.provider).map(([id, e]) => ({
        key: `native/${id}`, provider: e.provider, file: nativeFile(id), make: `pnpm eval:setup:native-exports -p ${e.provider}`,
        args: ["--source", e.provider], env: () => (e.provider === "firebase" ? firebaseHashEnv() : {}), rows: () => nativeRows(id),
      }))
    : (only ? [only] : Object.keys(PROVIDER_EXPORTS)).map((p) => ({
        key: p, provider: p, file: exportFile(p), make: `pnpm eval:setup:provider-exports -p ${p}`,
        args: [] as string[], env: () => ({}), rows: () => JSON.parse(readFileSync(exportFile(p), "utf8")).users as Record<string, unknown>[],
      }));
  const seedPassword = JSON.parse(readFileSync("data/users-eval.json", "utf8")).seedPassword as string;
  const work = mkdtempSync(join(tmpdir(), "eval-golden-"));
  // Any pool target will do: golden keys depend on the Clerk settings, which the build sets.
  const { target: t, release } = await claimTarget("eval:setup:golden");
  const clerk = clerkRun({ cli: cfg.cli, secretKey: t.secretKey, log: join(work, "clerk.log") });
  const target = targetArgs(t);
  const patch = (body: object) => clerk.patchConfig(target, body);
  const version = cliVersion(cfg.cli);
  console.log(`CLI ${version} · Clerk target ${t.name} · log ${join(work, "clerk.log")}`);
  if (await clerk.settledCount()) await deleteAllUsers(clerk.clerk);
  let failed = 0;
  try {
    for (const [settings, { dest, allowPartial, reserveUnverified, usedBy }] of combos) {
      if (!DESTS[dest]) throw new Error(`${usedBy.join(", ")}: dest "${dest}" is not one of ${Object.keys(DESTS).join(" ")}`);
      console.log(`${settings} (used by ${usedBy.join(", ")})`);
      await patch(withBaseline(DESTS[dest]));
      for (const { key: name, provider, file, make, args, env, rows: readRows } of inputs) {
        const label = `${settings.padEnd(11)} ${name.padEnd(12)}`;
        if (!existsSync(file)) {
          console.log(`✗ ${label} no export: run ${make}`);
          failed++;
          continue;
        }
        const runs = join(work, `${settings}-${name.replace("/", "-")}`);
        let importRun: string | undefined;
        try {
          const existing = await clerk.settledCount();
          if (existing) throw new Error(`instance ${t.name}: ${t.app} ${t.instance} already has ${existing} users: run pnpm teardown`);
          const imp = await clerk.cli([
            "migrate", "import", file, "--yes", "--json", ...(allowPartial ? ["--allow-partial"] : []),
            ...(reserveUnverified ? ["--reserve-unverified"] : []), ...args, ...target, "--runs-dir", runs,
          ], env());
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
          // A 5xx is Clerk having a bad moment, not an outcome the key should expect: build this key again.
          const flaky = [...lines].filter(([, l]) => /"status":\s*5\d\d\b|\b5\d\d\b.*(gateway|server error|unavailable|timeout)/i.test(l.error ?? ""));
          if (flaky.length) throw new Error(`server error for ${flaky.map(([id]) => id).join(", ")}; run it again`);
          const rows = new Map(readRows().map((r) => [sourceIdOf(r), r]));
          const key: GoldenKey = {
            source: provider,
            seedPassword,
            metadataPlacement: "strict",
            settings,
            dest,
            allowPartial,
            reserveUnverified,
            cliVersion: version,
            exportSha: sha256(file),
            createdAt: new Date().toISOString(),
            users: [
              ...users.map((u) => toExpected(u, !bad.has(u.id))),
              ...[...lines].filter(([, l]) => l.status !== "created").map(([id, l]) => skipped(id, l.reason ?? l.error ?? l.status, rowIdentifiers(rows.get(id)))),
            ],
          };
          mkdirSync(dirname(goldenFile(settings, name)), { recursive: true });
          writeFileSync(goldenFile(settings, name), JSON.stringify(key, null, 2) + "\n");
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
