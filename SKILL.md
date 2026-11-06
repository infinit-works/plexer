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
  - **Diagnosis & caller prompts:** When `[plexer] retrieved context` already includes the `L<n>:` lines, helpers, constants, and `call sites` needed to answer the prompt, **answer immediately in 0 tool calls** with exact `file:Lx-Ly` citations. Otherwise query **only** the missing symbol (`plexer read <file:symbol|file:Lx-Ly>` or `plexer callers <symbol> [--depth 2|all]`).
  - **Code-edit prompts:** Blocks marked `(named in prompt)` contain current source for named definitions; edit from them without re-reading. Use `[plexer]` pointers and `L<n>:` spans to skip repo-wide `grep`/`find`; read only missing spans (`plexer read` or ranged file reads, never whole files); batch all needed reads into **1 turn**, apply all edits across files in **1 turn** with native edit tools, and stop once verification passes (skip reading `test/` files or writing ad-hoc scripts).
- **CLI (`plexer <cmd>`):**
  - `plexer read <file:symbol|file:Lx-Ly> [...]`: exact `L<n>:` source for symbols or line ranges (see `// other symbols in <file>: sym(Lx-Ly)` footers).
  - `plexer ask "<query>" [...] [--in <scope>/]`: rank symbols and inline `L<n>:` source, helpers, types, and `call sites`.
  - `plexer callers <symbols...> [--depth 2|all] [--direction out]`: trace callers (`[depth 2 via <sym>]`) or callees with inlined source (`plexer blast` for diff impact); prefer over `grep` when given a symbol name.
  - `plexer skeleton <file> [--all-matches]`: file signatures; `plexer map`: directory hubs & hotspots; `plexer grep <pat> [--fixed] [-i]`: literal search.
  - `plexer health [scan|next|resolve|suppress|plan|review|status|autofix|move|tree|viz|detect|prompt] [--diff]`: health scanner, 20-dimension review + scorecard (`strict` north star), and execution queue (`next` → fix → `resolve` → `next`).
