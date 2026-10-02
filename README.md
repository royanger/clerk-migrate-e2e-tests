# migration-test-apps

This repo seeds seven auth providers with one set of fake users (500 or
10,000), runs `clerk migrate` against each provider, and checks what lands in
Clerk.

## Start here

You need the [1Password CLI](https://developer.1password.com/docs/cli/) (`op`),
signed in to the vault that `op.env` points at. Every script that needs a
secret runs through `op run --env-file=op.env`. No script reads `.env`.

```sh
pnpm install
pnpm generate:users   # data/users.json: 500 users
pnpm check:env        # calls each provider for real; prints no secrets
pnpm seed             # pushes the users into every provider except Clerk
pnpm test:migrate -p better-auth -v B0
```

Run `check:env` first. It names the wrong value before `seed` spends minutes
failing on it.

### Commands

| | |
|---|---|
| `pnpm generate:users` | write `data/users.json` (500 users) |
| `pnpm generate:users:10k` | write `data/users-10k.json` (10,000 users) |
| `pnpm seed` | seed every provider except Clerk |
| `pnpm seed -p <name>` | seed one provider |
| `pnpm reset` | dry run: count what a reset would delete |
| `pnpm reset -y` | delete users from every provider except Clerk |
| `pnpm reset -p <name> -y` | delete from one provider |
| `pnpm teardown` | empty a Clerk test instance and restore its baseline (uses your `clerk` CLI login) |
| `pnpm check:env` | test every credential against the live provider |
| `pnpm db:tables` | list tables and row counts in both Turso databases |
| `pnpm supabase:sql <file>` | run a `.sql` file on the Supabase project |
| `pnpm test:migrate -p <name>` | run one provider's migration tests |
| `pnpm test:migrate:all` | run every migration test with one 1Password approval |
| `pnpm generate:custom` | write the made-up provider exports ([Custom sources](#custom-sources)) |
| `pnpm test:custom -e <export> -s <source.ts>` | import one export through a custom source and grade it |
| `pnpm test:custom --all --sources-dir <dir>` | the same for all 8 exports |
| `pnpm eval:ready` | check both agents are signed in (and as whom), their flags work, and they are isolated |
| `pnpm eval:sources --set <name>` | have Claude and Codex each write a source for all 8 exports, then grade them ([Source evals](#source-evals)) |
| `pnpm eval:sync-skill` | copy the clerk-migrate skill from `skillSource` into `evals/skill/` (`-n` to preview) |
| `pnpm typecheck` | typecheck `scripts/` |

These flags apply to the commands listed. `pnpm seed -h` and `pnpm reset -h`
print their own usage.

| Long | Short | Used by | Means |
|---|---|---|---|
| `--provider <name>` | `-p` | seed, reset, test:migrate | act on one provider instead of all |
| `--10k` | `-k` | seed, reset | use `data/users-10k.json` |
| `--reset` | `-r` | seed | clear the Turso tables first |
| `--yes` | `-y` | reset, teardown | delete for real |
| `--count <n>` | `-c` | generate:users | how many users to write |
| `--out <path>` | `-o` | generate:users | where to write them |
| `--variation <id>` | `-v` | test:migrate | run one test by its ID ([Test IDs](#test-ids)) |
| `--dest <D1…D5\|all>` | `-d` | test:migrate | the Clerk config to import into ([Dests](#dests)) |
| `--target <name>` | `-t` | test:migrate | the Clerk instance to import into ([Targets](#targets)) |
| `--export <name.fmt>` | `-e` | test:custom | the export to import, e.g. `keyhole.csv` |
| `--source <path>` | `-s` | test:custom | the custom source to import it with |
| `--all` | | test:custom | every export; needs `--sources-dir` |
| `--sources-dir <dir>` | | test:custom | where `--all` finds `<name>-<fmt>.ts`, else `<name>.ts` |
| `--cli <path>` | | test:migrate, test:custom, teardown | run a local Clerk CLI checkout |
| `--dry-run` | `-n` | teardown | report without changing anything |
| `--app <id>` | `-a` | teardown | skip the picker and use that app's development instance |
| `--agent <name>` | `-a` | eval:sources | run one agent (`claude` or `codex`) instead of both |
| `--production` | `-p` | teardown | use production: with `-a`, that app's; alone, a picker of production instances |
| `--help` | `-h` | seed, reset | print usage |

`<name>` is one of `authjs` `better-auth` `supabase` `firebase` `auth0`
`workos` `clerk`. Provider setup is at the [end](#configuring-providers).

---

## Migration tests

Each test seeds a source with known users, exports them with
`clerk migrate export`, and imports them into a Clerk instance with
`clerk migrate import`. It then compares what Clerk holds with what the seed
says should be there, and undoes the import. A test starts and ends with an
empty Clerk instance.

```sh
pnpm test:migrate:all                         # everything (about 1.5–2 hours)
pnpm test:migrate -p better-auth              # every variation, each on its own dests
pnpm test:migrate -p better-auth -v B0        # one variation
pnpm test:migrate -p better-auth -v B0 -d all # against D1–D5
pnpm test:migrate -p better-auth --target 10k-prod
pnpm test:migrate ... --cli <path/to/cli.ts>  # a different CLI checkout
```

Each variation and dest pair runs the same loop:

1. Set the source's config (connection, tables, plugins), reset it and seed it.
2. Run `clerk migrate export` against the source, then empty the source.
3. Patch the Clerk instance to the dest config.
4. Dry run, import, check what Clerk holds, then undo.

The runner snapshots the Clerk config first and restores it at the end. The
Clerk instance has to start empty. If it isn't, run `pnpm teardown`.

### What every test checks

- **The dry run matches the import.** The number of users the dry run calls
  importable must equal the number created, with none failing at import time.
- **What Clerk holds matches the seed.** The runner counts users, passwords,
  usernames, phones, verified emails and bans in Clerk, and compares them with
  what the source can carry. Auth0 and WorkOS never export password hashes, so
  their tests expect 0 passwords.
- **Imported passwords work.** The runner checks each password with Clerk's
  `verify_password` and the seed password. Past 500 users, it checks a spread
  sample of 200.
- **Undo leaves the instance empty.** After `clerk migrate undo`, the instance
  must hold 0 users again.

Some tests add their own checks: how names split (J7), which metadata bucket
holds what (A7, C6, W4), external IDs (A4, A5, A7, W5), or an export that must
refuse the source's schema (B10, J6).

### Expected failures

These tests set out to make the CLI refuse users, and check that it refuses
the right ones.

**Exact rejects per Clerk config (B9).** The runner compares the users the dry
run rejected with the users that config must reject, and checks each reason. A
user rejected by mistake, a user the dry run should have rejected, or a wrong
reason fails the test.

| Dest | Must reject |
|---|---|
| D1 | nobody |
| D2 | users without a verified real email (an `@phone.local` placeholder doesn't count), or with a username outside Clerk's default rules |
| D3 | users without a verified phone, or with a bad username |
| D4 | users without a username, or with a bad username |
| D5 | users without a verified real email. D5 turns phone and username off, so the CLI drops those fields and keeps the user |

**Deliberate failures (X1–X5, Better Auth source).**

| ID | Scenario | Must happen |
|---|---|---|
| X1 | password required (D2), half the users have none | nobody rejected; a "without a password, which this instance requires" warning; all imported |
| X2 | `--require-password` | the CLI leaves out users without a password |
| X3 | an email, a phone and a username already taken in Clerk | the CLI rejects those 3 users and no others, each "already used / already taken" |
| X4 | 1 user already in the dev instance, 100 to import | the CLI rejects 1 user, for the 100-user limit |
| X5 | the same export imported twice | "already imported", and nothing added |

### Results

Each test run writes to two folders with the same name,
`<timestamp>-<provider>-<target>`:

| Folder | What's in it |
|---|---|
| `test-results/<run>/` | `report.md` and `report.json` (one row per test), `log.txt`, the Clerk config snapshot, and per test its seed file, dry run, import and Clerk summary |
| `clerk-runs/<run>/` | the Clerk CLI's own run store (`--runs-dir`): each `export.json`, `users.ndjson` and `run.json`. `report.json` names the export and import run IDs for each test |

Git ignores both folders, because the export files hold the seeded users and
their password hashes. You can delete them at any time: each test undoes its
own import.

### Before a long run

- **1Password:** each `pnpm test:migrate` asks once. `test:migrate:all` asks
  once for the whole run.
- **Supabase:** free projects pause after a week idle. `test:migrate:all`
  wakes the project first. For a single run, restore it from the dashboard if
  the tests time out on SQL.
- **Clerk dev instance:** Clerk caps it at 100 users, so tests on the `dev`
  target use 100 or fewer. BK1K and BK run on the raised-limit and production
  instances.
- **Auth0 free tier:** the Management API allows about 2 requests a second.
  Each Auth0 test creates a temporary connection and deletes it afterwards;
  Auth0 then removes that connection's users on its side.

### Test IDs

Each test has a short ID that starts with its provider's letter. `-v <id>` runs
that test; leave `-v` off to run all of a provider's tests.
[Every test](#every-test) has the full descriptions.

| Provider (`-p`) | IDs |
|---|---|
| `auth0` | A1–A7 |
| `authjs` | J1–J7 |
| `better-auth` | B0, BP, BI, B1–B10, X1–X5, BK1K, BK |
| `clerk` | C1–C6 |
| `firebase` | F1, F1H, F2–F8 |
| `supabase` | S1–S8 |
| `workos` | W1–W7 |

For the quickest full check, run `pnpm test:migrate -p better-auth -v B0`: 100
users, the seeded schema and D1, and all 100 must land in Clerk.

### Dests

The Clerk instance configs the tests import into. D1 is the default.

| Dest | Clerk config | What it exercises |
|---|---|---|
| D1 | email, phone, username and password all on, nothing required; extended username characters | every valid user imports |
| D2 | email and password required | the CLI rejects users without a verified email; passwordless users import with a warning |
| D3 | phone required | the CLI rejects email-only users |
| D4 | username required | the CLI rejects users without one |
| D5 | email code only; phone, username and password off | the CLI drops phones and usernames; Clerk stores passwords, which work once you turn passwords on |

### Targets

| Target | Instance | Used by |
|---|---|---|
| `dev` (default) | Migration Testing dev | every variation except the 10K ones; also the Clerk-as-source instance |
| `10k-dev` | 10K dev (user limit raised to 10,000) | BK1K |
| `10k-prod` | 10K production | BK |

## Every test

### Auth0 (`-p auth0`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| A1 | email + password on the default DB connection (username and phone in metadata) | D1 | dev |
| A2 | DB connection with `requires_username`: username on the real field | D1 | dev |
| A3 | Flexible Identifiers: `phone_number` as an identifier on the DB connection | D1 | dev |
| A4 | passwordless email only (`email\|` users) | D1 | dev |
| A5 | passwordless SMS only (`sms\|` users, phone-only) | D1 | dev |
| A6 | combined: 8 DB + 5 passwordless email (2 share a DB email) + 3 SMS | D1–D5 | dev |
| A7 | edge cases: blocked, unverified email, heavy metadata, custom `user_id` | D1 | dev |

### Auth.js (`-p authjs`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| J1 | magic link only: a timestamp verifies each user | D1 | dev |
| J2 | GitHub only: unverified emails, and 1 in 4 users shared no email at all | D1 | dev |
| J3 | email + GitHub: the exporter ignores account rows, so this exports like J1 | D1 | dev |
| J4 | phone OTP: verified `<digits>@phone.local` placeholders, which Clerk refuses, so the dry run rejects those users | D1 | dev |
| J5 | user table renamed to `users`: the exporter's fallback table name | D1 | dev |
| J6 | snake_case `email_verified` column (a Prisma `@map`): the exporter must refuse it with a clear message *(export expected to fail)* | D1 | dev |
| J7 | names of one, two and three words | D1 | dev |

### Better Auth (`-p better-auth`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| B0 | smoke: the app's own schema (username + phone plugins), 100 users | D1 | dev |
| BP | phone countries: every non-+1 phone in `users.json` (20 users, 8 countries) | D1 | dev |
| BI | invalid phones on users with an email: Clerk creates them from the email and the CLI drops the phone | D1 | dev |
| B1 | core only: email + password, no plugin columns | D1 | dev |
| B2 | + username plugin | D1 | dev |
| B3 | + phone plugin: verified, unverified and no phone | D1 | dev |
| B4 | + admin plugin: 1 in 5 banned, and they stay banned in Clerk | D1 | dev |
| B5 | + 2FA plugin: 1 in 3 email users enrolled (the CLI documents that MFA doesn't carry over) | D1 | dev |
| B6 | GitHub: social-only (no credential) and password + GitHub | D1 | dev |
| B7 | password formats: native scrypt, bcrypt, argon2id, and one no hasher accepts | D1 | dev |
| B8 | anonymous plugin: half the users are guests, which the CLI skips | D1 | dev |
| B9 | every plugin at once, mixed cohorts; exact rejects checked per dest ([Expected failures](#expected-failures)) | D1–D5 | dev |
| B10 | user table renamed to `users` (`modelName`): the exporter must refuse it with a clear message *(export expected to fail)* | D1 | dev |
| X1 | password required, half the users have none: imported, with a warning | D2 | dev |
| X2 | `--require-password`: the CLI leaves out users without one | D1 | dev |
| X3 | an email, a phone and a username already taken in Clerk: those 3 rejected, no others | D1 | dev |
| X4 | 1 user already in the dev instance, 100 to import: 1 rejected for the limit | D1 | dev |
| X5 | the same export imported twice: "already imported", nothing added | D1 | dev |
| BK1K | 1K on the raised-limit dev instance: a 10% slice of `data/users-10k.json` | D1 | 10k-dev |
| BK | 10K on production: all of `data/users-10k.json`, to measure rate-limit throttling | D1 | 10k-prod |

### Clerk as a source (`-p clerk`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| C1 | email + password | D1 | dev |
| C2 | email + username + phone + password | D1 | dev |
| C3 | phone only, including a European number | D1 | dev |
| C4 | email code only: no passwords at the source (D5 as the source config) | D1 | dev |
| C5 | TOTP + backup codes on half the users, which the API can't export | D1 | dev |
| C6 | public, private and unsafe metadata, and banned users | D1 | dev |

### Firebase (`-p firebase`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| F1 | email + password with Firebase's own scrypt: the hashes export and verify in Clerk | D1 | dev |
| F1H | F1, exported with a second service account (`FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE`), to test which IAM roles can export hashes ([Firebase](#firebase)) | D1 | dev |
| F2 | email link only: no password | D1 | dev |
| F3 | phone only | D1 | dev |
| F4 | email + password + phone | D1 | dev |
| F5 | imported bcrypt and HMAC_SHA256 hashes: Firebase exports them empty, so those passwords don't survive | D1 | dev |
| F6 | Google: password + Google linked, and Google only (the exporter skips provider data) | D1 | dev |
| F7 | edge cases: disabled, unverified, custom claims and anonymous users | D1 | dev |
| F8 | combined: every group, disabled users, Google links and bcrypt imports | D1–D5 | dev |

### Supabase (`-p supabase`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| S1 | email + password (GoTrue bcrypt) | D1 | dev |
| S2 | passwordless (magic link or email OTP): `encrypted_password = ''` | D1 | dev |
| S3 | phone only: Supabase stores numbers without the `+`, and the CLI adds it back | D1 | dev |
| S4 | email + password + phone | D1 | dev |
| S5 | unconfirmed: half the emails and a third of the phones | D1 | dev |
| S6 | OAuth: GitHub only, Google only, and password + GitHub (Clerk dev has Google on and GitHub off) | D1 | dev |
| S7 | edge cases: banned, soft-deleted, argon2id, heavy metadata, anonymous, SSO duplicate email | D1 | dev |
| S8 | combined: unconfirmed, banned, password + GitHub and passwordless users | D1–D5 | dev |

### WorkOS (`-p workos`)

| ID | What it tests | Dests | Target |
|---|---|---|---|
| W1 | email + password (WorkOS takes the bcrypt hash and never returns it) | D1 | dev |
| W2 | no password (Magic Auth style): exports the same shape as W1 | D1 | dev |
| W3 | unverified emails | D1 | dev |
| W4 | metadata: empty, at the limits (10 keys, 40-char keys, 600-char values), and the default | D1 | dev |
| W5 | `external_id` at the 64-char limit, and name edge cases (unicode, first-only, last-only) | D1 | dev |
| W6 | orgs, memberships, roles and TOTP factors: the export carries none, and the import must drop them without errors | D1 | dev |
| W7 | combined: passwords, no password, unverified, metadata, `external_id`, orgs and TOTP | D1–D5 | dev |

---

## Custom sources

Exports from four made-up auth providers, for testing a skill that writes
`clerk migrate` custom sources. Each is further from Clerk's shape than the last:

| Provider | Distance from Clerk | What makes it hard |
|---|---|---|
| Keyhole | ~10–15% | near-Clerk names (`phone_number`, `password_hash`), verified flags |
| Passly | ~30% | `{ users: [...] }` wrapper, display name only, nested credentials, `status`, Unix-second dates |
| Gatekeep | ~50–60% | `{ data: { accounts } }`, an `identities[]` array with the primary not first, pbkdf2 split into parts, one mixed `attrs` blob, `flags[]`, ms dates |
| Vaultrun | ~70% | one `login` column holding an email, phone or username; a `vf` bitmask; `"Last, First"`; prefixed hash strings; metadata as a JSON string and `k=v;k=v`; soft-deleted rows |

Each has a JSON and a CSV export of the same 50 users, and every password is
a real hash of the seed password.

```
data/custom-sources/            the 8 exports: the only folder the skill should see
data/custom-sources-answers/    answer keys and reference sources: keep away from the skill
  <name>.expected.json          what each user should become in Clerk
  <name>.ts                     a hand-written source that grades A+ on both formats
```

`pnpm test:custom` configures the dev instance for what the users hold (phone,
username, password; nothing required), runs a dry run, imports, grades every user
against the answer key, then undoes the import and restores the config.

**The grade.** Every expected fact is one check: the user exists, each email and
phone and its verification, primaries, username, names, banned, password (it
must sign in), and each metadata key. Accuracy is checks passed / checks made.
A user that never landed fails all its checks. A+ is 100%, then A ≥ 95%, B ≥ 85%,
C ≥ 70%, D ≥ 50%, F below that or when the run fails.

**The report** (`test-results/<stamp>-custom*/report.md`) groups failures by field
and reason: five users with a broken phone are one problem listing five IDs.
For Gatekeep and Vaultrun the export does not say which metadata is public, so
any metadata field passes and a placement different from the reference source's
is a note, not a failure.

---

## Source evals

Can an agent, given only the clerk-migrate skill and one export, write a source
that imports the users correctly? `pnpm eval:sources` runs Claude Code and Codex
over all 8 exports (16 runs) and grades each source with `test:custom`.

```
pnpm eval:ready                                   run first: accounts, flags, isolation
pnpm eval:sources --set clear-correct             all 16 runs
pnpm eval:sources --set clueless -a claude          one agent
pnpm eval:sources --set mixed --agent-cli dry-run -a codex --exports gatekeep.csv
```

| Flag | Means |
|---|---|
| `--set <name>` | the answer set in `evals/answer-sets/` (required) |
| `--agent-cli none\|sources\|dry-run` | what the agent's `clerk` may run: nothing (default), `migrate sources`, or that plus `import --dry-run`. `--yes`, `undo` and `config` are always refused. |
| `-a`, `--agent claude\|codex` | one agent, or both comma-separated (default both, Claude first) |
| `--exports a.json,b.csv` | which exports (default all 8) |

**Each run** gets a temp workspace holding only the export and the skill. Claude
runs with project-only settings and no MCP servers; Codex with a temp HOME
holding only its login. Neither sees your global skills, plugins, hooks or
`CLAUDE.md`/`AGENTS.md` (`eval:ready` proves it). The agent's `clerk` is a shim
that runs `cli` from `evals/config.json` and enforces `--agent-cli`.

**Questions.** The agent ends each turn with a question, a finished source, or a
blocker. Questions are matched to topics by a small model and answered from the
set; one the set does not cover goes to the set's `fallback`, which is either a
fixed reply or you, in the terminal. An answer you type can be saved into the
set, which bumps its version. Format: `evals/answer-sets/README.md`.

**Settings** (`evals/config.json`): `cli` (a `cli.ts` path, or `clerk`),
`skillSource`, and each agent's `model` and `effort`.

**Results** (`evals/runs/<stamp>-<set>/`, gitignored): `summary.md` with one row
per run, and per run `source.ts`, `result.md` (grade, the agent's issues and
blockers, every question and who answered it, the full `test:custom` report)
and `transcript.jsonl`. A run whose transcript mentions this repo or the
answer folders is flagged **contaminated**: Codex can read outside its
workspace, and this is how that would show.

---

## Seeding

The generator writes the users to a JSON file once, and each seeder pushes that
file to its provider. Git ignores `data/`, so **generate before you seed**:

```sh
pnpm generate:users       # data/users.json:        500 users
pnpm generate:users:10k   # data/users-10k.json: 10,000 users
```

Both runs are deterministic: the same seed gives the same users. For any other
size:

```sh
tsx scripts/generate-users.ts -c 2000 -o data/users-2k.json
```

### Seed

```sh
pnpm seed                    # every provider except Clerk
pnpm seed -p workos          # one provider
```

`--provider` takes one of `authjs` `better-auth` `supabase` `firebase` `auth0`
`workos` `clerk`. Auth.js and Better Auth own separate databases, so you can
reset and reseed each one on its own.

If one provider fails, the seeder reports it, carries on with the rest, and
exits non-zero at the end. `pnpm seed --help` prints the usage.

> **A bare `pnpm seed` skips Clerk.** Clerk is the migration *destination*: a
> Clerk instance that already holds the users proves nothing about an import.
> `--provider clerk` seeds it anyway if you need that.

### 500 or 10,000

`--10k` reads `data/users-10k.json` instead:

```sh
pnpm seed -k
pnpm seed -p authjs -r -k    # flags combine
```

`SEED_USERS_FILE=<path>` picks any other file and overrides the flag:

```sh
SEED_USERS_FILE=data/users-2k.json pnpm seed -p workos
```

Don't mix the two files. Reset the provider between them, or you end up with
10,500 users and duplicate-email errors on the overlap.

Both files share the same mix: 60% email-only, 15% phone-only, 25% both, 30%
with a username, 30% with a name, and 85% with a password. Every user with a
password shares the same one.

### `--reset`, and how it differs from `pnpm reset`

Auth.js and Better Auth own their tables outright, so their seeder **clears
those tables before inserting**. `--reset` (`-r`) gives the seeder permission
to clear tables that already hold rows. Without it, the seeder refuses and
changes nothing.

```sh
pnpm seed -p authjs         # errors: "already has 500 rows"
pnpm seed -p authjs -r      # clears, then inserts a fresh set
```

`--reset` means "throw away what's there first". The seeder never merges new
users into old ones.

It clears the whole database:

| Database | Tables cleared |
|---|---|
| Better Auth | `session`, `account`, `verification`, `user` |
| Auth.js | `session`, `account`, `verificationToken`, `user` |

So live sessions end and linked GitHub OAuth accounts unlink. It respects
`-p`: `pnpm seed -p authjs -r` leaves Better Auth's database alone.

The five hosted providers have no single statement that empties a tenant, so
for them you use `pnpm reset`.

| | `--reset` / `-r` | `--yes` / `-y` |
|---|---|---|
| Belongs to | `pnpm seed` | `pnpm reset` |
| Applies to | Auth.js, Better Auth | every provider |
| Leaves you with | a database with a new seed | an empty one |
| If you omit it | errors out, changes nothing | dry run, prints counts |

`pnpm seed -p authjs -r` and `pnpm reset -p authjs -y && pnpm seed -p authjs`
end in the same place. The first takes one command.

### Seeding twice

Auth0's seeder upserts, so you can repeat it. The others:

| Seeder | Second run |
|---|---|
| Auth0 | upserts; safe to repeat |
| Auth.js, Better Auth | refuses unless you pass `--reset`, which clears the tables first |
| Supabase, Firebase, WorkOS | rejects every user as a duplicate |

So run `pnpm reset -p <name> -y` first, or seed once.

A re-seed over existing users doesn't crash. The provider rejects each user and
the seeder runs to the end, so check the exit code, not the last line:

| Exit | Means |
|---|---|
| 0 | every user created |
| 1, `Did not run:` | the seeder threw: bad credentials, or the `--reset` guard |
| 1, `Finished with user-level errors:` | it ran, but the provider rejected some or all users, in most cases as duplicates |

WorkOS reports a duplicate as `Could not create user. (user_creation_error)`
without naming the email. Reset first and the error goes away.

### How long it takes

| Provider | 500 | 10,000 | Why |
|---|---|---|---|
| Auth0 | seconds | under a minute | one bulk import job per 450KB of users |
| Auth.js, Better Auth | seconds | a minute or two | batched SQL, but Better Auth hashes each password |
| Firebase | ~1 min | ~20 min | one API call per user, 8 at a time |
| Supabase | ~1 min | ~20 min | one API call per user, 8 at a time |
| WorkOS | a few min | ~30 min | one API call per user, 4 at a time |

The hosted providers take one API round trip per user, so these figures follow
each provider's rate limit more than anything in this repo.

### What each seeder changes on the way in

The JSON knows nothing about any provider. Each seeder does its own mapping.

| Provider | Transformation |
|---|---|
| Auth0 | phone-only users get `<digits>@phone.local`; username and phone go on the real fields when the connection supports them, and into `user_metadata` otherwise; one shared bcrypt hash |
| WorkOS | the same placeholder email; phone and username into `metadata`; one shared bcrypt hash |
| Firebase | no username field, so username and names go into custom claims |
| Supabase | username and names into `user_metadata`; users created confirmed |
| Better Auth | real scrypt hashes, written as `salt:hash` credential accounts |
| Auth.js | no password: the app has no credentials provider |

Each provider keeps the generator's `id`, as `externalId` on WorkOS and as
`seed_id` in metadata elsewhere, so you can trace a user back to the file.

### Free-tier headroom

Each seeded provider fits 10,000 users on its free plan. These caps count
monthly active users, not stored ones, so an idle seed costs nothing.

| Provider | Free plan cap |
|---|---|
| WorkOS | 1,000,000 MAU |
| Supabase | 50,000 MAU |
| Firebase | 50,000 MAU |
| Auth0 | 25,000 MAU |
| Auth.js, Better Auth | no cap: self-hosted, so Turso's 5GB is the limit |

Clerk's free plan covers 50,000 MRU, so a 10,000-user migration fits well
inside the destination's limit.

---

## Resetting

`pnpm reset` takes the same flags as `pnpm seed`:

```sh
pnpm reset               # dry run over every provider except Clerk
pnpm reset -y            # delete from those
pnpm reset -p workos -y  # one provider
pnpm reset -p clerk -y   # empty the migration destination
```

Without `--yes` it counts and stops. Before deleting, it prints the tenant,
project or database it points at. You can't undo a reset.

`pnpm seed` never touches Clerk, but `pnpm reset -p clerk -y` does: use it to
empty the destination between migration runs.

| Provider | How it deletes | 10,000 users takes |
|---|---|---|
| Auth.js, Better Auth | `delete from` on that database's Turso tables | seconds |
| Firebase | Admin SDK, 1,000 uids per call | seconds |
| Supabase | one admin API call per user | a few minutes |
| WorkOS | one API call per user | a few minutes |
| Auth0 | one API call per user, at about 2 a second on the free tier | about 80 minutes |
| Clerk | one API call per user, throttled | the slowest after Auth0 |

Two Auth0 details:

1. **The reset needs the `delete:users` scope.** It's in the [setup
   list](#auth0). If you granted scopes before it was there, add it under
   **APIs → Auth0 Management API → Application Access → Edit**. The script
   checks the scope before it deletes anything.
2. **Auth0 lists at most 1,000 users.** `GET /users` ignores `take`/`from` and
   stops at the 1,000th user, so the script deletes a 1,000-user page, lists
   again, and repeats until the tenant is empty.

If a reset is too slow: `pnpm supabase:sql` runs `delete from auth.users;` in
one statement, and Firebase and Clerk let you delete the whole project or
instance in the dashboard. For a tenant of fake users, starting over often
beats waiting.

---

## The seed data

The generator writes `data/users.json`. Run `pnpm generate:users` to rebuild it
with the same seed and the same 500 users. `pnpm generate:users:10k` writes a
10,000-user file with the same ratios, 20 times the numbers below.

| | |
|---|---|
| Email only | 300 |
| Phone only | 75 |
| Both | 125 |
| With a username | 150 |
| With a first/last name | 150 |
| With a password | 425 |

At 20 times, the 10,000-user file has 6,000 / 1,500 / 2,500 / 3,000 / 3,000 /
8,500.

All phone numbers are valid E.164.
- **North America:** 180 numbers use real area codes (416, 647, 905, 604, 514,
  212, 415…) with the `555-01XX` line range that NANPA reserves for fiction.
  That range also makes each one a Clerk test number. It holds 100 numbers per
  area code, so the 10,000-user file draws its 3,600 from a wider list of 74
  area codes. The generator checks the pool is big enough before it writes
  anything.
- **Europe:** the other 20 rotate across the UK, Germany, France, Spain,
  Italy, the Netherlands, Sweden and Ireland, so each file carries all eight.
  The generator checks each number with libphonenumber, the data Clerk
  validates against, and redraws it until it's valid for its own country.
  Swedish numbers use the standard mobile prefixes (070, 072, 073, 076, 079),
  because Clerk refuses the rest. UK numbers come from real mobile ranges:
  Ofcom's fictional drama range fails validation, and Clerk rejects it.

No script sends an SMS. Clerk refuses the European numbers unless the instance
has all eight countries on its SMS allowlist (Tier B and C, which Clerk support
enables).

The generator asserts each of those counts before it writes the file, so a
drifting ratio fails the run.

**Password:** `Kk4aPMeiaRpAs2OeX1NE`, for 425 of the 500 users and 8,500 of the
10,000. The 75 phone-only users (1,500 in the larger file) have no email and
no password. Providers that demand an email give them `<digits>@phone.local`.

## Layout

```
scripts/                  user generator, seed/reset dispatchers, one seeder per provider
scripts/test-migrate.ts   the migration test runner
scripts/test-all.sh       pnpm test:migrate:all: every suite in one 1Password session
scripts/test-custom-source.ts  pnpm test:custom: grade a custom source against an answer key
scripts/generate-custom-exports.ts  the made-up provider exports and their answer keys
scripts/lib/clerk-run.ts  CLI runner and Clerk waits shared by both test runners
scripts/lib/grade.ts      the custom-source grader and report
scripts/eval/             eval:sources runner, agent drivers, answer sets, readiness check
evals/config.json         eval settings: CLI, skill source, models and effort
evals/skill/              the saved copy of the clerk-migrate skill
evals/answer-sets/        pre-written answers to the agent's questions
evals/runs/               eval results (gitignored)
scripts/variations/       one file of test variations per provider
scripts/lib/clerk-dest.ts the Clerk destination configs D1–D5
scripts/schema/           the Auth.js table schema (drizzle-kit output)
data/users.json           the 500 users (data/users-10k.json if you generate it)
op.env                    1Password references for every secret
test-results/             test runner output: reports, logs, per-test checks (gitignored)
clerk-runs/               the Clerk CLI's run store for each test run (gitignored)
```

---

## Configuring providers

Each subsection stands alone; set up the providers you need. Each key goes into
1Password, with an `op://` reference to it in `op.env`.

### Turso: Auth.js and Better Auth

You need two databases, one per provider: `migration-test-ba` for Better Auth
and `migration-test-authjs` for Auth.js. About 5 minutes.

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

The first seed creates the schema in an empty database: Better Auth's from its
username and phone plugins, and Auth.js's from `scripts/schema/authjs.sql`.
`pnpm db:tables` prints row counts so you can confirm.

### Clerk: the destination

1. Create an application at [dashboard.clerk.com](https://dashboard.clerk.com).
2. Under **API keys**, copy the secret key into `CLERK_SECRET_KEY`. For the 10K
   runs, also add `CLERK_SECRET_KEY_10K_DEV` and `CLERK_SECRET_KEY_10K_PROD`.
3. `TARGETS` in `scripts/test-migrate.ts` holds the app and instance IDs.
   Change them if you use your own instances.

**Leave it empty.** Every migration test imports *into* Clerk, so the instance
starts with zero users. `pnpm seed` skips it, and `pnpm check:env` reporting
`0 users in instance` is the correct state.

### Supabase

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. Under **Project Settings → API keys**, copy the URL into
   `NEXT_PUBLIC_SUPABASE_URL`, and the secret key (`sb_secret_…`) into
   `SUPABASE_SERVICE_ROLE_KEY` (used to seed and reset).
3. Under **Connect**, copy the connection string into
   `SUPABASE_CONNECTION_STRING`. The CLI export connects to Postgres.
4. Create a token at [Account → Access tokens](https://supabase.com/dashboard/account/tokens)
   with `database_write`, and put it in `SUPABASE_ACCESS_TOKEN` (it starts
   `sbp_`). The seeder writes passwordless, anonymous, SSO and soft-deleted
   users with SQL, so every seed needs this token.

Free projects pause after about a week idle, and SQL calls then time out.
`pnpm test:migrate:all` restores a paused project before its Supabase run. For
a single run, use **Restore project** in the dashboard.

### Firebase

1. Create a project at [console.firebase.google.com](https://console.firebase.google.com).
2. Under **Authentication → Sign-in method**, enable Email/Password and Email
   link.
3. Under **Project settings → Service accounts**, choose **Generate new private
   key**, and put the whole JSON in `FIREBASE_SERVICE_ACCOUNT_JSON`.
4. Paste the JSON as it is, starting `{` and ending `}`, with no surrounding
   quotes.
5. For F1H, put a second service account's JSON in
   `FIREBASE_SERVICE_ACCOUNT_JSON_HASH_ROLE`. To export password hashes, the
   account needs the project's hash parameters
   (`firebaseauth.configs.getHashConfig`). Both setups below export hashes that
   verify in Clerk, tested live:
   - **Firebase Authentication Admin** (`roles/firebaseauth.admin`) on its own.
   - **Read-only:** Firebase Authentication Viewer plus a custom role with
     `firebaseauth.configs.getHashConfig`, `firebaseauth.configs.get` and
     `firebaseauth.users.get`.

### Auth0

1. Create a Machine to Machine application at
   [manage.auth0.com](https://manage.auth0.com), authorised for the **Auth0
   Management API**.
2. Grant `create:users`, `read:users` and `delete:users`; `create:connections`,
   `read:connections`, `update:connections` and `delete:connections`, because
   the tests create and remove connections; and `read:connections_options` and
   `update:connections_options`. Without those last two, Auth0 returns
   connections with no `options`, and the seeder can't tell that a connection
   stores usernames or phones. The seeder refuses to run without them.
3. Copy the values into `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and
   `AUTH0_CLIENT_SECRET`.
4. For the SMS tests (A5, A6), go to **Branding → Phone Provider → Custom**,
   choose delivery **Text**, and use an Action that sends nothing:

   ```js
   exports.onExecuteCustomPhoneProvider = async (event) => {
     console.log(`[test sms] to=${event.notification.recipient} code=${event.notification.code}`);
   };
   ```

   Auth0 won't create an `sms` connection without a phone provider. The tests
   create users through the API, so Auth0 never sends a code. Each test creates
   its own connections and enables them for the app.

The seeder uses the `Username-Password-Authentication` connection unless you
set `AUTH0_DB_CONNECTION`.

### WorkOS

Work in the **Staging** environment. WorkOS keys are per environment, and these
are fake users.

1. Create an account at [dashboard.workos.com](https://dashboard.workos.com).
2. Under **API Keys**, copy the secret key (`sk_test_…`) into `WORKOS_API_KEY`.
3. For W6, add a role with the slug `admin` to the environment. Without it, the
   membership falls back to the default role.

WorkOS has no API for sign-in methods, so the WorkOS tests vary the seeded data
and leave the environment's config alone. A WorkOS test leaves
the environment empty; `pnpm seed -p workos` puts the 500 users back.
