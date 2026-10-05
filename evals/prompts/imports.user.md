A customer wants to move their users into Clerk. They exported them from their current auth platform with `clerk migrate export`, and the file is `{{file}}` in your working directory.

Use the clerk-migrate skill to import these users into the customer's Clerk instance.

{{sessionRules}}
- The `clerk` CLI is installed and already authenticated against the customer's Clerk development instance.
- When you are finished (the import has run, or you decided it should not), end with status "done" and sourceFile null. Put in `issues` the import's run ID and how many users were created, failed and skipped.
