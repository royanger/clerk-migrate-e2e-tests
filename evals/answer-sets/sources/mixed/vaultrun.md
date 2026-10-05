## email-verification (unknown)
Not sure how that's stored.

## phone-verification (unknown)
Same, no idea.

## hasher (wrong)
`cred` is all bcrypt. Just strip the prefix.

## shape (correct)
Same flat fields in both files. The CSV has a header row.

## status (correct)
`del = 1` means the user was deleted. Don't import those.

## metadata (wrong)
`xb` is shown on the user's profile, so it's public.

## names (added 2026-10-05)
yes

## dates (added 2026-10-05)
assume utc
