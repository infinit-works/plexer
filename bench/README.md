# `plexer` Benchmarks & Methodology

This directory contains the reproducible multi-model benchmark suite for `plexer`:
- [`bench/tasks.js`](tasks.js) — 12 natural-language A/B engineering task specifications (`T1`–`T12`), rubrics, and automated code-edit verification commands across 6 repositories (including 2 unseen holdout repositories).
- [`bench/swebench/tasks.json`](swebench/tasks.json) — 8 official real-world software engineering tasks (`S1`–`S8`) from **`ScaleAI/SWE-bench_Pro` V2** across 4 languages (**Python**, **Go**, **JavaScript**, **TypeScript**) and 4 repositories (`qutebrowser/qutebrowser`, `flipt-io/flipt`, `NodeBB/NodeBB`, `tutao/tutanota`), bundled with their official container verifier scripts (`test.sh`, `run_script.sh`, `parser.py`, `config.json`).
- [`bench/grade.js`](grade.js) — Automated transcript parser (supporting both Antigravity JSONL and Claude Code `stream-json` JSONL), cohort-symmetry validator, separated token accounting (`toolOutputTokens`, `finalContextTokens`, `uncachedInputTokens`, `cachedInputTokens`, `cumulativeInputTokens`, `totalModelOutputTokens`), rubric/test grader, and Markdown table generator.
- [`bench/run-agy-ab.js`](run-agy-ab.js) — Reproducible headless CLI runner for Google Antigravity (`agy -p`) across explicit model and effort configurations (`argon-low`: `gemini-4-argon-low --effort low`; `argon-medium`: `gemini-4-argon-medium --effort medium`).
- [`bench/run-claude-ab.js`](run-claude-ab.js) — Reproducible headless CLI runner for Claude Code (`claude -p`) with explicit `--effort medium` (`claude-sonnet-5-5` and `claude-opus-5-5`) across all 12 tasks (`T1`–`T12`).
- [`bench/run-swebench-ab.js`](run-swebench-ab.js) — Reproducible A/B runner for `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`) across all 4 models (`argon-low`, `argon-medium`, `claude-sonnet-5-5`, `claude-opus-5-5`), supporting both deterministic patch/symbol/file grading and official Docker container verification (`SWEBENCH_DOCKER=1`).
- [`bench/skill-review.html`](skill-review.html) — Self-contained interactive `/skill-creator` evaluation viewer across all paired A/B evaluations.
- [`bench/run.js`](run.js) — Deterministic engine & retrieval benchmark across 6 repositories and 24 de-leaked natural-language intent queries (`npm run bench`).

---

## 1. De-Benchmaxxed 4-Model Live A/B Agent Evaluation (`T1`–`T12`: `plexer` vs. Cold Agent)

### Methodology & Anti-Benchmaxxing Controls

To evaluate whether `plexer` genuinely improves coding agent token efficiency, speed, and correctness on realistic software engineering work across multiple model families and effort levels, we ran a **48-pair (96-session) A/B evaluation** (`12 tasks × 2 arms × 4 explicit model configurations`: **Antigravity `argon-low` (`gemini-4-argon-low --effort low`)**, **Antigravity `argon-medium` (`gemini-4-argon-medium --effort medium`)**, **Claude Sonnet 5.5 (`claude -p --model claude-sonnet-5-5 --effort medium`)**, and **Claude Opus 5.5 (`claude -p --model claude-opus-5-5 --effort medium`)**) across **6 repositories** (`plexer`, `kohls-admin`, `flux`, `sert`, plus **2 unseen holdouts** `building-tools` and `z`, spanning JavaScript, Luau, Rust, and Python from 1,028 to 5,878 symbols and up to 9,594 edges) and **3 realistic task categories**:

1. **Symptom-Based Bug / Behavior Diagnosis (`T1`–`T4`)**: Given a user-facing symptom or edge-case question described in domain language (without internal symbol names or file paths leaked in the prompt), diagnose the exact mechanism and cite `file:Lx-Ly` spans.
2. **Refactoring & Blast-Radius Planning (`T5`–`T8`)**: Audit where a subsystem boundary or contract is defined and trace all direct and second-hop callers affected by a proposed change.
3. **End-to-End Multi-File Code Edits + Test Verification (`T9`–`T12`)**: Implement a real feature across multiple files in an isolated worktree and pass both the repository's existing test suite and a held-out behavioral verification spec.

