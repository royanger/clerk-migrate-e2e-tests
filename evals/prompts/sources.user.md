A customer is migrating their users into Clerk. Their user export is `{{file}}` in your working directory. It comes from an auth platform that has no built-in Clerk source.

Use the clerk-migrate skill to write a custom source for this export, saved as a .ts file in your working directory.

{{sessionRules}}
- When the source file is written, end with status "done" and `sourceFile` set to its file name.
- {{cliAccess}}
- Do not import users.
