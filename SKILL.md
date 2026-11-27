---
name: plexer
description: >-
  `plexer` CLI code-graph workflow for callers/importers, exact symbol spans,
  and blast radius. Activate for `/plexer` or cross-file caller/importer tracing,
  reading symbol spans, or repo mapping when `[plexer]` Turn-0 context is absent.
  Skip for simple local edits, docs/config tweaks, or `plexer-health`.
---

# Plexer (`/plexer`)

- Cite Turn-0 `[plexer]` `<n>:` spans and `call sites` (`file:Lx-Ly`) with 0 calls when sufficient; otherwise fetch in 1 `plexer read <file:sym|Lx-Ly ...>` or `plexer callers <sym>`.
- CLI: `plexer read`, `ask "<q>"`, `callers|callees <sym>`, `impact <sym>`, `blast`, `skeleton`, `grep "<pat>"`, `map`.
