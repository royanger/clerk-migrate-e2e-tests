/**
 * Generates exports from four made-up auth providers, for testing a skill that
 * writes `clerk migrate` custom sources. Each provider is further from Clerk's
 * shape than the last:
 *
 *   keyhole   ~10–15%  flat, near-Clerk field names
 *   passly    ~30%     wrapped JSON, renamed fields, display name only, status string
 *   gatekeep  ~50–60%  nested identities[], national-format phones + region, one mixed metadata blob
 *   vaultrun  ~70%     one `login` column of mixed kinds, bitmask flags, packed strings
 *
 * Two more are a holdout: never tune the skill's wording or examples on them,
 * so their grades show whether it generalises rather than whether it names
 * the trap.
 *
 *   frostline ~45%     status strings, national phones + country_iso, passlib and $2y$ hashes, state words + frozen_until
 *   nimbus    ~70%     packed contacts, 00/+ phones, {SSHA} and unsupported $6$ hashes, letter states, querystring props
 *
 * Each provider gets a JSON and a CSV export of the same 50 users, plus an
 * answer key (what each user should become in Clerk) that the skill must never
 * see:
 *
 *   data/custom-sources/<name>.{json,csv}                 what the skill reads
 *   data/custom-sources-answers/<name>.expected.json      what test:custom grades against
 *
 * Every password is a real hash of SEED_PASSWORD, so test:custom can check each
 * one signs in. The exception is nimbus's `$6$` (sha512-crypt), which Clerk
 * can't import: those are random, and the answer key expects no password. The users are deterministic per provider; the hashes are not
 * (bcrypt and argon2 salt themselves), which no check depends on.
 *
 * Run: pnpm generate:custom
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, pbkdf2Sync } from "node:crypto";
import bcrypt from "bcryptjs";
import { faker } from "@faker-js/faker";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { EUROPEAN_FORMATS, europeanNumber } from "./lib/phones";

/** The password every seeded user has. Read, not imported: generate-users.ts runs on import. */
const SEED_PASSWORD: string = JSON.parse(readFileSync("data/users.json", "utf8")).seedPassword;

const OUT = "data/custom-sources";
const ANSWERS = "data/custom-sources-answers";
const COUNT = 50;

// ── the canonical user, before any provider shapes it ──

type Hasher = "bcrypt" | "argon2id" | "pbkdf2" | "passlib" | "ssha" | "sha512crypt";
type Canon = {
  n: number;
  /** Primary first. */
  emails: { value: string; verified: boolean }[];
  phone?: { e164: string; country: string; verified: boolean };
  username?: string;
  firstName?: string;
  lastName?: string;
  hasher?: Hasher;
  banned: boolean;
  deleted: boolean;
  createdAt: Date;
  /** Where the reference source puts each key. */
  meta: { public: Record<string, unknown>; private: Record<string, unknown>; unsafe: Record<string, unknown> };
};

/** What one user should become in Clerk. Absent = must be absent in Clerk too. */
export type Expected = {
  externalId: string;
  /** Rejected by the source (soft-deleted): must not be in Clerk. */
  skip?: string;
  /** A skipped user's emails, phones and username, for matching it by identifier. */
  identifiers?: string[];
  primaryEmail?: string;
  emails: string[];
  unverifiedEmails: string[];
  primaryPhone?: string;
  phones: string[];
  unverifiedPhones: string[];
  username?: string;
  firstName?: string;
  lastName?: string;
  banned: boolean;
  hasPassword: boolean;
  publicMetadata: Record<string, unknown>;
  privateMetadata: Record<string, unknown>;
  unsafeMetadata: Record<string, unknown>;
};

export type AnswerKey = {
  source: string;
  seedPassword: string;
  /**
   * strict: each metadata key must land in the field named here.
   * advisory: the export does not say where a key belongs, so any metadata
   *   field counts; a different one than the reference source's is a note.
   */
  metadataPlacement: "strict" | "advisory";
  /** Private keys graded even when placement is advisory or lenient: billing and CRM IDs, internal notes. */
  sensitive?: string[];
  users: Expected[];
};

