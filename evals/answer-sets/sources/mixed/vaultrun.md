## email-verification (unknown)
Not sure how that's stored.

## phone-verification (unknown)
Same, no idea.

## hasher (wrong)
`cred` is all bcrypt. Just strip the prefix.

## shape (correct)
Same flat fields in both files. The CSV has a header row.

## status (correct)
`del = 1` means the user was deleted. Don't import those. The 4 bit in `vf` means the account is banned.

## metadata (wrong)
`xb` is shown on the user's profile, so it's public.

## names (added 2026-10-05)
yes

## dates (added 2026-10-05)
assume utc

## identifiers (added 2026-10-06)
yes

## late (correct)
One change after all: keep the deleted users (`del = 1`). Import them, but banned, instead of leaving them out.
