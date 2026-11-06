# `plexer` Benchmarks & Methodology

This directory contains the multi-model benchmark suite for `plexer`:
- **Tasks (`T1`–`T12`):** [`bench/tasks.js`](tasks.js) defines 12 engineering tasks (`T1`–`T12`), rubrics, and automated code-edit verification commands across 6 repositories, including 2 holdout repositories.
- **SWE-bench Pro V2 (`S1`–`S8`):** [`bench/swebench/tasks.json`](swebench/tasks.json) bundles 8 tasks (`S1`–`S8`) from **`ScaleAI/SWE-bench_Pro` V2** across Python, Go, JavaScript, and TypeScript (`qutebrowser/qutebrowser`, `flipt-io/flipt`, `NodeBB/NodeBB`, `tutao/tutanota`), along with their container verifier scripts (`test.sh`, `run_script.sh`, `parser.py`, `config.json`).
- **Transcript Grader:** [`bench/grade.js`](grade.js) parses Antigravity and Claude Code JSONL transcripts, checks cohort symmetry, scores rubrics and tests, and computes separated token metrics (`toolOutputTokens`, `finalContextTokens`, `uncachedInputTokens`, `cachedInputTokens`, `cumulativeInputTokens`, `totalModelOutputTokens`).
- **Antigravity A/B Runner:** [`bench/run-agy-ab.js`](run-agy-ab.js) runs headless Google Antigravity (`agy -p`) evaluations on `argon-low` (`gemini-4-argon-low --effort low`) and `argon-medium` (`gemini-4-argon-medium --effort medium`).
- **Claude Code A/B Runner:** [`bench/run-claude-ab.js`](run-claude-ab.js) runs headless Claude Code (`claude -p --effort medium`) evaluations on `claude-sonnet-5-5` and `claude-opus-5-5` across `T1`–`T12`.
- **SWE-bench A/B Runner:** [`bench/run-swebench-ab.js`](run-swebench-ab.js) runs `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`) across all 4 models, supporting both patch/symbol grading and Docker verification (`SWEBENCH_DOCKER=1`).
- **Offline Fast Evaluator:** [`bench/eval-fast.js`](eval-fast.js) evaluates all 20 tasks (`T1`–`T12` + `S1`–`S8`) offline in ~4.8s at `$0` API cost. It measures Turn-0 BPE token budgets, file and symbol recall, needed-line coverage (`NeedCov` / `LocCov`), and predicted wall time and cumulative input (`EstWall`, `EstCum`).
- **Transcript Span Miner:** [`bench/replay.js`](replay.js) and [`bench/needed-spans.json`](needed-spans.json) extract ranged file reads, whole-file reads, grep hits, and gold patch hunks across all 20 tasks into a ground-truth fixture.
- **Coverage Metrics:** [`bench/needcov.js`](needcov.js) computes `needCov` (weighted share of needed lines inlined at Turn 0), `locCov` (share of needed symbols pointed to or inlined), and `fileCov`.
- **Empirical Cost Model:** [`bench/cost-model.js`](cost-model.js) and [`bench/turn-model.json`](turn-model.json) fit per-family cost equations (`wall_ms ~ 1 + turns + outTok`, `outTok ~ 1 + turns`, `cumIn - (turns + 1)·t0 ~ 1 + (turns + 1)`) with leave-one-out cross-validation (`R² = 0.83–0.94`).
- **Offline Trail-Code Comparison:** [`bench/graft-arm.js`](graft-arm.js) compares `plexer` offline against `@trailhq/trail-code@0.25.0` (`graft-hook` and `graft-push`) across `T4`, `T5`, `T9`, and `S1`–`S8`.
- **Live 3-Arm Trail-Code Runner:** [`bench/trail-live-helper.js`](trail-live-helper.js) wires `@trailhq/trail-code@0.25.0` (`trail init`, `trail _hook`, `PreInvocation` `systemMessage` caching, and deduplicated `PostToolUse` hooks) in isolated worktrees alongside `cold` and `plexer`.
- **Trail-Comparable Metrics:** [`bench/trail-table.js`](trail-table.js) computes per-task means (tool calls, uncached input tokens `input + cache_creation`, cache-aware cost, and latency) alongside cumulative input tokens and search wall time.
- **Worktree Fixture Builder:** [`bench/ensure-base.js`](ensure-base.js) populates `/tmp/plexer-ab-base/{clean,indexed}` and `/tmp/plexer-swebench-base/{clean,indexed}`.
- **Interactive Evaluation Viewer:** [`bench/skill-review.html`](skill-review.html) renders a self-contained `/skill-creator` evaluation viewer for all paired A/B runs.
- **Benchmark SVG Generator:** [`bench/chart.js`](chart.js) generates [`bench/chart-small.svg`](chart-small.svg) and [`bench/chart.svg`](chart.svg) with automatic light/dark theme support.
- **Engine & Retrieval Benchmark:** [`bench/run.js`](run.js) runs the deterministic engine and retrieval benchmark across 6 repositories and 24 natural-language intent queries (`npm run bench`).

