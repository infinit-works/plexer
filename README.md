# `plexer`

An offline structural code graph for AI coding agents. `plexer` indexes symbols, call chains, imports, and exact line spans into a local `plexer/` directory with WASM Tree-sitter so agents find definitions, callers, and diff blast radius in one turn.

- **Lower token cost:** Cuts tool output tokens by 35–59% and tool calls by 31–51% across 140 live evaluations ([see benchmarks](#benchmarks)).
- **Fast local queries:** Answers natural-language `ask` queries in 7–21ms (100% Recall@1) and re-parses edited files in ~3ms with zero API keys.
- **One-command host setup:** Wires skills, lifecycle hooks, and an MCP server (`plexer mcp`) across 12 AI coding tools.
- **25 languages:** Supports TypeScript/JS, Python, Go, Rust, Java, C/C++, C#, and more out of the box, including Luau and Roblox projects.
- **Visual explorer & health queue:** Includes a 60fps Canvas graph viewer (`plexer viz`) and a persistent codebase health scanner (`plexer health`).

## Quickstart

Requires **Node.js >= 20**.

```bash
npm install -g @plexer/cli

plexer init --global   # One-time setup: ~/.local/bin/plexer + global skills, hooks & MCP
plexer init            # Index current repo (<repo>/plexer/) and wire detected AI tools

plexer ask "freshness fingerprints" --source         # Rank symbols and inline L<n>: source
plexer callers resolveSymbol --depth 2               # Trace incoming callers
plexer skeleton src/graph/traverse.js                # List file signatures and line spans
plexer read src/graph/traverse.js:parseWalkDepth     # Read exact <file:symbol> or <file:Lx-Ly> spans
plexer blast --base main --markdown                  # Report diff blast radius
plexer viz                                           # Open local 60fps Canvas graph viewer
```

Once initialized, hooks inject a compact repo map and prompt-matched code spans on Turn 1, warn on downstream caller impact after edits, and expose `plexer` over stdio MCP. Run `plexer retract` at any time to remove every host edit cleanly.

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@plexer/cli@1.1.1/assets/how-it-works.svg" alt="How plexer works: Your Codebase (25 languages) is indexed by plexer init into a Live Code Graph in plexer/, powering Turn-1 Code Search, Callers &amp; Blast Radius, and an Interactive Web Graph." width="100%" />
</p>

## Commands

Query commands refresh modified files automatically and accept `--json` and `--no-refresh`. Run `plexer <command> --help` for all flags.

| Command | Description |
| :--- | :--- |
| `plexer init [dir]` | Build `plexer/` and wire AI hosts (`--global`, `--agents`, `--list-agents`, `--dry-run`). |
| `plexer build [dir]` | Build or incrementally refresh the local `plexer/` index. |
| `plexer ask <queries...>` | Rank symbols by BM25F + PageRank (`--source`, `--full`, `-n <limit>`, `--in <path>`). |
| `plexer read <spans...>` | Read exact `L<n>:` source for `<file:symbol>` or `<file:Lx-Ly>` spans. |
| `plexer grep <patterns...>` | Search indexed files by regex or literal (`--fixed`, `-i`), grouped by symbol. |
| `plexer callers <syms...>` | Walk incoming call, import, inheritance, and reference edges (`-d <depth\|all>`). |
| `plexer callees` / `impact` | Walk outgoing callees or 2-hop incoming callers. |
| `plexer skeleton <files...>` | Print file signatures, line spans, and doc summaries. |
| `plexer map [dir]` | Summarize directory clusters, hub symbols, and hotspots. |
| `plexer blast [dir]` | Compute git diff blast radius (`--base <ref>`, `--markdown`, `--mermaid`). |
| `plexer health [sub]` | Scan codebase health and work through the `plexer/.health/` execution queue. |
| `plexer viz [dir]` | Start the local 60fps HTML5 Canvas graph server (`-p <port>`, `--export <dir>`). |
| `plexer check` / `retract` | Verify index freshness for CI (`check`) or remove host wiring (`retract`). |

## Codebase Health (`plexer health`)

`plexer health` combines AST and graph detectors (dead code, duplication, cycles, cohesion, complexity, test gaps, and Luau/Roblox checks) with blind 20-dimension LLM review in a persistent execution queue:

```bash
plexer health scan .          # Scan repository and score mechanical + subjective health
plexer health next            # Pull the highest-impact issue from the living plan
plexer health resolve <id>    # Mark an issue resolved after fixing and verifying callers
plexer health prompt          # Print the full autonomous improvement prompt for your agent
```

## Benchmarks

Evaluated across **Gemini 4 Carbon**, **Gemini 4 Argon**, **Gemini 3.8 Flash**, **Claude Opus 5.5**, and **Claude Sonnet 5.5** on **28 tasks (`T1`–`T12`, `S1`–`S8`, `L1`–`L8`)** across **11 repositories** up to **1,350+ files** (**140 paired and 3-arm evaluations**).

<p align="center">
  <img src="https://cdn.jsdelivr.net/npm/@plexer/cli@1.1.1/assets/chart-small.svg" alt="plexer Benchmark Summary: 12-Task Suite, SWE-bench Pro V2, Large-Repo Suite, and 3-Arm Comparison vs. trail-code and Cold Baseline" width="100%" />
</p>

- **Fewer tokens and turns:** Cuts tool output tokens by **58.6%** (`59W/1L`) on `T1`–`T12`, **35.4%** on `SWE-bench_Pro` V2, and **53.2%** (`40/40` resolved) on the large-repo suite while cutting wall time by **18–22%**.
- **Ahead of `trail-code` in 3-arm runs:** Across 111 shared 3-arm sessions, `plexer` cuts uncached input tokens by **28.6%** (`-38.1%` after Turn 1) and cumulative input by **37.4%** vs. **-12.4%** and **-13.0%** for `@trailhq/trail-code@0.29.0`, with **100% gold file recall (`111/111`)**.
- **Sub-25ms local retrieval:** Hits **100% Recall@1 (`24/24`)** and **1.000 MRR** across 6 pinned repositories in **6.8–20.6ms** for `ask --source` and **<2ms** for `callers`, `skeleton`, and `map`.

## Supported Hosts & Languages

- **Hosts (`plexer init --list-agents`):** Claude Code (`claude`), Google Antigravity (`antigravity`), OpenAI Codex / `AGENTS.md` (`agents`), Cursor (`cursor`), Gemini CLI (`gemini`), Windsurf (`windsurf`), GitHub Copilot (`copilot`), Aider (`aider`), Kiro (`kiro`), OpenCode (`opencode`), Grok CLI (`grok`), and Amp (`amp`).
- **Languages (25):** TypeScript, JavaScript, Python, Go, Rust, Luau (Rojo `default.project.json` + `.luaurc`), Java, Kotlin, Swift, C, C++, C#, Ruby, PHP, Scala, Elixir, Solidity, OCaml, Zig, Dart, Clojure, Nix, R, Lua, and Vue.

## Programmatic API

Ships with TypeScript declarations (`src/index.d.ts`):

```ts
import { Plexer, formatAsk, formatReadSpans, formatSkeleton } from "@plexer/cli";

const plexer = new Plexer();
await plexer.graph("/path/to/repo");

console.log(formatAsk(plexer.ask("/path/to/repo", "freshness fingerprints", { source: true })));
console.log(formatSkeleton(plexer.skeleton("/path/to/repo", "src/graph/fingerprint.js")));
console.log(formatReadSpans(plexer.read("/path/to/repo", ["src/graph/fingerprint.js:probeDrift"])));
```

## License

MIT © Infinit Works
