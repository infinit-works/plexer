# `plexer`

`plexer` builds a local, offline structural code graph for coding agents inside a `plexer/` directory. Using bundled WASM Tree-sitter grammars and Node.js built-in SQLite storage, it indexes symbols, call edges, type relationships, imports, and exact line spans so agents retrieve definitions, callers, and git diff blast radius without exploratory file paging.

- Local `node:sqlite` WAL storage and incremental dirty-cone rebuilds re-parse changed files without rescanning unchanged modules.
- Queries return BM25F + PageRank-ranked hits with `L<n>:` crux excerpts in 6.8–20.6ms (`100%` Recall@1 across 24 benchmark queries) with zero API keys or network calls.
- One-command setup wires skills, lifecycle hooks, and a stdio MCP server (`plexer mcp`) across 12 coding agents, backed by a hot-RAM `plexerd` Unix socket daemon.
- 27 languages and single-file components parse offline, including TypeScript/TSX, JavaScript/JSX, Vue, Svelte, Astro, Rust, Go, Python, and Luau/Rojo projects.
- Includes an HTML5 Canvas graph explorer (`plexer viz`) with a treemap view and a persistent codebase health queue (`plexer health`).

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

After initialization, lifecycle hooks run through a unified cross-host dispatcher (`src/hosts/engine/dispatcher.js`) and the local `plexerd` socket daemon. On Turn 0, hooks inject repository orientation, prompt-matched code spans, and co-edit or test pointers; after edits, they warn on downstream caller impact and track seen line spans per session. Run `plexer uninstall --yes` (or `plexer retract --yes`) to remove host edits cleanly.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@plexer/cli@2.0.0/assets/how-it-works.svg" alt="How plexer works: your codebase (27 languages and SFCs) is indexed by plexer init into plexer/, powering Turn-0 retrieval, caller traversal, blast radius, and the interactive graph viewer." width="100%" />
</p>

## Architecture

`plexer` stores parsed file caches, dependency edges, and multi-channel BM25 postings (`name`, `path`, `sig`, `summary`, `literals`, `body`, `stem`, `exact_ident`) in `<outDir>/.cache/index.sqlite` using `node:sqlite` in WAL mode alongside `<outDir>/.graph/wiring.json`. When files change, the incremental dirty-cone builder resolves only modified files, their importers, and affected barrel re-exports instead of rebuilding the whole graph.

At Turn 0, prompt retrieval classifies confidence (`high` or `exploratory`) and adapts output to the prompt. High-confidence queries inline compact `L<n>:` crux excerpts and pinned definitions (`src/claude/pin.js`), while exploratory queries return an 8-entry diverse candidate map (`candidateMap`) with caller/callee counts and file pointers rather than speculative code blocks.

For repeated queries and hook invocations, `plexerd` caches repo graphs and session state over a user-scoped Unix socket so hooks avoid cold disk reads. Pass `--no-daemon` to bypass the socket cache for single CLI calls.

## CLI Reference

Global options apply across commands: `--dir <path>` selects a custom context directory instead of `<repo>/plexer`, `--session <id>` tracks seen spans across calls, and `--no-daemon` skips the `plexerd` fast path. Query commands automatically refresh modified files unless `--no-refresh` is set, and support `--json`.