/**
 * Phones come from the same countries as data/users.json: the first 8 holders
 * get one number each from EUROPEAN_FORMATS (GB DE FR ES IT NL SE IE), the rest
 * North American. Those are the countries the Clerk instances accept.
 *
 * North American area codes; with 555-01XX every number is a Clerk test number.
 */
const AREA_CODES = ["416", "647", "437", "905", "604", "778", "514", "438", "212", "646", "718", "415", "628", "312", "773"];
const CANADIAN = new Set(["416", "647", "437", "905", "604", "778", "514", "438"]);

/**
 * The 50-user mix. Shuffled per provider so the groups are not contiguous.
 * Every user with an unverified email or phone also holds a verified
 * identifier, so nobody's only way in is unconfirmed.
 */
type Group = "email+pw" | "email" | "phone" | "phone+pw" | "email+phone+pw" | "username+pw" | "email+username";
const MIX: [Group, number][] = [
  ["email+pw", 15],
  ["email", 8],
  ["phone", 4],
  ["phone+pw", 4],
  ["email+phone+pw", 10],
  ["username+pw", 3],
  ["email+username", 6],
];

function northOrEurope(p: number, seed: number) {
  const f = EUROPEAN_FORMATS[p];
  if (f) return { e164: europeanNumber(f), country: f.country as string };
  const n = p - EUROPEAN_FORMATS.length;
  const area = AREA_CODES[n % AREA_CODES.length];
  return { e164: `+1${area}5550${100 + (seed % 50) + Math.floor(n / AREA_CODES.length)}`, country: CANADIAN.has(area) ? "CA" : "US" };
}

/** "+44 7911 123456". */
const international = (e164: string) => parsePhoneNumberFromString(e164)!.formatInternational();
/** "07911 123456": what a user types at home; needs the country to read back. */
const national = (e164: string) => parsePhoneNumberFromString(e164)!.formatNational();

type Options = {
  seed: number;
  /** Hasher for the i-th password holder. */
  hasher: (i: number) => Hasher;
  /** Users who get a second email; `verified` says whether it is confirmed. */
  extraEmails?: boolean[];
  deleted?: number;
  /** Which metadata keys a user can carry, by Clerk field. */
  meta: { public?: () => Record<string, unknown>; private?: () => Record<string, unknown>; unsafe?: () => Record<string, unknown> };
};

