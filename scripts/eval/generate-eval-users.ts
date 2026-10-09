/**
 * Writes data/users-eval.json: 50 users from data/users.json with every edge
 * case the import eval needs, so one small file seeds all seven providers.
 *
 * data/users.json itself is left alone: the migration tests pick users from it
 * by group and position, and its users carry no edge-case fields.
 *
 * Deterministic: same users.json in, same file out. Phone-only users have no
 * password, as in users.json.
 *
 * Run: pnpm eval:users
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { SeedUser } from "../lib/users";

const OUT = "data/users-eval.json";
const { seedPassword, users } = JSON.parse(readFileSync("data/users.json", "utf8")) as { seedPassword: string; users: SeedUser[] };

const chosen: SeedUser[] = [];
const has = (u: SeedUser) => chosen.some((c) => c.id === u.id);
const take = (n: number, pred: (u: SeedUser) => boolean) => {
  const got = users.filter((u) => !has(u) && pred(u)).slice(0, n);
  assert.equal(got.length, n, `only ${got.length} of ${n} users match`);
  chosen.push(...got);
};

// One phone from each European country, alternating phone-only and both.
const countries = ["+44", "+49", "+33", "+34", "+39", "+31", "+46", "+353"];
countries.forEach((cc, i) => {
  const want = i % 2 ? "both" : "phone-only";
  const pool = users.filter((u) => u.phone?.startsWith(cc) && !has(u));
  chosen.push(pool.find((u) => u.group === want) ?? pool[0]);
});
const eu = chosen.length;
const inGroup = (g: SeedUser["group"]) => chosen.filter((u) => u.group === g).length;

// users.json gives an email-only user a username and a name, or neither; 5 of
// these lose the username below, for name-only users.
take(15, (u) => u.group === "email-only" && !!u.username);
take(10, (u) => u.group === "email-only" && !u.username);
take(8 - inGroup("phone-only"), (u) => u.group === "phone-only" && u.phone!.startsWith("+1"));
take(5, (u) => u.group === "both" && !!u.username && u.phone!.startsWith("+1"));
take(5, (u) => u.group === "both" && !u.username && !!u.firstName && u.phone!.startsWith("+1"));
take(17 - inGroup("both"), (u) => u.group === "both" && !u.username && !u.firstName && u.phone!.startsWith("+1"));
assert.equal(chosen.length, 50);

// ── edge cases, each on its own users ──
const out = chosen.map((u) => ({ ...u }));
out.filter((u) => u.group === "email-only" && u.username).slice(10).forEach((u) => (u.username = null));
const used = new Set<string>();
const mark = (n: number, pred: (u: SeedUser) => boolean, apply: (u: SeedUser, i: number) => void) => {
  const got = out.filter((u) => !used.has(u.id) && pred(u)).slice(0, n);
  assert.equal(got.length, n, `only ${got.length} of ${n} users for an edge case`);
  got.forEach((u, i) => {
    used.add(u.id);
    apply(u, i);
  });
};
const emailOnly = (u: SeedUser) => u.group === "email-only";
const both = (u: SeedUser) => u.group === "both";

mark(3, emailOnly, (u) => (u.banned = true));
mark(2, emailOnly, (u) => (u.deleted = true));
mark(2, emailOnly, (u) => (u.emailVerified = false));
mark(2, both, (u) => (u.emailVerified = false));
mark(2, both, (u) => (u.phoneVerified = false));
mark(4, emailOnly, (u) => (u.hasPassword = false));
mark(2, both, (u) => (u.hasPassword = false));
mark(5, (u) => u.hasPassword && !!u.email, (u, i) => (u.passwordFormat = i < 3 ? "argon2id" : "bcrypt"));

// Metadata goes on top of the other cases: it can sit on any user.
const METADATA: NonNullable<SeedUser["metadata"]>[] = [
  { user: { theme: "dark", onboarding: true } },
  { app: { plan: "enterprise", crm_id: "hs_40213" } },
  { public: { tier: "gold" } },
  { user: { theme: "light" }, app: { plan: "team", seats: 12 }, public: { tier: "silver", badge: "early" } },
];
out.filter((_, i) => i % 3 === 1).slice(0, 15).forEach((u, i) => (u.metadata = METADATA[i % METADATA.length]));

writeFileSync(OUT, JSON.stringify({ seedPassword, count: out.length, users: out }, null, 2) + "\n");

const n = (pred: (u: SeedUser) => boolean) => out.filter(pred).length;
console.log(`${OUT}: ${out.length} users`);
console.log(`  groups      email-only ${n(emailOnly)} · phone-only ${n((u) => u.group === "phone-only")} · both ${n(both)}`);
console.log(`  phones      ${eu} European (${countries.join(" ")}), ${n((u) => !!u.phone?.startsWith("+1"))} North American`);
console.log(`  usernames ${n((u) => !!u.username)} · names ${n((u) => !!u.firstName)} · metadata ${n((u) => !!u.metadata)}`);
console.log(`  banned ${n((u) => !!u.banned)} · deleted ${n((u) => !!u.deleted)} · unverified email ${n((u) => !!u.email && !u.emailVerified)} · unverified phone ${n((u) => !!u.phone && !u.phoneVerified)}`);
console.log(`  no password ${n((u) => !u.hasPassword)} · argon2id ${n((u) => u.passwordFormat === "argon2id")} · bcrypt ${n((u) => u.passwordFormat === "bcrypt")}`);
