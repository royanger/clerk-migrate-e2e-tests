/**
 * Seeds a WorkOS environment from data/users.json.
 *
 * There is no bulk import endpoint, so this is one POST /user_management/users
 * per user through the shared worker pool. The SDK already retries 429s with
 * backoff and honours Retry-After, and the pool retries on top of that.
 *
 * WorkOS User Management has no phone or username identifier — email is the
 * only one. Phone-only users therefore get the same <digits>@phone.local
 * placeholder the other apps use, and both the real number and the username
 * ride along in `metadata` so the migration data is still there.
 *
 * The migration-test variations (scripts/variations/workos.ts) also use:
 *   - `metadata.user` — replaces the default metadata outright (seed_id, phone,
 *     username), so a variation can seed empty or at-the-limit metadata.
 *     WorkOS metadata is string → string, at most 10 keys.
 *   - `sourceId` — the WorkOS `external_id` (default: the seed id).
 *   - `orgs` — memberships, in organizations named as given (created once).
 *   - `mfa` — a TOTP factor enrolled after the user exists.
 *
 * Not idempotent: a second run reports every user as email_not_available.
 * Clear the environment's users first, or seed once.
 *
 * Run: pnpm seed:workos
 */
import bcrypt from "bcryptjs";
import { WorkOS } from "@workos-inc/node";
import {
  loadUsers,
  placeholderEmail,
  pool,
  progressBar,
  reportFailures,
  type SeedUser,
} from "./lib/users";

const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
  clientId: process.env.WORKOS_CLIENT_ID,
});
const { seedPassword, users } = loadUsers();

/*
 * Every user shares one password, so one bcrypt hash is computed and reused.
 * Per-user salting would cost 425 rounds of bcrypt to protect a password that
 * is written in the README. $2b$ with 10 rounds is what WorkOS expects for
 * passwordHashType: "bcrypt".
 */
const passwordHash = await bcrypt.hash(seedPassword, 10);

/** WorkOS metadata values are strings; anything else is stored as JSON. */
const stringify = (record: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
  );

/** Organizations by name, created on first use; concurrent workers share the promise. */
const orgs = new Map<string, Promise<string>>();
const orgId = (name: string) => {
  if (!orgs.has(name))
    orgs.set(name, workos.organizations.createOrganization({ name }).then((o) => o.id));
  return orgs.get(name)!;
};

async function createUser(u: SeedUser) {
  const user = await workos.userManagement.createUser({
    email: u.email ?? placeholderEmail(u.phone!),
    emailVerified: u.emailVerified,
    externalId: u.sourceId ?? u.id,
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    ...(u.hasPassword ? { passwordHash, passwordHashType: "bcrypt" as const } : {}),
    metadata: u.metadata?.user
      ? stringify(u.metadata.user)
      : {
          seed_id: u.id,
          ...(u.phone ? { phone: u.phone } : {}),
          ...(u.username ? { username: u.username } : {}),
        },
  });

  for (const org of u.orgs ?? []) {
    const membership = { organizationId: await orgId(org.name), userId: user.id };
    // ponytail: an environment without the named role falls back to the
    // default one rather than failing the user; the export ignores roles anyway.
    await workos.userManagement
      .createOrganizationMembership({ ...membership, ...(org.role ? { roleSlug: org.role } : {}) })
      .catch((e) => {
        if (!org.role) throw e;
        return workos.userManagement.createOrganizationMembership(membership);
      });
  }

  if (u.mfa) await workos.multiFactorAuth.createUserAuthFactor({ userId: user.id, type: "totp" });
}

console.log(`Seeding ${users.length} users into WorkOS…`);

const failures = await pool(users, 4, createUser, progressBar("created"));
reportFailures(failures);

console.log(`\nSeed password: ${seedPassword}`);
console.log("Phone-only users were imported as <digits>@phone.local.");
console.log("Phone numbers and usernames are in user metadata — WorkOS has no identifier for either.");