function canon(o: Options): Canon[] {
  faker.seed(o.seed);
  const groups = faker.helpers.shuffle(MIX.flatMap(([g, k]) => Array<Group>(k).fill(g)));
  const usernames = new Set<string>();
  let phones = 0;
  let passwords = 0;

  const users = groups.map((g, i): Canon => {
    const first = faker.person.firstName().replace(/\s.*/, "");
    const last = faker.person.lastName();
    const hasEmail = g.startsWith("email");
    const hasPhone = g.includes("phone");
    const hasUsername = g.includes("username") || (g === "email+phone+pw" && i % 3 === 0);
    const hasPassword = g.endsWith("+pw") || (g === "email+username" && i % 3 !== 0);
    const named = hasUsername || faker.datatype.boolean();
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

    let username: string | undefined;
    while (hasUsername && !username) {
      const u = faker.internet.username({ firstName: first, lastName: last }).toLowerCase().replace(/[^a-z0-9_.]/g, "");
      if (u.length >= 4 && /[a-z]/.test(u) && !usernames.has(u)) usernames.add((username = u));
    }

    const p = hasPhone ? phones++ : 0;
    const emailVerified = !(g === "email+phone+pw" && i % 4 === 1);
    return {
      n: i,
      emails: hasEmail ? [{ value: `${slug(first)}.${slug(last)}${i + 1}@example.com`, verified: emailVerified }] : [],
      phone: hasPhone
        ? {
            ...northOrEurope(p, o.seed),
            // Unverified only when a verified email is there to sign in with.
            verified: !(g === "email+phone+pw" && emailVerified && i % 4 === 2),
          }
        : undefined,
      username,
      firstName: named ? first : undefined,
      lastName: named && faker.datatype.boolean({ probability: 0.85 }) ? last : undefined,
      hasher: hasPassword ? o.hasher(passwords++) : undefined,
      banned: false,
      deleted: false,
      createdAt: faker.date.between({ from: "2021-01-01", to: "2026-06-30" }),
      meta: {
        public: faker.datatype.boolean({ probability: 0.6 }) && o.meta.public ? o.meta.public() : {},
        private: faker.datatype.boolean({ probability: 0.5 }) && o.meta.private ? o.meta.private() : {},
        unsafe: faker.datatype.boolean({ probability: 0.4 }) && o.meta.unsafe ? o.meta.unsafe() : {},
      },
    };
  });

  // Bans, extra emails and deletions go to email + password users, so each
  // edge case lands on an otherwise ordinary account.
  const plain = users.filter((u) => u.emails.length && u.hasher && !u.phone && !u.username);
  plain.slice(0, 3).forEach((u) => (u.banned = true));
  (o.extraEmails ?? []).forEach((verified, k) => {
    const u = plain[3 + k];
    u.emails.push({ value: `${u.emails[0].value.split("@")[0]}.alt@example.org`, verified });
  });
  if (o.deleted) plain.slice(-o.deleted).forEach((u) => (u.deleted = true));
  return users;
}

// ── hashes of SEED_PASSWORD ──

const salt = () => faker.string.alphanumeric(16);
const PBKDF2_ROUNDS = 100_000;
const pbkdf2 = (s: string) => pbkdf2Sync(SEED_PASSWORD, s, PBKDF2_ROUNDS, 32, "sha256").toString("base64");

/** Node 22 has no argon2; Bun does, and the CLI already needs Bun. */
function argon2Pool(count: number): string[] {
  const script = `const o=[];for(let i=0;i<${count};i++)o.push(await Bun.password.hash(process.env.PW,{algorithm:"argon2id"}));console.log(JSON.stringify(o))`;
  return JSON.parse(execFileSync("bun", ["-e", script], { env: { ...process.env, PW: SEED_PASSWORD }, encoding: "utf8" }));
}
const ARGON2 = argon2Pool(COUNT * 2);
const argon2 = () => ARGON2.pop()!;
const bcryptHash = () => bcrypt.hashSync(SEED_PASSWORD, 10);
/** passlib's pbkdf2_sha256: `$pbkdf2-sha256$<rounds>$<salt>$<key>` in passlib's base64 (`.` for `+`, no padding), salt = 16 raw bytes. */
const passlib = () => {
  const ab64 = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, ".");
  const s = Buffer.from(faker.string.hexadecimal({ length: 32, prefix: "" }), "hex");
  const rounds = 29_000;
  return `$pbkdf2-sha256$${rounds}$${ab64(s)}$${ab64(pbkdf2Sync(SEED_PASSWORD, s, rounds, 32, "sha256"))}`;
};
/** OpenLDAP's {SSHA}: base64(sha1(password + salt) + salt), 8-byte salt. */
const ssha = () => {
  const s = Buffer.from(faker.string.hexadecimal({ length: 16, prefix: "" }), "hex");
  return `{SSHA}${Buffer.concat([createHash("sha1").update(SEED_PASSWORD).update(s).digest(), s]).toString("base64")}`;
};
/** A sha512-crypt-shaped value: Clerk has no hasher for it, so the source must drop it. Not a real hash. */
const sha512crypt = () => `$6$${faker.string.alphanumeric(16)}$${faker.string.alphanumeric(86)}`;
const django = () => {
  const s = salt();
  return `pbkdf2_sha256$${PBKDF2_ROUNDS}$${s}$${pbkdf2(s)}`;
};

// ── output helpers ──

