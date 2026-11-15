---
name: plexer-health
description: >-
  Codebase health scanner, 20-dimension architectural review, living execution
  queue, autofix/move refactoring, and interactive treemap visualization
  (`plexer health`). Activate when scanning repo health, auditing dead
  code/duplicates/coupling/slop, triaging tech debt, or generating health treemaps.
---

# Plexer Health & Architectural Triage

Use `plexer health` to run deterministic codebase audits, manage prioritized remediation queues, and generate architectural scorecards without external LLM calls.

## Core Workflows

- **Scan and triage:** Run `plexer health scan [--diff [base]] [--in <scope...>]` to populate `.health/state.json`, then pull prioritized work with `plexer health next [--count <n>] [--cluster <name>]`.
- **Resolve or suppress with attestation:** Mark verified fixes via `plexer health resolve <id> --attest "<note>"`, or record intentional exclusions via `plexer health suppress <id> --attest "<reason>"`.
- **Architectural review and scorecard:** Run `plexer health review [--diff]` or inspect strict scorecard metrics via `plexer health status` and `plexer health prompt`.
- **Automated fixes and refactoring:** Run `plexer health autofix [--dry-run]` for mechanical cleanup, `plexer health move <src> <dst>` to relocate files cleanly, and `plexer health tree` or `plexer health detect` for structural inspection.
- **Interactive visualization:** Run `plexer health viz` to write the standalone HTML treemap, or open the Auxiliary Pane via `[Plexer Graph](sidecar://plexer/viz/)` (`?tab=treemap`, or `?tab=modules|symbols|context|treemap&q=<query>`).
