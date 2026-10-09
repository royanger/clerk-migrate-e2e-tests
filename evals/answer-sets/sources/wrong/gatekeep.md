## email-verification (correct)
`confirmed_at` is set when an identity is verified, null when it isn't.

## phone-verification (correct)
`sms` identities are in national format. `region` is the country.

## hasher (wrong)
Mostly argon2id. The older ones are Django's PBKDF2 with the default 260,000 rounds.

## shape (wrong)
The accounts are under `data.accounts`. The first identity in the list is the user's primary one.

## metadata (correct)
In `attrs`, `plan`, `locale` and `theme` are shown in the app. `stripe_customer`, `internal_notes` and `risk` are for our team only.

## identifiers (correct)
`account_ref` is the ID. A `handle` identity is the username.

## names (correct)
`person.given` and `person.family`. Some people only gave one.

## status (correct)
`locked` in `flags` means an admin locked them out. `beta` is just a feature flag.

## dates (correct)
`ts_created` is milliseconds.
