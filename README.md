# `plexer`

`plexer` builds a local, offline structural code graph for coding agents inside a `plexer/` directory. Using bundled WASM Tree-sitter grammars and Node.js built-in SQLite storage, it indexes symbols, call edges, type relationships, imports, and exact line spans so agents retrieve definitions, callers, and git diff blast radius without exploratory file paging.

- Cuts cumulative input tokens by 64.2%, tool output by 61.4%, tool calls by 53.1%, and search time by 38.0% across 168 live runs ([see benchmarks](#benchmarks)).
- Local `node:sqlite` WAL storage and incremental dirty-cone rebuilds re-parse changed files without rescanning unchanged modules.
- Queries return BM25F + PageRank-ranked hits with `L<n>:` crux excerpts in 6.8–20.6ms (`100%` Recall@1 across 24 benchmark queries) with zero API keys or network calls.
- One-command setup wires skills, `PreInvocation`/`PreToolUse`/`PostToolUse` hooks, and a stdio MCP server (`plexer mcp`) across 12 coding agents, including a native Antigravity 2 plugin.
- 27 languages and single-file components parse offline, including TypeScript/TSX, JavaScript/JSX, Vue, Svelte, Astro, Rust, Go, Python, and Luau/Rojo projects, with a Canvas viewer (`plexer viz`) and health queue (`plexer health`).

## Quickstart

Requires **Node.js >= 22.13** (uses built-in `node:sqlite`).

```bash
npm install -g @plexer/cli

plexer init --global   # Link ~/.local/bin/plexer and install global skills, hooks, and opt-in MCP
plexer init            # Index the current repository (<repo>/plexer/) and wire detected hosts

plexer ask "freshness fingerprints" --source         # Rank symbols and inline L<n>: source
plexer callers resolveSymbol --depth 2               # Trace incoming callers across 2 hops
plexer skeleton src/graph/traverse.js                # List file signatures and line spans
plexer read src/graph/traverse.js:parseWalkDepth     # Read exact <file:symbol> or <file:Lx-Ly> spans
plexer blast --base main --markdown                  # Compute diff blast radius against main
plexer viz                                           # Launch local Canvas graph explorer
```

After initialization, lifecycle hooks run through a shared cross-host dispatcher (`src/hosts/engine/dispatcher.js`) and the local `plexerd` socket daemon. On Turn 0, hooks inject repository orientation, prompt-matched `L<n>:` code spans, and co-edit or test pointers before the first tool call. Before tool execution, `PreToolUse` hooks snap file reads to unseen AST spans, deduplicate repeated searches and `git diff` calls, and route `cat`/`head`/`tail`/`sed`/`grep`/`rg` shell lookups through `plexer`. After edits and plan handoffs, `PostToolUse` hooks refresh changed files incrementally and warn when signature or export edits affect callers. Run `plexer uninstall --yes` (or `plexer retract --yes`) to remove host wiring cleanly.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@plexer/cli@2.0.0/assets/how-it-works.svg" alt="How plexer works: your codebase (27 languages and SFCs) is indexed by plexer init into plexer/, powering Turn-0 retrieval, caller traversal, blast radius, and the interactive graph viewer." width="100%" />
</p>

## Architecture

`plexer` stores parsed file caches, dependency edges, and multi-channel BM25 postings (`name`, `path`, `sig`, `summary`, `literals`, `body`, `stem`, `exact_ident`) in `<outDir>/.cache/index.sqlite` using `node:sqlite` in WAL mode alongside `<outDir>/.graph/wiring.json`. When files change, the incremental dirty-cone builder resolves only modified files, their importers, and affected barrel re-exports instead of rebuilding the whole graph.

At Turn 0, prompt retrieval classifies confidence (`high` or `exploratory`) and adapts output to the prompt. High-confidence queries inline compact `L<n>:` crux excerpts and pinned definitions (`src/hosts/engine/prompt/pin.js`), while exploratory queries return an 8-entry diverse candidate map (`candidateMap`) with caller/callee counts and file pointers rather than speculative code blocks.

For repeated queries and hook invocations, `plexerd` caches repo graphs and session state over a user-scoped Unix socket so hooks avoid cold disk reads (`--no-daemon` bypasses the socket for single CLI calls). Multi-root workspaces federate across `.code-workspace` or `plexer/workspace.json` files, and the Antigravity 2 plugin (`plugin.json`, `hooks.json`) adds a live graph sidecar (`sidecar://plexer/viz/`).

## CLI Reference

Global options apply across commands: `--dir <path>` selects a custom context directory instead of `<repo>/plexer`, `--session <id>` tracks seen spans across calls, and `--no-daemon` skips the `plexerd` fast path. Query commands automatically refresh modified files unless `--no-refresh` is set, and support `--json`.

| Command | Purpose and Key Flags |
| :--- | :--- |
| `plexer version` | Print the installed `@plexer/cli` version. |
| `plexer init [dir]` | Build `plexer/` and wire detected hosts (`--global`, `--no-global`, `--agents <ids...>`, `--all-agents`, `--no-agents`, `--list-agents`, `--mcp`, `--no-mcp`, `--no-hooks`, `--no-build`, `--dry-run`, `-y`). |
| `plexer setup` | Install global binary symlink, skills, hooks, and optional `--mcp` (`--agents`, `--no-bin`, `--no-skills`, `--no-hooks`, `--dry-run`). |
| `plexer uninstall [dir]` | Remove host wiring and optionally `plexer/` (`alias: retract`, `-y`, `--dry-run`, `--keep-cache`, `--no-global`, `--json`). |
| `plexer build [dir]` | Build or incrementally refresh the graph (`--cards`, `--no-reuse`, `-e <exts...>`, `--only-dir <path>`, `--include-dir <name>`, `--follow-submodules`, `--follow-nested-repos`). |
| `plexer check [dir]` | Report added, changed, removed, or stale files against the built graph (`-e`, `--json`). |
| `plexer ask <queries...>` | Rank symbols by BM25F and PageRank; accepts multiple queries (`-n <limit>`, `--source`, `--no-source`, `--full`, `--in <path...>`, `--no-graph-rank`, `--json`). |
| `plexer skeleton <targets...>` | List symbol signatures, exact line spans, and doc summaries for files or directories (`--all-matches`, `--json`). |
| `plexer read <spans...>` | Read exact `L<n>:` ranges for `<file:symbol>` or `<file:Lx-Ly>` spans and coalesce overlaps (`--full`, `--json`). |
| `plexer grep <patterns...>` | Search indexed files by regex or fixed string (`--fixed`, `-i`, `-C <lines>`, `--source`, `--no-source`, `--full`, `--in <path...>`, `--json`). |
| `plexer callers <syms...>` | Walk incoming edges (`--direction <in\|out>`, `-d <depth\|all>`, `--source`, `--no-source`, `--full`, `--in <path...>`, `--json`). |
| `plexer callees <syms...>` | Walk outgoing callees (`-d <depth\|all>`, `--source`, `--no-source`, `--full`, `--in <path...>`, `--json`). |
| `plexer impact <syms...>` | Walk 2-hop incoming callers (`-d <depth\|all>`, `--source`, `--no-source`, `--full`, `--in <path...>`, `--json`). |
| `plexer map [dir]` | Summarize directory clusters, hub symbols, and git hotspots (`--max-dirs <n>`, `--churn`, `--json`). |
| `plexer blast [dir]` | Compute git diff blast radius (`--base <ref>`, `-d <depth\|all>`, `--format <text\|markdown\|mermaid\|json>`, `--markdown`, `--mermaid`, `--export-viz <dir>`, `--no-owners`, `--pr-author <who...>`). |
| `plexer viz [dir]` | Serve the local HTML5 Canvas viewer (`-p <port>`, `--no-open`, `--export <dir>`, `--title <text>`, `--tabs <context,code,modules,symbols,outline,treemap>`). |
| `plexer mcp [dir]` | Start the newline-delimited JSON-RPC 2.0 MCP server exposing 9 `plexer_*` tools. |
| `plexer health [sub]` | Scan codebase health and manage the `plexer/.health/` queue (`scan`, `next`, `backlog`, `status`, `show`, `resolve`, `suppress`, `plan`, `review`, `autofix`, `move`, `tree`, `viz`, `detect`, `zone`, `exclude`, `directives`, `config`, `prompt`). |

## Codebase Health Queue

`plexer health` pairs static AST and graph detectors (dead code, duplication, dependency cycles, cohesion, complexity, test gaps, and Luau/Roblox checks) with a persistent queue under `plexer/.health/`:

```bash
plexer health scan .          # Run AST/graph detectors and refresh the health queue
plexer health next            # Pop the highest-leverage open item from the queue
plexer health resolve <id>    # Mark an item resolved after fixing and verifying callers
plexer health prompt          # Output the autonomous review prompt for your agent
```

## Benchmarks

We evaluated `plexer` against a cold baseline (no index or hooks) across **168 live runs** on **28 tasks** and **11 repositories** up to **1,350+ files**. Across all 168 runs, `plexer` cuts cumulative input tokens by **64.2%** (`65.4M → 23.4M`), tool output tokens by **61.4%** (`2,189k → 845k`), and uncached input tokens by **50.6%** (`7.07M → 3.49M`). It also cuts tool calls by **53.1%** (`2,595 → 1,218`) and search time by **38.0%** (`18,521s → 11,481s`), while raising task accuracy from `98.7%` to **`99.6%`**. Runs span **Gemini 4 Neon**, **Carbon**, **Argon**, and **Hydrogen** in Google Antigravity alongside **Claude Opus 5.5** and **Sonnet 5.5** in Claude Code (full methodology and per-task tables in [`bench/README.md`](bench/README.md)).

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@plexer/cli@2.0.0/assets/chart-small.svg" alt="plexer Benchmark Summary: Engineering Tasks, SWE-bench Pro V2, Large OSS Repositories, and Head-to-Head vs. trail-code" width="100%" />
</p>

| Benchmark Suite | Input Tokens | Tool Output | Tool Calls | Search Time | Accuracy |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Engineering tasks** (12 tasks, 6 repos, 72 runs) | **-69.4%** (`20.5M → 6.25M`) | **-68.6%** (`932k → 292k`) | **-61.5%** (`930 → 358`) | **-46.7%** (`5,757s → 3,066s`) | **100.0%** (`576/576` vs. `572/576`) |
| **SWE-bench Pro V2** (8 OSS issues, 48 runs) | **-63.2%** (`40.1M → 14.8M`) | **-53.1%** (`946k → 444k`) | **-47.5%** (`1,255 → 659`) | **-33.8%** (`11,029s → 7,297s`) | **98.7%** (`379/384` vs. `374/384`) |
| **Large OSS repos** (440–1,350+ files, 48 runs) | **-50.2%** (`4.81M → 2.39M`) | **-65.0%** (`311k → 109k`) | **-51.0%** (`410 → 201`) | **-35.5%** (`1,735s → 1,118s`) | **100.0%** (`48/48` solved vs. `46/48`) |
| **All 168 evaluations** (28 tasks × 6 models) | **-64.2%** (`65.4M → 23.4M`) | **-61.4%** (`2,189k → 845k`) | **-53.1%** (`2,595 → 1,218`) | **-38.0%** (`18,521s → 11,481s`) | **99.6%** (`1,339/1,344` vs. `1,326/1,344`) |

Across 130 shared 3-arm runs against `@trailhq/trail-code@0.29.0`, `plexer` cuts cumulative input tokens by **60.6%** vs. **7.7%** for `trail-code` (**57.4%** vs. **14.6%** on new file reads after Turn 1, and **50.6%** lower tool output directly against `trail`) and solves **48/48** strict multi-file large-repo tasks vs. `47/48` for `trail` and `46/48` for `cold`. In the offline engine benchmark (`npm run bench`, 24 queries across 6 repos), `plexer` hits **100.0% Recall@1 (`24/24`)** and **1.000 MRR** with zero API keys. It answers `ask --source` in **6.8–20.6ms** and `callers`, `skeleton`, and `map` in **0.01–1.74ms**.

## Supported Hosts and Languages

- **Hosts (12 registered IDs via `plexer init --list-agents`):** `claude` (Claude Code), `antigravity` (Google Antigravity), `agents` (`AGENTS.md` / Codex-style CLIs), `opencode` (OpenCode), `cursor` (Cursor), `gemini` (Gemini CLI), `windsurf` (Windsurf), `copilot` (GitHub Copilot), `kiro` (Kiro), `grok` (Grok xAI), `adal` (AdaL), and `hermes` (Hermes Agent).
- **Languages and SFCs (27):**
  - **Depth tier (9):** TypeScript (`ts`, `mts`, `cts`, `tsx`), JavaScript (`js`, `mjs`, `cjs`, `jsx`), Python (`py`, `pyi`), Go (`go`), Java (`java`), Kotlin (`kt`, `kts`), Swift (`swift`), PHP (`php`), and R (`r`, `R`).
  - **Breadth tier (15):** Rust (`rs`), C (`c`, `h`), C++ (`cpp`, `cc`, `cxx`, `hpp`, `hh`), Ruby (`rb`), C# (`cs`), Scala (`scala`, `sc`), Elixir (`ex`, `exs`), Solidity (`sol`), OCaml (`ml`, `mli`), Zig (`zig`), Dart (`dart`), Clojure (`clj`, `cljs`, `cljc`, `bb`), Nix (`nix`), Lua (`lua`), and Luau (`luau`, including Rojo `default.project.json` and `.luaurc`).
  - **Container SFCs (3):** Vue (`vue`), Svelte (`svelte`), and Astro (`astro`).

## Programmatic API

Ships with TypeScript declarations in `src/index.d.ts`. `Plexer.ask`, `Plexer.skeleton`, `Plexer.grep`, and `Plexer.callers` accept either a single string or `string[]` batches and transparently federate repositories configured through `plexer/workspace.json` or VS Code/Antigravity `.code-workspace` files.

```ts
import { Plexer, formatAsk, formatReadSpans, formatSkeleton } from "@plexer/cli";

const plexer = new Plexer();
await plexer.graph("/path/to/repo");

// Single query, batched array query, or workspace federation (.code-workspace / plexer/workspace.json)
const hit = plexer.ask("/path/to/repo", "freshness fingerprints", { source: true });
const batch = plexer.ask("/path/to/app.code-workspace", ["auth guard", "session token"], { source: true });
const apis = plexer.skeleton("/path/to/repo", ["src/graph/fingerprint.js", "src/graph/workspace.js"]);
const refs = plexer.callers("/path/to/repo", ["probeDrift", "resolveSymbol"], { depth: 2 });

console.log(formatAsk(hit));
console.log(batch.map(formatAsk).join("\n"));
console.log(apis.map((s) => formatSkeleton(s)).join("\n"));
console.log(formatReadSpans(plexer.read("/path/to/repo", ["src/graph/fingerprint.js:probeDrift"])));
```

## License

MIT © Infinit Works
