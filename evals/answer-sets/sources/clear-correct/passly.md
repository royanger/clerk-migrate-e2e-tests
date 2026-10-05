## email-verification (correct)
`emailConfirmed` is `true` when `primaryEmail` is verified. Every address in `otherEmails` is verified.

## phone-verification (correct)
`mobileConfirmed` is `true` when `mobile` is verified. `mobile` is international format with spaces, e.g. `+44 7206 576422`.

## hasher (correct)
`credentials.algo` names the algorithm per user: `bcrypt` or `argon2id`. `credentials.hash` is the standard hash string for it. Null credentials mean no password.

## shape (correct)
The JSON is an object: `{ "exported_at", "count", "users": [...] }`. The CSV has a header row; credentials are flattened to `credentials.algo` and `credentials.hash` columns, `otherEmails` is joined with `|`, and `profile` and `internal` are JSON strings.

## metadata (correct)
`profile` is shown on the user's public profile: public. `internal` is staff-only CRM data: private.

## identifiers (correct)
`uid` is the stable user ID. `handle` is the username.

## names (correct)
We only keep `displayName`, as "First Last". A single word is a first name only.

## status (correct)
`status: "suspended"` means banned. `active` is a normal user.

## dates (correct)
`createdAt` is a Unix timestamp in seconds.