<p align="center">
  <img src="chart.svg" alt="plexer Multi-Suite Benchmark Breakdown" width="100%" />
</p>

---

## 1. 4-Model Live A/B Agent Evaluation (`T1`–`T12`: `plexer` vs. Cold Agent)

### Methodology & Controls

We ran a **48-pair (96-session) A/B evaluation** across 12 tasks, 2 arms (`cold` vs. `plexer`), and 4 model configurations:
- **Antigravity `argon-low`** (`gemini-4-argon-low --effort low`)
- **Antigravity `argon-medium`** (`gemini-4-argon-medium --effort medium`)
- **Claude Sonnet 5.5** (`claude -p --model claude-sonnet-5-5 --effort medium`)
- **Claude Opus 5.5** (`claude -p --model claude-opus-5-5 --effort medium`)

The suite spans **6 repositories** (`plexer`, `kohls-admin`, `flux`, `sert`, and 2 unseen holdouts `building-tools` and `z`) in JavaScript, Luau, Rust, and Python (1,028 to 5,878 symbols and up to 9,594 edges). Tasks fall into 3 categories:

1. **Bug and behavior diagnosis (`T1`–`T4`):** Diagnose the root mechanism behind a symptom or edge case described in domain terms and cite `file:Lx-Ly` spans.
2. **Refactoring and blast-radius planning (`T5`–`T8`):** Locate a subsystem contract and trace all direct and second-hop callers affected by a proposed change.
3. **Multi-file code edits and test verification (`T9`–`T12`):** Implement a feature across multiple files in an isolated worktree and pass both the existing test suite and a held-out verification spec.

#### Experimental Controls (`bench/grade.js`)

1. **No prompt or answer-key leakage:**
   - Prompts describe user-visible behavior and symptoms rather than internal helper names or file paths.
   - Worktrees are exported via `git archive HEAD` with `bench/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/`, `.cursor/`, `.gemini/`, and `.agents/` stripped. `grade.js` fails any run that accesses `bench/tasks.js`.
2. **Unseen holdout repositories:** `T4` (`z`), `T8` (`building-tools`), and `T12` (`building-tools`) run on repositories never used to tune retrieval weights or skill instructions.
3. **Prompt, effort, and environment symmetry:**
   - Within each model tier, `cold` and `plexer` run with the exact same model, `--effort` flag, tool permissions, and task prompt (`0` symmetry violations across all 96 transcripts).
   - The `cold` arm sets `PLEXER_DISABLE_HOOKS=1` so lifecycle hooks never fire. The `plexer` arm enables Turn-1 prompt-context and post-edit blast-radius hooks (`PLEXER_DISABLE_HOOKS=0`).
   - For Antigravity, [`bench/run-agy-ab.js`](run-agy-ab.js) runs `agy -p --agent bench-{cold,plexer} --model gemini-4-argon-{low,medium} --effort {low,medium} --dangerously-skip-permissions --disable-slash-commands` with `inheritCustomizations: false` and `inheritMcp: false`.
   - For Claude Code, [`bench/run-claude-ab.js`](run-claude-ab.js) passes `--model {sonnet,opus} --effort medium --setting-sources "" --disable-slash-commands --strict-mcp-config --tools "Bash,Read,Edit,Write,Grep,Glob"` and adds `--settings <hook-settings.json>` only on the `plexer` arm.

#### Token Accounting (`bench/grade.js`)

[`bench/grade.js`](grade.js) tracks five separate token metrics from provider transcripts so Antigravity (`agy`) and Claude Code (`claude`) runs can be compared directly:

1. **Tool Output Tokens (`toolOutputTokens = ceil(bytes / 4)`):** Total volume of tool output (`view_file`/`Read`, `run_command`/`Bash`, `grep_search`/`Grep`, `plexer` stdout, and test runner output) added to the conversation.
2. **Final Context Window Tokens (`finalContextTokens`):** Total context window size (`input + cache_read + cache_creation`) on the final LLM turn of each task. This measures the net context accumulated by the end of the session without turn-count multiplication.
3. **Uncached and Cached Cumulative Input Tokens (`uncachedInputTokens` + `cachedInputTokens` = `cumulativeInputTokens`):**
   - Every LLM turn re-sends the conversation history to that point, so `cumulativeInputTokens` scales as $\mathcal{O}(\text{turns} \times \text{context})$.
   - **Claude Code** caches the system prompt and tool definitions after Turn 1 (`99.98%` of input tokens are `cachedInputTokens` at `0.1x` cost, with only ~8–15 `uncachedInputTokens` per turn) and finishes in 24–79 turns across 12 tasks.
   - **Antigravity (`argon-low` and `argon-medium`)** makes more granular line-range `view_file` calls (55–107 turns across 12 tasks) and bills ~15–20% of each turn's prompt as `uncachedInputTokens`. Because `plexer` cuts both tool output per turn and total turns, it reduces Antigravity's cumulative input tokens by **47–72%** on `T1`–`T12` and **25–34%** on `SWE-bench Pro V2`.
