/**
 * Generates a seed-user file — the single source of users for every provider.
 *
 * Every provider seeder reads one of these files and maps it onto its own API.
 * Nothing here is provider-specific: no GitHub linkage, no Clerk subaddressing,
 * no Auth0 hashes. Those transformations happen in the individual seeders.
 *
 * Deterministic: same seed and same count in, same users out. Re-run freely.
 *
 * Run: pnpm generate:users          ->    500 users, data/users.json
 *      pnpm generate:users:10k      -> 10,000 users, data/users-10k.json
 *      tsx scripts/generate-users.ts -c 2000 -o data/users-2k.json
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { faker } from "@faker-js/faker";
import { isValidPhoneNumber, parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js/max";
import { value } from "./lib/args";

export const SEED_PASSWORD = "Kk4aPMeiaRpAs2OeX1NE";

const TOTAL = Number(value("count") ?? 500);
const OUT = value("out") ?? (TOTAL === 500 ? "data/users.json" : `data/users-${TOTAL}.json`);
assert.ok(Number.isInteger(TOTAL) && TOTAL > 0, "--count must be a positive integer");

/**
 * The mix, as ratios rather than counts, so any --count keeps the same shape.
 * At the default 500 these land on the original 300/75/125/150/150/20.
 */
const RATIO = {
  emailOnly: 0.6,
  phoneOnly: 0.15,
  both: 0.25,
  withUsername: 0.3,
  withName: 0.3,
  /** Share of the phone holders that get a European number. */
  european: 0.1,
};

const round = (r: number) => Math.round(TOTAL * r);
const EMAIL_ONLY = round(RATIO.emailOnly);
const PHONE_ONLY = round(RATIO.phoneOnly);
const BOTH = TOTAL - EMAIL_ONLY - PHONE_ONLY; // absorbs the rounding
const WITH_USERNAME = round(RATIO.withUsername);
const WITH_NAME = round(RATIO.withName);
const EUROPEAN_PHONES = Math.round((PHONE_ONLY + BOTH) * RATIO.european);

/**
 * North American numbers use a real area code with the 555-01XX line range,
 * which NANPA reserves for fiction. That keeps them valid E.164 while making
 * every one of them usable as a Clerk test number (code 424242, no SMS sent).
 * Canadian area codes are deliberately over-represented.
 *
 * The reserved range is exactly 100 numbers per area code (555-0100..555-0199),
 * so the list length is the hard ceiling on how many North American numbers can
 * exist: 74 codes = 7,400. A 10,000-user file needs 3,600 of them. Widening the
 * line range instead would start minting numbers that belong to real people.
 */
const CORE_AREA_CODES = [
  "416", "647", "437", "905", // Toronto / GTA
  "604", "778", // Vancouver
  "514", "438", // Montreal
  "212", "646", "718", // New York
  "415", "628", // San Francisco
  "312", "773", // Chicago
];

/** Used only when CORE_AREA_CODES cannot cover the requested count. */
const EXTRA_AREA_CODES = [
  // Canada
  "289", "365", // Toronto / GTA
  "236", "672", "250", // British Columbia
  "450", "579", // Montreal
  "613", "343", "819", "873", // Ottawa / Quebec
  "519", "226", "548", "705", "249", "807", // Ontario
  "403", "587", "825", "780", "368", // Alberta
  "306", "639", "204", "431", // Prairies
  "902", "782", "709", "867", // Atlantic / Territories
  // United States
  "917", "347", // New York
  "510", "341", "650", "408", "669", // Bay Area
  "872", // Chicago
  "213", "323", "310", "424", "818", "747", // Los Angeles
  "206", "253", "425", // Seattle
  "617", "857", "781", // Boston
  "512", "737", "214", "469", "713", "281", // Texas
  "305", "786", "954", // Florida
];

const naNeeded = PHONE_ONLY + BOTH - EUROPEAN_PHONES;
/**
 * Stay on the original 15 codes whenever they comfortably cover the count, so a
 * small file regenerates byte-identical to the one already seeded into every
 * provider. Only a large --count reaches for the wider list.
 */
const AREA_CODES =
  naNeeded * 1.2 <= CORE_AREA_CODES.length * 100
    ? CORE_AREA_CODES
    : [...CORE_AREA_CODES, ...EXTRA_AREA_CODES];

assert.ok(
  AREA_CODES.length * 100 >= naNeeded * 1.2,
  `--count ${TOTAL} needs ${naNeeded} North American numbers but only ` +
    `${AREA_CODES.length * 100} exist (${AREA_CODES.length} area codes x the ` +
    `100-number 555-01XX range). Add more codes to EXTRA_AREA_CODES.`,
);

/**
 * National mobile shapes. A shape is only a starting point: some of its ranges
 * are unassigned, so every candidate is checked with libphonenumber (the data
 * Clerk validates against) and redrawn until it passes. UK has no fictional
 * range that validates — Ofcom's drama range 07700 900xxx is rejected — so it
 * draws from real mobile ranges. Nothing here ever sends an SMS.
 */
