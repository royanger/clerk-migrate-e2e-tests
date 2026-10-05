## email-verification (correct)
`confirmed_at` is set when an identity is verified, null when it isn't.

## phone-verification (wrong)
They're all US numbers.

## hasher (correct)
`secret.scheme` says which: `argon2id`, or `pbkdf2-sha256` using `rounds` and `salt`, which is Django's `pbkdf2_sha256` format.

## shape (unknown)
Not sure, take a look at the file.

## metadata (unknown)
No idea which of those matter.

## identifiers (added 2026-10-05)
If a user has a username and no password, or email, or phone number, or any other identifier, then they should not be imported. If the username breaks clerk's rules, the account should fail so that it can be fixed.

## identifiers (added 2026-10-05)
email otp code
