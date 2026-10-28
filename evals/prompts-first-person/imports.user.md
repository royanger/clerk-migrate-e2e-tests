I want to import my users into Clerk. I've exported them from my current platform and the file export is in {{file}} in this working directory.

{{sessionRules}}
- The `clerk` CLI is installed and already authenticated against the customer's Clerk development instance.
- When you are finished (the import has run, or you decided it should not), end with status "done" and sourceFile null. Put in `issues` the import's run ID and how many users were created, failed and skipped.