#### Strict Experimental Controls (Enforced by `bench/grade.js`)

1. **Zero Prompt Leakage & Zero Answer-Key Leakage**:
   - Prompts describe symptoms, behaviors, or user-visible contracts—never internal helper names or file paths that only exist in the index.
   - Isolated worktrees are exported via `git archive HEAD` with `bench/`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/`, `.cursor/`, `.gemini/`, and `.agents/` stripped, and `grade.js` fails any run that accesses `bench/tasks.js`.
2. **Unseen Holdout Repositories**: `T4` (`z`), `T8` (`building-tools`), and `T12` (`building-tools`) run on repositories that were never used to tune `plexer`'s retrieval weights or skill instructions.
3. **Strict Prompt, Effort & Environment Symmetry**:
   - Within each model tier, `cold` and `plexer` run with the exact same model, explicit `--effort` flag, tool permissions, and task prompt (`0` symmetry violations across all 96 transcripts).
   - The `cold` arm sets `PLEXER_DISABLE_HOOKS=1` in the child environment so lifecycle hooks (`PreInvocation`, `UserPromptSubmit`, `PostToolUse`, `Stop`) never fire in `cold`, while the `plexer` arm enables `plexer`'s standard Turn-1 prompt-context and post-edit blast-radius hooks (`PLEXER_DISABLE_HOOKS=0`).
   - For Antigravity (`argon-low` and `argon-medium`), [`bench/run-agy-ab.js`](run-agy-ab.js) drives `agy -p --agent bench-{cold,plexer} --model gemini-4-argon-{low,medium} --effort {low,medium} --dangerously-skip-permissions --disable-slash-commands` with `inheritCustomizations: false` and `inheritMcp: false`.
   - For Claude Code (`sonnet` and `opus`), [`bench/run-claude-ab.js`](run-claude-ab.js) passes `--model {sonnet,opus} --effort medium --setting-sources "" --disable-slash-commands --strict-mcp-config --tools "Bash,Read,Edit,Write,Grep,Glob"` (adding `--settings <hook-settings.json>` only on the `plexer` arm).

#### Unified Token Accounting (`bench/grade.js`)

Why do raw cumulative input token totals differ in magnitude between Antigravity (`agy`) and Claude Code (`claude`)? [`bench/grade.js`](grade.js) tracks five distinct token metrics from the underlying provider transcripts so every dimension is transparent and apples-to-apples:

1. **Tool Output Tokens (`toolOutputTokens = ceil(bytes / 4)`)**: Exact volume of tool output text (`view_file`/`Read`, `run_command`/`Bash`, `grep_search`/`Grep`, `plexer` CLI stdout, test runner output) ingested into the conversation.
2. **Final Context Window Tokens (`finalContextTokens`)**: Total context window size (`input + cache_read + cache_creation`) on the **final LLM turn** of each task—measuring the net context footprint accumulated by the end of the session without quadratic turn-count multiplication.
3. **Uncached vs. Cached Cumulative Input Tokens (`uncachedInputTokens` + `cachedInputTokens` = `cumulativeInputTokens`)**:
   - Every LLM turn re-sends the conversation history to that point, so `cumulativeInputTokens` scales as $\mathcal{O}(\text{turns} \times \text{context})$.
   - **Claude Code** caches the system prompt and tool definitions after Turn 1 (`99.98%` of input tokens are `cachedInputTokens` at `0.1x` cost; `uncachedInputTokens` is only ~8–15 tokens/turn) and finishes in 24–79 turns across 12 tasks.
   - **Antigravity (`argon-low` / `argon-medium`)** uses granular line-range `view_file` calls (55–107 turns across 12 tasks) and bills ~15–20% of each turn's prompt as `uncachedInputTokens` alongside `cachedInputTokens`. Because `plexer` cuts both the per-turn tool output and the number of turns, it reduces Antigravity's cumulative input tokens by **47–68%** on `T1`–`T12` and **25–59%** on `SWE-bench Pro V2`.
4. **Model Output Tokens (`totalModelOutputTokens`)**: Total generated tokens (assistant text, tool-call arguments, and thinking tokens; on Claude Code read from the top-level `result` event's `usage.output_tokens`).

---

### Multi-Model Summary (`T1`–`T12` Across 4 Explicit Model Configurations)

```bash
node bench/run-agy-ab.js argon-low 4 both all
node bench/run-agy-ab.js argon-medium 4 both all
node bench/run-claude-ab.js sonnet 4 both all medium
node bench/run-claude-ab.js opus 4 both all medium
```

| Model & Effort (12 Tasks Each) | Symmetry | Correctness (`cold` → `plexer`) | Tool Calls (`cold` → `plexer`) | Tool Output Tokens (`cold` → `plexer`) | Final Context Tokens (`cold` → `plexer`) | Cumulative Input Tokens (`cold` → `plexer`) | Search Wall Time (`cold` → `plexer`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Antigravity `argon-low`** (`--effort low`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 146 → **80 (-45.2%)** (`9W/2T/1L`) | 263,482 → **108,332 (-58.9%)** (**`12W/0T/0L`**) | 511.5k → **299.8k (-41.4%)** | 3.19M → **1.70M (-46.6%)** | 1,017.0s → **961.0s (-5.5%)** (`8W/0T/4L`) |
| **Antigravity `argon-medium`** (`--effort medium`) | `PASSED (0)` | **96/96 → 96/96** (100%) | 160 → **81 (-49.4%)** (`11W/0T/1L`) | 254,639 → **111,730 (-56.1%)** (**`12W/0T/0L`**) | 530.2k → **319.0k (-39.8%)** | 4.63M → **1.51M (-67.5%)** | 1,525.0s → **929.0s (-39.1%)** (`9W/0T/3L`) |
| **Claude Opus 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 81 → **41 (-49.4%)** (**`10W/1T/1L`**) | 63,696 → **27,714 (-56.5%)** (**`12W/0T/0L`**) | 225.9k → **200.5k (-11.3%)** | 1.29M → **0.80M (-38.2%)** | 248.9s → **122.4s (-50.8%)** (**`12W/0T/0L`**) |
| **Claude Sonnet 5.5** (`--effort medium`) | `PASSED (0)` | 94/96 → **96/96 (+2.1%)** | 76 → **36 (-52.6%)** (**`11W/0T/1L`**) | 45,198 → **19,882 (-56.0%)** (**`12W/0T/0L`**) | 187.9k → **183.7k (-2.2%)** | 0.65M → **0.50M (-23.3%)** | 96.7s → **63.5s (-34.4%)** (**`10W/0T/2L`**) |
| **4-Model Total (`48` Task-Model Pairs)** | `PASSED (0)` | 380/384 → **384/384 (100%)** | 463 → **238 (-48.6%)** (`41W/3T/4L`) | 627,015 → **267,658 (-57.3%)** (**`48W/0T/0L`**) | 1,455.5k → **1,003.0k (-31.1%)** | 9.77M → **4.51M (-53.8%)** | 2,887.6s → **2,075.9s (-28.1%)** (`39W/0T/9L`) |

#### Separated Token Accounting Table (`T1`–`T12` Totals)

| Model Configuration | Arm | Turns | Tool Output Tok | Final Context Tok | Uncached Input Tok | Cached Input Tok | Cumulative Input Tok | Model Output Tok |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Antigravity `argon-low`** (`low`) | `cold` | 90 | 263,482 | 511,458 | 629,271 | 2,561,528 | 3,190,799 | 51,417 |
| **Antigravity `argon-low`** (`low`) | **`plexer`** | **61 (-32.2%)** | **108,332 (-58.9%)** | **299,816 (-41.4%)** | **495,021 (-21.3%)** | **1,209,349 (-52.8%)** | **1,704,370 (-46.6%)** | 67,801 |
| **Antigravity `argon-medium`** (`medium`) | `cold` | 107 | 254,639 | 530,222 | 650,052 | 3,982,421 | 4,632,473 | 91,320 |
| **Antigravity `argon-medium`** (`medium`) | **`plexer`** | **55 (-48.6%)** | **111,730 (-56.1%)** | **318,964 (-39.8%)** | **478,809 (-26.3%)** | **1,026,512 (-74.2%)** | **1,505,321 (-67.5%)** | **79,866 (-12.5%)** |
| **Claude Opus 5.5** (`medium`) | `cold` | 79 | 63,696 | 225,931 | 182 | 1,287,574 | 1,287,756 | 34,149 |
| **Claude Opus 5.5** (`medium`) | **`plexer`** | **40 (-49.4%)** | **27,714 (-56.5%)** | **200,513 (-11.3%)** | **104 (-42.9%)** | **795,525 (-38.2%)** | **795,629 (-38.2%)** | **24,467 (-28.4%)** |
| **Claude Sonnet 5.5** (`medium`) | `cold` | 41 | 45,198 | 187,880 | 106 | 654,253 | 654,359 | 24,145 |
| **Claude Sonnet 5.5** (`medium`) | **`plexer`** | **24 (-41.5%)** | **19,882 (-56.0%)** | **183,718 (-2.2%)** | **72 (-32.1%)** | **501,800 (-23.3%)** | **501,872 (-23.3%)** | **16,782 (-30.5%)** |

---

### Tier 1: Antigravity `argon-low` (`gemini-4-argon-low --effort low`) — Per-Task Breakdown (`-58.9%` Tool Tok `12W/0T/0L`, `-41.4%` Final Context, `-45.2%` Calls `9W/2T/1L`, `-5.5%` Search Time, `96/96`)

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

### Tier 2: Antigravity `argon-medium` (`gemini-4-argon-medium --effort medium`) — Per-Task Breakdown (`-56.1%` Tool Tok `12W/0T/0L`, `-39.8%` Final Context, `-49.4%` Calls `11W/0T/1L`, `-39.1%` Search Time `9W/0T/3L`, `96/96`)

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 5 (5) | **1 (1)** (-80%) | 6,494 | **471** (-93%) | 39.0s (39.0s) | **15.0s** (16.0s) (-62%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 4 (4) | 5 (3) (+25%) | 15,649 | **14,614** (-7%) | 28.0s (28.0s) | **23.0s** (23.0s) (-18%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 6 (4) | **5 (5)** (-17%) | 19,554 | **6,597** (-66%) | 35.0s (35.0s) | 82.0s (82.0s) (+134%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 7 (7) | **3 (3)** (-57%) | 14,467 | **4,013** (-72%) | 33.0s (33.0s) | **20.0s** (21.0s) (-39%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 13 (5) | **11 (7)** (-15%) | 30,593 | **19,185** (-37%) | 27.0s (27.0s) | 49.0s (49.0s) (+81%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 12 (2) | **1 (1)** (-92%) | 16,752 | **2,062** (-88%) | 29.0s (29.0s) | **5.0s** (6.0s) (-83%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 7 (5) | **4 (4)** (-43%) | 13,870 | **8,215** (-41%) | 61.0s (61.0s) | **36.0s** (36.0s) (-41%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 11 (5) | **1 (1)** (-91%) | 14,544 | **1,439** (-90%) | 62.0s (62.0s) | **13.0s** (13.0s) (-79%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 30 (16) | **18 (12)** (-40%) | 28,798 | **17,905** (-38%) | 253.0s (253.0s) | 273.0s (275.0s) (+8%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 17 (11) | **5 (3)** (-71%) | 27,434 | **7,009** (-74%) | 253.0s (253.0s) | **84.0s** (85.0s) (-67%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 33 (33) | **22 (12)** (-33%) | 49,581 | **24,663** (-50%) | 532.0s (532.0s) | **239.0s** (240.0s) (-55%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 15 (10) | **5 (3)** (-67%) | 16,903 | **5,557** (-67%) | 173.0s (173.0s) | **90.0s** (91.0s) (-48%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **160 (107)** | **81 (55) (-49.4%)** | **254,639** | **111,730 (-56.1%)** | **1525.0s (1525.0s)** | **929.0s (937.0s) (-39.1%)** | **96/96** | **96/96** |

---

### Tier 3: Claude Opus 5.5 (`claude -p --model claude-opus-5-5 --effort medium`) — Per-Task Breakdown (`-56.5%` Tool Tok `12W/0T/0L`, `-49.4%` Calls `10W/1T/1L`, `-50.8%` Search Time `12W/0T/0L`, `94/96 → 96/96`)

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 8 (7) | **1 (1)** (-87%) | 5,288 | **232** (-96%) | 13.8s (29.4s) | **0.4s** (14.6s) (-97%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 6 (6) | **3 (3)** (-50%) | 5,248 | **1,595** (-70%) | 15.9s (34.9s) | **5.8s** (25.9s) (-64%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 6 (6) | **3 (3)** (-50%) | 5,143 | **1,585** (-69%) | 11.7s (25.5s) | **8.0s** (23.1s) (-32%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 3 (3) | **2 (2)** (-33%) | 2,457 | **2,431** (-1%) | 4.6s (15.1s) | **4.2s** (17.7s) (-9%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 6 (5) | **6 (6)** (0%) | 11,421 | **7,032** (-38%) | 15.7s (34.7s) | **14.0s** (30.5s) (-11%) | 6/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 6 (6) | **1 (1)** (-83%) | 3,664 | **2,162** (-41%) | 14.6s (28.7s) | **0.8s** (17.7s) (-94%) | 8/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 6 (6) | **2 (2)** (-67%) | 2,887 | **1,138** (-61%) | 15.3s (29.9s) | **2.8s** (17.4s) (-82%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 5 (5) | **2 (2)** (-60%) | 5,508 | **2,513** (-54%) | 15.9s (37.6s) | **3.6s** (24.3s) (-78%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 11 (11) | **7 (7)** (-36%) | 6,134 | **2,395** (-61%) | 46.9s (58.6s) | **32.4s** (44.4s) (-31%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 8 (8) | 9 (8) (+13%) | 7,287 | **3,055** (-58%) | 30.8s (40.3s) | **28.5s** (35.5s) (-7%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 9 (9) | **3 (3)** (-67%) | 5,215 | **2,933** (-44%) | 45.1s (57.3s) | **15.3s** (25.4s) (-66%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 7 (7) | **2 (2)** (-71%) | 3,444 | **643** (-81%) | 18.6s (26.8s) | **6.4s** (15.3s) (-66%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **81 (79)** | **41 (40) (-49.4%)** | **63,696** | **27,714 (-56.5%)** | **248.9s (418.9s)** | **122.4s (291.7s) (-50.8%)** | **94/96** | **96/96** |

---

### Tier 4: Claude Sonnet 5.5 (`claude -p --model claude-sonnet-5-5 --effort medium`) — Per-Task Breakdown (`-56.0%` Tool Tok `12W/0T/0L`, `-52.6%` Calls `11W/0T/1L`, `-34.4%` Search Time `10W/0T/2L`, `94/96 → 96/96`)

| Task | Category | Repo | `cold` Calls (Turns) | `plexer` Calls (Turns) | `cold` Tool Tok | `plexer` Tool Tok | `cold` Search (Total) | `plexer` Search (Total) | `cold` Score | `plexer` Score |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **T1** Diagnose command target validation & group-role fail-closed behavior | `diagnosis` | `kohls-admin` | 3 (2) | **1 (1)** (-67%) | 2,914 | **267** (-91%) | 1.7s (9.9s) | **0.0s** (10.8s) (-98%) | 8/8 | **8/8** |
| **T2** Diagnose runaway reactive effect loop detection and disposal | `diagnosis` | `flux` | 9 (5) | **2 (2)** (-78%) | 5,445 | **847** (-84%) | 9.0s (22.6s) | **3.4s** (19.2s) (-63%) | 8/8 | **8/8** |
| **T3** Diagnose stateful model test command-redraw shrinking stability | `diagnosis` | `sert` | 2 (2) | **0 (0)** (-100%) | 1,065 | **0** (-100%) | 1.6s (9.4s) | **0.0s** (10.4s) (-100%) | 8/8 | **8/8** |
| **T4** Diagnose zero-byte element validation in count-prefixed arrays *(holdout)* | `diagnosis` | `z` | 4 (3) | **3 (2)** (-25%) | 2,921 | **2,551** (-13%) | 4.3s (11.4s) | **2.9s** (20.2s) (-33%) | 8/8 | **8/8** |
| **T5** Blast radius of changing working-tree freshness checking | `blast-radius` | `plexer` | 6 (3) | **3 (3)** (-50%) | 6,969 | **5,647** (-19%) | 6.3s (18.9s) | 8.0s (22.0s) (+27%) | 8/8 | **8/8** |
| **T6** Blast radius of refactoring user permission flag checks | `blast-radius` | `kohls-admin` | 2 (2) | **1 (1)** (-50%) | 1,024 | **662** (-35%) | 1.5s (10.2s) | **0.4s** (10.4s) (-74%) | 6/8 | **8/8** |
| **T7** Blast radius of refactoring manual/engine frame step wiring | `blast-radius` | `flux` | 3 (3) | **2 (2)** (-33%) | 2,656 | **830** (-69%) | 4.8s (12.4s) | **2.4s** (11.7s) (-50%) | 8/8 | **8/8** |
| **T8** Blast radius of refactoring chunked transport invocation *(holdout)* | `blast-radius` | `building-tools` | 9 (3) | **1 (1)** (-89%) | 7,253 | **2,248** (-69%) | 7.8s (23.3s) | **0.7s** (16.0s) (-91%) | 8/8 | **8/8** |
| **T9** Implement multi-file `--all-matches` mode for `plexer skeleton` | `code-edit` | `plexer` | 4 (3) | 5 (3) (+25%) | 2,330 | **1,778** (-24%) | 10.6s (18.3s) | 11.6s (22.0s) (+10%) | 8/8 | **8/8** |
| **T10** Implement `Store.clear(proxy)` and re-export on `Flux.Store.clear` | `code-edit` | `flux` | 8 (4) | **6 (2)** (-25%) | 4,391 | **1,942** (-56%) | 13.1s (18.9s) | **7.3s** (18.6s) (-44%) | 8/8 | **8/8** |
| **T11** Add `delay` and `cancel` to simulator `HostHooks`, `server.host`, and `client.host` | `code-edit` | `sert` | 10 (5) | **4 (4)** (-60%) | 4,598 | **2,532** (-45%) | 17.7s (23.7s) | **16.8s** (28.5s) (-5%) | 8/8 | **8/8** |
| **T12** Implement `History.clear` and `Actions.clearHistory` *(holdout)* | `code-edit` | `building-tools` | 16 (6) | **8 (3)** (-50%) | 3,632 | **578** (-84%) | 18.4s (22.6s) | **10.1s** (22.3s) (-45%) | 8/8 | **8/8** |
| **Total (`T1`–`T12`)** | — | **6 repos** | **76 (41)** | **36 (24) (-52.6%)** | **45,198** | **19,882 (-56.0%)** | **96.7s (201.5s)** | **63.5s (212.2s) (-34.4%)** | **94/96** | **96/96** |

---

## 2. External Multi-Language Benchmark: `ScaleAI/SWE-bench_Pro` V2 (`S1`–`S8`)

To validate `plexer` on an external, independently authored benchmark spanning multiple languages and large open-source repositories, [`bench/run-swebench-ab.js`](run-swebench-ab.js) evaluates an 8-task stratified subset (`S1`–`S8`, 2 tasks per language across **Python**, **Go**, **JavaScript**, and **TypeScript**) from **`ScaleAI/SWE-bench_Pro` V2** across all 4 model configurations:

- **`S1` & `S2` (Python — `qutebrowser/qutebrowser`)**: WebKit `NetworkReply` Qt 5.15 `errorOccurred` signal migration (`S1`) and multi-file `KeyMode` / `EventFilter` handling (`S2`).
- **`S3` & `S4` (Go — `flipt-io/flipt`)**: Authentication cleanup service gating (`ShouldRunCleanup`) across `internal/cleanup`, `internal/cmd`, and `internal/config` (`S3`), and evaluation rollout caching (`GetEvaluationRollouts`) across `internal/storage/cache` and `internal/storage` (`S4`).
- **`S5` & `S6` (JavaScript — `NodeBB/NodeBB`)**: User email confirmation refactor across `src/middleware` and `src/user` (`S5`), and queued-post topic merging (`updateQueuedPostsTopic`) across `src/posts/queue.js` and `src/topics/merge.js` (`S6`).
- **`S7` & `S8` (TypeScript — `tutao/tutanota`)**: Desktop download manager error handling across `src/desktop/DesktopDownloadManager.ts` and `DesktopNetworkClient.ts` (`S7`), and device credential encryption facade updates across `src/api/worker/facades` and `src/misc/credentials` (`S8`).

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
| **Antigravity `argon-medium`** (`--effort medium`) | 62/64 → **61/64** (`100%` file recall) | 345 → **180 (-47.8%)** (**`8W/0T/0L`**) | 333,078 → **214,257 (-35.7%)** (**`8W/0T/0L`**) | 869.7k → **607.7k (-30.1%)** | 19.69M → **8.03M (-59.2%)** | 313,971 → **229,538 (-26.9%)** | 5,686.0s → **3,394.0s (-40.3%)** (**`8W/0T/0L`**) |
| **Claude Sonnet 5.5** (`--effort medium`) | **55/64 → 55/64** (`100%` file recall) | 65 → **34 (-47.7%)** (`5W/2T/1L`) | 19,344 → **14,262 (-26.3%)** (`6W/1T/1L`) | 125.2k → 131.5k (+5.1%) | 637.0k → **552.4k (-13.3%)** | 21,386 → **15,550 (-27.3%)** | 120.1s → **103.5s (-13.8%)** |
| **Claude Opus 5.5** (`--effort medium`) | 58/64 → **60/64 (+3.4%)** (`100%` file recall) | 39 → 47 (+20.5%) | 24,253 → **19,916 (-17.9%)** (`7W/0T/1L`) | 133.0k → 151.2k (+13.7%) | 645.6k → 909.8k (+40.9%) | 23,373 → 25,137 (+7.5%) | 193.1s → 217.4s (+12.6%) |

---

## 3. Deterministic Engine & Retrieval Benchmark (`npm run bench`)

### Methodology

[`bench/run.js`](run.js) benchmarks the `plexer` engine directly across 6 repositories (`plexer`, `kohls-admin`, `flux`, `sert`, `building-tools`, and `z`, totaling **17,172 symbols** and **31,335 graph edges**) and **24 de-leaked natural-language intent queries**:

```bash
npm run bench
# Or emit raw JSON metrics:
node bench/run.js --json
```

### Results Across 6 Repositories (24 De-Leaked Intent Queries)

- **Retrieval Accuracy**: **91.7% Recall@1 (22/24)** · **100.0% Recall@3 (24/24)** · **100.0% Recall@5 (24/24)** · **0.951 MRR**

| Repository | Graph Size (Nodes / Edges) | `wiring.json` | `check` | `ask --source` Latency & Tokens (vs Raw Files) | `callers` (`d=2`) | `skeleton` | `map` |
| :--- | ---: | ---: | ---: | :--- | ---: | ---: | ---: |
| **`plexer`** (JS/TS) | 1,028 / 3,189 | 804 KB | 18.0ms | **9.1ms** / 1,398 tok (**-85%** vs 9,084 raw) | **0.33ms** | **0.20ms** | 1.73ms |
| **`kohls-admin`** (Luau) | 5,878 / 8,176 | 3,630 KB | 109.1ms | **18.8ms** / 1,077 tok (**-86%** vs 7,473 raw) | **3.14ms** | **0.29ms** | 11.54ms |
| **`flux`** (Luau) | 1,183 / 1,962 | 665 KB | 16.0ms | **15.9ms** / 1,013 tok (**-97%** vs 30,646 raw) | **0.68ms** | **0.30ms** | 1.70ms |
| **`sert`** (Luau + Py) | 2,039 / 3,877 | 1,309 KB | 26.5ms | **9.5ms** / 1,238 tok (**-96%** vs 28,010 raw) | **1.98ms** | **0.11ms** | 1.71ms |
| **`building-tools`** (Luau) | 1,807 / 4,537 | 1,320 KB | 24.8ms | **7.5ms** / 1,471 tok (**-72%** vs 5,306 raw) | **1.00ms** | **0.06ms** | 1.71ms |
| **`z`** (Luau + Rust + Py) | 5,237 / 9,594 | 3,604 KB | 66.9ms | **30.2ms** / 1,435 tok (**-92%** vs 18,701 raw) | **1.39ms** | **0.32ms** | 8.55ms |
