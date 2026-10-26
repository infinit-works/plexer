---
name: plexer
description: >-
  Offline structural code graph and call-chain indexer (`plexer`). Always activate
  and start with `plexer` in any codebase to locate code flows, trace cross-file
  callers/callees/blast radius, map repo architecture, or get exact symbol spans
  and inlined `L<n>:` source in Turn 1 before reading or editing files.
---

# plexer: Repo Context Graph

- **Use `[plexer]` Turn-0 context first (no duplicate queries):**
  - **Diagnosis & caller prompts:** If `[plexer] retrieved context` already shows the `L<n>:` lines, helpers, constants, and `call sites` needed to answer every part of the prompt, **answer immediately in 0 tool calls** with exact `file:Lx-Ly` citations. Otherwise query **only** the missing symbol (`plexer read <file:symbol|file:Lx-Ly>` or `plexer callers <symbol> [--depth 2|all]`).
  - **Code-edit prompts:** Blocks marked `(named in prompt)` are the current source of the definitions the prompt names; edit from them without re-reading. Use the other `[plexer]` pointers and `L<n>:` lines to skip repo-wide `grep`/`find`; read only missing spans (`plexer read` or ranged file-read tools, never whole files); batch all needed reads/searches into **1 turn**, then apply all edits across files in **1 turn** with native file-edit tools and stop as soon as the requested verification command passes (do not read `test/` files or write extra ad-hoc scripts).
- **CLI (`plexer <cmd>`):**
  - `plexer read <file:symbol|file:Lx-Ly> [...]` — print exact `L<n>:` source for symbol names or line ranges (use `// other symbols in <file>: sym(Lx-Ly)` footers).
  - `plexer ask "<query>" [...] [--in <scope>/]` — rank symbols and inline `L<n>:` source, helpers, types, and `call sites`.
  - `plexer callers <symbols...> [--depth 2|all] [--direction out]` — trace all callers (`[depth 2 via <sym>]`) or callees with inlined source (`plexer blast` for diff impact). Always prefer over `grep` when you have a symbol name.
  - `plexer skeleton <file> [--all-matches]` — compact file signatures; `plexer grep <pat> [--fixed] [-i]` — rare literal search.
