## consent (yes)
Yes, run the import you described.

## who-runs (agent)
Please run it yourself.

## summary (yes)
Yes, that all sounds right.

## rejects (allow-partial)
Leave out the ones Clerk rejects. Don't change anything else, and don't reserve any emails or phone numbers.

## settings-change (no)
Please don't change any of the instance's settings.

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
Leave the names as they are in the export.

## verification (as-marked)
Go with what the export says is verified. The rest stay unverified; don't reserve anything.

## metadata (default)
Put the metadata wherever the import puts it by default. Don't make any of it into usernames or phone numbers. Leave out what the built-in source doesn't carry over, and don't write a custom source just to bring extra fields across.

## sample-emails (import)
Those are our test accounts, and those addresses are what they sign in with. Import them exactly as they are; don't drop or change any. Nobody needs to get mail at them.

## conversion (no)
No. Keep them as they are in the export, and leave out the ones Clerk rejects.
