# migration-test-apps

Seeds seven auth providers with one set of fake users (500 or 10,000), then
runs `clerk migrate` against each one and checks what lands in Clerk.

## Start here

You need the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`),
signed in to the vault that `op.env` points at. Every script that needs a
secret runs through `op run --env-file=op.env`. Nothing reads `.env`.

```sh
pnpm install
pnpm generate:users   # data/users.json — 500 users
pnpm check:env        # calls every provider for real; never prints a secret
pnpm seed             # push the users into every provider except Clerk
pnpm test:migrate -p better-auth -v B0
```

`check:env` tells you exactly which value is wrong before `seed` wastes time
finding out the hard way.

### Commands

| | |
|---|---|
| `pnpm generate:users` | write `data/users.json` — 500 users |
| `pnpm generate:users:10k` | write `data/users-10k.json` — 10,000 users |
| `pnpm seed` | seed every provider except Clerk |
| `pnpm seed -p <name>` | seed one |
| `pnpm reset` | dry run: count what would be deleted |
| `pnpm reset -y` | delete users from every provider except Clerk |
| `pnpm reset -p <name> -y` | delete from one |
| `pnpm teardown` | empty a Clerk test instance and restore its baseline (uses `clerk` CLI login) |
| `pnpm check:env` | verify every credential against the live provider |
| `pnpm db:tables` | tables and row counts in both Turso databases |
| `pnpm supabase:sql <file>` | run a `.sql` file on the Supabase project |
| `pnpm test:migrate -p <name>` | run the migration tests for one provider |
| `pnpm typecheck` | typecheck `scripts/` |

Flags, and which commands take them. `pnpm seed -h` and `pnpm reset -h` print
their own.

| Long | Short | Used by | Means |
|---|---|---|---|
| `--provider <name>` | `-p` | seed, reset, test:migrate | act on one provider instead of all |
| `--10k` | `-k` | seed, reset | use `data/users-10k.json` |
| `--reset` | `-r` | seed | clear the Turso tables first |
| `--yes` | `-y` | reset, teardown | actually delete |
| `--count <n>` | `-c` | generate:users | how many users |
| `--out <path>` | `-o` | generate:users | where to write |
| `--variation <id>` | `-v` | test:migrate | run one test, by its ID ([Test IDs](#test-ids)) |
| `--dest <D1…D5\|all>` | `-d` | test:migrate | Clerk config to import into ([Dests](#dests)) |
| `--target <name>` | `-t` | test:migrate | Clerk instance to import into ([Targets](#targets)) |
| `--cli <path>` | | test:migrate, teardown | run a local Clerk CLI checkout instead |
| `--dry-run` | `-n` | teardown | report without changing anything |
| `--app <id>` | `-a` | teardown | skip the picker: that app's development instance |
| `--production` | `-p` | teardown | production instead: with `-a`, that app's; alone, only offer production |
| `--help` | `-h` | seed, reset | usage |

`<name>` is one of `authjs` `better-auth` `supabase` `firebase` `auth0`
`workos` `clerk`. Provider setup is at the [end](#configuring-providers).

---

## Migration tests

```sh
pnpm test:migrate -p better-auth              # every variation, each on its own dests
pnpm test:migrate -p better-auth -v B0        # one variation
pnpm test:migrate -p better-auth -v B0 -d all # against D1–D5
pnpm test:migrate -p better-auth --target 10k-prod
pnpm test:migrate ... --cli <path/to/cli.ts>  # a different CLI checkout
```

Each variation × dest runs the same loop:

1. Set the source's config (connection, tables, plugins…), reset it and seed it.
2. `clerk migrate export` from the source, then empty the source.
3. Patch the Clerk instance to the dest config.
4. Dry run, import, verify what Clerk holds, then undo.

The Clerk config is snapshotted first and restored at the end. The Clerk
instance has to start empty — run `pnpm teardown` if it isn't.

Output goes to `runs/<timestamp>-<provider>-<target>/`: `report.md`,
`report.json`, and per run the export, dry run, import and Clerk summary.

### Test IDs

Every test has a short ID, prefixed by its provider. `-v <id>` runs just that
one; leave `-v` off to run all of a provider's tests. Full descriptions are in
[Every test](#every-test).

| Provider (`-p`) | IDs |
|---|---|
| `auth0` | A1–A7 |
| `authjs` | J1–J7 |
| `better-auth` | B0, BP, BI, B1–B10, BK1K, BK |
| `clerk` | C1–C6 |
| `firebase` | F1, F1H, F2–F8 |
| `supabase` | S1–S8 |
| `workos` | W1–W7 |

`pnpm test:migrate -p better-auth -v B0` is the quickest full check: 100 users,
the seeded schema, D1, and every user must land in Clerk.

### Dests

Clerk instance configs the import is tested against. Default is D1.

| Dest | Clerk config | What it exercises |
|---|---|---|
| D1 | email, phone, username, password all on, nothing required; extended username characters | every valid user imports |
| D2 | email + password required | phone-only and passwordless users are rejected |
| D3 | phone required | email-only users are rejected |
| D4 | username required | users without one are rejected |
| D5 | email code only, no password | passwords dropped |

### Targets

| Target | Instance | Used by |
|---|---|---|
| `dev` (default) | Migration Testing dev | every variation except the 10K ones; also the Clerk-as-source instance |
| `10k-dev` | 10K dev (user limit raised to 10,000) | BK1K |
| `10k-prod` | 10K production | BK |

## Every test

### Auth0 — `-p auth0`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| A1 | email + password, default DB connection (username/phone in metadata) | D1 | dev |
| A2 | DB connection with requires_username: username on the real field | D1 | dev |
| A3 | Flexible Identifiers: phone_number as an identifier on the DB connection | D1 | dev |
| A4 | passwordless email only (email\| users) | D1 | dev |
| A5 | passwordless SMS only (sms\| users, phone-only) | D1 | dev |
| A6 | combined: 8 DB + 5 passwordless email (2 share a DB email) + 3 SMS | D1–D5 | dev |
| A7 | edge cases: blocked, unverified email, heavy metadata, custom user_id | D1 | dev |

### Auth.js — `-p authjs`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| J1 | magic link only: every user verified by timestamp | D1 | dev |
| J2 | GitHub only: unverified emails, and 1 in 4 shared no email at all | D1 | dev |
| J3 | email + GitHub: account rows are ignored, so this exports like J1 | D1 | dev |
| J4 | phone OTP: verified <digits>@phone.local placeholders, which Clerk refuses (cli-bugs #10) | D1 | dev |
| J5 | user table renamed to `users`: the exporter's fallback table name | D1 | dev |
| J6 | snake_case `email_verified` column (a Prisma @map): the exporter should refuse clearly *(export expected to fail)* | D1 | dev |
| J7 | names: one word, two words, three words | D1 | dev |

### Better Auth — `-p better-auth`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| B0 | smoke: the app's own schema (username + phone plugins), 100 users | D1 | dev |
| BP | phone countries: every non-+1 phone in users.json (20 users, 8 countries) | D1 | dev |
| BI | invalid phones on users that also have an email (cli-bugs #2, fixed 069a1db3) | D1 | dev |
| B1 | core only: email + password, no plugin columns | D1 | dev |
| B2 | + username plugin | D1 | dev |
| B3 | + phone plugin: verified, unverified and no phone | D1 | dev |
| B4 | + admin plugin: 1 in 5 banned (plan bug #1, fixed in ea8fc9dd) | D1 | dev |
| B5 | + 2FA plugin: 1 in 3 email users enrolled (MFA is documented as not carried) | D1 | dev |
| B6 | GitHub: social-only (no credential) and password + GitHub | D1 | dev |
| B7 | password formats: native scrypt, bcrypt, argon2id, and one no hasher accepts | D1 | dev |
| B8 | anonymous plugin: half the users are guests, which the CLI skips (cli-bugs #5) | D1 | dev |
| B9 | every plugin at once, mixed cohorts | D1–D5 | dev |
| B10 | user table renamed to `users` (modelName): the exporter should refuse clearly *(export expected to fail)* | D1 | dev |
| BK1K | 1K on the raised-limit dev instance: a 10% slice of data/users-10k.json | D1 | 10k-dev |
| BK | 10K on production: data/users-10k.json, the app's schema — rate-limit throttling | D1 | 10k-prod |

### Clerk (as a source) — `-p clerk`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| C1 | email + password | D1 | dev |
| C2 | email + username + phone + password | D1 | dev |
| C3 | phone only (incl. a European number) | D1 | dev |
| C4 | email code only: no passwords at the source (D5 as the source config) | D1 | dev |
| C5 | TOTP + backup codes on half the users: not exportable through the API | D1 | dev |
| C6 | public/private/unsafe metadata, and banned users | D1 | dev |

### Firebase — `-p firebase`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| F1 | email + password, Firebase's own scrypt: hashes export and verify in Clerk | D1 | dev |
| F1H | F1, exported with the custom firebaseauth.configs.getHashConfig role (plan bug #4) *(skipped: FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE is not a service-account JSON yet)* | D1 | dev |
| F2 | email link only: no password | D1 | dev |
| F3 | phone only | D1 | dev |
| F4 | email + password + phone | D1 | dev |
| F5 | imported bcrypt / HMAC_SHA256 hashes: Firebase exports them empty, so those passwords are lost | D1 | dev |
| F6 | Google: password + Google linked, and Google only (provider data is not exported) | D1 | dev |
| F7 | edge cases: disabled, unverified, custom claims, and anonymous users | D1 | dev |
| F8 | combined: every group, disabled users, Google links and bcrypt imports | D1–D5 | dev |

### Supabase — `-p supabase`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| S1 | email + password (gotrue bcrypt) | D1 | dev |
| S2 | passwordless (magic link / email OTP): encrypted_password = '' | D1 | dev |
| S3 | phone only, stored without the + (cli-bugs plan #5, fixed 0effeda3) | D1 | dev |
| S4 | email + password + phone | D1 | dev |
| S5 | unconfirmed: half the emails, a third of the phones | D1 | dev |
| S6 | OAuth: GitHub only, Google only, and password + GitHub (Clerk dev: Google on, GitHub off) | D1 | dev |
| S7 | edge cases: banned, soft-deleted, argon2id, heavy metadata, anonymous, SSO duplicate email | D1 | dev |
| S8 | combined: unconfirmed, banned, password + GitHub, passwordless — against D1–D5 | D1–D5 | dev |

### WorkOS — `-p workos`

| ID | What it tests | Dests | Target |
|---|---|---|---|
| W1 | email + password (bcrypt hash in; WorkOS never gives one back) | D1 | dev |
| W2 | no password (Magic Auth style): exports the same shape as W1 | D1 | dev |
| W3 | unverified emails | D1 | dev |
| W4 | metadata: empty, at the limits (10 keys × 40-char keys × 600-char values), and the default | D1 | dev |
| W5 | external_id at the 64-char limit, and name edge cases (unicode, first-only, last-only) | D1 | dev |
| W6 | orgs + memberships + roles, and TOTP factors: none exported, all should drop cleanly | D1 | dev |
| W7 | combined: passwords, no-password, unverified, metadata, external_id, orgs and TOTP mixed | D1–D5 | dev |

---

## Seeding

Users are generated once into a JSON file, then pushed to each provider. `data/`
is not committed, so **generate before you seed anything**:

```sh
pnpm generate:users       # data/users.json      —    500 users
pnpm generate:users:10k   # data/users-10k.json  — 10,000 users
```

Both are deterministic: same seed, same users, every time. For any other size:

```sh
tsx scripts/generate-users.ts -c 2000 -o data/users-2k.json
```

### Seed

```sh
pnpm seed                    # every provider except Clerk
pnpm seed -p workos          # just one
```

`--provider` takes one of `authjs` `better-auth` `supabase` `firebase` `auth0`
`workos` `clerk`. Auth.js and Better Auth own separate databases and reset and
reseed independently.

A provider that fails is reported and the run carries on to the rest, exiting
non-zero at the end. `pnpm seed --help` prints the usage.

> **Clerk is never part of a bare `pnpm seed`.** It is the migration
> *destination*, so it has to stay empty to be a real test — a Clerk instance
> that already holds the users proves nothing. `--provider clerk` seeds it
> anyway if you have a reason to.

### 500 or 10,000

`--10k` reads `data/users-10k.json` instead:

```sh
pnpm seed -k
pnpm seed -p authjs -r -k    # flags combine
```

`SEED_USERS_FILE=<path>` picks any other file, and wins over the flag:

```sh
SEED_USERS_FILE=data/users-2k.json pnpm seed -p workos
```

The two files do not mix. Reset the provider between them, or you get 10,500
users and duplicate-email errors on the overlap.

The mix is identical at both sizes — 60% email-only, 15% phone-only, 25% both,
30% with a username, 30% with a name, 85% with a password — and the password is
the same one.

### `--reset`, and how it differs from `pnpm reset`

Auth.js and Better Auth own their tables outright, so their seeder **always
clears those tables before inserting**. `--reset` (`-r`) is what permits that
clearing to happen over rows that already exist; without it the seeder refuses
and changes nothing.

```sh
pnpm seed -p authjs         # errors: "already has 500 rows"
pnpm seed -p authjs -r      # clears, then inserts a fresh set
```

It is not "add these users regardless" — nothing is ever merged. It is "yes,
throw away what is there first."

What gets thrown away is the whole database, not just its users:

| Database | Tables cleared |
|---|---|
| Better Auth | `session`, `account`, `verification`, `user` |
| Auth.js | `session`, `account`, `verificationToken`, `user` |

So live sessions end and linked GitHub OAuth accounts unlink. It respects
`-p`: `pnpm seed -p authjs -r` leaves Better Auth's database untouched.

The other five providers have no equivalent — there is no single statement that
empties a hosted tenant — so they need `pnpm reset` instead.

| | `--reset` / `-r` | `--yes` / `-y` |
|---|---|---|
| Belongs to | `pnpm seed` | `pnpm reset` |
| Applies to | Auth.js, Better Auth | every provider |
| Leaves you with | a freshly seeded database | an empty one |
| If you omit it | errors out, nothing happens | dry run, prints counts |

`pnpm seed -p authjs -r` and `pnpm reset -p authjs -y && pnpm seed -p authjs`
end in the same place; the first is one command.

### Seeding twice

Only Auth0 is idempotent; its seeder upserts. The rest:

| Seeder | Second run |
|---|---|
| Auth0 | upserts, safe to repeat |
| Auth.js, Better Auth | refuses unless you pass `--reset`, which clears the tables first |
| Supabase, Firebase, WorkOS | every user comes back as a duplicate error |

So `pnpm reset -p <name> -y` first, or seed once.

A re-seed over existing users is not a crash — each user is rejected
individually and the seeder runs to the end — so watch the exit code, not the
last line:

| Exit | Means |
|---|---|
| 0 | every user created |
| 1, `Did not run:` | the seeder threw — bad credentials, or the `--reset` guard |
| 1, `Finished with user-level errors:` | it ran, but some or all users were rejected. Almost always duplicates. |

WorkOS reports a duplicate as the unhelpfully generic
`Could not create user. (user_creation_error)` rather than naming the email —
verified by creating the same address twice. Reset first and it goes away.

### How long it takes

| Provider | 500 | 10,000 | Why |
|---|---|---|---|
| Auth0 | seconds | under a minute | one bulk import job per 450KB of users |
| Auth.js, Better Auth | seconds | a minute or two | batched SQL, but Better Auth hashes each password |
| Firebase | ~1 min | ~20 min | one API call per user, 8 at a time |
| Supabase | ~1 min | ~20 min | one API call per user, 8 at a time |
| WorkOS | a few min | ~30 min | one API call per user, 4 at a time |

Rough figures — every one of these is an API round trip per user, so they track
the provider's rate limit more than anything in this repo.

### What each seeder changes on the way in

The JSON is provider-neutral; every transformation happens in the seeder.

| Provider | Transformation |
|---|---|
| Auth0 | phone-only users get `<digits>@phone.local`; phone + username into `user_metadata`; one shared bcrypt hash |
| WorkOS | same placeholder email; phone + username into `metadata`; one shared bcrypt hash |
| Firebase | no username field, so username and names go into custom claims |
| Supabase | username and names into `user_metadata`; users created pre-confirmed |
| Better Auth | genuine scrypt hashes, written as `salt:hash` credential accounts |
| Auth.js | no password at all — it has no credentials provider here |

Every provider keeps the generator's `id` — as `externalId` on WorkOS, as
`seed_id` in metadata elsewhere — so a user can be traced back to the file.

### Free-tier headroom

Every seeded provider fits 10,000 users on a free plan, and none of these caps
count stored users — only monthly active ones, so an idle seed costs nothing.

| Provider | Free plan cap |
|---|---|
| WorkOS | 1,000,000 MAU |
| Supabase | 50,000 MAU |
| Firebase | 50,000 MAU |
| Auth0 | 25,000 MAU |
| Auth.js, Better Auth | no cap — self-hosted, Turso's 5GB is the limit |

Clerk's free plan is 50,000 MRU, which matters on the receiving end: a 10,000
user migration lands well inside it.

---

## Resetting

Same shape as `pnpm seed`:

```sh
pnpm reset               # dry run over every provider except Clerk
pnpm reset -y            # actually delete from those
pnpm reset -p workos -y  # just one
pnpm reset -p clerk -y   # empties the migration destination
```

Without `--yes` it only counts, and it always prints which tenant, project or
database it is pointed at before deleting. There is no undo.

Clerk is reachable here even though nothing seeds it, because this is how you
empty the destination between migration runs.

| Provider | How it deletes | 10,000 users takes |
|---|---|---|
| Auth.js, Better Auth | `delete from` on that database's Turso tables | seconds |
| Firebase | Admin SDK, 1,000 uids per call | seconds |
| Supabase | one admin API call per user | a few minutes |
| WorkOS | one API call per user | a few minutes |
| Auth0 | one API call per user | a few minutes |
| Clerk | one API call per user, throttled | the slow one |

Two provider quirks worth knowing:

1. **Auth0 needs the `delete:users` scope.** It is in the setup list below; if you granted the scopes before that was added, go back to **APIs → Auth0 Management API → Application Access → Edit**. The script checks for it and says so before touching anything.
2. **Auth0 cannot page past 1,000 users** with ordinary pagination, so the script uses checkpoint pagination (`take`/`from`) to enumerate a 10,000-user tenant.

Faster alternatives if a reset is ever too slow to sit through: Supabase will
run `delete from auth.users;` through `pnpm supabase:sql` in one statement, and
Firebase and Clerk both let you delete the whole project/instance in the
dashboard and start over — for a tenant of fake users that is often quicker
than waiting.

---


## The seed data

`data/users.json` is generated, not hand-written. Regenerate with `pnpm generate:users` — same seed, same 500 users, every time. `pnpm generate:users:10k` writes a 10,000-user file with the same ratios; the table below scales by 20×.

| | |
|---|---|
| Email only | 300 |
| Phone only | 75 |
| Both | 125 |
| With a username | 150 |
| With a first/last name | 150 |
| With a password | 425 |

`pnpm generate:users:10k` produces the same proportions at 20×: 6,000 / 1,500 /
2,500 / 3,000 / 3,000 / 8,500.

Phone numbers are valid E.164. 180 are North American on real area codes (416, 647, 905, 604, 514, 212, 415…) using the `555-01XX` line range that NANPA reserves for fiction — which also makes every one of them a valid Clerk test number. That range holds exactly 100 numbers per area code, so the 10,000-user file draws on a wider list of 74 real area codes to find its 3,600; the generator asserts the pool is big enough before it writes anything. The other 20 are European, spread round-robin across UK, Germany, France, Spain, Italy, Netherlands, Sweden and Ireland, so every file carries all eight. Each is checked with libphonenumber — the same data Clerk validates against — and redrawn until it is a valid number in its own country. UK numbers come from real mobile ranges: Ofcom's fictional drama range fails validation, and Clerk rejects it. Nothing here sends an SMS. Clerk accepts these numbers only on instances with all eight countries on the SMS allowlist (Tier B and C, enabled by Clerk support).

The generator asserts every one of those counts before it writes the file, so a drifting ratio fails loudly.


**Password:** `Kk4aPMeiaRpAs2OeX1NE` — 425 of the 500 users, 8,500 of the
10,000. The 75 phone-only users have no email, so no password — 1,500 of them
in the larger file. Providers that demand an email got `<digits>@phone.local`.

## Layout

```
scripts/              user generator, seed/reset dispatchers, one seeder per provider
scripts/test-migrate.ts   the migration test runner
scripts/variations/   one file of test variations per provider
scripts/schema/       the Auth.js table schema (drizzle-kit output)
data/users.json       the 500 users (data/users-10k.json if you generate it)
op.env                1Password references for every secret
runs/                 test output (gitignored)
```

---

## Configuring providers

Each subsection is independent. Do only the ones you need. Every key goes into
1Password, with an `op://` reference for it in `op.env`.

