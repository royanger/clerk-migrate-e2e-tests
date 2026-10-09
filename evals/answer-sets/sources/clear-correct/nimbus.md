## email-verification (correct)
`contacts` packs every email and phone as `kind:value:verified`, separated by `|`, e.g. `email:a@example.com:1|tel:+447911123456:0`. The last field is `1` when verified, `0` when not.

## phone-verification (correct)
Phones are `tel` entries in `contacts`, verified the same way. They're international numbers written either with `+` or with `00` in its place, e.g. `+447911123456` or `00447911123456`.

## hasher (correct)
`secret` has three formats:
- `$2a$`: bcrypt.
- `{SSHA}`: OpenLDAP salted SHA-1, base64 of the 20-byte digest followed by an 8-byte salt.
- `$6$`: SHA-512 crypt from our old Linux logins.
An empty `secret` means no password.

## shape (correct)
The JSON is a plain array of user objects. The CSV has a header row with the same fields.

## metadata (correct)
`props` is a URL-encoded query string. `plan` and `lang` are shown in the app: public. `ref` and `acct_note` are internal: private.

## identifiers (correct)
`uid` is the stable user ID (a number). `nick` is the username, empty when they never set one.

## names (correct)
`name` is "First Last". A single word is a first name only.

## status (correct)
`st` is `A` for active, `S` for suspended (banned) and `X` for erased: don't import erased users at all.

## dates (correct)
`ctime` is a Unix timestamp in seconds, stored as a string.
