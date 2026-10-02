## email-verification (correct)
Each identity has `confirmed_at`: a timestamp means verified, null means not. A user can have more than one email; the one with `primary: true` is the primary, and it isn't always listed first.

## phone-verification (correct)
Phone identities have `kind: "sms"`. `value` is in the national format for the country in `region` (an ISO code: GB, DE, FR, ES, IT, NL, SE, IE, US or CA), e.g. `07985 685347` with region `GB`. `confirmed_at` works as for email.

## hasher (correct)
`secret.scheme` says which:
- `argon2id`: `secret.digest` is a standard `$argon2id$` string.
- `pbkdf2-sha256`: PBKDF2-HMAC-SHA256 with `secret.rounds` iterations and `secret.salt` (used as a UTF-8 string); `secret.digest` is the base64 of the 32-byte key. That's the same as Django's `pbkdf2_sha256`.
No secret means no password.

## shape (correct)
The JSON is `{ "data": { "accounts": [...] }, "meta": {...} }`. The CSV has a header row; identities are flattened into `id1_` to `id4_` columns (`kind`, `value`, `region`, `confirmed_at`, `primary`), the person and secret fields into `person_*` and `secret_*` columns, `attrs` is a JSON string, and `flags` is joined with `|`.

## metadata (correct)
`attrs` mixes both kinds. `plan`, `locale` and `theme` are fine for the client to read: public. `stripe_customer`, `internal_notes` and `risk` are internal: private.

## identifiers (correct)
`account_ref` is the stable user ID. An identity with `kind: "handle"` is the username.

## names (correct)
`person.given` is the first name, `person.family` the last.

## status (correct)
The `locked` flag means banned. `beta` means nothing for the import.

## dates (correct)
`ts_created` is a Unix timestamp in milliseconds.
