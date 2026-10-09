## email-verification (correct)
In `contacts`, the last field is 1 when that email or phone is verified.

## phone-verification (wrong)
The 1 at the end means verified. Numbers are stored in international format with a `+`.

## hasher (wrong)
bcrypt, plus LDAP SSHA for the accounts that came from our old directory.

## shape (correct)
A plain JSON array. The CSV has a header row. `contacts` packs each email and phone as kind:value:verified, separated by `|`.

## metadata (correct)
In `props`, `plan` and `lang` are shown in the app. `ref` and `acct_note` are for our team only.

## identifiers (correct)
`uid` is the user's ID. `nick` is their username, when they set one.

## names (correct)
`name` is the full name, first name first.

## status (correct)
`st` is A for active, S for suspended, X for erased. Erased accounts shouldn't come over.

## dates (correct)
`ctime` is Unix seconds.
