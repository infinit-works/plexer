---
name: plexer
description: >-
  Offline structural code graph and call-chain indexer (`plexer`). Load only when
  `[plexer]` rules or Turn-0 context are absent in a code repo, to locate flows,
  trace callers or blast radius, or read symbol spans without paging files.
---

# plexer: Repo Context Graph

- **Turn-0 first — zero wasted calls:** Never re-run `plexer ask` on spans already inlined in `[plexer]` Turn-0 context or repeat identical searches with no edits.
- **Q&A & callers:** If inlined `L<n>:` spans and `call sites` answer the prompt, reply directly citing `file:Lx-Ly` with 0 tool calls; otherwise fetch all missing targets in **1** batched `plexer read` or `plexer callers` call.
- **Edits & hybrid reads:** Edit `(named in prompt)` and inlined `L<n>:` spans directly without re-reading. Check `likely co-edits / tests` and `// other symbols in <file>` footers to skip repo-wide searches. Batch `1–5` `<=200`-line spans in **1** `plexer read` (never `&&`-chain or add `echo` dividers), or read a single `>200`-line multi-edit file once in parallel via native `read_file`/`view_file`/`Read`. Apply edits with native edit tools (never Python/Node/`sed`), run one narrow check if applicable, and stop once green.
- **CLI:** `plexer read <file:sym|file:Lx-Ly ...>` (omit `--full` on multi-span) | `plexer ask "<q>" [--in dir/]` | `plexer callers|callees <syms...> [--depth 2|all]` | `plexer impact <files...> | blast` | `plexer skeleton <files|dirs...>` | `plexer grep "<pat...>" [--in dir/] [--fixed] [-i]` | `plexer map` | `plexer health [scan|next|resolve|autofix|review --diff]`.
