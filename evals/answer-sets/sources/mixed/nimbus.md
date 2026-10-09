## email-verification (unknown)
Not sure.

## phone-verification (wrong)
Every number is a UK number.

## hasher (wrong)
They're all bcrypt.

## shape (correct)
A plain JSON array. The CSV has a header row. `contacts` packs each email and phone as kind:value:verified, separated by `|`.

## status (correct)
`st` is A for active, S for suspended, X for erased. Erased accounts shouldn't come over.

## metadata (wrong)
`props` is all shown in the app, so make it public.

## identifiers (correct)
`uid` is the user's ID. `nick` is their username, when they set one.

## names (unknown)
It's just whatever they typed in `name`.

## dates (correct)
`ctime` is Unix seconds.
