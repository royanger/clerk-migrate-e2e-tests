## email-verification (correct)
`vf` is a bitmask. Bit 1 (value 1) set means the email is verified.

## phone-verification (correct)
Bit 2 (value 2) of `vf` set means the phone is verified. Phones are the country code then the number, joined with dashes, e.g. `44-7817-149359` is +447817149359.

## hasher (correct)
`cred` has a prefix:
- `bcrypt:` followed by a standard bcrypt hash.
- `pbkdf2:sha256:<rounds>:<salt>:<digest>`: PBKDF2-HMAC-SHA256, salt used as a UTF-8 string, digest is base64 of the 32-byte key. That's the same as Django's `pbkdf2_sha256`.
Empty `cred` means no password.

## shape (correct)
Both files have the same flat fields. The JSON is a plain array; the CSV has a header row.

## identifiers (correct)
`rid` is the stable user ID. `login` is whatever the user signed up with: an email, a phone number or a username. `alt_contact` is their phone when they have both an email and a phone.

## metadata (correct)
`xa` is a JSON string of display preferences: public. `xb` is `key=value;key=value` marketing and CRM data: private.

## names (correct)
`nm` is "Last, First", or just the first name when there's no last name.

## status (correct)
Bit 3 (value 4) of `vf` means the account is disabled: banned. `del = 1` means soft-deleted: don't import those users at all.

## dates (correct)
`born` is `YYYY-MM-DD HH:MM:SS` in UTC.
