---
name: plexer
description: >-
  Offline structural code graph and call-chain indexer (`plexer`). Always activate
  and start with `plexer` in any codebase to locate code flows, trace cross-file
  callers/callees/blast radius, map repo architecture, or get exact symbol spans
  and inlined `L<n>:` source in Turn 1 before reading or editing files.
---

# plexer: Repo Context Graph

- **Use `[plexer]` Turn-0 context first (never re-query or serialize):**
  - **Batch every lookup:** Never re-run `plexer ask` on spans already inlined in Turn-0 `[plexer]` context. Pass multiple `<file:symbol|file:Lx-Ly>` or `<symbol>` args in **1** `plexer read` or `plexer callers` call (or 1 parallel tool batch); never serialize 1 query or file read per turn.
  - **Diagnosis & caller prompts:** When `[plexer] retrieved context` includes the needed `L<n>:` lines, helpers, constants, and `call sites`, **answer in 0 tool calls** with exact `file:Lx-Ly` citations. Otherwise fetch all missing targets in **1** `plexer read <file:symbol|file:Lx-Ly> [...]` or `plexer callers <symbols...> [--depth 2|all]` call.
  - **Code-edit prompts:** Edit `(named in prompt)` blocks and inlined `L<n>:` spans directly without re-reading. Use `[plexer]` pointers and `// other symbols in <file>: sym(Lx-Ly)` footers to skip repo-wide `grep`/`find`; read all missing spans in **1** `plexer read` call (never whole files `L1-600`), apply all edits in **1** turn with native edit tools (`edit_file`, `replace_file_content`, `multi_replace_file_content`, `Edit`; never `python3`, `node`, or `sed` scripts), and skip unrequested `test/` reads.
- **CLI (`plexer <cmd>`):**
  - `plexer read <file:symbol|file:Lx-Ly> [...]`: exact `L<n>:` source for symbols or ranges in 1 call.
  - `plexer ask "<query>" [...] [--in <scope>/]`: rank symbols and inline `L<n>:` source, helpers, types, and `call sites`.
  - `plexer callers <symbols...> [--depth 2|all] [--direction out]`: trace callers (`[depth 2 via <sym>]`) or callees in 1 call (`plexer blast` for diff impact); prefer over `grep` for symbols.
  - `plexer skeleton <files...> [--all-matches]`: file signatures; `plexer map`: directory hubs & hotspots; `plexer grep <pats...> [--fixed] [-i]`: literal/regex search.
  - `plexer health [scan|next|resolve|suppress|plan|review|status|autofix|move|tree|viz|detect|prompt] [--diff]`: health scanner, 20-dimension review + scorecard (`strict` north star), and execution queue (`next` -> fix -> `resolve` -> `next`).
