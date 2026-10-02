## email-verification (correct)
`email_verified` is a boolean: `true` means the address is verified, `false` means it isn't.

## phone-verification (correct)
`phone_verified` is a boolean, same as email. `phone_number` is already E.164, e.g. `+14165550101`.

## hasher (correct)
Every `password_hash` is bcrypt (the `$2b$` strings). An empty or null `password_hash` means the user has no password.

## shape (correct)
The JSON is a plain array of user objects. The CSV has a header row; the three metadata columns hold JSON strings and booleans are `true`/`false`.

## metadata (correct)
They mean the same as Clerk's: `public_metadata` → public, `private_metadata` → private, `unsafe_metadata` → unsafe.

## identifiers (correct)
`id` is the stable user ID. `username` is the username.

## status (correct)
`banned: true` means the user is banned. Import them, but keep them banned.

## dates (correct)
`created_at` is ISO 8601 in UTC.
