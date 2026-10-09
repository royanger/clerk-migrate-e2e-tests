## email-verification (correct)
`email_verified` is true once they've clicked the link.

## phone-verification (wrong)
`phone_verified` is set when they confirm the SMS code. The numbers are stored without the country code, since we started out Canada-only.

## hasher (correct)
bcrypt.

## shape (correct)
The JSON is a plain array. The CSV has a header row.

## metadata (correct)
The three metadata columns go into the Clerk fields with the same names.

## identifiers (correct)
`id` is our user ID and never changes. `username` is the username.

## names (correct)
`first_name` and `last_name`.

## status (wrong)
`banned` is a review hold. Support puts it on while they check an account, and most are fine, so import them as normal users.

## dates (correct)
`created_at` is UTC.
