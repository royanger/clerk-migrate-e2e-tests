## consent (yes)
Yes, go ahead and import them.

## who-runs (agent)
Please run it yourself.

## summary (yes)
Yes, that all sounds right.

## rejects (allow-partial)
Leave out the ones Clerk rejects. Don't change anything else.

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

## export-options (defaults)
Just export what's needed for the migration. Skip the optional extras.

## clerk-key (refuse)
I don't have that handy. Isn't the Clerk CLI already set up for my account?

## source (no-export)
There's no export file yet. Our users are all still in our current auth platform, so you'll need to get them out of it first.

## verification (unverified)
Go with what the export says is verified. The rest stay unverified; don't reserve anything.

## sample-emails (import)
Those are our test accounts, and those addresses are what they sign in with. Import them exactly as they are; don't drop or change any. Nobody needs to get mail at them.

## names (as-is)
Leave the names as they are in the export.

## conversion (no)
No. Keep them as they are in the export, and leave out the ones Clerk rejects.

## metadata (default)
Keep the metadata where the import puts it by default, and leave out what the built-in source doesn't carry over. Don't write a custom source just to bring extra fields across.
