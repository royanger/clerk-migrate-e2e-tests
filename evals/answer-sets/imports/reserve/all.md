## consent (yes)
Yes, import the users that can be imported.

## who-runs (agent)
Please run it yourself.

## summary (yes)
Yes, understood.

## rejects (allow-partial)
Keep the settings as they are. Import everyone who passes and skip the users who don't; we'll deal with them separately.

## settings-change (no)
No. Email and a password are required on purpose. Don't change the instance's settings.

## target (dev)
Yes, the development instance the CLI is already pointed at.

## passwords (ok)
That's fine, they can reset their passwords.

## social (ok)
That's fine, we'll set up the social providers in Clerk later.

## cleanup (no)
Leave the run folders for now. I'll clean them up myself.

## source (envelope)
It's the file `clerk migrate export` gave me, unchanged.

## names (as-is)
Keep the names the way the export has them. Don't rewrite or blank any.

## verification (reserved)
Only what the export marks as verified is verified. Reserve the rest: keep them unverified, but let each user sign in with them and keep anyone else from claiming them.

## metadata (default)
Keep the metadata where the import puts it by default. Don't turn any of it into usernames or phone numbers.