function csv(rows: Record<string, unknown>[]): string {
  const cols = [...new Set(rows.flatMap(Object.keys))];
  const cell = (v: unknown) => {
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

const orNull = (o: Record<string, unknown>) => (Object.keys(o).length ? o : null);

function expected(u: Canon, externalId: string): Expected {
  const verified = u.emails.filter((e) => e.verified).map((e) => e.value);
  return {
    externalId,
    ...(u.deleted ? { skip: "soft-deleted at the source" } : {}),
    primaryEmail: verified[0],
    emails: verified,
    unverifiedEmails: u.emails.filter((e) => !e.verified).map((e) => e.value),
    primaryPhone: u.phone?.verified ? u.phone.e164 : undefined,
    phones: u.phone?.verified ? [u.phone.e164] : [],
    unverifiedPhones: u.phone && !u.phone.verified ? [u.phone.e164] : [],
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    banned: u.banned,
    hasPassword: Boolean(u.hasher) && u.hasher !== "sha512crypt",
    publicMetadata: u.meta.public,
    privateMetadata: u.meta.private,
    unsafeMetadata: u.meta.unsafe,
  };
}

function write(name: string, placement: AnswerKey["metadataPlacement"], json: unknown, rows: Record<string, unknown>[], answers: Expected[], sensitive: string[]) {
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(json, null, 2) + "\n");
  writeFileSync(`${OUT}/${name}.csv`, csv(rows));
  const key: AnswerKey = { source: name, seedPassword: SEED_PASSWORD, metadataPlacement: placement, sensitive, users: answers };
  writeFileSync(`${ANSWERS}/${name}.expected.json`, JSON.stringify(key, null, 2) + "\n");
  const live = answers.filter((a) => !a.skip).length;
  console.log(`${name.padEnd(9)} ${answers.length} users (${live} should import) → ${OUT}/${name}.{json,csv}`);
}

const pick = <T>(xs: T[]) => faker.helpers.arrayElement(xs);
const some = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v], i) => i === 0 || faker.datatype.boolean())) as Partial<T>;

// ── 1. Keyhole: ~10–15% from Clerk ──

function keyhole() {
  const users = canon({
    seed: 1001,
    hasher: () => "bcrypt",
    meta: {
      public: () => some({ plan: pick(["free", "pro", "team"]), role: pick(["member", "admin", "viewer"]) }),
      private: () => some({ stripe_customer_id: `cus_${faker.string.alphanumeric(14)}`, signup_source: pick(["google_ads", "referral", "organic"]) }),
      unsafe: () => some({ theme: pick(["light", "dark", "system"]), onboarding_done: faker.datatype.boolean() }),
    },
  });
  const records = users.map((u) => ({
    id: `kh_${faker.string.hexadecimal({ length: 24, casing: "lower", prefix: "" })}`,
    email: u.emails[0]?.value ?? null,
    email_verified: u.emails[0]?.verified ?? false,
    phone_number: u.phone?.e164 ?? null,
    phone_verified: u.phone?.verified ?? false,
    username: u.username ?? null,
    first_name: u.firstName ?? null,
    last_name: u.lastName ?? null,
    password_hash: u.hasher ? bcryptHash() : null,
    public_metadata: u.meta.public,
    private_metadata: u.meta.private,
    unsafe_metadata: u.meta.unsafe,
    created_at: u.createdAt.toISOString(),
    banned: u.banned,
  }));
  write("keyhole", "strict", records, records, users.map((u, i) => expected(u, records[i].id)), ["stripe_customer_id"]);
}

// ── 2. Passly: ~30% ──

