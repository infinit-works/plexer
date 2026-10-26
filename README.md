# `plexer`

**Offline structural code graph for AI coding agents.**

Coding agents burn most of their context window running blind `grep` searches and reading whole files just to find a few lines. `plexer` indexes your repository locally in seconds using pure WASM Tree-sitter—offline, `$0`, with no API keys, embeddings, or native C++ compilation—and incrementally refreshes modified files in milliseconds before every query.

- **59–73% fewer tool output tokens (`48W/0L`)** and **45–67% fewer tool calls** across 80+ paired A/B and 3-arm evaluations on Gemini 3.8 Flash, Gemini 4 Argon, Claude Sonnet 5.5, and Claude Opus 5.5 ([see benchmarks](#benchmarks))
- **100.0% Recall@1 · 1.000 MRR** in **7–19ms** on natural-language intent queries across 17,551 symbols and 32,566 edges (`73–96%` smaller than raw files)
- **25 languages out of the box** — TypeScript/JS, Python, Go, Rust, Java, C/C++, C#, Kotlin, Swift, Ruby, PHP, and more, plus **first-class Luau / Roblox** (`default.project.json`, `.luaurc`, `require()`, `_K` registries)
- **12 AI coding hosts** — one command wires Claude Code, Google Antigravity, OpenAI Codex, Cursor, Gemini CLI, Windsurf, GitHub Copilot, Aider, Kiro, OpenCode, Grok CLI, and Amp
- **60fps HTML5 Canvas visualizer** — interactive force-directed architecture and diff blast-radius explorer (`plexer viz`)

---

## Quickstart

Requires **Node.js >= 20**.

```bash
npm install -g @plexer/cli

plexer init --global   # One-time setup: ~/.local/bin/plexer + global skills, hooks & MCP
plexer init            # Index current repo (<repo>/plexer/) and wire detected AI tools
```

Run `plexer retract` at any time to cleanly remove every host edit.

<p align="center">
  <img src="assets/how-it-works.svg" alt="How plexer works: Your Codebase (25 languages) is indexed by plexer init into a Live Code Graph in plexer/, powering Turn-1 Code Search, Callers &amp; Blast Radius, and an Interactive Web Graph." width="100%" />
</p>

Once initialized, your coding agent uses `plexer` automatically:
- **Turn-1 orientation**: Lifecycle hooks (`SessionStart`, `UserPromptSubmit`, `PreInvocation`) inject a compact repo map and prompt-matched symbol spans before the first tool call.
- **Live blast-radius warnings & ~3ms freshness**: `PostToolUse` hooks warn on downstream caller impact after edits, and every CLI/MCP query incrementally re-parses drifted files before answering.
- **Native MCP server (`plexer mcp`)**: Exposes `plexer_find_code`, `plexer_find_all`, `plexer_trace_calls`, `plexer_file_api`, `plexer_repo_map`, and `plexer_check_freshness` over stdio.

---

## Commands & Usage

```bash
plexer ask "probing drift and freshness fingerprints" --source  # BM25F + PageRank search with L<n>: source
plexer callers resolveSymbol --depth 2                          # Multi-hop incoming callers (or: callees / impact)
plexer skeleton src/graph/traverse.js                           # Signatures, line spans & doc summaries (~10x smaller)
plexer read src/graph/traverse.js:parseWalkDepth                # Exact L<n>: lines for <file:symbol> or <file:Lx-Ly>
plexer blast --base main --markdown                             # Diff blast radius report + Mermaid diagram
plexer viz                                                      # Local 60fps HTML5 Canvas graph explorer
```

All query commands auto-refresh modified files and accept `--json` and `--no-refresh`. Run `plexer <command> --help` for full flag details.

| Command | Description |
| :--- | :--- |
| `plexer init [dir]` | Build `plexer/` and wire AI hosts (`--global`, `--agents <ids...>`, `--list-agents`, `--dry-run`; alias: `setup`). |
| `plexer build [dir]` | Build or incrementally refresh `plexer/` (`-e <exts...>`, `--only-dir <path>`, `--cards`). |
| `plexer ask <queries...>` | Rank symbols by BM25F + PageRank (`--source`, `--full`, `-n <limit>`, `--in <path>`). |
| `plexer read <spans...>` | Read exact `L<n>:` source for `<file:symbol>`, `<file:Lx-Ly>`, or `<file>` without reading whole files. |
| `plexer grep <patterns...>` | Regex/literal search grouped by enclosing symbol and ranked by caller count (`--fixed`, `-i`, `--in <path>`). |
| `plexer callers <syms...>` | Walk incoming `calls`/`imports`/`extends`/`implements`/`references` edges (`-d <depth\|all>`, `--source`). |
| `plexer callees` / `impact` | Walk outgoing callees or multi-hop incoming callers (`--depth 2` default on `impact`). |
| `plexer skeleton <files...>` | File signatures, exact line spans, and doc summaries (`--all-matches`). |
| `plexer map [dir]` | Architectural overview: directory clusters, hub symbols, and hotspots (`--max-dirs <n>`). |
| `plexer blast [dir]` | Git diff blast radius (`--base <ref>`, `--markdown`, `--mermaid`, `--export-viz <dir>`). |
| `plexer viz [dir]` | Interactive 60fps HTML5 Canvas graph server (`-p <port>`, `--export <dir>`). |
| `plexer check` / `retract` | Verify index hash freshness (`check`) or cleanly remove host wiring (`retract` / `uninstall`). |

---

## Benchmarks

Evaluated across **Gemini 3.8 Flash**, **Gemini 4 Argon** (`low` & `medium`), **Claude Sonnet 5.5**, and **Claude Opus 5.5**. Full per-model tables, per-task breakdowns (`T1`–`T12`, `S1`–`S8`), and reproduction scripts live in [`bench/README.md`](bench/README.md).

| Evaluation Suite | Correctness | Tool Calls | Tool Output Tokens | Cumulative Input Tokens | Search Wall Time |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **12-Task Suite (`T1`–`T12`, 48 pairs)** | 380/384 → **384/384 (100%)** | 449 → **198 (-55.9%)** | 626.4k → **234.4k (-62.6%, `48W/0L`)** | 9.41M → **3.91M (-58.5%)** | 2,780s → **1,826s (-34.3%)** |
| **`SWE-bench_Pro` V2 (`S1`–`S8`, 32 pairs)** | 238/256 → **239/256** | 616 → **438 (-28.9%)** | 573.0k → **402.3k (-29.8%)** | 20.30M → **14.29M (-29.6%)** | 6,085s → **4,906s (-19.4%)** |
| **Live 3-Arm vs. `trail` (`T4,T5,T9` + `S1`–`S8`)** | **`plexer` 339/352** (`trail` 337, `cold` 337) | **884** (`trail` 1,112, `cold` 1,168) | **572.8k** (`trail` 780.9k, `cold` 829.5k) | **39.92M** (`trail` 54.56M, `cold` 51.27M) | **5,697s** (`trail` 7,158s, `cold` 6,568s) |

- **Retrieval & Latency (`npm run bench`)**: **100.0% Recall@1 (24/24)** · **1.000 MRR** across 6 repos (17,551 symbols, 32,566 edges) vs. `@trailhq/trail-code@0.25.0` (`20.8% Recall@1` overall / `62.5%` on non-Luau repos), with **7–19ms** `ask --source` latency and **<2ms** `callers`/`skeleton`/`map` queries.

---

## Supported Hosts & Languages

- **12 AI Coding Hosts (`plexer init`, `plexer init --list-agents`)**: Claude Code (`claude`), Google Antigravity (`antigravity`), OpenAI Codex / `AGENTS.md` (`agents`), Cursor (`cursor`), Gemini CLI (`gemini`), Windsurf (`windsurf`), GitHub Copilot (`copilot`), Aider (`aider`), Kiro (`kiro`), OpenCode (`opencode`), Grok CLI (`grok`), and Amp (`amp`).
- **25 Languages (WASM Tree-sitter)**:
  - **Depth AST + receiver/import resolution (9)**: TypeScript, JavaScript, Python, Go, Java, Kotlin, Swift, PHP, R
  - **Luau / Roblox (1)**: 2024–2026 Luau syntax normalizer, Rojo `default.project.json` DataModel paths, `.luaurc` aliases, `require()`, `Module.fn` / `Class:Method()`, and `_K` registries
  - **Breadth `tags.scm` + cross-file calls/imports (15)**: Rust, C, C++, C#, Ruby, Scala, Elixir, Solidity, OCaml, Zig, Dart, Clojure, Nix, Lua, and Vue (`<script>`)

---

## Programmatic API

Ships with TypeScript declarations ([`src/index.d.ts`](src/index.d.ts)):

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