### Turso — Auth.js and Better Auth

Two separate databases, one per provider: `migration-test-ba` (Better Auth)
and `migration-test-authjs` (Auth.js). About 5 minutes.

1. Create both databases in the [Turso dashboard](https://app.turso.tech), or
   on any libSQL host.
2. Add each database's URL and an auth token to 1Password:
   - `BA_TURSO_DATABASE_URL`, `BA_TURSO_DATABASE_TOKEN`
   - `AUTHJS_TURSO_DATABASE_URL`, `AUTHJS_TURSO_DATABASE_TOKEN`
3. Seed both:

```sh
pnpm seed -p better-auth
pnpm seed -p authjs
```

A database with no tables gets its schema on the first seed: Better Auth's
from its username + phone plugins, Auth.js's from `scripts/schema/authjs.sql`.
`pnpm db:tables` prints row counts to confirm.

### Clerk — the destination

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com)
2. **API keys** → `CLERK_SECRET_KEY`. For 10K runs, also
   `CLERK_SECRET_KEY_10K_DEV` and `CLERK_SECRET_KEY_10K_PROD`.
3. The app and instance ids live in `TARGETS` in `scripts/test-migrate.ts`.
   Update them if you use your own instances.

**Leave it empty.** Clerk is the destination every migration test imports
*into*, so it starts with zero users. `pnpm seed` skips it, and `pnpm
check:env` reporting `0 users in instance` is the correct state.