function passly() {
  const users = canon({
    seed: 2002,
    hasher: (i) => (i % 5 === 4 ? "argon2id" : "bcrypt"),
    extraEmails: [true, true, true],
    meta: {
      public: () => some({ timezone: faker.location.timeZone(), avatar_color: faker.color.rgb(), bio: faker.person.bio() }),
      private: () => some({ crm_id: `hs_${faker.number.int({ min: 10000, max: 99999 })}`, lifetime_value: faker.number.int({ min: 0, max: 5000 }) }),
    },
  });
  const records = users.map((u) => {
    const hash = u.hasher === "argon2id" ? argon2() : u.hasher ? bcryptHash() : null;
    return {
      uid: faker.string.uuid(),
      primaryEmail: u.emails[0]?.value ?? null,
      emailConfirmed: u.emails[0]?.verified ?? false,
      otherEmails: u.emails.slice(1).map((e) => e.value),
      mobile: u.phone ? international(u.phone.e164) : null,
      mobileConfirmed: u.phone?.verified ?? false,
      handle: u.username ?? null,
      displayName: [u.firstName, u.lastName].filter(Boolean).join(" ") || null,
      credentials: hash ? { algo: u.hasher, hash } : null,
      profile: orNull(u.meta.public),
      internal: orNull(u.meta.private),
      createdAt: Math.floor(u.createdAt.getTime() / 1000),
      status: u.banned ? "suspended" : "active",
    };
  });
  const json = { exported_at: "2026-09-30T14:02:11Z", count: records.length, users: records };
  const rows = records.map(({ credentials, otherEmails, ...r }) => ({
    ...r,
    otherEmails: otherEmails.join("|"),
    "credentials.algo": credentials?.algo,
    "credentials.hash": credentials?.hash,
  }));
  write("passly", "strict", json, rows, users.map((u, i) => expected(u, records[i].uid)), ["crm_id"]);
}

// ── 3. Gatekeep: ~50–60% ──

function gatekeep() {
  const users = canon({
    seed: 3003,
    hasher: (i) => (i % 3 === 2 ? "pbkdf2" : "argon2id"),
    extraEmails: [true, false, true, false],
    // One `attrs` blob in the export; split here only to say where the
    // reference source puts each key.
    meta: {
      public: () => some({ plan: pick(["starter", "growth", "scale"]), locale: pick(["en-CA", "en-US", "fr-CA"]), theme: pick(["light", "dark"]) }),
      private: () => some({ stripe_customer: `cus_${faker.string.alphanumeric(14)}`, internal_notes: faker.lorem.sentence(), risk: pick(["low", "medium", "high"]) }),
    },
  });
  const confirmedAt = (u: Canon, ok: boolean) =>
    ok ? faker.date.between({ from: u.createdAt, to: "2026-09-01" }).toISOString() : null;

  const records = users.map((u) => {
    const identities: Record<string, unknown>[] = u.emails.map((e, k) => ({
      kind: "email", value: e.value, confirmed_at: confirmedAt(u, e.verified), primary: k === 0,
    }));
    if (u.phone) {
      identities.push({ kind: "sms", value: national(u.phone.e164), region: u.phone.country, confirmed_at: confirmedAt(u, u.phone.verified), primary: !u.emails.length });
    }
    if (u.username) identities.push({ kind: "handle", value: u.username, confirmed_at: null, primary: !u.emails.length && !u.phone });
    let secret: Record<string, unknown> | null = null;
    if (u.hasher === "argon2id") secret = { scheme: "argon2id", digest: argon2() };
    if (u.hasher === "pbkdf2") {
      const s = salt();
      secret = { scheme: "pbkdf2-sha256", rounds: PBKDF2_ROUNDS, salt: s, digest: pbkdf2(s) };
    }
    const flags = [...(u.banned ? ["locked"] : []), ...(faker.datatype.boolean({ probability: 0.2 }) ? ["beta"] : [])];
    return {
      account_ref: `acct_${faker.string.alphanumeric({ length: 10, casing: "lower" })}`,
      // The primary is not always listed first.
      identities: faker.helpers.shuffle(identities),
      person: u.firstName || u.lastName ? { given: u.firstName ?? null, family: u.lastName ?? null } : null,
      secret,
      attrs: orNull({ ...u.meta.public, ...u.meta.private }),
      flags,
      ts_created: u.createdAt.getTime(),
    };
  });
  const json = { data: { accounts: records }, meta: { page: 1, pages: 1, total: records.length } };
  const rows = records.map((r) => {
    const row: Record<string, unknown> = { account_ref: r.account_ref };
    for (let k = 0; k < 4; k++) {
      const id = r.identities[k] as Record<string, unknown> | undefined;
      for (const f of ["kind", "value", "region", "confirmed_at", "primary"]) row[`id${k + 1}_${f}`] = id?.[f];
    }
    Object.assign(row, {
      person_given: r.person?.given,
      person_family: r.person?.family,
      secret_scheme: r.secret?.scheme,
      secret_rounds: r.secret?.rounds,
      secret_salt: r.secret?.salt,
      secret_digest: r.secret?.digest,
      attrs: r.attrs,
      flags: r.flags.join("|"),
      ts_created: r.ts_created,
    });
    return row;
  });
  write("gatekeep", "advisory", json, rows, users.map((u, i) => expected(u, records[i].account_ref)), ["stripe_customer", "internal_notes"]);
}

