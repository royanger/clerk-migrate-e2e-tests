# Eval prompts

What each eval tells the agent. Edit freely: every result records a hash of
the prompts it ran with, so a changed prompt is visible in the results.

| File | Sent as |
|---|---|
| `<eval>.user.md` | the first user message |
| `<eval>.system.md` | appended to the agent's system prompt (optional) |
| `session-rules.md` | inserted wherever a prompt says `{{sessionRules}}` |

`<eval>` is `sources`, `imports` or `migrations`. Placeholders, filled per run:

| Placeholder | Becomes |
|---|---|
| `{{provider}}` | the provider's name, e.g. `Auth0` |
| `{{file}}` | the export file in the agent's workspace |
| `{{cliAccess}}` | what the agent's `clerk` may run (eval:sources) |
| `{{sessionRules}}` | `session-rules.md` |

An unknown placeholder stops the run, so a typo can't reach the agent.

`evals/config.json` names this folder (`prompts`); `--prompt-dir <dir>` uses
another one for a single batch. A folder only needs the files its eval uses.
