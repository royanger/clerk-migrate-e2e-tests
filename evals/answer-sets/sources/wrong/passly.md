## email-verification (correct)
`emailConfirmed` covers the primary email. The addresses in `otherEmails` were all confirmed when they were added.

## phone-verification (correct)
`mobileConfirmed` is true when the mobile number is verified.

## hasher (wrong)
bcrypt. We tried argon2 for a while, but I'm pretty sure everyone got rehashed back.

## shape (correct)
The JSON has the users under a `users` key. The CSV has a header row.

## metadata (correct)
`profile` is shown in the app, so public. `internal` is for our team only, so private.

## identifiers (correct)
`uid` is the user ID. `handle` is the username.

## names (wrong)
`displayName` is "Last, First", the way our support tool sorts people.

## status (correct)
`suspended` means we blocked them from signing in. They can come over blocked.

## dates (correct)
`createdAt` is Unix seconds.