// ── 4. Vaultrun: ~70% ──

function vaultrun() {
  const users = canon({
    seed: 4004,
    hasher: (i) => (i % 2 ? "pbkdf2" : "bcrypt"),
    deleted: 3,
    meta: {
      public: () => some({ tier: pick(["bronze", "silver", "gold"]), nl: faker.datatype.boolean(), ui: pick(["compact", "comfy"]) }),
      private: () => some({ crm: `hs_${faker.number.int({ min: 10000, max: 99999 })}`, src: pick(["adwords", "partner", "direct"]), seg: pick(["b2b", "b2c", "edu"]) }),
    },
  });
  // One login column: a username only survives when it is the only identifier.
  for (const u of users) if (u.emails.length || u.phone) u.username = undefined;
  /** "44-7911-123456": country code first, no plus. */
  const dashed = (e164: string) => international(e164).slice(1).replace(/ /g, "-");
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = (d: Date) =>
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;

  const records = users.map((u, i) => {
    const e = u.emails[0];
    let cred = "";
    if (u.hasher === "bcrypt") cred = `bcrypt:${bcryptHash()}`;
    if (u.hasher === "pbkdf2") {
      const s = salt();
      cred = `pbkdf2:sha256:${PBKDF2_ROUNDS}:${s}:${pbkdf2(s)}`;
    }
    const vf = (e?.verified ? 1 : 0) | (u.phone?.verified ? 2 : 0) | (u.banned ? 4 : 0);
    const xb = Object.entries(u.meta.private).map(([k, v]) => `${k}=${v}`).join(";");
    return {
      rid: String(100_001 + i * 7),
      login: e?.value ?? (u.phone ? dashed(u.phone.e164) : u.username),
      alt_contact: e && u.phone ? dashed(u.phone.e164) : "",
      nm: u.firstName && u.lastName ? `${u.lastName}, ${u.firstName}` : (u.firstName ?? ""),
      cred,
      vf,
      xa: Object.keys(u.meta.public).length ? JSON.stringify(u.meta.public) : "",
      xb,
      born: stamp(u.createdAt),
      del: u.deleted ? 1 : 0,
    };
  });
  write("vaultrun", "advisory", records, records, users.map((u, i) => expected(u, records[i].rid)), ["crm"]);
}

// ── 5. Frostline: ~45% (holdout) ──

