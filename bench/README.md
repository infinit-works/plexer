# `plexer` Benchmarks & Methodology

This directory holds the multi-model benchmark suite, runners, transcript graders, offline evaluators, and visualization scripts for `plexer`. [`bench/tasks.js`](tasks.js) defines 12 engineering tasks (`T1`–`T12`) with rubrics and code-edit checks across 6 repositories (including 2 holdouts). [`bench/swebench/tasks.json`](swebench/tasks.json) bundles 8 tasks (`S1`–`S8`) from **`ScaleAI/SWE-bench_Pro` V2** across `qutebrowser/qutebrowser` (Python), `flipt-io/flipt` (Go), `NodeBB/NodeBB` (JavaScript), and `tutao/tutanota` (TypeScript) alongside container verifier scripts (`test.sh`, `run_script.sh`, `parser.py`, `config.json`). [`bench/large-tasks.js`](large-tasks.js) and [`bench/run-large-ab.js`](run-large-ab.js) define 8 multi-hop architectural and 3–4-file code-edit tasks (`L1`–`L8`) across repos up to **1,350+ files** (including PocketBase `L1` OAuth2/`RecordUpsert` and `L5` PR #6744 WebP thumbnail tasks). Strict binary `Resolved` verifiers fail any run missing one sibling file, while [`bench/ensure-base.js`](ensure-base.js) populates `/tmp/plexer-ab-base/{clean,indexed}` and `/tmp/plexer-swebench-base/{clean,indexed}`.

Live evaluations run through [`bench/run-agy-ab.js`](run-agy-ab.js) for headless Google Antigravity (`agy -p` on `neon-medium`, `carbon-medium`, `hydrogen-medium`, and the dual-model Orchestrators `orch-neon-high-hydrogen-high` and `orch-neon-xhigh-hydrogen-xhigh`, pairing `gemini-4-neon-{high,xhigh}` planner with `gemini-4-hydrogen-{high,xhigh}` executor) and [`bench/run-claude-ab.js`](run-claude-ab.js) for Claude Code (`claude -p --effort medium` on `claude-sonnet-5-5` and `claude-opus-5-5`). [`bench/run-swebench-ab.js`](run-swebench-ab.js) executes `S1`–`S8` across all 7 model configurations with symbol/patch grading and optional Docker verification (`SWEBENCH_DOCKER=1`). [`bench/grade.js`](grade.js) parses Antigravity and Claude Code JSONL transcripts, tracks per-role `modelBreakdown` and plan transitions (`planHandoffs`, `planReviews`) on Orchestrator runs, checks cohort symmetry, grades rubrics and strict binary `resolved` status, and reports separated metrics (`toolOutputTokens`, `finalContextTokens`, `uncachedInputTokens`, `cachedInputTokens`, `cumulativeInputTokens`, and `totalModelOutputTokens`).

Offline tools replay transcripts and fit cost models at zero API cost. [`bench/replay.js`](replay.js) mines ranged reads, whole-file reads, grep hits, and gold patch hunks across all 28 tasks into [`bench/needed-spans.json`](needed-spans.json), which [`bench/needcov.js`](needcov.js) scores via `needCov`, `locCov`, and `fileCov`. [`bench/eval-fast.js`](eval-fast.js) evaluates Turn-0 BPE budgets, gold file recall, coverage, and predicted metrics (`EstWall`, `EstUncached`, `EstCost`, `EstCum`) across all 28 tasks in ~5.0s. Those predictions use the leave-one-out regressions in [`bench/cost-model.js`](cost-model.js) and [`bench/turn-model.json`](turn-model.json) (`wall_ms`, `outTok`, `uncIn`, `cumIn`, and cache-aware cost `1.25·uncIn + 0.1·cacheRead + 5·outTok`, `R² = 0.84–0.98`). Visualization and engine scripts include [`bench/chart.js`](chart.js) ([`bench/chart-small.svg`](chart-small.svg) and [`bench/chart.svg`](chart.svg)) and [`bench/run.js`](run.js) for the 24-query deterministic engine benchmark (`npm run bench`).

<p align="center">
  <img src="chart.svg" alt="plexer Multi-Suite Benchmark Breakdown" width="100%" />
</p>

---

## 1. 7-Model Live A/B Agent Evaluation (`T1`–`T12`: `plexer` vs. Cold Agent)

### Methodology & Controls

We ran an **84-pair (168-session) A/B evaluation** across 12 tasks, 2 arms (`cold` vs. `plexer`), and 7 model configurations: 5 single-model configurations pinned to `--effort medium` plus 2 dual-model Antigravity Orchestrator configurations (`orch-neon-high-hydrogen-high` pairing `gemini-4-neon-high` planner with `gemini-4-hydrogen-high` executor, and `orch-neon-xhigh-hydrogen-xhigh` pairing `gemini-4-neon-xhigh` planner with `gemini-4-hydrogen-xhigh` executor). The single-model Antigravity runs cover `neon-medium` (`gemini-4-neon-medium`), `carbon-medium` (`gemini-4-carbon-medium`), and `hydrogen-medium` (`gemini-4-hydrogen-medium`), while the Claude Code runs cover **Claude Opus 5.5** (`claude-opus-5-5`) and **Claude Sonnet 5.5** (`claude-sonnet-5-5`).

The suite spans **6 repositories** (`plexer`, `kohls-admin`, `flux`, `sert`, and 2 unseen holdouts `building-tools` and `z`) in JavaScript, Luau, Rust, and Python (1,445 to 3,614 symbols and up to 6,437 edges). Tasks fall into 3 categories:

1. **Bug and behavior diagnosis (`T1`–`T4`):** Diagnose the root mechanism behind a symptom or edge case described in domain terms and cite `file:Lx-Ly` spans.
2. **Refactoring and blast-radius planning (`T5`–`T8`):** Locate a subsystem contract and trace all direct and second-hop callers affected by a proposed change.
3. **Multi-file code edits and test verification (`T9`–`T12`):** Implement a feature across multiple files in an isolated worktree and pass both the existing test suite and a held-out verification spec.

#### Experimental Controls (`bench/grade.js`)

1. **No prompt or answer-key leakage:**
   - Prompts describe user-visible behavior and symptoms rather than internal helper names or file paths.
   - Worktrees are exported via `git archive HEAD` with `bench/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/`, `.cursor/`, `.gemini/`, and `.agents/` stripped. `grade.js` fails any run that accesses `bench/tasks.js`.
2. **Unseen holdout repositories:** `T4` (`z`), `T8` (`building-tools`), and `T12` (`building-tools`) run on repositories never used to tune retrieval weights or skill instructions.
3. **Prompt, effort, and environment symmetry:**
   - Within each model tier, `cold` and `plexer` run with the exact same model, effort/orchestrator settings, tool permissions, and task prompt (`0` symmetry violations across all 168 transcripts).
   - The `cold` arm sets `PLEXER_DISABLE_HOOKS=1` so lifecycle hooks never fire. The `plexer` arm enables Turn-0 prompt-context, `PreToolUse` read/shell compaction, and `PostToolUse` span-tracking and blast-radius hooks (`PLEXER_DISABLE_HOOKS=0`).
   - For single-model Antigravity runs, [`bench/run-agy-ab.js`](run-agy-ab.js) passes `-p --agent bench-{cold,plexer} --model gemini-4-{neon,carbon,hydrogen}-medium --effort medium --dangerously-skip-permissions --disable-slash-commands` with `inheritCustomizations: false` and `inheritMcp: false`.
   - For Orchestrator Antigravity runs (`orch-neon-high-hydrogen-high` and `orch-neon-xhigh-hydrogen-xhigh`), omitting `--agent` and `--effort` is required because passing `--agent` forces Antigravity into single-model mode even when `enter_plan_mode`/`exit_plan_mode` are listed. [`bench/agy-bench-helper.js`](agy-bench-helper.js) therefore launches `agy -p --model gemini-pro-orchestrator-neon --settings '{"orchestrator":{"planner":"gemini-4-neon-{high,xhigh}","executor":"gemini-4-hydrogen-{high,xhigh}"}}' --output-format stream-json --dangerously-skip-permissions --disable-slash-commands` inside a sterile temporary `HOME` (`createSterileBenchHome`: symlinks only auth, `antigravity-cli`, and host toolchains/caches such as `.rokit` via `ROKIT_ROOT`, keeping `.gemini/config` and `.gemini/skills` empty) while injecting arm rules and hooks through worktree `.agents/rules/bench-arm.md` (with `trigger: always_on`) and `.agents/hooks.json`.
   - For Claude Code, [`bench/run-claude-ab.js`](run-claude-ab.js) passes `--model {sonnet,opus} --effort medium --setting-sources "" --disable-slash-commands --strict-mcp-config --tools "Bash,Read,Edit,Write,Grep,Glob"` and adds `--settings <hook-settings.json>` only on the `plexer` arm.

#### Token Accounting (`bench/grade.js`)

[`bench/grade.js`](grade.js) tracks five separate token metrics from provider transcripts so Antigravity (`agy`) and Claude Code (`claude`) runs can be compared directly:

1. **Tool Output Tokens (`toolOutputTokens = ceil(bytes / 4)`):** Total volume of tool output (`view_file`/`Read`, `run_command`/`Bash`, `grep_search`/`Grep`, `plexer` stdout, and test runner output) added to the conversation.
2. **Final Context Window Tokens (`finalContextTokens`):** Total context window size (`input + cache_read + cache_creation`) on the final LLM turn of each task. This measures the net context accumulated by the end of the session without turn-count multiplication.
3. **Uncached and Cached Cumulative Input Tokens (`uncachedInputTokens` + `cachedInputTokens` = `cumulativeInputTokens`):**
   - Every LLM turn re-sends the conversation history to that point, so `cumulativeInputTokens` scales as $\mathcal{O}(\text{turns} \times \text{context})$.
   - **Claude Code** caches the system prompt and tool definitions after Turn 1 (`99.98%` of input tokens are `cachedInputTokens` at `0.1x` cost, with only ~8–15 `uncachedInputTokens` per turn) and finishes in 21–79 turns across 12 tasks.
   - **Antigravity (`neon-medium`, `carbon-medium`, and `hydrogen-medium`)** makes more granular line-range `view_file` calls (34–168 turns across 12 tasks) and bills ~10–20% of each turn's prompt as `uncachedInputTokens`. Because `plexer` cuts both tool output per turn and total turns, it reduces Antigravity's cumulative input tokens by **59–78%** on `T1`–`T12` and **41–67%** on `SWE-bench Pro V2`.
4. **Model Output Tokens (`totalModelOutputTokens`):** Total generated tokens including assistant text, tool-call arguments, and thinking tokens. On Claude Code, this is read from the top-level `result` event's `usage.output_tokens`.

---

### Multi-Model Summary (`T1`–`T12` Across 7 Model Configurations)

```bash
node bench/run-agy-ab.js orch-neon-high-hydrogen-high 4 both all
node bench/run-agy-ab.js orch-neon-xhigh-hydrogen-xhigh 4 both all
node bench/run-agy-ab.js neon-medium 4 both all
node bench/run-agy-ab.js carbon-medium 4 both all
node bench/run-agy-ab.js hydrogen-medium 4 both all
node bench/run-claude-ab.js opus 4 both all medium
node bench/run-claude-ab.js sonnet 4 both all medium
```

| Model & Effort (12 Tasks Each) | Symmetry | Correctness (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `orch-neon+h2-h`** (`Neon+H2 High`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 244 → **131 (-46.3%)** (`11W/0T/1L`) | 322,662 → **121,568 (-62.3%)** (**`12W/0T/0L`**) | 709.3k → **425.0k (-40.1%)** | 5.69M → **2.29M (-59.7%)** | 1,476.0s → **866.0s (-41.3%)** (`11W/0T/1L`) |
| **Antigravity `orch-neon+h2-xh`** (`Neon+H2 XHigh`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 300 → **116 (-61.3%)** (**`12W/0T/0L`**) | 512,000 → **98,692 (-80.7%)** (**`12W/0T/0L`**) | 1,035.1k → **398.5k (-61.5%)** | 9.44M → **1.96M (-79.2%)** | 1,811.0s → **1,214.0s (-33.0%)** (`9W/0T/3L`) |
| **Antigravity `neon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 181 → **60 (-66.9%)** (**`12W/0T/0L`**) | 155,652 → **37,702 (-75.8%)** (**`12W/0T/0L`**) | 355.6k → **204.4k (-42.5%)** | 3.13M → **0.70M (-77.5%)** | 970.0s → **423.0s (-56.4%)** (**`12W/0T/0L`**) |
| **Antigravity `carbon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 292 → **121 (-58.6%)** (**`12W/0T/0L`**) | 323,826 → **115,781 (-64.2%)** (**`12W/0T/0L`**) | 699.7k → **354.1k (-49.4%)** | 8.71M → **2.43M (-72.1%)** | 2,602.0s → **1,457.0s (-44.0%)** (`11W/0T/1L`) |
| **Antigravity `hydrogen-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 154 → **61 (-60.4%)** (`11W/1T/0L`) | 89,441 → **36,763 (-58.9%)** (`10W/0T/2L`) | 251.6k → **194.2k (-22.8%)** | 2.39M → **0.99M (-58.7%)** | 422.0s → **250.0s (-40.8%)** (`9W/0T/3L`) |
| **Claude Opus 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 81 → **28 (-65.4%)** (**`12W/0T/0L`**) | 63,696 → **18,287 (-71.3%)** (**`12W/0T/0L`**) | 225.9k → **177.5k (-21.4%)** | 1.29M → **0.57M (-55.7%)** | 248.9s → **93.1s (-62.6%)** (**`12W/0T/0L`**) |
| **Claude Sonnet 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 76 → **27 (-64.5%)** (`11W/1T/0L`) | 45,198 → **11,021 (-75.6%)** (**`12W/0T/0L`**) | 187.9k → **164.3k (-12.5%)** | 0.65M → **0.41M (-37.4%)** | 96.7s → **51.7s (-46.5%)** (`11W/0T/1L`) |
| **7-Model Total (`84` Task-Model Pairs)** | `PASSED (0)` | 668/672 → **672/672 (100.0%)** | 1,328 → **544 (-59.0%)** (`81W/2T/1L`) | 1,512,475 → **439,814 (-70.9%)** (`82W/0T/2L`) | 3,465.2k → **1,918.1k (-44.6%)** | 31.30M → **9.36M (-70.1%)** | 7,626.7s → **4,354.8s (-42.9%)** (`75W/0T/9L`) |

#### Separated Token Accounting (`T1`–`T12` Totals)

| Model Configuration | Arm | Turns | Tool Output Tok | Final Context Tok | Uncached Input Tok | Cached Input Tok | Cumulative Input Tok | Model Output Tok |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Antigravity `orch-neon+h2-h`** (`High`) | `cold` | 101 | 322,662 | 709,323 | 1,043,920 | 4,644,760 | 5,688,680 | 153,985 |
| **Antigravity `orch-neon+h2-h`** (`High`) | **`plexer`** | **57 (-43.6%)** | **121,568 (-62.3%)** | **425,018 (-40.1%)** | **566,354 (-45.7%)** | **1,728,121 (-62.8%)** | **2,294,475 (-59.7%)** | **123,547 (-19.8%)** |
| **Antigravity `orch-neon+h2-xh`** (`XHigh`) | `cold` | 124 | 512,000 | 1,035,073 | 1,568,524 | 7,866,919 | 9,435,443 | 266,818 |
| **Antigravity `orch-neon+h2-xh`** (`XHigh`) | **`plexer`** | **51 (-58.9%)** | **98,692 (-80.7%)** | **398,518 (-61.5%)** | **538,739 (-65.7%)** | **1,423,495 (-81.9%)** | **1,962,234 (-79.2%)** | **194,076 (-27.3%)** |
| **Antigravity `neon-medium`** (`medium`) | `cold` | 133 | 155,652 | 355,622 | 517,854 | 2,615,025 | 3,132,879 | 83,262 |
| **Antigravity `neon-medium`** (`medium`) | **`plexer`** | **34 (-74.4%)** | **37,702 (-75.8%)** | **204,423 (-42.5%)** | **253,631 (-51.0%)** | **449,997 (-82.8%)** | **703,628 (-77.5%)** | **65,242 (-21.6%)** |
| **Antigravity `carbon-medium`** (`medium`) | `cold` | 168 | 323,826 | 699,692 | 839,204 | 7,869,433 | 8,708,637 | 193,833 |
| **Antigravity `carbon-medium`** (`medium`) | **`plexer`** | **84 (-50.0%)** | **115,781 (-64.2%)** | **354,140 (-49.4%)** | **408,985 (-51.3%)** | **2,018,418 (-74.4%)** | **2,427,403 (-72.1%)** | **123,702 (-36.2%)** |
| **Antigravity `hydrogen-medium`** (`medium`) | `cold` | 127 | 89,441 | 251,636 | 425,574 | 1,967,710 | 2,393,284 | 72,261 |
| **Antigravity `hydrogen-medium`** (`medium`) | **`plexer`** | **45 (-64.6%)** | **36,763 (-58.9%)** | **194,209 (-22.8%)** | **261,051 (-38.7%)** | **727,177 (-63.0%)** | **988,228 (-58.7%)** | **51,353 (-28.9%)** |
| **Claude Opus 5.5** (`medium`) | `cold` | 79 | 63,696 | 225,931 | 182 | 1,287,574 | 1,287,756 | 34,149 |
| **Claude Opus 5.5** (`medium`) | **`plexer`** | **28 (-64.6%)** | **18,287 (-71.3%)** | **177,499 (-21.4%)** | **80 (-56.0%)** | **570,169 (-55.7%)** | **570,249 (-55.7%)** | **23,832 (-30.2%)** |
| **Claude Sonnet 5.5** (`medium`) | `cold` | 41 | 45,198 | 187,880 | 106 | 654,253 | 654,359 | 24,145 |
| **Claude Sonnet 5.5** (`medium`) | **`plexer`** | **19 (-53.7%)** | **11,021 (-75.6%)** | **164,329 (-12.5%)** | **62 (-41.5%)** | **409,296 (-37.4%)** | **409,358 (-37.4%)** | **16,923 (-29.9%)** |

---

### Tier 1: Antigravity `neon-medium` (`gemini-4-neon-medium --effort medium`)

Cuts tool output tokens by `-75.8%` (`12W/0T/0L`), final context by `-42.5%`, tool calls by `-66.9%` (`12W/0T/0L`), cumulative input by `-77.5%`, search time by `-56.4%` (`12W/0T/0L`), and total latency by `-49.6%` (`1,285.1s → 648.3s`, `96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 5 (5) | **1 (1)** (-80%) | 4,208 | **415** (-90%) | 21.0s (36.5s) | **8.0s** (**16.6s**) (-62%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 9 (9) | **7 (4)** (-22%) | 7,530 | **4,789** (-36%) | 43.0s (84.8s) | **29.0s** (**63.8s**) (-33%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 7 (7) | **3 (2)** (-57%) | 10,813 | **2,095** (-81%) | 45.0s (160.7s) | **11.0s** (**27.8s**) (-76%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 10 (7) | **0 (0)** (-100%) | 10,589 | **0** (-100%) | 39.0s (54.4s) | **0.0s** (**19.6s**) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 16 (16) | **7 (3)** (-56%) | 26,910 | **8,215** (-69%) | 78.0s (102.4s) | **37.0s** (**72.6s**) (-53%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 31 (11) | **3 (2)** (-90%) | 13,301 | **3,313** (-75%) | 60.0s (84.3s) | **19.0s** (**53.5s**) (-68%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 6 (4) | **2 (1)** (-67%) | 8,822 | **1,147** (-87%) | 20.0s (39.7s) | **9.0s** (**27.3s**) (-55%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 9 (6) | **3 (1)** (-67%) | 9,323 | **3,663** (-61%) | 40.0s (69.3s) | **11.0s** (**42.4s**) (-72%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 23 (15) | **10 (6)** (-57%) | 11,558 | **3,860** (-67%) | 171.0s (181.3s) | **114.0s** (**122.2s**) (-33%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 16 (12) | **8 (6)** (-50%) | 19,682 | **4,884** (-75%) | 130.0s (134.7s) | **66.0s** (**71.3s**) (-49%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 31 (31) | **9 (5)** (-71%) | 15,092 | **3,884** (-74%) | 244.0s (250.7s) | **88.0s** (**94.5s**) (-64%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 18 (10) | **7 (3)** (-61%) | 17,824 | **1,437** (-92%) | 79.0s (86.4s) | **31.0s** (**36.7s**) (-61%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **181 (133)** | **60 (34) (-66.9%)** | **155,652** | **37,702 (-75.8%)** | **970.0s (1285.1s)** | **423.0s (648.3s) (-56.4%)** | **96/96** | **96/96** |

---

### Tier 2: Antigravity `carbon-medium` (`gemini-4-carbon-medium --effort medium`)

Cuts tool output tokens by `-64.2%` (`12W/0T/0L`), final context by `-49.4%`, tool calls by `-58.6%` (`12W/0T/0L`), cumulative input by `-72.1%`, and total latency by `-33.4%` (`3,228.9s → 2,149.0s`, `96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 11 (7) | **3 (3)** (-73%) | 9,893 | **2,103** (-79%) | 44.0s (81.0s) | **32.0s** (66.8s) (-27%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 9 (7) | **5 (3)** (-44%) | 17,363 | **6,178** (-64%) | 50.0s (158.0s) | 103.0s (178.7s) (+106%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 5 (4) | **2 (2)** (-60%) | 15,614 | **2,538** (-84%) | 35.0s (110.2s) | **15.0s** (66.2s) (-57%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 12 (6) | **1 (1)** (-92%) | 18,300 | **2,198** (-88%) | 45.0s (98.8s) | **7.0s** (62.7s) (-84%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 21 (12) | **17 (10)** (-19%) | 41,423 | **29,924** (-28%) | 126.0s (242.1s) | **124.0s** (**214.1s**) (-2%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 34 (10) | **4 (4)** (-88%) | 29,875 | **8,478** (-72%) | 145.0s (225.2s) | **41.0s** (115.5s) (-72%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 19 (13) | **5 (5)** (-74%) | 26,612 | **6,277** (-76%) | 117.0s (158.5s) | **45.0s** (86.1s) (-62%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 11 (6) | **7 (3)** (-36%) | 14,251 | **9,463** (-34%) | 114.0s (187.4s) | **67.0s** (279.5s) (-41%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 43 (20) | **21 (14)** (-51%) | 34,553 | **13,910** (-60%) | 415.0s (426.6s) | **271.0s** (**290.2s**) (-35%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 46 (32) | **14 (11)** (-70%) | 50,405 | **13,025** (-74%) | 734.0s (745.4s) | **233.0s** (**243.3s**) (-68%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 46 (27) | **20 (13)** (-57%) | 32,781 | **11,121** (-66%) | 516.0s (525.1s) | **324.0s** (**343.2s**) (-37%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 35 (24) | **22 (15)** (-37%) | 32,756 | **10,566** (-68%) | 261.0s (270.8s) | **195.0s** (202.6s) (-25%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **292 (168)** | **121 (84) (-58.6%)** | **323,826** | **115,781 (-64.2%)** | **2602.0s (3228.9s)** | **1457.0s (2149.0s) (-44.0%)** | **96/96** | **96/96** |

---

### Tier 3: Antigravity `hydrogen-medium` (`gemini-4-hydrogen-medium --effort medium`)

Cuts tool output tokens by `-58.9%` (`10W/0T/2L`), final context by `-22.8%`, tool calls by `-60.4%` (`11W/1T/0L`), cumulative input by `-58.7%`, and search time by `-40.8%` (`9W/0T/3L`, `96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 2 (2) | **1 (1)** (-50%) | 2,818 | **307** (-89%) | 4.0s (14.0s) | 5.0s (**12.7s**) (+25%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 9 (5) | **3 (2)** (-67%) | 6,459 | **1,814** (-72%) | 14.0s (30.5s) | **7.0s** (**24.1s**) (-50%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 7 (7) | **1 (1)** (-86%) | 6,231 | **380** (-94%) | 16.0s (26.1s) | **3.0s** (**13.1s**) (-81%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 6 (6) | **0 (0)** (-100%) | 4,205 | **0** (-100%) | 13.0s (22.5s) | **0.0s** (**9.0s**) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 18 (10) | **4 (4)** (-78%) | 19,033 | **7,005** (-63%) | 26.0s (40.1s) | **19.0s** (**27.2s**) (-27%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 3 (3) | **3 (3)** (0%) | 1,979 | 3,312 (+67%) | 7.0s (19.9s) | 14.0s (27.4s) (+100%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 6 (6) | **2 (1)** (-67%) | 2,905 | **1,262** (-57%) | 12.0s (23.2s) | **7.0s** (**18.2s**) (-42%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 7 (7) | **2 (1)** (-71%) | 5,247 | **2,420** (-54%) | 19.0s (30.5s) | **6.0s** (**29.9s**) (-68%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 22 (14) | **19 (16)** (-14%) | 8,657 | 9,955 (+15%) | 75.0s (80.2s) | 96.0s (99.6s) (+28%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 15 (15) | **9 (7)** (-40%) | 10,864 | **3,490** (-68%) | 61.0s (63.5s) | **35.0s** (**37.4s**) (-43%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 36 (29) | **7 (3)** (-81%) | 12,090 | **2,907** (-76%) | 108.0s (111.0s) | **26.0s** (**28.5s**) (-76%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 23 (23) | **10 (6)** (-57%) | 8,953 | **3,911** (-56%) | 67.0s (70.5s) | **32.0s** (**35.4s**) (-52%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **154 (127)** | **61 (45) (-60.4%)** | **89,441** | **36,763 (-58.9%)** | **422.0s (531.8s)** | **250.0s (362.7s) (-40.8%)** | **96/96** | **96/96** |

---

### Tier 4: Claude Opus 5.5 (`claude -p --model claude-opus-5-5 --effort medium`)

Cuts tool output tokens by `-71.3%` (`12W/0T/0L`), tool calls by `-65.4%` (`12W/0T/0L`), and search time by `-62.6%` (`12W/0T/0L`), while raising score from `94/96` to `96/96`.

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 8 (7) | **0 (0)** (-100%) | 5,288 | **0** (-100%) | 13.8s (29.4s) | **0.0s** (13.8s) (-100%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 6 (6) | **2 (2)** (-67%) | 5,248 | **654** (-88%) | 15.9s (34.9s) | **2.8s** (20.9s) (-82%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 6 (6) | **3 (3)** (-50%) | 5,143 | **994** (-81%) | 11.7s (25.5s) | **8.9s** (24.2s) (-24%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 3 (3) | **0 (0)** (-100%) | 2,457 | **0** (-100%) | 4.6s (15.1s) | **0.0s** (10.8s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 6 (5) | **3 (3)** (-50%) | 11,421 | **3,643** (-68%) | 15.7s (34.7s) | **8.4s** (27.7s) (-47%) | 6/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 6 (6) | **1 (1)** (-83%) | 3,664 | **662** (-82%) | 14.6s (28.7s) | **0.4s** (17.7s) (-97%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 6 (6) | **1 (1)** (-83%) | 2,887 | **1,147** (-60%) | 15.3s (29.9s) | **0.5s** (18.2s) (-97%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 5 (5) | **1 (1)** (-80%) | 5,508 | **1,268** (-77%) | 15.9s (37.6s) | **2.2s** (22.0s) (-86%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 11 (11) | **7 (7)** (-36%) | 6,134 | **2,797** (-54%) | 46.9s (58.6s) | **29.1s** (41.4s) (-38%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 8 (8) | **4 (4)** (-50%) | 7,287 | **2,312** (-68%) | 30.8s (40.3s) | **15.3s** (24.0s) (-50%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 9 (9) | **4 (4)** (-56%) | 5,215 | **3,321** (-36%) | 45.1s (57.3s) | **19.4s** (28.0s) (-57%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 7 (7) | **2 (2)** (-71%) | 3,444 | **1,489** (-57%) | 18.6s (26.8s) | **6.1s** (12.7s) (-67%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **81 (79)** | **28 (28) (-65.4%)** | **63,696** | **18,287 (-71.3%)** | **248.9s (418.9s)** | **93.1s (261.5s) (-62.6%)** | **94/96** | **96/96** |

---

### Tier 5: Claude Sonnet 5.5 (`claude -p --model claude-sonnet-5-5 --effort medium`)

Cuts tool output tokens by `-75.6%` (`12W/0T/0L`), tool calls by `-64.5%` (`11W/1T/0L`), and search time by `-46.5%` (`11W/0T/1L`), while raising score from `94/96` to `96/96`.

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 3 (2) | **0 (0)** (-100%) | 2,914 | **0** (-100%) | 1.7s (9.9s) | **0.0s** (6.7s) (-100%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 9 (5) | **3 (2)** (-67%) | 5,445 | **1,349** (-75%) | 9.0s (22.6s) | **4.5s** (18.2s) (-51%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 2 (2) | **0 (0)** (-100%) | 1,065 | **0** (-100%) | 1.6s (9.4s) | **0.0s** (6.7s) (-100%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 4 (3) | **0 (0)** (-100%) | 2,921 | **0** (-100%) | 4.3s (11.4s) | **0.0s** (7.9s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 6 (3) | **3 (3)** (-50%) | 6,969 | **1,435** (-79%) | 6.3s (18.9s) | **4.5s** (**14.8s**) (-29%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 2 (2) | **0 (0)** (-100%) | 1,024 | **0** (-100%) | 1.5s (10.2s) | **0.0s** (9.9s) (-100%) | 6/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 3 (3) | **3 (1)** (0%) | 2,656 | **1,157** (-56%) | 4.8s (12.4s) | **0.9s** (9.8s) (-82%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 9 (3) | **1 (1)** (-89%) | 7,253 | **716** (-90%) | 7.8s (23.3s) | **0.4s** (19.8s) (-95%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 4 (3) | **3 (3)** (-25%) | 2,330 | **1,245** (-47%) | 10.6s (18.3s) | 13.0s (18.6s) (+23%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 8 (4) | **2 (2)** (-75%) | 4,391 | **1,239** (-72%) | 13.1s (18.9s) | **6.1s** (11.5s) (-54%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 10 (5) | **4 (4)** (-60%) | 4,598 | **1,737** (-62%) | 17.7s (23.7s) | **14.3s** (**19.6s**) (-19%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 16 (6) | **8 (3)** (-50%) | 3,632 | **2,143** (-41%) | 18.4s (22.6s) | **8.3s** (**12.1s**) (-55%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **76 (41)** | **27 (19) (-64.5%)** | **45,198** | **11,021 (-75.6%)** | **96.7s (201.5s)** | **51.7s (155.7s) (-46.5%)** | **94/96** | **96/96** |

---

### Tier 6: Antigravity `orch-neon-xhigh-hydrogen-xhigh` (`gemini-pro-orchestrator-neon`, `Neon XHigh` planner + `Hydrogen XHigh` executor)

Cuts tool output tokens by `-80.7%` (`12W/0T/0L`), final context by `-61.5%`, tool calls by `-61.3%` (`12W/0T/0L`), cumulative input by `-79.2%`, search time by `-33.0%` (`9W/0T/3L`), and total latency by `-30.1%` (`2,462.3s → 1,720.4s`, `96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 12 (5) | **0 (0)** (-100%) | 36,583 | **0** (-100%) | 40.0s (91.3s) | **0.0s** (47.1s) (-100%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 12 (4) | **5 (3)** (-58%) | 49,674 | **7,381** (-85%) | 24.0s (152.3s) | 35.0s (**139.8s**) (+46%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 7 (3) | **3 (2)** (-57%) | 25,439 | **3,498** (-86%) | 23.0s (108.9s) | 26.0s (**86.4s**) (+13%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 14 (7) | **0 (0)** (-100%) | 37,360 | **0** (-100%) | 58.0s (117.2s) | **0.0s** (39.2s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 24 (7) | **22 (4)** (-8%) | 47,353 | **25,268** (-47%) | 71.0s (169.9s) | 88.0s (**141.7s**) (+24%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 27 (9) | **4 (2)** (-85%) | 36,292 | **3,441** (-91%) | 77.0s (156.1s) | **32.0s** (92.9s) (-58%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 14 (6) | **4 (2)** (-71%) | 31,306 | **3,662** (-88%) | 55.0s (104.4s) | **34.0s** (76.0s) (-38%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 18 (6) | **5 (3)** (-72%) | 26,775 | **5,894** (-78%) | 66.0s (137.6s) | **44.0s** (121.8s) (-33%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 39 (16) | **21 (10)** (-46%) | 44,094 | **11,635** (-74%) | 352.0s (359.1s) | **254.0s** (259.5s) (-28%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 41 (23) | **15 (10)** (-63%) | 55,261 | **14,589** (-74%) | 440.0s (445.5s) | **295.0s** (298.7s) (-33%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 50 (21) | **21 (9)** (-58%) | 65,286 | **14,205** (-78%) | 396.0s (402.6s) | **298.0s** (305.8s) (-25%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 42 (17) | **16 (6)** (-62%) | 56,577 | **9,119** (-84%) | 209.0s (217.3s) | **108.0s** (111.6s) (-48%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **300 (124)** | **116 (51) (-61.3%)** | **512,000** | **98,692 (-80.7%)** | **1,811.0s (2,462.3s)** | **1,214.0s (1,720.4s) (-33.0%)** | **96/96** | **96/96** |

#### Orchestrator Role Breakdown (`gemini-4-neon-xhigh` Planner vs. `gemini-4-hydrogen-xhigh` Executor)

Aggregated across the multi-role handoff sessions (`T9`–`T12`, `S1`–`S8`, and `L5`–`L8` where `exit_plan_mode` transitioned to the executor):

| Suite (Handoff Tasks) | Arm | Handoffs / Reviews | Planner (`gemini-4-neon-xhigh`) | Executor (`gemini-4-hydrogen-xhigh`) |
| :--- | :--- | :---: | :---: | :---: |
| **Engineering `T9`–`T12`** (4 tasks) | `cold` | `4 / 0` | `49t · 107 calls · 3,592k cum · 506k unc` | `32t · 65 calls · 3,375k cum · 485k unc` |
| **Engineering `T9`–`T12`** (4 tasks) | **`plexer`** | `4 / 0` | **`22t · 43 calls · 640k cum (-82.2%) · 160k unc`** | **`17t · 30 calls · 750k cum (-77.8%) · 203k unc`** |
| **SWE-bench Pro `S1`–`S8`** (8 tasks) | `cold` | `8 / 0` | `136t · 385 calls · 11,581k cum · 1,137k unc` | `46t · 106 calls · 5,799k cum · 1,100k unc` |
| **SWE-bench Pro `S1`–`S8`** (8 tasks) | **`plexer`** | `8 / 4` | **`57t · 176 calls · 2,540k cum (-78.1%) · 543k unc`** | **`35t · 75 calls · 2,097k cum (-63.8%) · 532k unc`** |
| **Large OSS `L5`–`L8`** (4 tasks) | `cold` | `4 / 0` | `34t · 69 calls · 1,095k cum · 207k unc` | `12t · 20 calls · 533k cum · 194k unc` |
| **Large OSS `L5`–`L8`** (4 tasks) | **`plexer`** | `4 / 0` | **`14t · 35 calls · 329k cum (-70.0%) · 109k unc`** | **`15t · 24 calls · 486k cum (-8.8%) · 152k unc`** |

---

### Tier 7: Antigravity `orch-neon-high-hydrogen-high` (`gemini-pro-orchestrator-neon`, `Neon High` planner + `Hydrogen High` executor)

Cuts tool output tokens by `-62.3%` (`12W/0T/0L`), final context by `-40.1%`, tool calls by `-46.3%` (`11W/0T/1L`), cumulative input by `-59.7%`, search time by `-41.3%` (`11W/0T/1L`), and total latency by `-33.9%` (`1,882.3s → 1,243.4s`, `96/96` score) with zero `[plan review]` bounces across all 3 suites.

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 7 (4) | **1 (1)** (-86%) | 13,226 | **739** (-94%) | 29.0s (57.5s) | **15.0s** (**31.7s**) (-48%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 11 (4) | **4 (4)** (-64%) | 15,976 | **4,941** (-69%) | 39.0s (101.6s) | **35.0s** (**90.8s**) (-10%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 5 (3) | **1 (1)** (-80%) | 16,773 | **7,670** (-54%) | 45.0s (78.0s) | **7.0s** (**41.8s**) (-84%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 7 (4) | **4 (3)** (-43%) | 29,607 | **4,383** (-85%) | 35.0s (83.2s) | **29.0s** (**82.9s**) (-17%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 17 (6) | 19 (4) (+12%) | 35,384 | **30,593** (-14%) | 47.0s (116.9s) | 50.0s (**108.8s**) (+6%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 28 (6) | **2 (2)** (-93%) | 25,262 | **2,482** (-90%) | 61.0s (118.8s) | **28.0s** (**75.2s**) (-54%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 10 (5) | **2 (1)** (-80%) | 21,209 | **1,217** (-94%) | 29.0s (68.5s) | **13.0s** (**48.3s**) (-55%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 14 (5) | **9 (3)** (-36%) | 18,966 | **11,516** (-39%) | 65.0s (110.9s) | **48.0s** (**102.7s**) (-26%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 30 (13) | **27 (11)** (-10%) | 36,514 | **17,210** (-53%) | 209.0s (215.2s) | **190.0s** (**195.5s**) (-9%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 36 (21) | **15 (8)** (-58%) | 31,218 | **18,722** (-40%) | 480.0s (483.7s) | **169.0s** (**172.8s**) (-65%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 41 (16) | **25 (11)** (-39%) | 47,460 | **12,786** (-73%) | 265.0s (270.9s) | **203.0s** (**208.4s**) (-23%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 38 (14) | **22 (8)** (-42%) | 31,067 | **9,309** (-70%) | 172.0s (177.1s) | **79.0s** (**84.4s**) (-54%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **244 (101)** | **131 (57) (-46.3%)** | **322,662** | **121,568 (-62.3%)** | **1,476.0s (1,882.3s)** | **866.0s (1,243.4s) (-41.3%)** | **96/96** | **96/96** |

#### Orchestrator Role Breakdown (`gemini-4-neon-high` Planner vs. `gemini-4-hydrogen-high` Executor)

| Suite (Handoff Tasks) | Arm | Handoffs / Reviews | Planner (`gemini-4-neon-high`) | Executor (`gemini-4-hydrogen-high`) |
| :--- | :--- | :---: | :---: | :---: |
| **Engineering `T9`–`T12`** (4 tasks) | `cold` | `4 / 0` | `34t · 76 calls · 1,666k cum · 281k unc` | `34t · 69 calls · 2,549k cum · 360k unc` |
| **Engineering `T9`–`T12`** (4 tasks) | **`plexer`** | `4 / 0` | **`17t · 27 calls · 501k cum (-70.0%) · 119k unc`** | **`25t · 62 calls · 1,191k cum (-53.3%) · 232k unc`** |
| **SWE-bench Pro `S1`–`S8`** (8 tasks) | `cold` | `8 / 0` | `123t · 269 calls · 7,128k cum · 925k unc` | `40t · 97 calls · 3,374k cum · 796k unc` |
| **SWE-bench Pro `S1`–`S8`** (8 tasks) | **`plexer`** | `8 / 0` | **`55t · 129 calls · 2,261k cum (-68.3%) · 418k unc`** | **`47t · 112 calls · 3,023k cum (-10.4%) · 667k unc`** |
| **Large OSS `L5`–`L8`** (4 tasks) | `cold` | `4 / 0` | `22t · 45 calls · 530k cum · 103k unc` | `16t · 26 calls · 510k cum · 157k unc` |
| **Large OSS `L5`–`L8`** (4 tasks) | **`plexer`** | `4 / 0` | **`12t · 25 calls · 269k cum (-49.3%) · 70k unc`** | **`13t · 26 calls · 381k cum (-25.3%) · 166k unc`** |

---

## 2. External Multi-Language Benchmark: `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`)

[`bench/run-swebench-ab.js`](run-swebench-ab.js) evaluates an 8-task stratified subset (`S1`–`S8`, 2 tasks per language across Python, Go, JavaScript, and TypeScript) from **`ScaleAI/SWE-bench_Pro` V2** across all 7 model configurations:

- **`S1` & `S2` (Python, `qutebrowser/qutebrowser`):** WebKit `NetworkReply` Qt 5.15 `errorOccurred` signal migration (`S1`) and multi-file `KeyMode` / `EventFilter` handling (`S2`).
- **`S3` & `S4` (Go, `flipt-io/flipt`):** Authentication cleanup service gating (`ShouldRunCleanup`) across `internal/cleanup`, `internal/cmd`, and `internal/config` (`S3`), and evaluation rollout caching (`GetEvaluationRollouts`) across `internal/storage/cache` and `internal/storage` (`S4`).
- **`S5` & `S6` (JavaScript, `NodeBB/NodeBB`):** User email confirmation refactor across `src/middleware` and `src/user` (`S5`), and queued-post topic merging (`updateQueuedPostsTopic`) across `src/posts/queue.js` and `src/topics/merge.js` (`S6`).
- **`S7` & `S8` (TypeScript, `tutao/tutanota`):** Desktop download manager error handling across `src/desktop/DesktopDownloadManager.ts` and `DesktopNetworkClient.ts` (`S7`), and device credential encryption facade updates across `src/api/worker/facades` and `src/misc/credentials` (`S8`).

```bash
node bench/run-swebench-ab.js orch-neon-high-hydrogen-high 4 both all
node bench/run-swebench-ab.js orch-neon-xhigh-hydrogen-xhigh 4 both all
node bench/run-swebench-ab.js neon-medium 4 both all
node bench/run-swebench-ab.js carbon-medium 4 both all
node bench/run-swebench-ab.js hydrogen-medium 4 both all
node bench/run-swebench-ab.js opus 4 both all
node bench/run-swebench-ab.js sonnet 4 both all
```

### `SWE-bench Pro V2` Summary Across All 7 Models (`S1`–`S8`, 56 Pairs)

| Model & Effort (8 Tasks Each) | Patch Score (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Model Output Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `orch-neon+h2-h`** (`Neon+H2 High`) | **63/64 → 63/64** (`100%` file recall) | 366 → **241 (-34.2%)** (**`8W/0T/0L`**) | 312,484 → **204,373 (-34.6%)** (`6W/0T/2L`) | 669.7k → **528.7k (-21.1%)** | 10.50M → **5.28M (-49.7%)** | 263,039 → **181,903 (-30.8%)** | 2,956.0s → **1,874.0s (-36.6%)** (**`8W/0T/0L`**) |
| **Antigravity `orch-neon+h2-xh`** (`Neon+H2 XHigh`) | 64/64 → **63/64** (`100%` file recall) | 491 → **251 (-48.9%)** (**`8W/0T/0L`**) | 528,081 → **196,623 (-62.8%)** (**`8W/0T/0L`**) | 1,079.9k → **542.4k (-49.8%)** | 17.38M → **4.64M (-73.3%)** | 455,081 → **315,790 (-30.6%)** | 3,824.0s → **2,692.0s (-29.6%)** (**`8W/0T/0L`**) |
| **Antigravity `neon-medium`** (`--effort medium`) | 62/64 → **63/64 (+1.6%)** (`100%` file recall) | 228 → **114 (-50.0%)** (**`8W/0T/0L`**) | 136,801 → **63,245 (-53.8%)** (**`8W/0T/0L`**) | 377.6k → **250.2k (-33.8%)** | 4.56M → **1.53M (-66.5%)** | 128,272 → **82,268 (-35.9%)** | 1,370.0s → **853.0s (-37.7%)** (**`8W/0T/0L`**) |
| **Antigravity `carbon-medium`** (`--effort medium`) | **64/64 → 64/64** (`100%` file recall) | 457 → **212 (-53.6%)** (**`8W/0T/0L`**) | 380,361 → **176,378 (-53.6%)** (**`8W/0T/0L`**) | 965.9k → **594.5k (-38.4%)** | 20.07M → **6.97M (-65.3%)** | 339,673 → **253,767 (-25.3%)** | 5,681.0s → **3,569.0s (-37.2%)** (**`8W/0T/0L`**) |
| **Antigravity `hydrogen-medium`** (`--effort medium`) | 62/64 → **63/64 (+1.6%)** (`100%` file recall) | 193 → **117 (-39.4%)** (**`8W/0T/0L`**) | 89,571 → **59,233 (-33.9%)** (**`8W/0T/0L`**) | 282.7k → **233.7k (-17.3%)** | 2.87M → **1.70M (-40.9%)** | 98,806 → **64,947 (-34.3%)** | 652.0s → **562.0s (-13.8%)** (`6W/0T/2L`) |
| **Claude Opus 5.5** (`--effort medium`) | 62/64 → **63/64 (+1.6%)** (`100%` file recall) | 39 → 49 (+25.6%) (`2W/3T/3L`) | 24,253 → **18,896 (-22.1%)** (`7W/0T/1L`) | 132.9k → 152.0k (+14.3%) | 645.6k → 913.3k (+41.5%) | 23,373 → 25,841 (+10.6%) | 193.1s → 193.7s (+0.3%) (`4W/0T/4L`) |
| **Claude Sonnet 5.5** (`--effort medium`) | 60/64 → **62/64 (+3.3%)** (`100%` file recall) | 65 → **26 (-60.0%)** (**`8W/0T/0L`**) | 19,344 → **9,877 (-48.9%)** (**`8W/0T/0L`**) | 125.2k → **123.5k (-1.4%)** | 637.0k → **410.4k (-35.6%)** | 21,386 → **13,109 (-38.7%)** | 120.1s → **54.7s (-54.5%)** (**`8W/0T/0L`**) |
| **7-Model Total (`56` Task-Model Pairs)** | 437/448 → **441/448** (`100%` file recall) | 1,839 → **1,010 (-45.1%)** (`50W/3T/3L`) | 1,490,895 → **728,625 (-51.1%)** (`53W/0T/3L`) | 3,633.9k → **2,424.9k (-33.3%)** | 56.67M → **21.44M (-62.2%)** | 1,329,630 → **937,625 (-29.5%)** | 14,796.2s → **9,798.4s (-33.8%)** (`50W/0T/6L`) |

---

## 3. Large-Repo & Discriminative Suite (`L1`–`L8`)

[`bench/run-large-ab.js`](run-large-ab.js) evaluates 8 multi-file tasks (`L1`–`L8`) across `pocketbase/pocketbase`, `tutao/tutanota`, `qutebrowser/qutebrowser`, `flipt-io/flipt`, and `NodeBB/NodeBB` (440 to 1,350+ files). Tasks `L1`–`L4` trace cross-subsystem blast radius, and `L5`–`L8` apply coordinated 2–4 file edits under strict binary resolution (`100%` gold sibling files plus contract checks).

```bash
node bench/run-large-ab.js orch-neon-high-hydrogen-high 4 both all
node bench/run-large-ab.js orch-neon-xhigh-hydrogen-xhigh 4 both all
node bench/run-large-ab.js neon-medium 4 both all
node bench/run-large-ab.js carbon-medium 4 both all
node bench/run-large-ab.js hydrogen-medium 4 both all
node bench/run-large-ab.js opus 4 both all
node bench/run-large-ab.js sonnet 4 both all
```

### Large-Repo Summary Across All 7 Models (`L1`–`L8`, 56 Pairs)

| Model & Effort (8 Tasks Each) | Strict Resolved (`cold` → `plexer`) | Score (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `orch-neon+h2-h`** (`Neon+H2 High`) | **8/8 → 8/8** | **64/64 → 64/64** | 108 → **60 (-44.4%)** | 84,349 → **38,266 (-54.6%)** | 244.2k → **206.2k (-15.6%)** | 1.45M → **0.84M (-42.0%)** | 532.0s → **395.0s (-25.8%)** |
| **Antigravity `orch-neon+h2-xh`** (`Neon+H2 XHigh`) | **8/8 → 8/8** | **64/64 → 64/64** | 131 → **70 (-46.6%)** | 123,421 → **43,581 (-64.7%)** | 304.4k → **220.8k (-27.4%)** | 2.08M → **1.00M (-51.7%)** | 669.0s → **646.0s (-3.4%)** |
| **Antigravity `neon-medium`** (`--effort medium`) | **8/8 → 8/8** | **64/64 → 64/64** | 84 → **26 (-69.0%)** | 49,391 → **14,277 (-71.1%)** | 132.0k → **103.8k (-21.4%)** | 666.5k → **235.8k (-64.6%)** | 322.0s → **129.0s (-59.9%)** |
| **Antigravity `carbon-medium`** (`--effort medium`) | **8/8 → 8/8** | **64/64 → 64/64** | 114 → **55 (-51.8%)** | 105,659 → **43,246 (-59.1%)** | 237.6k → **167.3k (-29.6%)** | 1.95M → **823.7k (-57.8%)** | 838.0s → **602.0s (-28.2%)** |
| **Antigravity `hydrogen-medium`** (`--effort medium`) | **8/8 → 8/8** | **64/64 → 64/64** | 73 → **31 (-57.5%)** | 37,590 → **14,186 (-62.3%)** | 115.5k → **104.2k (-9.7%)** | 502.4k → **310.5k (-38.2%)** | 137.0s → **104.0s (-24.1%)** |
| **Claude Opus 5.5** (`--effort medium`) | **8/8 → 8/8** | **64/64 → 64/64** | 25 → 31 (+24.0%) | 17,993 → **10,163 (-43.5%)** | 106.1k → 122.5k (+15.5%) | 360.4k → 441.8k (+22.6%) | 58.7s → 69.3s (+17.9%) |
| **Claude Sonnet 5.5** (`--effort medium`) | 6/8 → **8/8** | 60/64 → **64/64** | 41 → **28 (-31.7%)** | 17,706 → **10,543 (-40.5%)** | 105.3k → 120.3k (+14.3%) | 314.3k → 328.8k (+4.6%) | 40.9s → **33.9s (-17.2%)** |
| **7-Model Total (`56` Pairs)** | 54/56 → **56/56** | 444/448 → **448/448** | 576 → **301 (-47.7%)** (`47W/4T/5L`) | 436,109 → **174,262 (-60.0%)** (`54W/0T/2L`) | 1,245.0k → **1,045.2k (-16.0%)** | 7.32M → **3.98M (-45.6%)** | 2,597.7s → **1,979.2s (-23.8%)** (`40W/2T/14L`) |

### 3-Tier Offline Optimization Suite (`node bench/eval-fast.js`)

[`bench/eval-fast.js`](eval-fast.js) evaluates retrieval ranking, named-definition pinning (`src/claude/pin.js`), and hook budgets across all 28 tasks (`T1`–`T12` + `S1`–`S8` + `L1`–`L8`) in ~5.0s at `$0` API cost:
1. **Transcript-mined ground truth (`bench/replay.js` → `bench/needed-spans.json`):** Captures every line range and symbol that `cold` agents read or grepped across `T1`–`T12`, `S1`–`S8`, and `L1`–`L8`, plus SWE-bench and Large-Repo gold patch hunks.
2. **Coverage metrics (`bench/needcov.js`):** Computes `NeedCov` (weighted share of needed lines inlined with `<n>:` numbers at Turn 0: `T=6.6%`, `S=19.2%`, `L=24.2%`, `holdout=6.4%` for Claude; `T=16.8%`, `S=35.0%`, `L=40.2%`, `holdout=22.7%` for Gemini) and `LocCov` (share of needed symbols pointed to or inlined at Turn 0: `T=34.4%`, `S=47.6%`, `L=86.6%`, `holdout=34.6%` for Claude; `T=38.8%`, `S=57.4%`, `L=91.7%`, `holdout=48.3%` for Gemini), with separate holdout reporting (`T4`, `T8`, `T12`).
3. **Live-calibrated cost model (`bench/cost-model.js` & `bench/turn-model.json`):** Uses per-family linear models fit on the recorded live runs (`wall R² = 0.91–0.92` on Claude, `0.90–0.98` on single-model Gemini, and `0.95–0.99` on Orchestrator `Neon+H2` `High` and `XHigh`; `cum R² = 0.84–0.93` with `1.0 × (turns + 1) × t0Tok` Turn-0 re-billing), achieving **`100.0%` Gold File Recall on `S1`–`S8` and `L1`–`L8`** (`94.4%` on `T1`–`T12`), **`67.3%` `TokCov` on `T1`–`T12`**, **`-19.0%` `EstWall`**, **`-1.4%` `EstUncached`**, **`-13.4%` `EstCost`**, and **`-20.7%` `EstCum`** on Claude (`-45.1%`, `-47.4%`, `-50.4%`, and `-64.2%` across single-model Gemini 4; `-39.1%`, `-47.4%`, `-47.1%`, and `-58.7%` across Orchestrator `Neon+H2` `High` & `XHigh`) vs. `cold`.

```bash
node bench/eval-fast.js
node bench/eval-fast.js --missing S5
node bench/eval-fast.js --quiet --set editMergedBytes=3200
```

---

## 4. Engine & Retrieval Benchmark (`npm run bench`)

[`bench/run.js`](run.js) benchmarks the `plexer` engine across 6 repositories (`plexer`, `kohls-admin`, `flux`, `sert`, `building-tools`, and `z`, totaling **14,475 symbols** and **29,088 graph edges** at pinned benchmark commits) and **24 natural-language intent queries**:

```bash
npm run bench
# Emit raw JSON metrics:
node bench/run.js --json
```

### Results Across 6 Repositories (24 Intent Queries)

- **Retrieval accuracy:** **100.0% Recall@1 (24/24)**, **100.0% Recall@3 (24/24)**, **100.0% Recall@5 (24/24)**, and **1.000 MRR**.

| Repository | Graph Size (Nodes / Edges) | `wiring.json` | `check` | `ask --source` Latency & Tokens (vs Raw Files) | `callers` (`d=2`) | `skeleton` | `map` |
| :--- | ---: | ---: | ---: | :--- | ---: | ---: | ---: |
| **`plexer`** (JS/TS) | 1,973 / 6,126 | 1,571 KB | 42.1ms | **14.0ms** / 1,181 tok (**-96%** vs 28,541 raw) | **0.18ms** | **0.14ms** | 0.05ms |
| **`kohls-admin`** (Luau) | 2,547 / 3,659 | 1,526 KB | 75.8ms | **11.9ms** / 1,161 tok (**-89%** vs 10,574 raw) | **0.80ms** | **0.05ms** | 0.02ms |
| **`flux`** (Luau) | 1,445 / 2,027 | 768 KB | 24.0ms | **6.8ms** / 1,290 tok (**-95%** vs 27,441 raw) | **0.28ms** | **0.14ms** | 0.01ms |
| **`sert`** (Luau + Py) | 2,926 / 6,070 | 1,915 KB | 58.9ms | **11.6ms** / 938 tok (**-91%** vs 10,757 raw) | **1.74ms** | **0.04ms** | 0.01ms |
| **`building-tools`** (Luau) | 1,970 / 4,769 | 1,437 KB | 33.3ms | **10.5ms** / 1,346 tok (**-75%** vs 5,306 raw) | **0.99ms** | **0.02ms** | 0.01ms |
| **`z`** (Luau + Rust + Py) | 3,614 / 6,437 | 2,465 KB | 71.5ms | **20.6ms** / 1,234 tok (**-92%** vs 15,116 raw) | **0.58ms** | **0.04ms** | 0.06ms |

---

## 5. Track A: Verified Regression Fixes (Apples-to-Apples on v1 Baselines)

Track A addressed the regressions uncovered in the initial 196-pair run while keeping the v1 benchmark files untouched. We trimmed `SKILL.md` from `1,020 B` to `319 B`, dynamically slimmed Claude Turn-0 budgets, switched edit excerpts to contiguous verbatim slices without mid-body gaps, and disabled redundant shell rewrites and post-edit blast noise. On the graph side, we extracted Python Qt signal and class-attribute edges alongside CommonJS dotted namespace members (`src/graph/extract.js`, `src/graph/resolve.js`, `src/claude/pin.js`), added fast Gemini budget scaling (`FAST_GEMINI_HOOK_BUDGETS`), and moved PageRank to a flat typed-array CSR sparse frontier (`src/ask/graph-rank.js`).

Across untouched v1 baselines, offline `node bench/eval-fast.js` cut `L1–L8` Turn-0 hook volume from `35.3 kB` (`+2,478` avg tok) to **`27.6 kB`** (`+1,795` tok). That raised `L6` symbol coverage to **`5/5`**, `L7` need coverage from `27%` to **`54%`**, and `SCORE` `EstUncached` from `+1.3%` to **`-1.4%`** (`EstCost -13.3%`, `EstCum -20.5%`). On `tutanota` (`L8`, 1,350 files / 11,544 nodes / 37,842 edges), `preparePageRankTopology` dropped from `34.9ms` to **`18.3ms`**, cold `ask` from `174.9ms` to **`131.6ms`**, warm `ask` from `50.0ms` to **`23.7ms`**, and warm `ask --source` from `37.8–41.2ms` to **`20.8ms`**.

| Model & Task | Before Track A (`plexer` vs `cold`) | After Track A (`plexer` vs `cold`) |
| :--- | :--- | :--- |
| **Claude `opus L6`** (NodeBB) | `7` calls (`+74.0%` cum) | **`2` vs `2` calls (`+12.7%` cum, `15.1s` vs `16.6s`, `8/8`)** |
| **Claude `opus L8`** (tutanota) | `8` calls (`+143.3%` cum) | **`4` vs `5` calls (`+0.5%` cum, `25.3s` vs `26.1s`, `8/8`)** |
| **Claude `opus S3`** (flipt) | `9` calls (`+61.2%` cum) | **`7` vs `11` calls (`-27.3%` cum, `45.8s` vs `59.5s`, `8/8`)** |
| **Claude `opus S6` / `S7`** | `8` calls (`+102.5%`) / `10` calls (`+121.3%`) | **`4` vs `3` calls (`+26.0%`, `8/8`) / `6` vs `7` calls (`+2.6%`, `54.3s`)** |
| **Claude `sonnet L7`** (qutebrowser) | `5` calls (`+43.1%` cum) | **`3` vs `7` calls (`-14.3%` cum, `13.4s` vs `16.4s`, `8/8`)** |
| **Orchestrator `L7` & `S6`** | `25` calls (`L7`), `8→7` (`S6`) | **`10` vs `17` calls (`-29.4%` cum, `L7`) · `25` vs `50` calls (`-57.6%` cum, `S6`)** |
| **Fast Gemini `hydrogen T6` & `T9`** | `3` calls (`+80.1%` cum, `T6`) / `+60.8%` (`T9`) | **`1` vs `3` calls (`-10.1%` cum, `T6`) · `+51.3%` cum (`19` vs `20` calls, `T9`)** |

---

## 6. Track B: De-Leaked v2 Multi-Scale & Execution-Verified Suite

To evaluate repo scaling and generalization without benchmark leakage, v2 tasks and statistical tooling live separately from the v1 archive (`bench/tasks.js`, `bench/large-tasks.js`):

1. **De-leaked 4-tier OSS scale ladder + negative controls ([`bench/v2-tasks.js`](v2-tasks.js)):** Spans Small (`<250` files: `plexer`, holdout `pallets/click`), Medium (`400–800` files: de-leaked `pocketbase`, `qutebrowser`, `flipt`, `NodeBB`), Large (`1,000–2,500` files: `tutanota`, holdout `vitejs/vite`), and Mega (`3,000–10,000+` files: `microsoft/TypeScript`, holdout `facebook/react`), plus 4 negative controls (`N1` local typo, `N2` ambiguous `Validate`, `N3` dynamic hooks, `N4` non-indexed `package.json`).
2. **Locked holdouts & automated leakage audit ([`bench/v2-holdout.json`](v2-holdout.json), [`bench/audit-leakage.js`](audit-leakage.js)):** Fails any discovery or symptom prompt that leaks file paths, directory hints, or `>1` gold symbols, and verifies SHA-256 prompt locks (`npm run bench:leakage` → `18/18` clean, `0` violations).
3. **Hybrid Docker & native execution verification ([`bench/verify-exec.js`](verify-exec.js)):** SWE-bench Docker verifier runs default-on (`--rm --network=none`) alongside pinned language containers (`python:3.12-slim`, `node:24-slim`, `golang:1.23-alpine`) and native test suites. Passing `--no-docker` records `verificationMode: "unverified-heuristic"` and `resolved: null` rather than claiming heuristic resolution.
4. **Published cache-aware API `$` costing & paired multi-trial stats ([`bench/cost-model.js`](cost-model.js), [`bench/stats.js`](stats.js), [`bench/run-v2-ab.js`](run-v2-ab.js)):** Separates `cacheWriteTokens` from `cacheReadTokens` in [`bench/grade.js`](grade.js), computes real USD costs per model family and Orchestrator `modelBreakdown`, defaults v2 sweeps to `--trials 3` (stamping `N=1 unreplicated` otherwise), and reports median, IQR, 95% seeded bootstrap CIs, paired Wilcoxon signed-rank p-values, and exact sign tests split across `train`, `holdout`, `negativeControl`, and `byTier`.
5. **Hard retrieval & 25k-node synthetic scale stress ([`bench/hard-retrieval.js`](hard-retrieval.js), [`bench/scale-stress.js`](scale-stress.js)):** `npm run bench:hard` evaluates 116 queries across ambiguous symbols, Python signals, ESM barrels/CommonJS namespaces, polyglot multi-hop paths, modern language templates (TSX, Vue, Svelte, Astro, C++, Kotlin, Rust, Bash, SQL, HCL, Protobuf, GraphQL), and out-of-scope queries (**99.0% Recall@1**, **100.0% Recall@3**, **0.995 MRR**, **0.0% negative false positives**). `npm run bench:scale` builds and queries a 27,092-node (37,512-edge) polyglot monorepo on SQLite v3 (**2,078.6ms** cold build, **107.2ms** 1-file dirty-cone refresh, **9.18ms** p50 / **13.05ms** p95 `ask --source`, **0.02ms** p50 `callers`, **226.7ms** `blast`, **7.51ms** Turn-0 hook, **26.63ms** daemon RPC, **339 MB** RSS).
