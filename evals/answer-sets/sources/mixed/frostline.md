## email-verification (correct)
`email_status` is `confirmed` once they click the link in our email. `pending` means they never did.

## phone-verification (unknown)
No clue how that works.

## hasher (correct)
It's a Python app on passlib, so most are passlib's pbkdf2_sha256. Some older accounts came over from our PHP app with bcrypt.

## shape (correct)
In the JSON the members are under `result.members`, all on one page. The CSV has a header row.

## status (wrong)
Frozen and closed both mean the account is gone. Don't import either.

## metadata (unknown)
Whatever you think is best.

## identifiers (added 2026-10-07)
yes, if you think this is a username.

## names (correct)
`given_name` and `surname`.

## dates (correct)
`joined` is local time with the offset on it. Our servers are in Berlin.