function frostline() {
  const users = canon({
    seed: 5005,
    hasher: (i) => (i % 4 === 3 ? "bcrypt" : "passlib"),
    deleted: 3,
    meta: {
      public: () => some({ plan: pick(["basic", "plus", "max"]) }),
      private: () => some({ stripe_id: `cus_${faker.string.alphanumeric(14)}`, seats: faker.number.int({ min: 1, max: 40 }) }),
      unsafe: () => some({ theme: pick(["light", "dark"]), language: pick(["en", "fr", "de"]) }),
    },
  });
  const offset = (d: Date) => new Date(d.getTime() + 2 * 3600_000).toISOString().replace("Z", "+02:00");
  const records = users.map((u, i) => ({
    member_no: `FL-${String(100_200 + i * 13).padStart(6, "0")}`,
    contact: {
      email: u.emails[0]?.value ?? null,
      email_status: u.emails[0] ? (u.emails[0].verified ? "confirmed" : "pending") : null,
      mobile: u.phone ? national(u.phone.e164) : null,
      country_iso: u.phone?.country ?? null,
      mobile_status: u.phone ? (u.phone.verified ? "confirmed" : "pending") : null,
    },
    login_name: u.username ?? null,
    given_name: u.firstName ?? null,
    surname: u.lastName ?? null,
    // PHP's bcrypt prefix: the same algorithm as $2b$.
    pw: u.hasher === "passlib" ? passlib() : u.hasher ? bcryptHash().replace(/^\$2b\$/, "$2y$") : null,
    state: u.deleted ? "closed" : u.banned ? "frozen" : "active",
    // A frozen account thaws on this date: the data says it's a hold, not gone.
    frozen_until: u.banned ? new Date(Date.UTC(2026, 10, 1 + (i % 28))).toISOString().slice(0, 10) : null,
    billing: orNull({ ...u.meta.public, ...u.meta.private }),
    settings: orNull(u.meta.unsafe),
    joined: offset(u.createdAt),
  }));
  const json = { result: { members: records }, next_cursor: null };
  const rows = records.map(({ contact, ...r }) => ({ ...r, ...Object.fromEntries(Object.entries(contact).map(([k, v]) => [`contact_${k}`, v])) }));
  write("frostline", "advisory", json, rows, users.map((u, i) => expected(u, records[i].member_no)), ["stripe_id"]);
}

// ── 6. Nimbus: ~70% (holdout) ──

function nimbus() {
  const users = canon({
    seed: 6006,
    hasher: (i) => (i % 5 === 1 ? "ssha" : i % 5 === 3 ? "sha512crypt" : "bcrypt"),
    deleted: 2,
    // One `props` querystring in the export; split here only to say where the reference source puts each key.
    meta: {
      public: () => some({ plan: pick(["solo", "team", "corp"]), lang: pick(["en", "es"]) }),
      private: () => some({ ref: pick(["partner", "ads", "organic"]), acct_note: faker.lorem.words(4) }),
    },
  });
  const records = users.map((u, i) => {
    // Half the numbers dialled from abroad (00 44…), half in E.164.
    const tel = u.phone ? (i % 2 ? `00${u.phone.e164.slice(1)}` : u.phone.e164) : undefined;
    const contacts = [
      ...u.emails.map((e) => `email:${e.value}:${e.verified ? 1 : 0}`),
      ...(u.phone && tel ? [`tel:${tel}:${u.phone.verified ? 1 : 0}`] : []),
    ].join("|");
    const props = new URLSearchParams(Object.entries({ ...u.meta.public, ...u.meta.private }).map(([k, v]) => [k, String(v)])).toString();
    return {
      uid: 70_000 + i * 11,
      contacts,
      nick: u.username ?? "",
      name: [u.firstName, u.lastName].filter(Boolean).join(" "),
      secret: u.hasher === "ssha" ? ssha() : u.hasher === "sha512crypt" ? sha512crypt() : u.hasher ? bcryptHash().replace(/^\$2b\$/, "$2a$") : "",
      st: u.deleted ? "X" : u.banned ? "S" : "A",
      props,
      ctime: String(Math.floor(u.createdAt.getTime() / 1000)),
    };
  });
  write("nimbus", "advisory", records, records, users.map((u, i) => expected(u, String(records[i].uid))), ["acct_note"]);
}

mkdirSync(OUT, { recursive: true });
mkdirSync(ANSWERS, { recursive: true });
keyhole();
passly();
gatekeep();
vaultrun();
frostline();
nimbus();
