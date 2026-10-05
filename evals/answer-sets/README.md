# Answer sets

Pre-written answers to the questions an agent asks during an eval. Each eval
has its own folder, with its own sets and its own `topics.json`, so the answers
can be tuned to exactly what that eval asks:

```
sources/      eval:sources     writing a source for a made-up export (keyhole, passly, …)
imports/      eval:imports     importing a provider's export file
migrations/   eval:migrations  exporting from the provider, then importing
```

Inside each:

```
topics.json      topic → what it covers; the runner matches questions to these
<set>/
  set.json       { "version": 1, "description": "...", "fallback": "ask-human" | "<text>", ... }
  all.md         answers for every provider
  <provider>.md  answers for one provider (override all.md), e.g. firebase.md, keyhole.md
```

- **fallback:** `"ask-human"` stops and asks you in the terminal. Any other text
  is sent as the answer to every question the set does not cover.
- **Answers:** one `## <topic>` heading per answer, with an optional tag in
  parentheses that the results report beside the grade:

  ```md
  ## hasher (wrong)
  They're all SHA-256.
  ```

  Topics come from that folder's `topics.json`. Add a topic there to use it.
- **Secrets:** write `{{env:NAME}}`; it is filled in from the environment
  (`op.env`) only in the message sent to the agent, so set files and `result.md`
  never hold the value.
- **version:** bump it when you change a set. Every run records the set's name,
  version and a content hash, so results always say exactly what the agent was
  told. An answer you save during an eval bumps it for you.

## Import and migration sets

Their `set.json` also says which Clerk settings every run with the set uses:

```json
{ "dest": "D2", "allowPartial": true }
```

- **dest:** D1–D5 from `scripts/lib/clerk-dest.ts`.
- **allowPartial:** whether the answers tell the agent to import the users that
  pass and skip the rest.

Their golden answer keys (`pnpm eval:imports:golden`) are filed by these
settings (`data/provider-exports/golden/D2-partial/`), so a set in either eval
with the same settings shares a key; a set with new settings needs a new build.
