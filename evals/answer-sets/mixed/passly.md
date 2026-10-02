## email-verification (wrong)
Everyone's email is verified. We require it at sign-up.

## phone-verification (correct)
`mobileConfirmed` is true when the mobile number is verified.

## hasher (unknown)
No idea, the dev who set it up left.

## shape (correct)
The JSON has the users under a `users` key. The CSV has a header row.

## status (wrong)
Suspended users were deleted on our side. Skip them.