const EUROPEAN_FORMATS: { cc: string; country: CountryCode; build: () => string }[] = [
  { cc: "+44", country: "GB", build: () => `7${d(9)}` }, // United Kingdom
  { cc: "+49", country: "DE", build: () => `151${d(8)}` }, // Germany
  { cc: "+33", country: "FR", build: () => `6${d(8)}` }, // France
  { cc: "+34", country: "ES", build: () => `6${d(8)}` }, // Spain
  { cc: "+39", country: "IT", build: () => `3${d(9)}` }, // Italy
  { cc: "+31", country: "NL", build: () => `6${d(8)}` }, // Netherlands
  // Sweden: only the standard mobile prefixes. libphonenumber-js also accepts
  // 074/075/077/078, but Clerk rejected +46787512503 as not E.164.
  { cc: "+46", country: "SE", build: () => `7${faker.helpers.arrayElement(["0", "2", "3", "6", "9"])}${d(7)}` }, // Sweden
  { cc: "+353", country: "IE", build: () => `8${faker.helpers.arrayElement(["3","5","6","7","9"])}${d(7)}` }, // Ireland
];

const d = (n: number) =>
  Array.from({ length: n }, () => faker.number.int({ min: 0, max: 9 })).join("");

type Group = "email-only" | "phone-only" | "both";

export type SeedUser = {
  id: string;
  group: Group;
  email: string | null;
  phone: string | null;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  hasPassword: boolean;
  emailVerified: boolean;
  phoneVerified: boolean;
};

/**
 * Splits `total` across groups in proportion to their size, with the leftover
 * from rounding going to the groups with the largest fractional part. Keeps the
 * sum exact — plain rounding would drift.
 */
function proportional(sizes: number[], total: number): number[] {
  const population = sizes.reduce((a, b) => a + b, 0);
  const exact = sizes.map((s) => (s / population) * total);
  const out = exact.map(Math.floor);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  let leftover = total - out.reduce((a, b) => a + b, 0);
  for (const { i } of order) {
    if (leftover-- <= 0) break;
    out[i]++;
  }
  return out;
}

function main() {
  faker.seed(20260902);

  const groups: Group[] = [
    ...Array<Group>(EMAIL_ONLY).fill("email-only"),
    ...Array<Group>(PHONE_ONLY).fill("phone-only"),
    ...Array<Group>(BOTH).fill("both"),
  ];

  // Usernames and names are spread proportionally across the three groups and
  // are independent of each other, so a user can have either, both or neither.
  const groupOrder: Group[] = ["email-only", "phone-only", "both"];
  const sizes = [EMAIL_ONLY, PHONE_ONLY, BOTH];
  const usernameQuota = proportional(sizes, WITH_USERNAME);
  const nameQuota = proportional(sizes, WITH_NAME);

  const perGroup = Object.fromEntries(
    groupOrder.map((g, i) => [g, { seen: 0, username: usernameQuota[i], name: nameQuota[i] }]),
  ) as Record<Group, { seen: number; username: number; name: number }>;

  const emails = new Set<string>();
  const phones = new Set<string>();
  const usernames = new Set<string>();

  const uniq = (set: Set<string>, make: (attempt: number) => string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const v = make(attempt);
      if (set.has(v)) continue;
      set.add(v);
      return v;
    }
    throw new Error("exhausted the pool trying to generate a unique value");
  };

  // Which phone-holders get a European number. Chosen up front so they are
  // spread across phone-only and both, not clustered at one end.
  const phoneHolders = groups
    .map((g, i) => (g === "email-only" ? -1 : i))
    .filter((i) => i >= 0);
  const european = new Set(faker.helpers.arrayElements(phoneHolders, EUROPEAN_PHONES));
  let europeanSeen = 0;

  const users: SeedUser[] = groups.map((group, i) => {
    const quota = perGroup[group];
    // Deterministic interleave: hand out the quota to a spread of the group's
    // members rather than the first N, so it is not front-loaded.
    const slot = quota.seen++;
    const groupSize = sizes[groupOrder.indexOf(group)];
    const wantsUsername = Math.floor((slot * quota.username) / groupSize) <
      Math.floor(((slot + 1) * quota.username) / groupSize);
    const nameSlot = (slot + Math.floor(groupSize / 2)) % groupSize;
    const wantsName = Math.floor((nameSlot * quota.name) / groupSize) <
      Math.floor(((nameSlot + 1) * quota.name) / groupSize);

    const first = faker.person.firstName();
    const last = faker.person.lastName();

    const email =
      group === "phone-only"
        ? null
        : uniq(emails, () => `${first}.${last}${i + 1}@example.com`.toLowerCase());

    const phone =
      group === "email-only"
        ? null
        : european.has(i)
          ? uniq(phones, () => {
              // Round-robin, so even the 500-user file carries every country.
              const f = EUROPEAN_FORMATS[europeanSeen++ % EUROPEAN_FORMATS.length];
              for (;;) {
                const candidate = `${f.cc}${f.build()}`;
                // The country check keeps +44 out of Jersey/Guernsey/Isle of Man.
                if (parsePhoneNumberFromString(candidate)?.country === f.country && isValidPhoneNumber(candidate))
                  return candidate;
              }
            })
          : uniq(
              phones,
              () => `+1${faker.helpers.arrayElement(AREA_CODES)}55501${d(2)}`,
            );

    return {
      id: `u${String(i + 1).padStart(Math.max(4, String(TOTAL).length), "0")}`,
      group,
      email,
      phone,
      username: wantsUsername
        ? uniq(usernames, (attempt) => {
            const base = faker.internet
              .username({ firstName: first, lastName: last })
              .toLowerCase();
            // Faker's username pool starts colliding in the thousands. Falling
            // back to the row index guarantees a unique value at any --count.
            return attempt < 20
              ? base.slice(0, 30)
              : `${base.slice(0, 24)}${i + 1}`;
          })
        : null,
      firstName: wantsName ? first : null,
      lastName: wantsName ? last : null,
      fullName: wantsName ? `${first} ${last}` : null,
      // Only users with an email can hold a password — there is nothing to
      // verify a password against for a phone-only account.
      hasPassword: email !== null,
      emailVerified: email !== null,
      phoneVerified: phone !== null,
    };
  });

  check(users);

  mkdirSync("data", { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify({ seedPassword: SEED_PASSWORD, count: users.length, users }, null, 2) + "\n",
  );

  const naPhones = users.filter((u) => u.phone?.startsWith("+1")).length;
  console.log(`Wrote ${OUT} — ${users.length} users`);
  console.table({
    "email only": users.filter((u) => u.group === "email-only").length,
    "phone only": users.filter((u) => u.group === "phone-only").length,
    "email + phone": users.filter((u) => u.group === "both").length,
    "with username": users.filter((u) => u.username).length,
    "with name": users.filter((u) => u.fullName).length,
    "with password": users.filter((u) => u.hasPassword).length,
    "phones: North American": naPhones,
    "phones: European": users.filter((u) => u.phone && !u.phone.startsWith("+1")).length,
  });
}

