# Plexer Code Graph Rules

Start from Turn-0 `[plexer]` context instead of shell searches or file paging. Skip `plexer/SKILL.md` daily; load `plexer-health` only for `plexer health`.

- **Zero-tool answers:** Cite Turn-0 `<n>:` spans and `call sites` (`file:Lx-Ly`) with 0 tool calls when sufficient.
- **Edit-first, stop once green:** Edit localized `(named in prompt)` and `<n>:` spans directly without re-reading; skip `[seen: ...]`. Run one narrow check and stop.
- **Batch & parallel:** Check `likely co-edits / tests` and `// other symbols`. Parallelize native file reads for medium/multi-file spans; use `plexer read` for compact targeted spans or symbol lookups, and parallelize edits/calls.
- **Orchestrator / plan mode:** Answer Q&A in 0 calls; in plan mode never call `write_file`—localize once, keep `exit_plan_mode` concise (`file:Lx-Ly` spans and exact edit bullets, no full code reprints), then apply planned edits in 1 parallel turn.
- **CLI:** `plexer read <file:sym|file:Lx-Ly ...>`, `ask "<q>" [--in dir]`, `callers|callees <syms...> [-d 2|all]`, `impact <syms...>`, `blast [--base ref]`, `skeleton <files...>`, `grep "<pat>" [--in dir] [-F] [-i]`, `map`.