4. **Model Output Tokens (`totalModelOutputTokens`):** Total generated tokens including assistant text, tool-call arguments, and thinking tokens. On Claude Code, this is read from the top-level `result` event's `usage.output_tokens`.

---

### Multi-Model Summary (`T1`–`T12` Across 4 Model Configurations)

```bash
node bench/run-agy-ab.js argon-low 4 both all
node bench/run-agy-ab.js argon-medium 4 both all
node bench/run-claude-ab.js sonnet 4 both all medium
node bench/run-claude-ab.js opus 4 both all medium
```

| Model & Effort (12 Tasks Each) | Symmetry | Correctness (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `argon-low`** (`--effort low`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 146 → **80 (-45.2%)** (`9W/2T/1L`) | 263,482 → **108,332 (-58.9%)** (**`12W/0T/0L`**) | 511.5k → **299.8k (-41.4%)** | 3.19M → **1.70M (-46.6%)** | 1,017.0s → **961.0s (-5.5%)** (`8W/0T/4L`) |
| **Antigravity `argon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 146 → **65 (-55.5%)** (`11W/0T/1L`) | 253,993 → **95,399 (-62.4%)** (**`12W/0T/0L`**) | 534.7k → **292.8k (-45.2%)** | 4.28M → **1.22M (-71.5%)** | 1,417.0s → **710.0s (-49.9%)** (`10W/0T/2L`) |
| **Claude Opus 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 81 → **28 (-65.4%)** (**`12W/0T/0L`**) | 63,696 → **18,287 (-71.3%)** (**`12W/0T/0L`**) | 225.9k → **177.5k (-21.4%)** | 1.29M → **0.57M (-55.7%)** | 248.9s → **93.1s (-62.6%)** (**`12W/0T/0L`**) |
| **Claude Sonnet 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 76 → **25 (-67.1%)** (**`10W/2T/0L`**) | 45,198 → **12,368 (-72.6%)** (**`12W/0T/0L`**) | 187.9k → **161.2k (-14.2%)** | 0.65M → **0.41M (-36.7%)** | 96.7s → **62.0s (-35.9%)** (**`11W/0T/1L`**) |
| **4-Model Total (`48` Task-Model Pairs)** | `PASSED (0)` | 380/384 → **384/384 (100%)** | 449 → **198 (-55.9%)** (`42W/4T/2L`) | 626,369 → **234,386 (-62.6%)** (**`48W/0T/0L`**) | 1,460.0k → **931.3k (-36.2%)** | 9.41M → **3.91M (-58.5%)** | 2,779.7s → **1,826.1s (-34.3%)** (`41W/0T/7L`) |

#### Separated Token Accounting (`T1`–`T12` Totals)

| Model Configuration | Arm | Turns | Tool Output Tok | Final Context Tok | Uncached Input Tok | Cached Input Tok | Cumulative Input Tok | Model Output Tok |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Antigravity `argon-low`** (`low`) | `cold` | 90 | 263,482 | 511,458 | 629,271 | 2,561,528 | 3,190,799 | 51,417 |
| **Antigravity `argon-low`** (`low`) | **`plexer`** | **61 (-32.2%)** | **108,332 (-58.9%)** | **299,816 (-41.4%)** | **495,021 (-21.3%)** | **1,209,349 (-52.8%)** | **1,704,370 (-46.6%)** | 67,801 |
| **Antigravity `argon-medium`** (`medium`) | `cold` | 97 | 253,993 | 534,716 | 649,842 | 3,628,859 | 4,278,701 | 95,735 |
| **Antigravity `argon-medium`** (`medium`) | **`plexer`** | **44 (-54.6%)** | **95,399 (-62.4%)** | **292,767 (-45.2%)** | **412,053 (-36.6%)** | **807,189 (-77.8%)** | **1,219,242 (-71.5%)** | **67,225 (-29.8%)** |
| **Claude Opus 5.5** (`medium`) | `cold` | 79 | 63,696 | 225,931 | 182 | 1,287,574 | 1,287,756 | 34,149 |
| **Claude Opus 5.5** (`medium`) | **`plexer`** | **28 (-64.6%)** | **18,287 (-71.3%)** | **177,499 (-21.4%)** | **80 (-56.0%)** | **570,169 (-55.7%)** | **570,249 (-55.7%)** | **23,832 (-30.2%)** |
| **Claude Sonnet 5.5** (`medium`) | `cold` | 41 | 45,198 | 187,880 | 106 | 654,253 | 654,359 | 24,145 |
| **Claude Sonnet 5.5** (`medium`) | **`plexer`** | **21 (-48.8%)** | **12,368 (-72.6%)** | **161,197 (-14.2%)** | **66 (-37.7%)** | **414,469 (-36.7%)** | **414,535 (-36.7%)** | **16,831 (-30.3%)** |

---

### Tier 1: Antigravity `argon-low` (`gemini-4-argon-low --effort low`)

Cuts tool output tokens by `-58.9%` (`12W/0T/0L`), final context by `-41.4%`, tool calls by `-45.2%` (`9W/2T/1L`), and search time by `-5.5%` (`96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 4 (3) | **1 (1)** (-75%) | 10,015 | **470** (-95%) | 24.0s (24.0s) | **16.0s** (16.0s) (-33%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 5 (5) | **5 (5)** (0%) | 25,707 | **7,362** (-71%) | 27.0s (27.0s) | 48.0s (49.0s) (+78%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 5 (3) | **5 (4)** (0%) | 16,712 | **5,500** (-67%) | 17.0s (17.0s) | 27.0s (27.0s) (+59%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 7 (7) | **2 (2)** (-71%) | 16,157 | **3,203** (-80%) | 88.0s (88.0s) | **30.0s** (30.0s) (-66%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 9 (4) | 11 (11) (+22%) | 26,498 | **21,809** (-18%) | 25.0s (25.0s) | 110.0s (110.0s) (+340%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 12 (3) | **1 (1)** (-92%) | 16,996 | **2,062** (-88%) | 23.0s (23.0s) | **15.0s** (16.0s) (-35%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 10 (7) | **4 (4)** (-60%) | 24,224 | **6,396** (-74%) | 70.0s (70.0s) | **46.0s** (46.0s) (-34%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 8 (4) | **2 (2)** (-75%) | 13,249 | **2,516** (-81%) | 21.0s (21.0s) | **10.0s** (10.0s) (-52%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 37 (25) | **19 (14)** (-49%) | 35,680 | **21,589** (-39%) | 394.0s (395.0s) | **305.0s** (305.0s) (-23%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 11 (7) | **5 (3)** (-55%) | 22,485 | **6,692** (-70%) | 80.0s (80.0s) | **27.0s** (27.0s) (-66%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 26 (15) | **20 (11)** (-23%) | 30,007 | **25,652** (-15%) | 126.0s (126.0s) | 237.0s (237.0s) (+88%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 12 (7) | **5 (3)** (-58%) | 25,752 | **5,081** (-80%) | 122.0s (122.0s) | **90.0s** (90.0s) (-26%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **146 (90)** | **80 (61) (-45.2%)** | **263,482** | **108,332 (-58.9%)** | **1017.0s (1018.0s)** | **961.0s (963.0s) (-5.5%)** | **96/96** | **96/96** |

---

### Tier 2: Antigravity `argon-medium` (`gemini-4-argon-medium --effort medium`)

Cuts tool output tokens by `-62.4%` (`12W/0T/0L`), final context by `-45.2%`, tool calls by `-55.5%` (`11W/0T/1L`), and search time by `-49.9%` (`10W/0T/2L`, `96/96` score).

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 5 (5) | **1 (1)** (-80%) | 6,494 | **471** (-93%) | 39.0s (39.0s) | **15.0s** (16.0s) (-62%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 4 (4) | 5 (3) (+25%) | 15,649 | **14,614** (-7%) | 28.0s (28.0s) | **23.0s** (23.0s) (-18%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 6 (4) | **5 (5)** (-17%) | 19,554 | **6,597** (-66%) | 35.0s (35.0s) | 82.0s (82.0s) (+134%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 5 (4) | **0 (0)** (-100%) | 29,982 | **0** (-100%) | 20.0s (53.9s) | **0.0s** (15.6s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 14 (5) | **8 (5)** (-43%) | 30,657 | **16,972** (-45%) | 31.0s (58.9s) | 36.0s (63.6s) (+16%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 12 (2) | **1 (1)** (-92%) | 16,752 | **2,062** (-88%) | 29.0s (29.0s) | **5.0s** (6.0s) (-83%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 7 (5) | **4 (4)** (-43%) | 13,870 | **8,215** (-41%) | 61.0s (61.0s) | **36.0s** (36.0s) (-41%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 11 (5) | **1 (1)** (-91%) | 14,544 | **1,439** (-90%) | 62.0s (62.0s) | **13.0s** (13.0s) (-79%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 17 (9) | **8 (6)** (-53%) | 12,573 | **7,800** (-38%) | 154.0s (161.7s) | **87.0s** (95.1s) (-44%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 17 (11) | **5 (3)** (-71%) | 27,434 | **7,009** (-74%) | 253.0s (253.0s) | **84.0s** (85.0s) (-67%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 33 (33) | **22 (12)** (-33%) | 49,581 | **24,663** (-50%) | 532.0s (532.0s) | **239.0s** (240.0s) (-55%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 15 (10) | **5 (3)** (-67%) | 16,903 | **5,557** (-67%) | 173.0s (173.0s) | **90.0s** (91.0s) (-48%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **146 (97)** | **65 (44) (-55.5%)** | **253,993** | **95,399 (-62.4%)** | **1417.0s (1486.5s)** | **710.0s (766.4s) (-49.9%)** | **96/96** | **96/96** |

---

### Tier 3: Claude Opus 5.5 (`claude -p --model claude-opus-5-5 --effort medium`)

Cuts tool output tokens by `-71.3%` (`12W/0T/0L`), tool calls by `-65.4%` (`12W/0T/0L`), and search time by `-62.6%` (`12W/0T/0L`), while raising score from `94/96` to `96/96`.

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 8 (7) | **0 (0)** (-100%) | 5,288 | **0** (-100%) | 13.8s (29.4s) | **0.0s** (13.8s) (-100%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 6 (6) | **2 (2)** (-67%) | 5,248 | **1,382** (-74%) | 15.9s (34.9s) | **4.6s** (20.9s) (-71%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 6 (6) | **3 (3)** (-50%) | 5,143 | **994** (-81%) | 11.7s (25.5s) | **8.9s** (24.2s) (-24%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 3 (3) | **0 (0)** (-100%) | 2,457 | **0** (-100%) | 4.6s (15.1s) | **0.0s** (10.8s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 6 (5) | **3 (3)** (-50%) | 11,421 | **2,915** (-74%) | 15.7s (34.7s) | **6.6s** (27.7s) (-58%) | 6/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 6 (6) | **1 (1)** (-83%) | 3,664 | **662** (-82%) | 14.6s (28.7s) | **0.4s** (17.7s) (-97%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 6 (6) | **1 (1)** (-83%) | 2,887 | **1,147** (-60%) | 15.3s (29.9s) | **0.5s** (18.2s) (-97%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 5 (5) | **1 (1)** (-80%) | 5,508 | **1,268** (-77%) | 15.9s (37.6s) | **2.2s** (22.0s) (-86%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 11 (11) | **7 (7)** (-36%) | 6,134 | **2,797** (-54%) | 46.9s (58.6s) | **29.1s** (41.4s) (-38%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 8 (8) | **4 (4)** (-50%) | 7,287 | **2,312** (-68%) | 30.8s (40.3s) | **15.3s** (24.0s) (-50%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 9 (9) | **4 (4)** (-56%) | 5,215 | **3,321** (-36%) | 45.1s (57.3s) | **19.4s** (28.0s) (-57%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 7 (7) | **2 (2)** (-71%) | 3,444 | **1,489** (-57%) | 18.6s (26.8s) | **6.1s** (12.7s) (-67%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **81 (79)** | **28 (28) (-65.4%)** | **63,696** | **18,287 (-71.3%)** | **248.9s (418.9s)** | **93.1s (261.5s) (-62.6%)** | **94/96** | **96/96** |

---

### Tier 4: Claude Sonnet 5.5 (`claude -p --model claude-sonnet-5-5 --effort medium`)

Cuts tool output tokens by `-72.6%` (`12W/0T/0L`), tool calls by `-67.1%` (`10W/2T/0L`), and search time by `-35.9%` (`11W/0T/1L`), while raising score from `94/96` to `96/96`.

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 3 (2) | **0 (0)** (-100%) | 2,914 | **0** (-100%) | 1.7s (9.9s) | **0.0s** (6.7s) (-100%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 9 (5) | **3 (2)** (-67%) | 5,445 | **1,349** (-75%) | 9.0s (22.6s) | **4.5s** (18.2s) (-51%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 2 (2) | **0 (0)** (-100%) | 1,065 | **0** (-100%) | 1.6s (9.4s) | **0.0s** (6.7s) (-100%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 4 (3) | **0 (0)** (-100%) | 2,921 | **0** (-100%) | 4.3s (11.4s) | **0.0s** (7.9s) (-100%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 6 (3) | **3 (3)** (-50%) | 6,969 | **3,037** (-56%) | 6.3s (18.9s) | 7.9s (23.1s) (+25%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 2 (2) | **0 (0)** (-100%) | 1,024 | **0** (-100%) | 1.5s (10.2s) | **0.0s** (9.9s) (-100%) | 6/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 3 (3) | **3 (1)** (0%) | 2,656 | **1,157** (-56%) | 4.8s (12.4s) | **0.9s** (9.8s) (-82%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 9 (3) | **1 (1)** (-89%) | 7,253 | **716** (-90%) | 7.8s (23.3s) | **0.4s** (19.8s) (-95%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 4 (3) | **4 (3)** (0%) | 2,330 | **2,079** (-11%) | 10.6s (18.3s) | **10.0s** (15.8s) (-6%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 8 (4) | **2 (2)** (-75%) | 4,391 | **1,239** (-72%) | 13.1s (18.9s) | **6.1s** (11.5s) (-54%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 10 (5) | **4 (4)** (-60%) | 4,598 | **2,050** (-55%) | 17.7s (23.7s) | **17.5s** (28.3s) (-1%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 16 (6) | **5 (5)** (-69%) | 3,632 | **741** (-80%) | 18.4s (22.6s) | **14.9s** (26.9s) (-19%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **76 (41)** | **25 (21) (-67.1%)** | **45,198** | **12,368 (-72.6%)** | **96.7s (201.5s)** | **62.0s (184.7s) (-35.9%)** | **94/96** | **96/96** |

---

## 2. External Multi-Language Benchmark: `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`)

[`bench/run-swebench-ab.js`](run-swebench-ab.js) evaluates an 8-task stratified subset (`S1`–`S8`, 2 tasks per language across Python, Go, JavaScript, and TypeScript) from **`ScaleAI/SWE-bench_Pro` V2** across all 4 model configurations:

- **`S1` & `S2` (Python, `qutebrowser/qutebrowser`):** WebKit `NetworkReply` Qt 5.15 `errorOccurred` signal migration (`S1`) and multi-file `KeyMode` / `EventFilter` handling (`S2`).
- **`S3` & `S4` (Go, `flipt-io/flipt`):** Authentication cleanup service gating (`ShouldRunCleanup`) across `internal/cleanup`, `internal/cmd`, and `internal/config` (`S3`), and evaluation rollout caching (`GetEvaluationRollouts`) across `internal/storage/cache` and `internal/storage` (`S4`).
- **`S5` & `S6` (JavaScript, `NodeBB/NodeBB`):** User email confirmation refactor across `src/middleware` and `src/user` (`S5`), and queued-post topic merging (`updateQueuedPostsTopic`) across `src/posts/queue.js` and `src/topics/merge.js` (`S6`).
- **`S7` & `S8` (TypeScript, `tutao/tutanota`):** Desktop download manager error handling across `src/desktop/DesktopDownloadManager.ts` and `DesktopNetworkClient.ts` (`S7`), and device credential encryption facade updates across `src/api/worker/facades` and `src/misc/credentials` (`S8`).

```bash
node bench/run-swebench-ab.js argon-low 4 both all
node bench/run-swebench-ab.js argon-medium 4 both all
node bench/run-swebench-ab.js sonnet 4 both all
node bench/run-swebench-ab.js opus 4 both all
```

### `SWE-bench Pro V2` Summary Across All 4 Models (`S1`–`S8`)

| Model & Effort (8 Tasks Each) | Patch Score (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Model Output Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `argon-low`** (`--effort low`) | **61/64 → 61/64** (`100%` file recall) | 239 → **180 (-24.7%)** | 233,849 → **183,048 (-21.7%)** (`6W/0T/2L`) | 498.5k → **446.2k (-10.5%)** | 7.70M → **5.77M (-25.1%)** | 95,451 → 114,880 (+20.4%) | 2,759.0s → **1,855.0s (-32.8%)** (`6W/0T/2L`) |
| **Antigravity `argon-medium`** (`--effort medium`) | 64/64 → **63/64** (`100%` file recall) | 273 → **195 (-28.6%)** (`6W/0T/2L`) | 295,513 → **190,595 (-35.5%)** (**`8W/0T/0L`**) | 704.6k → **573.4k (-18.6%)** | 11.32M → **7.45M (-34.2%)** | 207,280 → 207,777 (+0.2%) | 3,013.0s → **2,814.0s (-6.6%)** (`5W/0T/3L`) |
| **Claude Sonnet 5.5** (`--effort medium`) | 55/64 → **57/64 (+3.6%)** (`100%` file recall) | 65 → **29 (-55.4%)** (**`8W/0T/0L`**) | 19,344 → **12,040 (-37.8%)** (**`8W/0T/0L`**) | 125.2k → **117.7k (-6.0%)** | 637.0k → **444.7k (-30.2%)** | 21,386 → **13,742 (-35.7%)** | 120.1s → **81.5s (-32.1%)** (`7W/0T/1L`) |
| **Claude Opus 5.5** (`--effort medium`) | **58/64 → 58/64** (`100%` file recall) | 39 → **34 (-12.8%)** (`5W/1T/2L`) | 24,253 → **16,638 (-31.4%)** (`7W/0T/1L`) | 133.0k → 133.6k (+0.5%) | 645.6k → **623.6k (-3.4%)** | 23,373 → **21,420 (-8.4%)** | 193.1s → **155.4s (-19.5%)** (`6W/0T/2L`) |

---

## 3. Trail-Code (`@trailhq/trail-code@0.25.0`) Comparison

### Live 3-Arm Evaluation (`cold` vs. `trail` vs. `plexer`)

[`bench/run-agy-ab.js`](run-agy-ab.js) and [`bench/run-swebench-ab.js`](run-swebench-ab.js) run a 3rd live arm (`trail` via [`bench/trail-live-helper.js`](trail-live-helper.js)) across all 4 models on the shared non-Luau tasks (`T4, T5, T9`) and `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`):

| Model & Suite | `plexer` Calls / Tool Tok / CumIn / Search / Score | `trail` Calls / Tool Tok / CumIn / Search / Score | `cold` Calls / Tool Tok / CumIn / Search / Score |
| :--- | :---: | :---: | :---: |
| **Flash 3.8 Med — `T4, T5, T9`** | **69 (69t)** · **46.2k** · **2.80M** · **295s** · **24/24** | 82 (82t) · 57.3k · 3.58M · 308s · 24/24 | 92 (92t) · 69.4k · 4.09M · 345s · 24/24 |
| **Sonnet 5.5 Med — `T4, T5, T9`** | **11 (8t)** · **5.9k** · **184k** · **33s** · **24/24** | 20 (13t) · 11.8k · 321k · 44s · 24/24 | 26 (21t) · 14.1k · 471k · 60s · 24/24 |
| **Opus 5.5 Med — `T4, T5, T9`** | **21 (17t)** · **11.8k** · **424k** · **80s** · **24/24** | 19 (14t) · 15.0k · 381k · 72s · 24/24 | 43 (33t) · 27.0k · 1.12M · 175s · 24/24 |
| **Argon 4 Med — `T4, T5, T9`** | **16 (11t)** · **24.8k** · **273k** · **123s** · **24/24** | 47 (30t) · 52.8k · 856k · 294s · 24/24 | 36 (18t) · 73.2k · 552k · 205s · 24/24 |
| **Flash 3.8 Med — `S1`–`S8`** | **418 (418t)** · **238.3k** · **26.63M** · **1,808s** · **61/64** | 487 (487t) · 282.3k · 34.24M · 2,252s · 61/64 | 510 (510t) · 275.8k · 31.47M · 2,088s · 61/64 |
| **Sonnet 5.5 Med — `S1`–`S8`** | **67 (35t)** · **23.4k** · **793k** · **189s** · **61/64** | 101 (54t) · 36.3k · 1.47M · 254s · 60/64 | 82 (48t) · 31.5k · 1.10M · 203s · 60/64 |
| **Opus 5.5 Med — `S1`–`S8`** | **87 (54t)** · **31.8k** · **1.37M** · **355s** · **61/64** | 91 (66t) · 42.0k · 2.09M · 423s · 61/64 | 106 (79t) · 43.0k · 2.15M · 480s · 60/64 |
| **Argon 4 Med — `S1`–`S8`** | **195 (132t)** · **190.6k** · **7.45M** · **2,814s** · **63/64** | 265 (185t) · 283.6k · 11.62M · 3,511s · 63/64 | 273 (193t) · 295.5k · 11.32M · 3,013s · 64/64 |

### Trail-Comparable Metric Table (`node bench/trail-table.js`)

Trail-Code (`@trailhq/trail-code`) reports per-task means on read-only Q&A prompts (`--max-turns 10`) by pre-running `ask "<question>" --source` and prepending the output to the prompt. It tracks **uncached input tokens** (`input_tokens + cache_creation_input_tokens`) and **cache-aware cost** (`1·input + 1.25·cache_write + 0.1·cache_read + 5·output`). [`bench/trail-table.js`](trail-table.js) computes those same metrics alongside cumulative input tokens and search wall time across our Claude Code sessions:

```bash
node bench/trail-table.js --suite qa
node bench/trail-table.js --suite all
node bench/trail-table.js --suite swe
```

| Model & Suite (Per-Task Mean) | Tool Calls (`cold` → `plexer`) | Uncached Input Tok (`cold` → `plexer`) | Cumulative Input Tok (`cold` → `plexer`) | Cache-Aware Cost (`cold` → `plexer`) | Search Time (`cold` → `plexer`) | Total Latency (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Opus 5.5 — Q&A (`T1`–`T8`)** | 5.8 → **1.4 (-76%)** | 12,608 → **8,412 (-33%)** | 86,533 → **31,790 (-63%)** | 35,377 → **21,579 (-39%)** | 13.4s → **2.7s (-80%)** | 29.5s → **19.4s (-34%)** |
| **Sonnet 5.5 — Q&A (`T1`–`T8`)** | 4.8 → **1.3 (-74%)** | 9,655 → **6,747 (-30%)** | 46,218 → **24,648 (-47%)** | 24,615 → **16,343 (-34%)** | 4.6s → **1.8s (-62%)** | 14.8s → **12.8s (-14%)** |
| **Opus 5.5 — All (`T1`–`T12`)** | 6.8 → **2.3 (-65%)** | 13,111 → **8,940 (-32%)** | 107,313 → **47,521 (-56%)** | 40,034 → **24,961 (-38%)** | 20.7s → **7.8s (-63%)** | 34.9s → **21.8s (-38%)** |
| **Sonnet 5.5 — All (`T1`–`T12`)** | 6.3 → **2.1 (-67%)** | 9,950 → **6,510 (-35%)** | 54,530 → **34,545 (-37%)** | 26,953 → **17,953 (-33%)** | 8.1s → **5.2s (-36%)** | 16.8s → **15.4s (-8%)** |
| **Opus 5.5 — SWE-bench (`S1`–`S8`)** | 4.9 → **4.3 (-13%)** | 11,751 → **10,111 (-14%)** | 80,703 → **77,954 (-3%)** | 36,189 → **32,808 (-9%)** | 24.1s → **19.4s (-20%)** | 35.9s → **28.7s (-20%)** |
| **Sonnet 5.5 — SWE-bench (`S1`–`S8`)** | 8.1 → **3.6 (-55%)** | 10,653 → **9,713 (-9%)** | 79,626 → **55,584 (-30%)** | 33,577 → **25,315 (-25%)** | 15.0s → **10.2s (-32%)** | 21.1s → **17.7s (-16%)** |

### Offline Head-to-Head vs. `@trailhq/trail-code@0.25.0` (`node bench/graft-arm.js`)

[`bench/graft-arm.js`](graft-arm.js) compares `plexer`'s `UserPromptSubmit` hook against `@trailhq/trail-code@0.25.0` across all 11 shared Rust, JS, TS, Python, and Go tasks (`T4`, `T5`, `T9`, `S1`–`S8`). It tests both `graft-hook` (`trail ask <prompt> --json -n 3`, pointers only) and `graft-push` (`trail ask <prompt> --source`, Trail-Code's benchmark push bundle):

```bash
node bench/graft-arm.js
```

| Arm (`T4`, `T5`, `T9`, `S1`–`S8` Mean) | Turn-0 Tokens | Gold File Recall | `NeedCov` (Inlined Lines) | `LocCov` (Located Symbols) | Predicted Wall (`EstWall`) | Predicted CumInput (`EstCum`) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: |
| **`plexer` (`11/11` task wins)** | **2,613 tok** | **100.0%** | **28.7%** | **49.8%** | **41.0s** | **125k** |
| `graft-hook` (`ask --json -n 3`) | 135 tok | 41.6% | 0.0% | 4.5% | 49.1s | 140k |
| `graft-push` (`ask --source`) | 5,741 tok | 60.6% | 3.9% | 8.3% | 48.2s | 191k |

### 3-Tier Offline Optimization Suite (`node bench/eval-fast.js`)

[`bench/eval-fast.js`](eval-fast.js) evaluates retrieval ranking, named-definition pinning (`src/claude/pin.js`), and hook budgets in under 5s at `$0` API cost:
1. **Transcript-mined ground truth (`bench/replay.js` → `bench/needed-spans.json`):** Captures every line range and symbol that `cold` agents read or grepped across all 20 tasks, plus SWE-bench gold patch hunks.
2. **Coverage metrics (`bench/needcov.js`):** Computes `NeedCov` (weighted share of needed lines inlined with `L<n>:` numbers at Turn 0) and `LocCov` (share of needed symbols pointed to or inlined at Turn 0), with separate holdout reporting (`T4`, `T8`, `T12`).
3. **Live-calibrated cost model (`bench/cost-model.js` & `bench/turn-model.json`):** Uses per-family linear models fit on the 80 recorded live runs (`wall R² = 0.92` on Opus, `cum R² = 0.90–0.92` with `1.0 × (turns + 1) × t0Tok` Turn-0 re-billing).

```bash
node bench/eval-fast.js
node bench/eval-fast.js --missing S5
node bench/eval-fast.js --quiet --set editMergedBytes=3200
```

---

## 4. Engine & Retrieval Benchmark (`npm run bench`)

[`bench/run.js`](run.js) benchmarks the `plexer` engine across 6 repositories (`plexer`, `kohls-admin`, `flux`, `sert`, `building-tools`, and `z`, totaling **14,197 symbols** and **29,020 graph edges** at pinned benchmark commits) and **24 natural-language intent queries**:

```bash
npm run bench
# Emit raw JSON metrics:
node bench/run.js --json
```

### Results Across 6 Repositories (24 Intent Queries)

- **Retrieval accuracy:** **100.0% Recall@1 (24/24)**, **100.0% Recall@3 (24/24)**, **100.0% Recall@5 (24/24)**, and **1.000 MRR**. By comparison, `@trailhq/trail-code@0.25.0` reaches `20.8% Recall@1` / `0.250 MRR` across all 6 repos and `62.5% Recall@1` / `0.750 MRR` on the shared non-Luau repos.

| Repository | Graph Size (Nodes / Edges) | `wiring.json` | `check` | `ask --source` Latency & Tokens (vs Raw Files) | `callers` (`d=2`) | `skeleton` | `map` |
| :--- | ---: | ---: | ---: | :--- | ---: | ---: | ---: |
| **`plexer`** (JS/TS) | 1,655 / 5,343 | 1,353 KB | 30.0ms | **13.5ms** / 1,367 tok (**-91%** vs 15,477 raw) | **0.13ms** | **0.13ms** | 0.05ms |
| **`kohls-admin`** (Luau) | 2,508 / 4,137 | 1,568 KB | 39.3ms | **10.4ms** / 1,280 tok (**-88%** vs 10,566 raw) | **0.85ms** | **0.04ms** | 0.01ms |
| **`flux`** (Luau) | 1,524 / 2,210 | 808 KB | 17.7ms | **5.1ms** / 1,448 tok (**-94%** vs 26,234 raw) | **0.33ms** | **0.10ms** | 0.01ms |
| **`sert`** (Luau + Py) | 2,926 / 6,127 | 1,906 KB | 36.3ms | **10.7ms** / 1,186 tok (**-89%** vs 10,757 raw) | **1.56ms** | **0.04ms** | 0.01ms |
| **`building-tools`** (Luau) | 1,970 / 4,778 | 1,413 KB | 39.1ms | **7.1ms** / 1,445 tok (**-73%** vs 5,306 raw) | **0.70ms** | **0.02ms** | 0.01ms |
| **`z`** (Luau + Rust + Py) | 3,614 / 6,425 | 2,438 KB | 47.1ms | **24.0ms** / 1,376 tok (**-93%** vs 20,675 raw) | **0.37ms** | **0.05ms** | 0.03ms |
