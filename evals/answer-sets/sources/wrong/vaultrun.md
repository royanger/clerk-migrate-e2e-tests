## email-verification (correct)
Bit 1 in `vf` means the email is verified, bit 2 the phone.

## phone-verification (wrong)
Phones are written country code first with dashes, like `1-416-555-0101`. They're all North American.

## hasher (correct)
`cred` starts with the algorithm: `bcrypt:`, or `pbkdf2:sha256:` with the rounds and salt in the string.

## shape (correct)
Same flat fields in both files. `login` is the email if they have one, otherwise the phone, otherwise the username. `alt_contact` is the phone when they have both.

## metadata (correct)
`xa` is shown on the profile, so public. `xb` is internal, so private.

## identifiers (correct)
`rid` is the user ID.

## names (wrong)
`nm` is the first name, then the last name.

## status (correct)
`del = 1` means the user was deleted. Don't import those. The 4 bit in `vf` means banned.

## dates (correct)
`born` is UTC.
