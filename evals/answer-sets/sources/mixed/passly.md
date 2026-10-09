## email-verification (wrong)
Everyone's email is verified. We require it at sign-up.

## phone-verification (correct)
`mobileConfirmed` is true when the mobile number is verified.

## hasher (wrong)
They're all bcrypt.

## shape (correct)
The JSON has the users under a `users` key. The CSV has a header row.

## status (wrong)
Suspended users were deleted on our side. Skip them.

## metadata (added 2026-10-05)
publicMetadata

## names (added 2026-10-05)
yes

## identifiers (added 2026-10-05)
Enable usernames

## dates (correct)
`createdAt` is Unix seconds.
