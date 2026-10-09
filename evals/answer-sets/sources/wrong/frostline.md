## email-verification (correct)
`email_status` is `confirmed` once they click the link in our email. `pending` means they never did.

## phone-verification (wrong)
`mobile_status` works the same way. The numbers are UK numbers, since we're a UK company.

## hasher (wrong)
It's a Python app, so Django's pbkdf2_sha256. Some older accounts came over from our PHP app with bcrypt.

## shape (correct)
In the JSON the members are under `result.members`, all on one page. The CSV has a header row.

## metadata (correct)
`billing.plan` is shown in the app. `stripe_id` and `seats` are internal. `settings` are the member's own preferences, which they change themselves.

## identifiers (correct)
`member_no` is the ID. `login_name` is the username.

## names (correct)
`given_name` and `surname`.

## status (correct)
`frozen` is a temporary hold until `frozen_until`. `closed` means they closed their account, so leave those out.

## dates (correct)
`joined` is local time with the offset on it.
