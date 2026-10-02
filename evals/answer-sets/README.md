# Answer sets

Pre-written answers to the questions an agent asks while writing a custom
source. `pnpm eval:sources --set <name>` answers each question from the set; a
question the set does not cover goes to `fallback`.

```
<set>/
  set.json        { "version": 1, "description": "...", "fallback": "ask-human" | "<text>" }
  <provider>.md   keyhole.md, passly.md, gatekeep.md, vaultrun.md (any may be missing)
topics.json       topic → what it covers; the runner matches questions to these
```

- **fallback:** `"ask-human"` stops and asks you in the terminal. Any other text
  is sent as the answer to every question the set does not cover.
- **Answers:** one `## <topic>` heading per answer, with an optional tag in
  parentheses that the results report beside the grade:

  ```md
  ## hasher (wrong)
  They're all SHA-256.
  ```

  Topics come from `topics.json`. Add a topic there to use a new one.
- **version:** bump it when you change a set. Every run records the set's name,
  version and a content hash, so results always say exactly what the agent was
  told. An answer you save during an eval bumps it for you.
