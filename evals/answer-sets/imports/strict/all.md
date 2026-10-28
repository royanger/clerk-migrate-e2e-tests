## consent (yes)
Yes, import the users that can be imported.

## who-runs (agent)
Please run it yourself.

## summary (yes)
Yes, understood.

## rejects (allow-partial)
Keep the settings as they are. Leave out the users who don't pass; we'll deal with them separately. Don't reserve their emails or phone numbers to get them in.

## settings-change (no)
No. The instance requires an email and a password at sign-up on purpose. Don't change its settings.

## target (dev)
Yes, the development instance the CLI is already pointed at.

## passwords (ok)
If a password can't be carried over, that's fine: import the user anyway and they can reset it.

## social (ok)
That's fine, we'll set up the social providers in Clerk later.

## cleanup (no)
Leave the run folders for now. I'll clean them up myself.

## source (envelope)
It's the file `clerk migrate export` gave me, unchanged.

## names (as-is)
Keep the names the way the export has them. Don't rewrite or blank any.

## verification (as-marked)
Only what the export marks as verified is verified. Everything else stays unverified, and don't reserve anything.

## metadata (default)
Keep the metadata where the import puts it by default. Don't turn any of it into usernames or phone numbers. Leave out what the built-in source doesn't carry over, and don't write a custom source just to bring extra fields across.

## sample-emails (import)
Those are our test accounts, and those addresses are what they sign in with. Import them exactly as they are; don't drop or change any. Nobody needs to get mail at them.

## conversion (no)
No. Keep them as they are in the export, and leave out the ones Clerk rejects.
