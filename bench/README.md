# `plexer` Benchmarks & Methodology

This directory holds the multi-model benchmark suite, runners, transcript graders, offline evaluators, and visualization scripts for `plexer`. [`bench/tasks.js`](tasks.js) defines 12 engineering tasks (`T1`–`T12`) with rubrics and code-edit checks across 6 repositories (including 2 holdouts). [`bench/swebench/tasks.json`](swebench/tasks.json) bundles 8 tasks (`S1`–`S8`) from **`ScaleAI/SWE-bench_Pro` V2** across `qutebrowser/qutebrowser` (Python), `flipt-io/flipt` (Go), `NodeBB/NodeBB` (JavaScript), and `tutao/tutanota` (TypeScript) alongside container verifier scripts (`test.sh`, `run_script.sh`, `parser.py`, `config.json`). [`bench/large-tasks.js`](large-tasks.js) and [`bench/run-large-ab.js`](run-large-ab.js) define 8 multi-hop architectural and 3–4-file code-edit tasks (`L1`–`L8`) across repos up to **1,350+ files** (including Trail-Code's PocketBase `L1` OAuth2/`RecordUpsert` and `L5` PR #6744 WebP thumbnail tasks). Strict binary `Resolved` verifiers fail any run missing one sibling file, while [`bench/ensure-base.js`](ensure-base.js) populates `/tmp/plexer-ab-base/{clean,indexed}` and `/tmp/plexer-swebench-base/{clean,indexed}`.

Live evaluations run through [`bench/run-agy-ab.js`](run-agy-ab.js) for headless Google Antigravity (`agy -p` on `neon-medium`, `carbon-medium`, `argon-medium`, and `hydrogen-medium`) and [`bench/run-claude-ab.js`](run-claude-ab.js) for Claude Code (`claude -p --effort medium` on `claude-sonnet-5-5` and `claude-opus-5-5`). [`bench/run-swebench-ab.js`](run-swebench-ab.js) executes `S1`–`S8` across all 6 models with symbol/patch grading and optional Docker verification (`SWEBENCH_DOCKER=1`). For 3-arm comparisons, [`bench/trail-live-helper.js`](trail-live-helper.js) configures `@trailhq/trail-code@0.29.0` via its native `trail init` flow (`SessionStart` `formatOrientation`, `UserPromptSubmit` `handlePrompt` `-n 3`, `PostToolUse` `formatBlastRadius`, and unblocked `mcp__trail__*` and `trail` CLI) alongside `cold` and `plexer`. [`bench/grade.js`](grade.js) parses Antigravity and Claude Code JSONL transcripts, checks cohort symmetry, grades rubrics and strict binary `resolved` status, and reports separated metrics (`toolOutputTokens`, `finalContextTokens`, `uncachedInputTokens`, `cachedInputTokens`, `cumulativeInputTokens`, and `totalModelOutputTokens`).

Offline tools replay transcripts and fit cost models at zero API cost. [`bench/replay.js`](replay.js) mines ranged reads, whole-file reads, grep hits, and gold patch hunks across all 28 tasks into [`bench/needed-spans.json`](needed-spans.json), which [`bench/needcov.js`](needcov.js) scores via `needCov`, `locCov`, and `fileCov`. [`bench/eval-fast.js`](eval-fast.js) evaluates Turn-0 BPE budgets, gold file recall, coverage, and predicted metrics (`EstWall`, `EstUncached`, `EstCost`, `EstCum`) across all 28 tasks in ~5.0s. Those predictions use the leave-one-out regressions in [`bench/cost-model.js`](cost-model.js) and [`bench/turn-model.json`](turn-model.json) (`wall_ms`, `outTok`, `uncIn`, `cumIn`, and cache-aware cost `1.25·uncIn + 0.1·cacheRead + 5·outTok`, `R² = 0.84–0.98`). [`bench/graft-arm.js`](graft-arm.js) runs an offline comparison against `@trailhq/trail-code@0.29.0` (`graft-hook` and `graft-push`) across 19 shared 3-arm tasks, while [`bench/trail-table.js`](trail-table.js) computes per-task means and repo-size scaling tables. Interactive and script outputs include [`bench/skill-review.html`](skill-review.html), [`bench/chart.js`](chart.js) ([`bench/chart-small.svg`](chart-small.svg) and [`bench/chart.svg`](chart.svg)), and [`bench/run.js`](run.js) for the 24-query deterministic engine benchmark (`npm run bench`).

<p align="center">
  <img src="chart.svg" alt="plexer Multi-Suite Benchmark Breakdown" width="100%" />
</p>

---

## 1. 6-Model Live A/B Agent Evaluation (`T1`–`T12`: `plexer` vs. Cold Agent)

### Methodology & Controls

We ran a **72-pair (144-session) A/B evaluation** across 12 tasks, 2 arms (`cold` vs. `plexer`), and 6 model configurations all pinned to `--effort medium`. The Antigravity runs cover `neon-medium` (`gemini-4-neon-medium`), `carbon-medium` (`gemini-4-carbon-medium`), `argon-medium` (`gemini-4-argon-medium`), and `hydrogen-medium` (`gemini-4-hydrogen-medium`), while the Claude Code runs cover **Claude Opus 5.5** (`claude-opus-5-5`) and **Claude Sonnet 5.5** (`claude-sonnet-5-5`).

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
   - Within each model tier, `cold` and `plexer` run with the exact same model, `--effort` flag, tool permissions, and task prompt (`0` symmetry violations across all 144 transcripts).
   - The `cold` arm sets `PLEXER_DISABLE_HOOKS=1` so lifecycle hooks never fire. The `plexer` arm enables Turn-0 prompt-context, `PreToolUse` read/shell compaction, and `PostToolUse` span-tracking and blast-radius hooks (`PLEXER_DISABLE_HOOKS=0`).
   - For Antigravity, [`bench/run-agy-ab.js`](run-agy-ab.js) runs `agy -p --agent bench-{cold,plexer} --model gemini-4-{neon,carbon,argon,hydrogen}-medium --effort medium --dangerously-skip-permissions --disable-slash-commands` with `inheritCustomizations: false` and `inheritMcp: false`.
   - For Claude Code, [`bench/run-claude-ab.js`](run-claude-ab.js) passes `--model {sonnet,opus} --effort medium --setting-sources "" --disable-slash-commands --strict-mcp-config --tools "Bash,Read,Edit,Write,Grep,Glob"` and adds `--settings <hook-settings.json>` only on the `plexer` arm.

#### Token Accounting (`bench/grade.js`)

[`bench/grade.js`](grade.js) tracks five separate token metrics from provider transcripts so Antigravity (`agy`) and Claude Code (`claude`) runs can be compared directly:

1. **Tool Output Tokens (`toolOutputTokens = ceil(bytes / 4)`):** Total volume of tool output (`view_file`/`Read`, `run_command`/`Bash`, `grep_search`/`Grep`, `plexer` stdout, and test runner output) added to the conversation.
2. **Final Context Window Tokens (`finalContextTokens`):** Total context window size (`input + cache_read + cache_creation`) on the final LLM turn of each task. This measures the net context accumulated by the end of the session without turn-count multiplication.
3. **Uncached and Cached Cumulative Input Tokens (`uncachedInputTokens` + `cachedInputTokens` = `cumulativeInputTokens`):**
   - Every LLM turn re-sends the conversation history to that point, so `cumulativeInputTokens` scales as $\mathcal{O}(\text{turns} \times \text{context})$.
   - **Claude Code** caches the system prompt and tool definitions after Turn 1 (`99.98%` of input tokens are `cachedInputTokens` at `0.1x` cost, with only ~8–15 `uncachedInputTokens` per turn) and finishes in 21–79 turns across 12 tasks.
   - **Antigravity (`neon-medium`, `carbon-medium`, `argon-medium`, and `hydrogen-medium`)** makes more granular line-range `view_file` calls (34–168 turns across 12 tasks) and bills ~10–20% of each turn's prompt as `uncachedInputTokens`. Because `plexer` cuts both tool output per turn and total turns, it reduces Antigravity's cumulative input tokens by **59–78%** on `T1`–`T12` and **41–71%** on `SWE-bench Pro V2`.
4. **Model Output Tokens (`totalModelOutputTokens`):** Total generated tokens including assistant text, tool-call arguments, and thinking tokens. On Claude Code, this is read from the top-level `result` event's `usage.output_tokens`.

---

### Multi-Model Summary (`T1`–`T12` Across 6 Model Configurations)

```bash
node bench/run-agy-ab.js neon-medium 4 both all
node bench/run-agy-ab.js carbon-medium 4 both all
node bench/run-agy-ab.js argon-medium 4 both all
node bench/run-agy-ab.js hydrogen-medium 4 both all
node bench/run-claude-ab.js opus 4 both all medium
node bench/run-claude-ab.js sonnet 4 both all medium
```

| Model & Effort (12 Tasks Each) | Symmetry | Correctness (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `neon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 181 → **60 (-66.9%)** (**`12W/0T/0L`**) | 155,652 → **37,702 (-75.8%)** (**`12W/0T/0L`**) | 355.6k → **204.4k (-42.5%)** | 3.13M → **0.70M (-77.5%)** | 970.0s → **423.0s (-56.4%)** (**`12W/0T/0L`**) |
| **Antigravity `carbon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 292 → **121 (-58.6%)** (**`12W/0T/0L`**) | 323,826 → **115,781 (-64.2%)** (**`12W/0T/0L`**) | 699.7k → **354.1k (-49.4%)** | 8.71M → **2.43M (-72.1%)** | 2,602.0s → **1,457.0s (-44.0%)** (`11W/0T/1L`) |
| **Antigravity `argon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 146 → **61 (-58.2%)** (`11W/1T/0L`) | 253,993 → **72,940 (-71.3%)** (**`12W/0T/0L`**) | 534.7k → **253.3k (-52.6%)** | 4.28M → **1.15M (-73.1%)** | 1,417.0s → **791.0s (-44.2%)** (`10W/0T/2L`) |
| **Antigravity `hydrogen-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 154 → **61 (-60.4%)** (`11W/1T/0L`) | 89,441 → **36,763 (-58.9%)** (`10W/0T/2L`) | 251.6k → **194.2k (-22.8%)** | 2.39M → **0.99M (-58.7%)** | 422.0s → **250.0s (-40.8%)** (`9W/0T/3L`) |
| **Claude Opus 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 81 → **28 (-65.4%)** (**`12W/0T/0L`**) | 63,696 → **18,287 (-71.3%)** (**`12W/0T/0L`**) | 225.9k → **177.5k (-21.4%)** | 1.29M → **0.57M (-55.7%)** | 248.9s → **93.1s (-62.6%)** (**`12W/0T/0L`**) |
| **Claude Sonnet 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 76 → **27 (-64.5%)** (`11W/1T/0L`) | 45,198 → **11,021 (-75.6%)** (**`12W/0T/0L`**) | 187.9k → **164.3k (-12.5%)** | 0.65M → **0.41M (-37.4%)** | 96.7s → **51.7s (-46.5%)** (`11W/0T/1L`) |
| **6-Model Total (`72` Task-Model Pairs)** | `PASSED (0)` | 572/576 → **576/576 (100.0%)** | 930 → **358 (-61.5%)** (`69W/3T/0L`) | 931,806 → **292,494 (-68.6%)** (`70W/0T/2L`) | 2,255.5k → **1,347.9k (-40.2%)** | 20.46M → **6.25M (-69.4%)** | 5,756.7s → **3,065.8s (-46.7%)** (`65W/0T/7L`) |

#### Separated Token Accounting (`T1`–`T12` Totals)

| Model Configuration | Arm | Turns | Tool Output Tok | Final Context Tok | Uncached Input Tok | Cached Input Tok | Cumulative Input Tok | Model Output Tok |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Antigravity `neon-medium`** (`medium`) | `cold` | 133 | 155,652 | 355,622 | 517,854 | 2,615,025 | 3,132,879 | 83,262 |
| **Antigravity `neon-medium`** (`medium`) | **`plexer`** | **34 (-74.4%)** | **37,702 (-75.8%)** | **204,423 (-42.5%)** | **253,631 (-51.0%)** | **449,997 (-82.8%)** | **703,628 (-77.5%)** | **65,242 (-21.6%)** |
| **Antigravity `carbon-medium`** (`medium`) | `cold` | 168 | 323,826 | 699,692 | 839,204 | 7,869,433 | 8,708,637 | 193,833 |
| **Antigravity `carbon-medium`** (`medium`) | **`plexer`** | **84 (-50.0%)** | **115,781 (-64.2%)** | **354,140 (-49.4%)** | **408,985 (-51.3%)** | **2,018,418 (-74.4%)** | **2,427,403 (-72.1%)** | **123,702 (-36.2%)** |
| **Antigravity `argon-medium`** (`medium`) | `cold` | 97 | 253,993 | 534,716 | 649,842 | 3,628,859 | 4,278,701 | 95,735 |
| **Antigravity `argon-medium`** (`medium`) | **`plexer`** | **41 (-57.7%)** | **72,940 (-71.3%)** | **253,291 (-52.6%)** | **338,310 (-47.9%)** | **813,169 (-77.6%)** | **1,151,479 (-73.1%)** | **64,717 (-32.4%)** |
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

### Tier 3: Antigravity `argon-medium` (`gemini-4-argon-medium --effort medium`)

Cuts tool output tokens by `-71.3%` (`12W/0T/0L`), final context by `-52.6%`, tool calls by `-58.2%` (`11W/1T/0L`), cumulative input by `-73.1%`, and search time by `-44.2%` (`10W/0T/2L`, `96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 5 (5) | **1 (1)** (-80%) | 6,494 | **471** (-93%) | 39.0s (39.0s) | **15.0s** (16.0s) (-62%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 4 (4) | **4 (4)** (0%) | 15,649 | **3,763** (-76%) | 28.0s (28.0s) | **27.0s** (48.8s) (-4%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 6 (4) | **3 (3)** (-50%) | 19,554 | **4,653** (-76%) | 35.0s (35.0s) | 55.0s (80.9s) (+57%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 5 (4) | **0 (0)** (-100%) | 29,982 | **0** (-100%) | 20.0s (53.9s) | **0.0s** (17.0s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 14 (5) | **11 (8)** (-21%) | 30,657 | **19,898** (-35%) | 31.0s (58.9s) | 149.0s (200.5s) (+381%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 12 (2) | **1 (1)** (-92%) | 16,752 | **2,062** (-88%) | 29.0s (29.0s) | **5.0s** (6.0s) (-83%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 7 (5) | **2 (1)** (-71%) | 13,870 | **1,433** (-90%) | 61.0s (61.0s) | **10.0s** (32.6s) (-84%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 11 (5) | **1 (1)** (-91%) | 14,544 | **1,439** (-90%) | 62.0s (62.0s) | **13.0s** (13.0s) (-79%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 17 (9) | **6 (4)** (-65%) | 12,573 | **1,992** (-84%) | 154.0s (161.7s) | **104.0s** (115.7s) (-32%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 17 (11) | **5 (3)** (-71%) | 27,434 | **7,009** (-74%) | 253.0s (253.0s) | **84.0s** (85.0s) (-67%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 33 (33) | **22 (12)** (-33%) | 49,581 | **24,663** (-50%) | 532.0s (532.0s) | **239.0s** (240.0s) (-55%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 15 (10) | **5 (3)** (-67%) | 16,903 | **5,557** (-67%) | 173.0s (173.0s) | **90.0s** (91.0s) (-48%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | - | **6 repos** | **146 (97)** | **61 (41) (-58.2%)** | **253,993** | **72,940 (-71.3%)** | **1417.0s (1486.5s)** | **791.0s (946.4s) (-44.2%)** | **96/96** | **96/96** |

---

### Tier 4: Antigravity `hydrogen-medium` (`gemini-4-hydrogen-medium --effort medium`)

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

### Tier 5: Claude Opus 5.5 (`claude -p --model claude-opus-5-5 --effort medium`)

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

### Tier 6: Claude Sonnet 5.5 (`claude -p --model claude-sonnet-5-5 --effort medium`)

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

## 2. External Multi-Language Benchmark: `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`)

[`bench/run-swebench-ab.js`](run-swebench-ab.js) evaluates an 8-task stratified subset (`S1`–`S8`, 2 tasks per language across Python, Go, JavaScript, and TypeScript) from **`ScaleAI/SWE-bench_Pro` V2** across all 6 model configurations:

- **`S1` & `S2` (Python, `qutebrowser/qutebrowser`):** WebKit `NetworkReply` Qt 5.15 `errorOccurred` signal migration (`S1`) and multi-file `KeyMode` / `EventFilter` handling (`S2`).
- **`S3` & `S4` (Go, `flipt-io/flipt`):** Authentication cleanup service gating (`ShouldRunCleanup`) across `internal/cleanup`, `internal/cmd`, and `internal/config` (`S3`), and evaluation rollout caching (`GetEvaluationRollouts`) across `internal/storage/cache` and `internal/storage` (`S4`).
- **`S5` & `S6` (JavaScript, `NodeBB/NodeBB`):** User email confirmation refactor across `src/middleware` and `src/user` (`S5`), and queued-post topic merging (`updateQueuedPostsTopic`) across `src/posts/queue.js` and `src/topics/merge.js` (`S6`).
- **`S7` & `S8` (TypeScript, `tutao/tutanota`):** Desktop download manager error handling across `src/desktop/DesktopDownloadManager.ts` and `DesktopNetworkClient.ts` (`S7`), and device credential encryption facade updates across `src/api/worker/facades` and `src/misc/credentials` (`S8`).

```bash
node bench/run-swebench-ab.js neon-medium 4 all all
node bench/run-swebench-ab.js carbon-medium 4 all all
node bench/run-swebench-ab.js argon-medium 4 all all
node bench/run-swebench-ab.js hydrogen-medium 4 all all
node bench/run-swebench-ab.js opus 4 all all
node bench/run-swebench-ab.js sonnet 4 all all
```

### `SWE-bench Pro V2` Summary Across All 6 Models (`S1`–`S8`, 48 Pairs)

| Model & Effort (8 Tasks Each) | Patch Score (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Model Output Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `neon-medium`** (`--effort medium`) | 62/64 → **63/64 (+1.6%)** (`100%` file recall) | 228 → **114 (-50.0%)** (**`8W/0T/0L`**) | 136,801 → **63,245 (-53.8%)** (**`8W/0T/0L`**) | 377.6k → **250.2k (-33.8%)** | 4.56M → **1.53M (-66.5%)** | 128,272 → **82,268 (-35.9%)** | 1,370.0s → **853.0s (-37.7%)** (**`8W/0T/0L`**) |
| **Antigravity `carbon-medium`** (`--effort medium`) | **64/64 → 64/64** (`100%` file recall) | 457 → **212 (-53.6%)** (**`8W/0T/0L`**) | 380,361 → **176,378 (-53.6%)** (**`8W/0T/0L`**) | 965.9k → **594.5k (-38.4%)** | 20.07M → **6.97M (-65.3%)** | 339,673 → **253,767 (-25.3%)** | 5,681.0s → **3,569.0s (-37.2%)** (**`8W/0T/0L`**) |
| **Antigravity `argon-medium`** (`--effort medium`) | **64/64 → 64/64** (`100%` file recall) | 273 → **141 (-48.4%)** (**`8W/0T/0L`**) | 295,513 → **116,273 (-60.7%)** (**`8W/0T/0L`**) | 704.6k → **326.9k (-53.6%)** | 11.32M → **3.24M (-71.3%)** | 207,280 → **79,917 (-61.4%)** | 3,013.0s → **2,065.0s (-31.5%)** (`7W/0T/1L`) |
| **Antigravity `hydrogen-medium`** (`--effort medium`) | 62/64 → **63/64 (+1.6%)** (`100%` file recall) | 193 → **117 (-39.4%)** (**`8W/0T/0L`**) | 89,571 → **59,233 (-33.9%)** (**`8W/0T/0L`**) | 282.7k → **233.7k (-17.3%)** | 2.87M → **1.70M (-40.9%)** | 98,806 → **64,947 (-34.3%)** | 652.0s → **562.0s (-13.8%)** (`6W/0T/2L`) |
| **Claude Opus 5.5** (`--effort medium`) | 62/64 → **63/64 (+1.6%)** (`100%` file recall) | 39 → 49 (+25.6%) (`2W/3T/3L`) | 24,253 → **18,896 (-22.1%)** (`7W/0T/1L`) | 132.9k → 152.0k (+14.3%) | 645.6k → 913.3k (+41.5%) | 23,373 → 25,841 (+10.6%) | 193.1s → 193.7s (+0.3%) (`4W/0T/4L`) |
| **Claude Sonnet 5.5** (`--effort medium`) | 60/64 → **62/64 (+3.3%)** (`100%` file recall) | 65 → **26 (-60.0%)** (**`8W/0T/0L`**) | 19,344 → **9,877 (-48.9%)** (**`8W/0T/0L`**) | 125.2k → **123.5k (-1.4%)** | 637.0k → **410.4k (-35.6%)** | 21,386 → **13,109 (-38.7%)** | 120.1s → **54.7s (-54.5%)** (**`8W/0T/0L`**) |
| **6-Model Total (`48` Task-Model Pairs)** | 374/384 → **379/384** (`100%` file recall) | 1,255 → **659 (-47.5%)** (`42W/3T/3L`) | 945,843 → **443,902 (-53.1%)** (`47W/0T/1L`) | 2,589.0k → **1,680.7k (-35.1%)** | 40.10M → **14.77M (-63.2%)** | 818,790 → **519,849 (-36.5%)** | 11,029.2s → **7,297.4s (-33.8%)** (`41W/0T/7L`) |

---

## 3. Large-Repo Suite (`L1`–`L8`) & Trail-Code (`@trailhq/trail-code@0.29.0`) Comparison

### Live 3-Arm Evaluation (`cold` vs. `trail` vs. `plexer`) Across 130 Tasks/Arm

[`bench/run-agy-ab.js`](run-agy-ab.js), [`bench/run-swebench-ab.js`](run-swebench-ab.js), and [`bench/run-large-ab.js`](run-large-ab.js) run a 3rd live arm (`trail` via [`bench/trail-live-helper.js`](trail-live-helper.js)). Trail uses its native `trail init` architecture (`SessionStart` `formatOrientation`, `UserPromptSubmit` `handlePrompt` `-n 3` pointers/snippets, `PostToolUse` `formatBlastRadius`, and unblocked `mcp__trail__*` and `trail` CLI). All six models (`Opus 5.5`, `Sonnet 5.5`, `Gemini 4 Neon`, `Gemini 4 Carbon`, `Gemini 4 Argon`, and `Gemini 4 Hydrogen`) ran on `T4, T5, T9`, `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`), and the Large-Repo & Discriminative Suite (`L1`–`L8`):

| Suite (`node bench/trail-table.js --suite 3arm`) | Tasks | Cold Raw Unc | Trail Raw Unc | `plexer` Raw Unc | Cold Post-T1 Unc | Trail Post-T1 Unc | `plexer` Post-T1 Unc | Cold Cumul | Trail Cumul | `plexer` Cumul | Cold Calls | Trail Calls | `plexer` Calls | Cold Score | Trail Score | `plexer` Score |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Claude Code Opus (`S1`–`S8`)** | 8 | 16.6k | 19.4k | 19.0k | 7.7k | 7.3k | **7.0k** | 81k | 118k | 114k | 4.9 | 6.1 | 6.1 | 62/64 | 62/64 | **63/64** |
| **Claude Code Sonnet (`S1`–`S8`)** | 8 | 15.7k | 17.0k | **15.4k** | 6.8k | 5.0k | **3.6k** | 80k | 62k | **51k** | 8.1 | 3.8 | **3.3** | 60/64 | 62/64 | **62/64** |
| **AGY Opus (`T4, T5, T9`)** | 3 | 43.5k | 32.7k | **18.1k** | 33.7k | 16.5k | **6.9k** | 372k | 137k | **66k** | 14.3 | 7.3 | **4.7** | 24/24 | 24/24 | **24/24** |
| **AGY Sonnet (`T4, T5, T9`)** | 3 | 28.4k | 27.6k | **14.6k** | 18.6k | 12.7k | **3.8k** | 157k | 83k | **27k** | 8.7 | 4.0 | **2.3** | 24/24 | 24/24 | **24/24** |
| **AGY Neon (`T4, T5, T9`)** | 3 | 49.2k | 36.6k | **21.1k** | 44.2k | 24.7k | **12.1k** | 312k | 133k | **73k** | 16.3 | 15.0 | **5.7** | 24/24 | 24/24 | **24/24** |
| **AGY Carbon (`T4, T5, T9`)** | 3 | 66.4k | 64.4k | **42.0k** | 61.3k | 58.2k | **32.9k** | 567k | 476k | **291k** | 25.3 | 22.3 | **13.0** | 24/24 | 24/24 | **24/24** |
| **AGY Argon (`T4, T5, T9`)** | 3 | 49.8k | 44.2k | **23.0k** | 39.2k | 33.0k | **14.5k** | 184k | 255k | **104k** | 12.0 | 14.3 | **5.7** | 24/24 | 24/24 | **24/24** |
| **AGY Hydrogen (`T4, T5, T9`)** | 3 | 37.2k | 28.4k | 28.5k | 31.4k | 21.5k | **19.6k** | 189k | 137k | 177k | 15.3 | 15.0 | **7.7** | 24/24 | 24/24 | **24/24** |
| **AGY Opus (`S1`–`S8`)** | 8 | 37.7k | 33.3k | **25.0k** | 28.7k | 18.2k | **15.1k** | 269k | 152k | **147k** | 13.3 | **6.9** | 11.0 | 60/64 | 61/64 | **62/64** |
| **AGY Sonnet (`S1`–`S8`)** | 8 | 26.5k | 27.9k | **18.5k** | 17.5k | 12.8k | **8.6k** | 138k | 97k | **66k** | 10.3 | **4.9** | 7.5 | 60/64 | 63/64 | **62/64** |
| **AGY Neon (`S1`–`S8`)** | 8 | 65.8k | 54.4k | **37.1k** | 60.1k | 47.5k | **27.9k** | 570k | 402k | **191k** | 28.5 | 27.1 | **14.3** | 62/64 | 63/64 | **63/64** |
| **AGY Carbon (`S1`–`S8`)** | 8 | 215.4k | 180.4k | **83.9k** | 191.4k | 173.5k | **74.7k** | 2,509k | 2,563k | **872k** | 57.1 | 57.3 | **26.5** | 64/64 | 64/64 | **64/64** |
| **AGY Argon (`S1`–`S8`)** | 8 | 117.9k | 102.5k | **48.0k** | 99.2k | 91.0k | **38.8k** | 1,414k | 1,401k | **406k** | 34.1 | 33.8 | **17.6** | 64/64 | 63/64 | **64/64** |
| **AGY Hydrogen (`S1`–`S8`)** | 8 | 53.2k | 55.4k | **37.1k** | 46.7k | 47.9k | **27.3k** | 359k | 414k | **212k** | 24.1 | 27.6 | **14.6** | 62/64 | 62/64 | **63/64** |
| **Claude Code Opus (`L1`–`L8`)** | 8 | 13.3k | 16.1k | 15.3k | 4.9k | 4.7k | **3.3k** | 45k | 54k | 55k | 3.1 | **2.9** | 3.9 | 64/64 | 64/64 | **64/64** |
| **Claude Code Sonnet (`L1`–`L8`)** | 8 | 13.2k | 17.2k | 15.0k | 4.9k | 5.9k | **3.2k** | 39k | 49k | 41k | 5.1 | 3.8 | **3.5** | 60/64 | 62/64 | **64/64** |
| **AGY Neon (`L1`–`L8`)** | 8 | 23.9k | 20.2k | **14.3k** | 18.7k | 13.9k | **5.2k** | 83k | 64k | **29k** | 10.5 | 8.9 | **3.3** | 64/64 | 64/64 | **64/64** |
| **AGY Carbon (`L1`–`L8`)** | 8 | 54.2k | 52.9k | **27.3k** | 49.0k | 45.6k | **18.5k** | 244k | 217k | **103k** | 14.3 | 12.8 | **6.9** | 64/64 | 64/64 | **64/64** |
| **AGY Argon (`L1`–`L8`)** | 8 | 28.3k | 20.1k | **14.4k** | 21.4k | 13.8k | **6.3k** | 127k | 66k | **32k** | 9.1 | 7.5 | **3.8** | 64/64 | 64/64 | **64/64** |
| **AGY Hydrogen (`L1`–`L8`)** | 8 | 20.7k | 19.2k | **17.0k** | 14.8k | 12.1k | **6.7k** | 63k | 57k | **39k** | 9.1 | 8.8 | **3.9** | 64/64 | 64/64 | **64/64** |
| **TOTAL (`130 tasks/arm`)** | **130** | **6,440k** | **5,789k (-10.1%)** | **3,540k (-45.0%)** | **5,261k** | **4,493k (-14.6%)** | **2,240k (-57.4%)** | **53,514k** | **49,395k (-7.7%)** | **21,082k (-60.6%)** | **2,129** | **1,929 (-9.4%)** | **1,125 (-47.2%)** | **1,018/1,040 (97.9%)** | **1,026/1,040 (98.7%)** | **1,031/1,040 (99.1%)** |

On the Large-Repo & Discriminative Suite (`L1`–`L8`, 48 3-arm sessions across all 6 models), `plexer` resolves **`48/48` (`100.0%`)** strict multi-file tasks (`8/8` on Neon, Carbon, Argon, Hydrogen, Opus, and Sonnet), compared to `47/48` for `trail` and `46/48` for `cold`. It also cuts tool output tokens by **`-65.0%` vs. `cold` (`311.0k → 108.8k`)** and **`-60.1%` vs. `trail` (`272.7k → 108.8k`)**.

#### Repo-Size Scaling Breakdown (`Cold` vs. `Trail` vs. `plexer`)

| Repo Size Bucket | Tasks/Arm | Cold Post-T1 Unc | Trail Post-T1 Unc | `plexer` Post-T1 Unc | Cold Cumul | Trail Cumul | `plexer` Cumul | Cold Calls | Trail Calls | `plexer` Calls | Cold Resolved | Trail Resolved | `plexer` Resolved |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Small (`<250 files`)** | 18 | 38.1k | 27.7k (-27.1%) | **15.0k (-60.7%)** | 297k | 204k (-31.4%) | **123k (-58.6%)** | 15.3 | 13.0 | **6.5** | 18/18 (100%) | 18/18 (100%) | **18/18 (100%)** |
| **Medium (`350–750 files`)** | 62 | 35.4k | 31.9k (-9.9%) | **14.9k (-57.9%)** | 367k | 364k (-1.0%) | **126k (-65.7%)** | 14.9 | 13.8 | **7.6** | 58/62 (94%) | 61/62 (98%) | **62/62 (100%)** |
| **Large (`700–1350+ files`)** | 50 | 47.6k | 40.3k (-15.3%) | **20.9k (-56.0%)** | 508k | 464k (-8.7%) | **221k (-56.5%)** | 18.6 | 16.8 | **10.7** | 36/50 (72%) | 41/50 (82%) | **43/50 (86%)** |

### Trail-Comparable Metric Table (`node bench/trail-table.js`)

Trail-Code (`@trailhq/trail-code`) reports per-task means on read-only Q&A prompts (`--max-turns 10`). It tracks **uncached input tokens** (`input_tokens + cache_creation_input_tokens`) and **cache-aware cost** (`1·input + 1.25·cache_write + 0.1·cache_read + 5·output`). Across Claude Code sessions, $\text{UncachedInputTokens} = \text{FinalContextTokens} - \text{Turn1CacheRead} + 2T$. [`bench/trail-table.js`](trail-table.js) separates raw uncached input from **warm-cache uncached input** (normalizing out cold-start worktree system prompt and `SKILL.md` cache-miss noise) and **post-Turn-1 exploration uncached tokens** (new tokens cached after Turn 1 via file reads and greps). It also reports cumulative input tokens, cache-aware cost, and direct 3-arm (`cold` vs. `trail` vs. `plexer`) comparisons:

```bash
node bench/trail-table.js --suite qa
node bench/trail-table.js --suite all
node bench/trail-table.js --suite swe
node bench/trail-table.js --suite large
node bench/trail-table.js --suite 3arm
```

| Model & Suite (Per-Task Mean) | Tool Calls (`cold` → `plexer`) | Uncached Input (`cold` → `plexer`) | Warm-Cache Uncached (`cold` → `plexer`) | Post-Turn-1 Uncached (`cold` → `plexer`) | Cumulative Input (`cold` → `plexer`) | Cache-Aware Cost (`cold` → `plexer`) | Search Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Opus 5.5: Q&A (`T1`–`T8`)** | 5.8 → **1.4 (-76%)** | 12,608 → **8,412 (-33%)** | 11,331 → **6,665 (-41%)** | 10,031 → **2,193 (-78%)** | 86,533 → **31,790 (-63%)** | 35,377 → **21,579 (-39%)** | 13.4s → **2.9s (-78%)** |
| **Sonnet 5.5: Q&A (`T1`–`T8`)** | 4.8 → **1.3 (-74%)** | 9,655 → **6,306 (-35%)** | 8,377 → **5,364 (-36%)** | 7,235 → **1,263 (-83%)** | 46,218 → **23,320 (-50%)** | 24,615 → **15,653 (-36%)** | 4.6s → **1.3s (-73%)** |
| **Neon Medium: Q&A (`T1`–`T8`)** | 11.6 → **3.3 (-72%)** | 33,479 → **18,426 (-45%)** | 17,312 → **7,728 (-55%)** | 28,454 → **7,511 (-74%)** | 154,258 → **34,639 (-78%)** | 68,743 → **40,556 (-41%)** | 43.3s → **15.5s (-64%)** |
| **Carbon Medium: Q&A (`T1`–`T8`)** | 15.3 → **5.5 (-64%)** | 47,653 → **24,073 (-49%)** | 35,039 → **16,185 (-54%)** | 42,615 → **15,563 (-63%)** | 272,494 → **95,392 (-65%)** | 119,524 → **69,236 (-42%)** | 84.5s → **54.3s (-36%)** |
| **Opus 5.5: All (`T1`–`T12`)** | 6.8 → **2.3 (-65%)** | 13,111 → **8,940 (-32%)** | 12,260 → **7,588 (-38%)** | 10,899 → **3,530 (-68%)** | 107,313 → **47,521 (-56%)** | 40,034 → **24,961 (-38%)** | 20.7s → **7.8s (-63%)** |
| **Sonnet 5.5: All (`T1`–`T12`)** | 6.3 → **2.3 (-64%)** | 9,950 → **7,339 (-26%)** | 8,956 → **6,362 (-29%)** | 7,750 → **2,267 (-71%)** | 54,530 → **34,113 (-37%)** | 26,953 → **18,901 (-30%)** | 8.1s → **4.3s (-47%)** |
| **Neon Medium: All (`T1`–`T12`)** | 15.1 → **5.0 (-67%)** | 43,155 → **21,136 (-51%)** | 23,059 → **10,443 (-55%)** | 38,088 → **10,721 (-72%)** | 261,073 → **58,636 (-78%)** | 99,639 → **52,070 (-48%)** | 80.8s → **35.3s (-56%)** |
| **Carbon Medium: All (`T1`–`T12`)** | 24.3 → **10.1 (-59%)** | 69,934 → **34,082 (-51%)** | 51,738 → **22,928 (-56%)** | 64,859 → **25,356 (-61%)** | 725,720 → **202,284 (-72%)** | 216,276 → **102,445 (-53%)** | 216.8s → **121.4s (-44%)** |
| **Opus 5.5: SWE-bench (`S1`–`S8`)** | 4.9 → 6.1 (`0%` vs `trail`) | 11,751 → 13,982 (+6% vs `trail`) | 10,048 → 11,806 (**`-4%` vs `trail`**) | 7,740 → **7,033 (-9%, `-3%` vs `trail`)** | 80,703 → 114,168 (**`-3%` vs `trail`**) | 36,189 → 43,643 (+3% vs `trail`) | 24.1s → 24.2s (+2% vs `trail`) |
| **Sonnet 5.5: SWE-bench (`S1`–`S8`)** | 8.1 → **3.3 (-60%, `-13%` vs `trail`)** | 10,653 → **10,282 (-3%, `-4%` vs `trail`)** | 8,948 → **8,104 (-9%, `-17%` vs `trail`)** | 6,795 → **3,562 (-48%, `-29%` vs `trail`)** | 79,626 → **51,295 (-36%, `-18%` vs `trail`)** | 33,577 → **25,145 (-25%, `-7%` vs `trail`)** | 15.0s → **6.8s (-54%, `-42%` vs `trail`)** |
| **Neon Medium: SWE-bench (`S1`–`S8`)** | 28.5 → **14.3 (-50%, `-47%` vs `trail`)** | 65,781 → **37,051 (-44%, `-32%` vs `trail`)** | 40,636 → **24,685 (-39%, `-28%` vs `trail`)** | 60,082 → **27,897 (-54%, `-41%` vs `trail`)** | 570,356 → **190,911 (-67%, `-53%` vs `trail`)** | 196,409 → **103,855 (-47%, `-35%` vs `trail`)** | 171.3s → **106.6s (-38%, `-37%` vs `trail`)** |
| **Carbon Medium: SWE-bench (`S1`–`S8`)** | 57.1 → **26.5 (-54%, `-54%` vs `trail`)** | 215,371 → **83,887 (-61%, `-53%` vs `trail`)** | 114,209 → **67,749 (-41%, `-40%` vs `trail`)** | 191,431 → **74,737 (-61%, `-57%` vs `trail`)** | 2,509,098 → **871,750 (-65%, `-66%` vs `trail`)** | 657,039 → **321,277 (-51%, `-48%` vs `trail`)** | 710.1s → **446.1s (-37%, `-34%` vs `trail`)** |
| **Opus 5.5: Large (`L1`–`L8`)** | 3.1 → 3.9 | 8,236 → 10,292 (**`-29%` vs `trail`**) | 6,687 → 8,116 (**`-10%` vs `trail`**) | 4,861 → **3,345 (-31%, `-29%` vs `trail`)** | 45,052 → 55,231 (+3% vs `trail`) | 23,484 → 27,347 (**`-14%` vs `trail`**) | 7.3s → 8.7s |
| **Sonnet 5.5: Large (`L1`–`L8`)** | 5.1 → **3.5 (-32%, `-7%` vs `trail`)** | 8,010 → 9,887 (**`-37%` vs `trail`**) | 6,459 → 7,709 (**`-23%` vs `trail`**) | 4,893 → **3,203 (-35%, `-46%` vs `trail`)** | 39,286 → 41,097 (**`-16%` vs `trail`**) | 22,081 → 23,087 (**`-26%` vs `trail`**) | 5.1s → **4.2s (-17%, `-38%` vs `trail`)** |
| **Neon Medium: Large (`L1`–`L8`)** | 10.5 → **3.3 (-69%, `-63%` vs `trail`)** | 23,890 → **14,254 (-40%, `-29%` vs `trail`)** | 9,915 → **6,378 (-36%, `-32%` vs `trail`)** | 18,727 → **5,246 (-72%, `-62%` vs `trail`)** | 83,312 → **29,471 (-65%, `-54%` vs `trail`)** | 48,183 → **31,076 (-36%, `-24%` vs `trail`)** | 40.3s → **16.1s (-60%, `-61%` vs `trail`)** |
| **Carbon Medium: Large (`L1`–`L8`)** | 14.3 → **6.9 (-52%, `-46%` vs `trail`)** | 54,202 → **27,312 (-50%, `-48%` vs `trail`)** | 23,117 → **14,323 (-38%, `-40%` vs `trail`)** | 49,015 → **18,541 (-62%, `-59%` vs `trail`)** | 244,041 → **102,959 (-58%, `-53%` vs `trail`)** | 110,492 → **67,535 (-39%, `-35%` vs `trail`)** | 104.8s → **75.3s (-28%, `-29%` vs `trail`)** |

### Offline Head-to-Head vs. `@trailhq/trail-code@0.29.0` (`node bench/graft-arm.js`)

[`bench/graft-arm.js`](graft-arm.js) compares `plexer`'s `UserPromptSubmit` hook against `@trailhq/trail-code@0.29.0` across all 19 shared Rust, JS, TS, Python, and Go tasks (`T4`, `T5`, `T9`, `S1`–`S8`, `L1`–`L8`) after stripping harness boilerplate so both tools receive clean task queries. It tests both `graft-hook` (`trail ask <prompt> --json -n 3`, pointers only) and `graft-push` (`trail ask <prompt> --source -n 5`, Trail-Code's benchmark push bundle):

```bash
node bench/graft-arm.js
```

| Arm (`T4, T5, T9, S1–S8, L1–L8` Mean, 19 Tasks) | Turn-0 Tokens | Gold File Recall | `NeedCov` (Inlined Lines) | `LocCov` (Located Symbols) | Predicted Wall (`EstWall`) | Predicted Uncached (`EstUncached`) | Post-Turn-0 Uncached (`EstPostT0Unc`) | Predicted Cost (`EstCost`) | Predicted CumInput (`EstCum`) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **`plexer` (`16/19` `EstCum` wins, `19/19` vs `graft-push`)** | **2,889 tok** | **100.0%** | **34.3%** | **66.8%** | **36.8s** | **20.9k** | **15.1k** | **51.5k** | **106k** |
| `graft-hook` (`ask --json -n 3`) | 207 tok | 67.9% | 0.0% | 25.3% | 45.4s | 18.0k | 17.6k | 54.3k | 125k |
| `graft-push` (`ask --source -n 5`) | 5,086 tok | 81.2% | 26.4% | 39.1% | 40.3s | 26.3k | 16.1k | 63.0k | 141k |

### 3-Tier Offline Optimization Suite (`node bench/eval-fast.js`)

[`bench/eval-fast.js`](eval-fast.js) evaluates retrieval ranking, named-definition pinning (`src/claude/pin.js`), and hook budgets across all 28 tasks (`T1`–`T12` + `S1`–`S8` + `L1`–`L8`) in ~5.0s at `$0` API cost:
1. **Transcript-mined ground truth (`bench/replay.js` → `bench/needed-spans.json`):** Captures every line range and symbol that `cold` agents read or grepped across `T1`–`T12`, `S1`–`S8`, and `L1`–`L8`, plus SWE-bench and Large-Repo gold patch hunks.
2. **Coverage metrics (`bench/needcov.js`):** Computes `NeedCov` (weighted share of needed lines inlined with `L<n>:` numbers at Turn 0: `T=18.0%`, `S=26.9%`, `L=27.2%` for Claude; `T=20.9%`, `S=42.9%`, `L=42.3%` for Gemini) and `LocCov` (share of needed symbols pointed to or inlined at Turn 0: `T=45.1%`, `S=52.6%`, `L=86.1%` for Claude; `T=50.1%`, `S=58.8%`, `L=85.9%` for Gemini), with separate holdout reporting (`T4`, `T8`, `T12`).
3. **Live-calibrated cost model (`bench/cost-model.js` & `bench/turn-model.json`):** Uses per-family linear models fit on the recorded live runs (`wall R² = 0.92–0.94` on Claude and `0.90–0.98` on Gemini, `cum R² = 0.84–0.95` with `1.0 × (turns + 1) × t0Tok` Turn-0 re-billing), achieving **`100.0%` Gold File Recall on `S1`–`S8` and `L1`–`L8`** (`94.4%` on `T1`–`T12`), **`84.8%` `TokCov` on `T1`–`T12`**, **`-25.8%` `EstWall`**, **`-4.3%` `EstUncached`**, **`-17.9%` `EstCost`**, and **`-24.7%` `EstCum`** on Claude (`-44.9%`, `-45.9%`, `-50.5%`, and `-63.5%` across Gemini 4 models) vs. `cold`.

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

- **Retrieval accuracy:** **100.0% Recall@1 (24/24)**, **100.0% Recall@3 (24/24)**, **100.0% Recall@5 (24/24)**, and **1.000 MRR**. By comparison, `@trailhq/trail-code@0.25.0` reaches `16.7% Recall@1` / `0.201 MRR` across all 6 repos and `50.0% Recall@1` / `0.604 MRR` on the shared non-Luau repos (`plexer` + `z`).

| Repository | Graph Size (Nodes / Edges) | `wiring.json` | `check` | `ask --source` Latency & Tokens (vs Raw Files) | `callers` (`d=2`) | `skeleton` | `map` |
| :--- | ---: | ---: | ---: | :--- | ---: | ---: | ---: |
| **`plexer`** (JS/TS) | 1,973 / 6,126 | 1,571 KB | 42.1ms | **14.0ms** / 1,181 tok (**-96%** vs 28,541 raw) | **0.18ms** | **0.14ms** | 0.05ms |
| **`kohls-admin`** (Luau) | 2,547 / 3,659 | 1,526 KB | 75.8ms | **11.9ms** / 1,161 tok (**-89%** vs 10,574 raw) | **0.80ms** | **0.05ms** | 0.02ms |
| **`flux`** (Luau) | 1,445 / 2,027 | 768 KB | 24.0ms | **6.8ms** / 1,290 tok (**-95%** vs 27,441 raw) | **0.28ms** | **0.14ms** | 0.01ms |
| **`sert`** (Luau + Py) | 2,926 / 6,070 | 1,915 KB | 58.9ms | **11.6ms** / 938 tok (**-91%** vs 10,757 raw) | **1.74ms** | **0.04ms** | 0.01ms |
| **`building-tools`** (Luau) | 1,970 / 4,769 | 1,437 KB | 33.3ms | **10.5ms** / 1,346 tok (**-75%** vs 5,306 raw) | **0.99ms** | **0.02ms** | 0.01ms |
| **`z`** (Luau + Rust + Py) | 3,614 / 6,437 | 2,465 KB | 71.5ms | **20.6ms** / 1,234 tok (**-92%** vs 15,116 raw) | **0.58ms** | **0.04ms** | 0.06ms |
