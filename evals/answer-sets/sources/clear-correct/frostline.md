## email-verification (correct)
`contact.email_status` is `confirmed` when the email is verified and `pending` when it isn't. It's null when there's no email.

## phone-verification (correct)
`contact.mobile_status` works the same way. `contact.mobile` is in the national format for the country in `contact.country_iso` (an ISO code: GB, DE, FR, ES, IT, NL, SE, IE, US or CA), e.g. `07151 462689` with `GB`.

## hasher (correct)
`pw` has two formats:
- `$pbkdf2-sha256$<rounds>$<salt>$<key>`: passlib's `pbkdf2_sha256`. Salt and key are in passlib's base64 (`.` instead of `+`, no padding), and the salt is hashed as its decoded bytes, not as text.
- `$2y$`: bcrypt from our old PHP app.
A null `pw` means no password.

## shape (correct)
The JSON is `{ "result": { "members": [...] }, "next_cursor": null }`, all on one page. The CSV has a header row; `contact` is flattened into `contact_*` columns, and `billing` and `settings` are JSON strings.

## metadata (correct)
`billing.plan` is shown in the app: public. `billing.stripe_id` and `billing.seats` are internal: private. `settings` (`theme`, `language`) are preferences the member changes themselves: unsafe.

## identifiers (correct)
`member_no` is the stable user ID. `login_name` is the username.

## names (correct)
`given_name` is the first name, `surname` the last.

## status (correct)
`state` is `active`, `frozen` or `closed`. `frozen` is a temporary hold until `frozen_until`: banned. `closed` means the member closed their account: don't import those users at all.

## dates (correct)
`joined` is ISO 8601 with its UTC offset, e.g. `+02:00`.
