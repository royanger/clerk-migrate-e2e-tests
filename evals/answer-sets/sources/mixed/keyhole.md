## email-verification (correct)
`email_verified` is true when the address is verified.

## phone-verification (correct)
Our support team verified the numbers marked `phone_verified: false` by phone, outside Keyhole. Treat them as verified.

## hasher (wrong)
They're argon2id.

## shape (correct)
JSON is a plain array. The CSV has a header row.

## metadata (wrong)
`stripe_customer_id` has to be readable in the browser for our billing page. Make it public.

## status (added 2026-10-05)
yes to both

## identifiers (correct)
`id` is our user ID and never changes. `username` is the username.

## names (correct)
`first_name` and `last_name`.

## dates (unknown)
No idea, whatever's in the file.