/** The runnable check for all of the above. Fails loudly if a ratio drifts. */
function check(users: SeedUser[]) {
  const by = (g: Group) => users.filter((u) => u.group === g);
  const phones = users.filter((u) => u.phone).map((u) => u.phone!);

  assert.equal(users.length, TOTAL);
  assert.equal(by("email-only").length, EMAIL_ONLY);
  assert.equal(by("phone-only").length, PHONE_ONLY);
  assert.equal(by("both").length, BOTH);

  assert.equal(users.filter((u) => u.username).length, WITH_USERNAME);
  assert.equal(users.filter((u) => u.fullName).length, WITH_NAME);
  assert.equal(users.filter((u) => u.hasPassword).length, EMAIL_ONLY + BOTH);

  // Every group contributes some usernames and some names, per the brief.
  for (const g of ["email-only", "phone-only", "both"] as Group[]) {
    assert.ok(by(g).some((u) => u.username), `no usernames in ${g}`);
    assert.ok(by(g).some((u) => u.fullName), `no names in ${g}`);
  }

  assert.equal(phones.length, PHONE_ONLY + BOTH);
  assert.equal(phones.filter((p) => !p.startsWith("+1")).length, EUROPEAN_PHONES);

  // Uniqueness — a duplicate email or phone breaks every seeder downstream.
  const emails = users.filter((u) => u.email).map((u) => u.email!);
  assert.equal(new Set(emails).size, emails.length, "duplicate email");
  assert.equal(new Set(phones).size, phones.length, "duplicate phone");
  const usernames = users.filter((u) => u.username).map((u) => u.username!);
  assert.equal(new Set(usernames).size, usernames.length, "duplicate username");

  // E.164: leading +, 8-15 digits, no separators. Providers reject anything else.
  for (const p of phones) assert.match(p, /^\+[1-9]\d{7,14}$/, `not E.164: ${p}`);
  // Shape is not enough: Clerk rejects numbers in unassigned ranges too.
  for (const p of phones) assert.ok(isValidPhoneNumber(p), `not a valid number: ${p}`);
  // Exactly the eight European countries the Clerk instances allow, each present.
  const countries = new Set(
    phones.filter((p) => !p.startsWith("+1")).map((p) => parsePhoneNumberFromString(p)?.country),
  );
  assert.deepEqual([...countries].sort(), EUROPEAN_FORMATS.map((f) => f.country).sort());
  // North American numbers must sit in the fictional 555-01XX line range so
  // they are safe to use as Clerk test numbers.
  for (const p of phones.filter((x) => x.startsWith("+1")))
    assert.match(p, /^\+1\d{3}55501\d{2}$/, `not a 555-01XX number: ${p}`);

  assert.ok(users.every((u) => u.email || u.phone), "user with neither email nor phone");
  assert.ok(
    users.every((u) => u.hasPassword === (u.email !== null)),
    "password flag disagrees with email presence",
  );
}

main();