### Supabase

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard)
2. **Project Settings → API** → `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (seed and reset)
3. **Connect → connection string** → `SUPABASE_CONNECTION_STRING` (the CLI export reads Postgres directly)
4. [Account → Access tokens](https://supabase.com/dashboard/account/tokens), with `database_write` → `SUPABASE_ACCESS_TOKEN` (`pnpm supabase:sql` and auth config changes)

### Firebase

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com)
2. **Authentication → Sign-in method**: enable Email/Password and Email link
3. **Project settings → Service accounts → Generate new private key** → the
   whole JSON into `FIREBASE_SERVICE_ACCOUNT_JSON`
4. Optional, for F1H: a second key whose service account has a custom role with
   `firebaseauth.configs.getHashConfig` → `FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE`

### Auth0

1. Create a Machine to Machine application at [manage.auth0.com](https://manage.auth0.com),
   authorised for the **Auth0 Management API**
2. Grant `create:users`, `read:users`, `delete:users`, and
   `create:connections`, `read:connections`, `update:connections`,
   `delete:connections` (the variations create and remove connections)
3. Copy into `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`

The seeder uses the `Username-Password-Authentication` connection unless
`AUTH0_DB_CONNECTION` is set.

### WorkOS

Stay in the **Staging** environment. Keys are per-environment, and these are
fake users.

1. Create an account at [dashboard.workos.com](https://dashboard.workos.com)
2. **API Keys** → the secret key (`sk_test_…`) into `WORKOS_API_KEY`
