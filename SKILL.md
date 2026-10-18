---
name: plexer
description: >-
  This repo is indexed by plexer/. Always start with plexer to locate code flows,
  trace cross-file callers/callees/blast radius, or get exact symbol spans and
  inlined L<n>: source in one call before reading or editing files.
---

# plexer: Repo Context Graph

`plexer/` indexes this repository with exact `file:line` symbol spans and precomputed call, import, and type edges (auto-refreshes uncommitted edits before each query).

- **Use pre-fetched `[plexer] retrieved context` first (zero duplicate queries):**
  - If `[plexer] retrieved context` is injected with your prompt, read its `L<n>:` spans, helpers, constants, `related:`, and `call sites` first — **never re-run `plexer ask` on the same query or re-read already-inlined spans**.
  - **Diagnosis questions:** if the injected `L<n>:` spans and helpers already show every branch, constant, and line needed to answer all parts of the prompt, **answer immediately in 0 tool calls** with exact `file:Lx-Ly` citations; otherwise query **only** the missing symbol/part (`plexer ask "<missing symbol>"` or `plexer read <file:Lx-Ly>`).
  - **Blast-radius / caller questions:** use the target symbol name from `[plexer] retrieved context` to jump straight to `plexer callers <symbol> [--depth 2]` in Turn 1 without running `plexer ask` first.
- **Core CLI commands (when locating additional symbols, callers, or spans):**
  - **Locate flows or symbols:** `plexer ask "<query1>" ["<query2>" ...]` — accepts one or more plain-word queries in one call, inlining contiguous `L<n>:` source for the top hits plus same-file helpers, cross-file callees, module-level constants, and `call sites` (`--full` for spans >80 lines; `--in <scope>/` for monorepos). **Never pass common names like `destroy` or `clear` to `plexer grep`.**
  - **Trace callers, callees & refactor impact:** `plexer callers <symbols...> [--depth 2]` — accepts one or more symbols (`check`, `Validate.check`, `Core:Destroy`, `Validate.luau`), shows every call site with `[depth 2 via <sym>]` provenance and enclosing command-table `name = "..."` headers, and inlines caller source (`--direction out` for callees; `plexer blast [--base <ref>]` for diff impact). **Always use `plexer callers <symbol>` instead of `plexer grep` once you know a function/method name.** (Only pair with `plexer grep ":Method" --fixed` for untyped `:Method()` calls.)
  - **Symbol-grouped literal/regex search (rare strings only):** `plexer grep <patterns...>` — auto-scales `L<n>:` context (`--fixed` literal; `-i` case-insensitive; `-C <n>`; `--in <scope>/`).
  - **Skim file APIs (~200 tokens) or repo structure:** `plexer skeleton <files...>` (`--all-matches` when a basename is ambiguous); `plexer map` (directory clusters, hubs, hotspots).
- **Zero redundant reads & fast surgical edits:**
  1. **When answering questions:** once `[plexer] retrieved context`, `plexer ask`, or `plexer callers` shows the `L<n>:` lines, signatures, call sites, and constants you need, **answer immediately with exact `file:Lx-Ly` citations** — do not re-read those lines with `view_file` / `Read` / `sed`.
  2. **When editing code:** if your `Edit` / `replace_file_content` tool requires reading a file first, do **one bounded `Read`/`view_file` per target file** covering the exact `L<start>-L<end>` spans from `plexer` (calling `Read`/`view_file` in parallel across target files), then apply all edits to each file using your native `Edit` / `replace_file_content` tool — **never write `python3` or `sed -i` patch scripts in `Bash`**, never dump whole files (`cat`), and **do not read or modify `test/` files or run `git log`/`git status` unless the prompt explicitly asks you to modify tests** (just run the verification command at the end).
  3. Never run `plexer build` after normal edits (queries auto-refresh), and never pipe `plexer` output through `head` or `tail`.
