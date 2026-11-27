---
name: plexer-health
description: >-
  Offline 20-dimension codebase health scanner, triage queue, safe autofix/move
  refactoring, and treemap visualizer (`plexer health`). Activate on
  /plexer-health or requests to scan repo health, audit dead code, duplicates,
  coupling, or slop, triage tech debt, or open health treemaps. Do not activate
  for HTTP `/health` endpoint bugs, generic `git diff` checks, or daily edits.
---

# Plexer Health & Triage (`/plexer-health`)

Run deterministic codebase audits, prioritized triage queues, and scorecards ($0, offline) via `plexer health`.

## 1. Choose Scan Scope

- **PR or branch changes:** `plexer health scan --diff [base]` limits findings to modified files (`review --diff` adds diff review context).
- **Module audit:** `plexer health scan --in <scope...>` targets specific directories; `plexer health tree [--focus <dir>] [--detail]` maps hotspots before scanning deep trees.
- **Full repository or CI:** `plexer health scan` updates `plexer/.health/state.json`; pass `--stateless` for read-only checks.

## 2. Triage Loop (`next` -> verify -> `resolve`)

1. Pull the highest-leverage open items with `plexer health next [--count <n>] [--cluster <name>] [--lanes]`.
2. Before modifying shared code or deleting dead exports, inspect callers with `plexer callers <symbol>` and read exact spans with `plexer read`.
3. Apply fixes with native edit tools and run the narrowest applicable check.
4. Close verified items with a concrete verification note:

```bash
plexer health resolve <id> --attest "Removed unused helper after confirming 0 callers; npm test passed"
```

## 3. Fix vs. Suppress Discipline

- Fix genuine defects, duplication, and coupling issues rather than hiding them.
- Suppress only verified false positives or intentional architectural boundaries with a specific reason:
  - `plexer health suppress <id> --attest "<reason>"`
  - `plexer health plan skip <id> --false-positive --attest "<reason>"` (or `--permanent` for accepted trade-offs)
- Never bulk-suppress open items to inflate scores.

## 4. Safe Mechanical Refactors

Preview every automated change before writing files, then check `git diff` and callers:

```bash
plexer health autofix --dry-run
plexer health autofix
plexer health move <src> <dst> --dry-run
```

## 5. Status, Targeted Detectors & Visualization

- **Inspect queue and detectors:** `plexer health status`, `plexer health show [--status open] [--code]`, `plexer health detect [--detector <name>]`, `plexer health review [--diff|--prepare|--run-batches]`.
- **Visualize treemap:** Run `plexer health viz [--output <file>]` or open `[Plexer Graph](sidecar://plexer/viz/?tab=treemap)`.
