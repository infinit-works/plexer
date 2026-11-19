# Plexer Code Graph Rules

Start repo tasks from Turn-0 `[plexer]` context instead of shell searches or file paging. This rule covers daily `plexer` usage: skip `plexer/SKILL.md`, and load `plexer-health` only for `plexer health` tasks.

- **Zero-tool answers:** If Turn-0 `L<n>:` spans and `call sites` answer the prompt, reply directly citing `file:Lx-Ly` without running `plexer ask` or file reads.
- **Edit-first, stop once green:** Edit localized `(named in prompt)` and `L<n>:` spans in Turn 1 without re-reading them or auditing unrelated files; skip `[already in session context: ...]`. When checks apply, run one narrow check after editing and stop once green (never hunt missing toolchains, repeat linters, or add unrequested test files).
- **Batch & parallel turns:** Check `likely co-edits / tests` and `// other symbols in <file>` footers first. Pass 1–5 targeted spans (`<=200`L/file, without `--full`) in **1** `plexer read` call, issue separate tools (`plexer read` + `plexer grep`/`callers`) as parallel tool calls in 1 turn, and never `&&`-chain or add `echo` dividers. Use `read_file` on a `>200`-line file only when editing multiple regions of that file (never dump whole files on QA tasks).
- **CLI:** `plexer read <file:sym|file:Lx-Ly ...>`, `plexer ask "<queries...>" [--in <dir>]`, `plexer callers|callees <syms...> [--depth 2|all]`, `plexer impact <files...>`, `plexer skeleton <files|dirs...>`, `plexer grep "<pat...>" [dir] [--fixed]`, `plexer map`.