| Command | Purpose and Key Flags |
| :--- | :--- |
| `plexer version` | Print the installed `@plexer/cli` version. |
| `plexer init [dir]` | Build `plexer/` and wire detected hosts (`--global`, `--agents <ids...>`, `--all-agents`, `--no-agents`, `--list-agents`, `--mcp`, `--no-build`, `--cards`, `--dry-run`, `-y`). |
| `plexer setup` | Install global binary symlink, skills, hooks, and optional `--mcp` (`--agents`, `--no-bin`, `--no-skills`, `--no-hooks`, `--dry-run`). |
| `plexer uninstall [dir]` | Remove host wiring and optionally `plexer/` (`alias: retract`, `-y`, `--dry-run`, `--keep-cache`, `--no-global`, `--json`). |
| `plexer build [dir]` | Build or incrementally refresh the graph (`--cards`, `--no-reuse`, `-e <exts...>`, `--only-dir <path>`, `--include-dir <name>`, `--follow-submodules`, `--follow-nested-repos`). |
| `plexer check [dir]` | Report added, changed, removed, or stale files against the built graph (`-e`, `--json`). |
| `plexer ask <queries...>` | Rank symbols by BM25F and PageRank; accepts multiple queries (`-n <limit>`, `--source`, `--no-source`, `--full`, `--in <path>`, `--no-graph-rank`, `--json`). |
| `plexer read <spans...>` | Read exact `L<n>:` ranges for `<file:symbol>` or `<file:Lx-Ly>` spans and coalesce overlaps (`--full`, `--json`). |
| `plexer grep <patterns...>` | Search indexed files by regex or fixed string (`--fixed`, `-i`, `-C <lines>`, `--source`, `--no-source`, `--full`, `--in <path>`, `--json`). |
| `plexer callers <syms...>` | Walk incoming edges (`--direction <in\|out>`, `-d <depth\|all>`, `--source`, `--no-source`, `--full`, `--in <path>`, `--json`). |
| `plexer callees <syms...>` | Walk outgoing callees (`-d <depth\|all>`, `--source`, `--no-source`, `--full`, `--in <path>`, `--json`). |
| `plexer impact <syms...>` | Walk 2-hop incoming callers (`-d <depth\|all>`, `--source`, `--no-source`, `--full`, `--in <path>`, `--json`). |
| `plexer map [dir]` | Summarize directory clusters, hub symbols, and git hotspots (`--max-dirs <n>`, `--churn`, `--json`). |
| `plexer blast [dir]` | Compute git diff blast radius (`--base <ref>`, `-d <depth\|all>`, `--format <text\|markdown\|mermaid\|json>`, `--markdown`, `--mermaid`, `--export-viz <dir>`, `--no-owners`, `--pr-author <who...>`). |
| `plexer viz [dir]` | Serve the local HTML5 Canvas viewer (`-p <port>`, `--no-open`, `--export <dir>`, `--title <text>`, `--tabs <context,modules,symbols,treemap>`). |
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

Evaluated across **Gemini 4 Carbon**, **Gemini 4 Argon**, **Gemini 3.8 Flash**, **Claude Opus 5.5**, and **Claude Sonnet 5.5**. The benchmark spans **28 tasks (`T1`–`T12`, `S1`–`S8`, `L1`–`L8`)** across **11 repositories** up to **1,350+ files**, totaling **140 paired and 3-arm evaluations** (methodology in [`bench/README.md`](bench/README.md)).

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@plexer/cli@2.0.0/assets/chart-small.svg" alt="plexer Benchmark Summary: 12-Task Suite, SWE-bench Pro V2, Large-Repo Suite, and 3-Arm Comparison vs. trail-code and Cold Baseline" width="100%" />
</p>

- On `T1`–`T12` (60 task-model pairs), `plexer` cuts tool output tokens by **57.3%** (`59W/1L`), tool calls by **50.1%**, cumulative input tokens by **52.9%**, and search time by **27.9%**, raising rubric score from `476/480` to `478/480`.
- On `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`, 40 task-model pairs), `plexer` cuts tool output tokens by **30.5%**, tool calls by **28.6%**, cumulative input tokens by **30.2%**, and search wall time by **23.4%**, with **100%** gold file recall (`303/320` patch score vs. `302/320` cold).
- On the large-repo suite (`L1`–`L8`, 40 3-arm sessions), `plexer` resolves **40/40 (`100.0%`)** strict multi-file tasks vs. `39/40` for `@trailhq/trail-code@0.29.0` and `38/40` cold, while cutting tool output tokens by **53.4%** vs. cold and **45.2%** vs. `trail-code`.
- Across 111 shared 3-arm evaluations (`T4, T5, T9`, `S1`–`S8`, `L1`–`L8`), `plexer` reduces uncached input tokens by **27.8%** (**37.3%** post-Turn-1) and cumulative input tokens by **35.3%**, compared to **12.3%** and **11.9%** for `@trailhq/trail-code@0.29.0`, with **100%** gold file recall (`111/111`).
- In the deterministic engine benchmark (`npm run bench`, 6 repositories, 24 queries), `plexer` achieves **100.0% Recall@1 (`24/24`)** and **1.000 MRR**, answering `ask --source` in **6.8–20.6ms** and `callers`, `skeleton`, and `map` in **0.01–1.74ms**.

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
