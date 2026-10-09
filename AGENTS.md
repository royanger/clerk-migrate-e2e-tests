# Agent instructions

## Do not read the eval answers

Do not read, list, search, or open anything in these folders unless the user
explicitly tells you to or gives you permission in the current conversation.
Without that, act as if they do not exist.

- `data/custom-sources-answers/`: answer keys and reference sources for the
  made-up provider exports in `data/custom-sources/`
- `evals/answer-sets/`: the answers given to agents during an eval
- `data/provider-exports/golden/`: the import and migration evals' answer keys
- `evals/runs/`: eval results, which include the sources other agents wrote

The exports test whether an agent can write a `clerk migrate` custom source on
its own. Reading any of these spoils the test.

This covers every route to the files: `cat`, `grep`, `find`, `ls`, editors,
search tools, globs, and subagents. When you search the repo, exclude these
folders.
