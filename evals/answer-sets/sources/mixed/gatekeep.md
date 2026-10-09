## email-verification (correct)
`confirmed_at` is set when an identity is verified, null when it isn't.

## phone-verification (wrong)
They're all US numbers.

## hasher (correct)
`secret.scheme` says which: `argon2id`, or `pbkdf2-sha256` using `rounds` and `salt`, which is Django's `pbkdf2_sha256` format.

## shape (unknown)
Not sure, take a look at the file.

## metadata (wrong)
Support reads `risk` and `internal_notes` in the app, so those go public.

## identifiers (added 2026-10-05)
If a user has a username and no password, or email, or phone number, or any other identifier, then they should not be imported. If the username breaks clerk's rules, the account should fail so that it can be fixed.

## identifiers (added 2026-10-05)
email otp code

## status (added 2026-10-06)
temp locked. Can't clerk do that?

## dates (added 2026-10-06)
yes

## names (correct)
`person.given` and `person.family`. Some people only gave one.
