#!/usr/bin/env node
/**
 * Tier 1 Instant Offline Deterministic Evaluator (`bench/eval-fast.js`, <1s, $0 API cost).
 *
 * Evaluates `SKILL.md` + `queryPromptContext` + `relevantRetrieval` across all 20
 * benchmark tasks (`T1`–`T12` and `S1`–`S8`) using cached indexed repositories.
 *
 * Reports:
 *  1. Calibrated Turn-0 BPE token budget (`skillTokens + orientTokens + hookTokens`)
 *     calibrated against Claude Code's actual `cache_creation_input_tokens` delta.
 *  2. Ground-truth file & symbol/span coverage in Turn-0 output (`0-call` readiness on
 *     diagnosis/caller tasks and `all-targets-localized` readiness on edit tasks).
 *  3. Predicted cumulative input tokens across multi-turn sessions (`T0_delta * turns`).
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HOOK_BUDGETS, queryPromptContext } from "../src/claude/hooks.js";
import { GEMINI_HOOK_BUDGETS, isNarrowPrompt } from "../src/hosts/engine/prompt/budget.js";
import { formatOrientation, relevantRetrieval } from "../src/claude/format.js";
import { fitAgyEphemeral } from "../src/hosts/engine/agy-context.js";
import { loadGraphCached } from "../src/context/graph-store.js";
import { contextDirFor } from "../src/util/paths.js";
import { TASKS } from "./tasks.js";
import { LARGE_TASKS } from "./large-tasks.js";
import { needCoverage } from "./needcov.js";
import { dot, fitFamily, loadRows, ols, predict } from "./cost-model.js";
import { ensureAbBaseRepos, ensureSwebenchBaseRepos } from "./ensure-base.js";

const SWEBENCH_TASKS = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "swebench/tasks.json"), "utf8")
);

/**
 * Ground-truth target files and required tokens/symbols for T1–T12 so we can
 * verify offline whether Turn-0 context alone covers the task's required spans.
 */
const T_ORACLE = {
    T1: {
        files: ["src/Shared/Auth.luau"],
        tokens: ["_KRolesLoaded", "Can't target loading user", "fromRank", "groupEntryRanks", "isPublicRole", "60"],
        expectedTurns: 1,
    },
    T2: {
        files: ["src/Graph.luau"],
        tokens: ["selfWritten", "requeue", "reruns", "32", "100", "runaway", "disposeOne"],
        expectedTurns: 1,
    },
    T3: {
        files: ["src/model.luau", "src/prop.luau"],
        tokens: ["mark", "hint", "redraw", "pre"],
        expectedTurns: 1,
    },
    T4: {
        files: ["compiler/src/resolve.rs"],
        tokens: ["max_wire_size", "has_guard", "Tuple", "Array", "Struct", "Union"],
        expectedTurns: 1,
    },
    T5: {
        files: ["src/graph/refresh.js", "bin/plexer.js", "src/mcp/tools.js"],
        tokens: ["probeDrift", "ensureFreshGraph", "refreshBefore", "callTool"],
        expectedTurns: 2,
    },
    T6: {
        files: ["src/Shared/Auth.luau"],
        tokens: ["hasPermission", "hasAccess", "creatorId", "default", "banasync", "targetothers", "settings", "serverlogs"],
        expectedTurns: 1,
    },
    T7: {
        files: ["src/init.luau", "src/Clock.luau", "src/Motion.luau"],
        tokens: ["RunService", "setFrame", "runFrame", "frameHook", "onRender", "onStep"],
        expectedTurns: 2,
    },
    T8: {
        files: ["src/Client/State/History.luau", "src/Client/Tools/Shared/Properties.luau", "src/Client/Systems/Actions.luau"],
        tokens: ["invokeChunked", "apply", "deleteSelection", "cloneSelection"],
        expectedTurns: 2,
    },
    T9: {
        files: ["src/ask/ask.js", "bin/plexer.js"],
        tokens: ["skeleton", "formatSkeleton", "allMatches", "--all-matches"],
        expectedTurns: 4,
    },
    T10: {
        files: ["src/Store.luau", "src/init.luau"],
        tokens: ["move", "reconcile", "Destroy", "Store"],
        expectedTurns: 3,
    },
    T11: {
        files: ["src/sim/scheduler.luau", "src/sim/coop.luau", "src/sim/world.luau"],
        tokens: ["HostHooks", "host", "after", "cancel", "coop", "server.host", "client.host"],
        expectedTurns: 4,
    },
    T12: {
        files: ["src/Client/State/History.luau", "src/Client/Systems/Actions.luau"],
        tokens: ["Store", "atTail", "busy", "Actions", "record"],
        expectedTurns: 3,
    },
};

function estimateBpeTokens(text, isCodeHeavy = false) {
    if (!text) return 0;
    // Calibrated against Claude Code BPE usage:
    // Prose / markdown (`SKILL.md`) averages ~3.3 chars/token.
    // `<n>:` numbered code blocks + pointers average ~2.05 chars/token.
    return Math.ceil(Buffer.byteLength(text, "utf8") / (isCodeHeavy ? 2.05 : 3.3));
}

function extractPatchSymbols(patchText) {
    const syms = new Set();
    for (const line of (patchText || "").split("\n")) {
        const hh = line.match(/^@@[^@]+@@\s*(.+)$/);
        if (hh) {
            const m = hh[1].match(/(?:function|def|func|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (m) syms.add(m[1]);
        }
        if (/^[+-]/.test(line) && !/^[+-]{3}/.test(line)) {
            const m = line.match(
                /(?:function\s+|def\s+|func\s+(?:\([^)]+\)\s*)?|export\s+(?:async\s+)?function\s+|\.\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\(/
            );
            if (m && m[1].length > 2) syms.add(m[1]);
        }
    }
    return [...syms];
}

const skillRaw = readFileSync(resolve(import.meta.dirname, "../SKILL.md"), "utf8");
const skillBody = skillRaw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
const skillTokens = estimateBpeTokens(skillBody, false);
const agyRuleBody = readFileSync(resolve(import.meta.dirname, "../rules/AGENTS.md"), "utf8").trim();
const agyRuleTokens = estimateBpeTokens(agyRuleBody, false);

console.log(`SKILL.md body: ${Buffer.byteLength(skillBody, "utf8")}B (~${skillTokens} BPE tok) | rules/AGENTS.md: ${Buffer.byteLength(agyRuleBody, "utf8")}B (~${agyRuleTokens} BPE tok)\n`);

// `--set qaMergedBytes=8000,editMaxInlined=3` overrides hook budgets for sweeps;
// `--set-gemini ...` overrides Gemini hook budgets; `--quiet` suppresses per-task rows.
const setIdx = process.argv.indexOf("--set");
if (setIdx >= 0) {
    for (const kv of (process.argv[setIdx + 1] || "").split(",")) {
        const [k, v] = kv.split("=");
        if (!(k in HOOK_BUDGETS)) throw new Error(`unknown budget ${k}`);
        HOOK_BUDGETS[k] = Number(v);
    }
    console.log(`budgets: ${JSON.stringify(HOOK_BUDGETS)}`);
}
const setGemIdx = process.argv.indexOf("--set-gemini");
if (setGemIdx >= 0) {
    for (const kv of (process.argv[setGemIdx + 1] || "").split(",")) {
        const [k, v] = kv.split("=");
        if (!(k in GEMINI_HOOK_BUDGETS)) throw new Error(`unknown gemini budget ${k}`);
        GEMINI_HOOK_BUDGETS[k] = Number(v);
    }
    console.log(`gemini budgets: ${JSON.stringify(GEMINI_HOOK_BUDGETS)}`);
}
if (process.argv.includes("--quiet")) {
    const orig = console.log;
    console.log = (...a) => {
        const s = String(a[0] ?? "");
        if (/^(TOTAL|NeedCov|GEMINI_NeedCov|SCORE|GEMINI_SCORE|ORCH_SCORE|opus|sonnet|neon-medium|hydrogen-medium|carbon-medium|orch-neon-high-hydrogen-high|orch-neon-high-hydrogen-xhigh|orch-neon-xhigh-hydrogen-xhigh|\s+plexer|budgets|gemini budgets|calibrated)/.test(s)) orig(...a);
    };
}

const NEEDED_PATH = resolve(import.meta.dirname, "needed-spans.json");
const NEEDED = existsSync(NEEDED_PATH) ? JSON.parse(readFileSync(NEEDED_PATH, "utf8")).tasks : {};
const TURN_MODEL_PATH = resolve(import.meta.dirname, "turn-model.json");
const CALIBRATE = process.argv.includes("--calibrate") || process.argv.includes("--recalibrate-spans");
const FIXTURES_ONLY = process.argv.includes("--fixtures-only");
const TURN_MODEL = existsSync(TURN_MODEL_PATH) && !CALIBRATE ? JSON.parse(readFileSync(TURN_MODEL_PATH, "utf8")) : {};
const V2_HOLDOUT_PATH = resolve(import.meta.dirname, "v2-holdout.json");
const V2_HOLDOUT_IDS = existsSync(V2_HOLDOUT_PATH)
    ? new Set(JSON.parse(readFileSync(V2_HOLDOUT_PATH, "utf8")).v2HoldoutTaskIds || [])
    : new Set();
const HOLDOUT = new Set([...TASKS.filter((t) => t.holdout).map((t) => t.id), ...V2_HOLDOUT_IDS]);
/** Per-task offline features, filled by `evalSuite` and consumed by `predictLive`. */
const FEATURES = new Map();
const GEMINI_FEATURES = new Map();
const FAST_GEMINI_FEATURES = new Map();
const XHIGH_GEMINI_FEATURES = new Map();

function recordFeatures(id, suite, ctx, g, _t0DeltaTok, hookTok, isEdit) {
    const t0DeltaTok = ctx ? skillTokens + hookTok : 0;
    const nc = needCoverage(ctx, g, NEEDED[id]);
    FEATURES.set(id, { id, suite, t0DeltaTok, hookTok, isEdit, ...nc });
    return nc;
}

function recordGeminiFeatures(id, suite, repoDir, promptStr, g, _orientTok, isEdit) {
    const narrowPrompt = isNarrowPrompt(promptStr);
    const computeProfile = (extraOpts) => {
        const opts = { geminiProfile: true, narrowPrompt, ...extraOpts };
        const askGem = queryPromptContext(repoDir, promptStr, opts);
        const cap = (opts.fastProfile || opts.narrowPrompt) ? 3 : 4;
        const rawGem = askGem ? relevantRetrieval(askGem, {}, cap, { ...opts, prompt: promptStr }) || "" : "";
        const ctxGem = fitAgyEphemeral(rawGem, 12000);
        const matched = Boolean(ctxGem);
        const hookTokGem = estimateBpeTokens(ctxGem, true);
        const t0DeltaTokGem = matched ? (agyRuleTokens + hookTokGem) : 0;
        const ncGem = needCoverage(ctxGem, g, NEEDED[id]);
        return { id, suite, t0DeltaTok: t0DeltaTokGem, hookTok: hookTokGem, isEdit, ...ncGem };
    };
    const gemFeat = computeProfile({});
    const fastFeat = computeProfile({ fastProfile: true });
    const xhighFeat = computeProfile({ xhighProfile: true });
    GEMINI_FEATURES.set(id, gemFeat);
    FAST_GEMINI_FEATURES.set(id, fastFeat);
    XHIGH_GEMINI_FEATURES.set(id, xhighFeat);
    return gemFeat;
}

function evaluateFamilies(rows, families, featuresMap, scoreLabel) {
    const feat = (r) => (typeof featuresMap === "function" ? featuresMap(r) : featuresMap.get(r.id));
    const turnX = (f) => [1, 1 - f.needCov, 1 - f.locCov, f.isEdit ? 1 : 0];
    const summary = [];
    for (const family of families) {
        const R = rows.filter((r) => r.family === family && feat(r));
        if (!R.length) continue;
        const cost = fitFamily(R, (r) => (r.arm === "plexer" ? feat(r).t0DeltaTok : 0));
        const P = R.filter((r) => r.arm === "plexer");
        const train = P.filter((r) => !HOLDOUT.has(r.id));
        let tc = TURN_MODEL[family];
        if (!tc || CALIBRATE) {
            tc = ols(train.map((r) => turnX(feat(r))), train.map((r) => r.turns), 0.5);
            if (tc[1] < 0) {
                const c3 = ols(train.map((r) => { const f = feat(r); return [1, 1 - f.locCov, f.isEdit ? 1 : 0]; }), train.map((r) => r.turns), 0.5);
                tc = [c3[0], 0, Math.max(0, c3[1]), c3[2]];
            } else if (tc[2] < 0) {
                const c3 = ols(train.map((r) => { const f = feat(r); return [1, 1 - f.needCov, f.isEdit ? 1 : 0]; }), train.map((r) => r.turns), 0.5);
                tc = [c3[0], Math.max(0, c3[1]), 0, c3[2]];
            }
            TURN_MODEL[family] = tc;
        }
        const err = (set) => set.reduce((a, r) => a + Math.abs(Math.max(0, dot(tc, turnX(feat(r)))) - r.turns), 0) / Math.max(1, set.length);
        const hold = P.filter((r) => HOLDOUT.has(r.id));
        let est = { turns: 0, wallMs: 0, cumIn: 0, uncIn: 0, cost: 0, usd: 0 };
        let live = { turns: 0, wallMs: 0, cumIn: 0, uncIn: 0, cost: 0, usd: 0 };
        for (const r of P) {
            const f = feat(r);
            const turns = Math.max(0, dot(tc, turnX(f)));
            const p = predict(cost, turns, f.t0DeltaTok);
            est.turns += turns;
            est.wallMs += p.wallMs;
            est.cumIn += p.cumIn;
            est.uncIn += p.uncIn;
            est.cost += p.cost;
            est.usd += p.usd;
            live.turns += r.turns;
            live.wallMs += r.ms;
            live.cumIn += r.cum;
            live.uncIn += r.unc;
            live.cost += r.cost;
            live.usd += r.usd;
        }
        const C = R.filter((r) => r.arm === "cold");
        const coldMs = C.reduce((a, r) => a + r.ms, 0);
        const coldCum = C.reduce((a, r) => a + r.cum, 0);
        const coldUnc = C.reduce((a, r) => a + r.unc, 0);
        const coldCost = C.reduce((a, r) => a + r.cost, 0);
        const coldUsd = C.reduce((a, r) => a + r.usd, 0);
        if (process.argv.includes("--coef")) console.log(`${family} cum coef ${JSON.stringify(cost.cum.c.map((v) => +v.toFixed(3)))} unc coef ${JSON.stringify(cost.unc.c.map((v) => +v.toFixed(3)))}`);
        console.log(
            `${family.padEnd(15)} turn-model [${tc.map((v) => v.toFixed(2)).join(", ")}] MAE train=${err(train).toFixed(2)} holdout=${err(hold).toFixed(2)} | ` +
                `wall R²=${cost.wall.r2.toFixed(2)} cum R²=${cost.cum.r2.toFixed(2)} unc R²=${cost.unc.r2.toFixed(2)}`
        );
        console.log(
            `  plexer EstTurns=${est.turns.toFixed(1)} (live-at-record ${live.turns}) | EstUsd=$${est.usd.toFixed(2)} (live $${live.usd.toFixed(2)}, cold $${coldUsd.toFixed(2)} → ${pct(coldUsd, est.usd)}) | ` +
                `EstWall=${(est.wallMs / 1000).toFixed(1)}s (live ${(live.wallMs / 1000).toFixed(1)}s, cold ${(coldMs / 1000).toFixed(1)}s → ${pct(coldMs, est.wallMs)}) | ` +
                `EstUncached=${(est.uncIn / 1000).toFixed(0)}k (live ${(live.uncIn / 1000).toFixed(0)}k, cold ${(coldUnc / 1000).toFixed(0)}k → ${pct(coldUnc, est.uncIn)}) | ` +
                `EstCost=${(est.cost / 1000).toFixed(0)}k (live ${(live.cost / 1000).toFixed(0)}k, cold ${(coldCost / 1000).toFixed(0)}k → ${pct(coldCost, est.cost)}) | ` +
                `EstCum=${(est.cumIn / 1000).toFixed(0)}k (live ${(live.cumIn / 1000).toFixed(0)}k, cold ${(coldCum / 1000).toFixed(0)}k → ${pct(coldCum, est.cumIn)})`
        );
        summary.push({ family, est, coldMs, coldCum, coldUnc, coldCost, coldUsd });
    }
    if (summary.length) {
        const u$ = summary.reduce((a, s) => a + s.est.usd, 0);
        const cu$ = summary.reduce((a, s) => a + s.coldUsd, 0);
        const w = summary.reduce((a, s) => a + s.est.wallMs, 0);
        const cw = summary.reduce((a, s) => a + s.coldMs, 0);
        const u = summary.reduce((a, s) => a + s.est.uncIn, 0);
        const cu = summary.reduce((a, s) => a + s.coldUnc, 0);
        const k = summary.reduce((a, s) => a + s.est.cost, 0);
        const ck = summary.reduce((a, s) => a + s.coldCost, 0);
        const c = summary.reduce((a, s) => a + s.est.cumIn, 0);
        const cc = summary.reduce((a, s) => a + s.coldCum, 0);
        const label = scoreLabel.padEnd(13);
        console.log(
            `${label} EstUsd vs cold ${pct(cu$, u$)} | EstWall vs cold ${pct(cw, w)} | EstUncached vs cold ${pct(cu, u)} | EstCost vs cold ${pct(ck, k)} | EstCum vs cold ${pct(cc, c)}  (lower is better; gate: must not regress)`
        );
    }
}

/**
 * Calibrate predicted plexer-arm turns from NeedCov against the recorded live runs,
 * then convert to wall time / cumulative input with the per-family cost model.
 * Fit on non-holdout tasks only; holdout error is reported separately.
 */
function predictLive() {
    const rows = loadRows();
    if (!rows.length || !FEATURES.size) return;
    console.log("\n=== Live-calibrated predictions (cost model + NeedCov turn model) ===");
    evaluateFamilies(rows, ["opus", "sonnet"], FEATURES, "SCORE");
    if (GEMINI_FEATURES.size) {
        evaluateFamilies(rows, ["neon-medium", "carbon-medium", "hydrogen-medium"], (r) => (r.family === "hydrogen-medium" ? FAST_GEMINI_FEATURES : GEMINI_FEATURES).get(r.id), "GEMINI_SCORE");
        evaluateFamilies(
            rows,
            ["orch-neon-high-hydrogen-high", "orch-neon-high-hydrogen-xhigh", "orch-neon-xhigh-hydrogen-xhigh"],
            (r) => (r.family === "orch-neon-xhigh-hydrogen-xhigh" ? XHIGH_GEMINI_FEATURES : GEMINI_FEATURES).get(r.id),
            "ORCH_SCORE",
        );
    }
    if (CALIBRATE) {
        writeFileSync(TURN_MODEL_PATH, JSON.stringify({ calibrated: new Date().toISOString(), features: "[1, 1-needCov, 1-locCov, isEdit]", ...TURN_MODEL }, null, 1) + "\n");
        console.log(`calibrated turn model → ${TURN_MODEL_PATH}`);
    }
}

const pct = (base, v) => `${(((v - base) / base) * 100).toFixed(1)}%`;

function needCols(nc) {
    return `${(nc.needCov * 100).toFixed(0).padStart(3)}% | ${(nc.locCov * 100).toFixed(0).padStart(3)}%`;
}

function evalSuite() {
    const t0Start = performance.now();
    console.log("=== Suite 1: T1–T12 (Diagnosis, Caller Blast-Radius, & Code Edits) ===");
    console.log("Task | Cat       | HookB  | T0DeltaTok | FileRec | TokCov  | Need | Loc  | EstTurns | EstT0CumTax | HitPointers");

    let tHookBytesSum = 0;
    let t0DeltaSum = 0;
    let tFileRecSum = 0;
    let tTokCovSum = 0;
    let tEstTaxSum = 0;
    let tCount = 0;

    for (const t of TASKS) {
        const repoDir = existsSync(`/tmp/plexer-ab-base/indexed/${t.repo}`)
            ? `/tmp/plexer-ab-base/indexed/${t.repo}`
            : `/tmp/plexer-ab-opus-plexer/${t.repo}`;
        if (!existsSync(repoDir)) continue;
        tCount++;
        const g = loadGraphCached(contextDirFor(repoDir));
        const orient = g ? formatOrientation(g) : "";
        const promptStr = t.prompt(repoDir);
        const askObj = queryPromptContext(repoDir, promptStr);
        const ctx = askObj ? relevantRetrieval(askObj, {}) || "" : "";
        const hookBytes = Buffer.byteLength(ctx, "utf8");
        const orientTok = estimateBpeTokens(orient, false);
        const hookTok = estimateBpeTokens(ctx, true);
        const t0DeltaTok = skillTokens + orientTok + hookTok;

        const oracle = T_ORACLE[t.id];
        const hitFiles = new Set((askObj?.hits || []).map((h) => (h.pointer || "").split(":")[0]));
        const matchedFiles = oracle.files.filter((f) => hitFiles.has(f) || ctx.includes(f));
        const fileRec = matchedFiles.length / oracle.files.length;
        const matchedToks = oracle.tokens.filter((tk) => ctx.toLowerCase().includes(tk.toLowerCase()));
        const tokCov = matchedToks.length / oracle.tokens.length;

        const nc = recordFeatures(t.id, "T", ctx, g, t0DeltaTok, hookTok, t.category === "code-edit");
        recordGeminiFeatures(t.id, "T", repoDir, promptStr, g, orientTok, t.category === "code-edit");
        const missingPenaltyTurns = (1 - fileRec) * 2 + (1 - tokCov) * 1.5;
        const estTurns = Math.max(1, Math.round(oracle.expectedTurns + missingPenaltyTurns));
        const estTax = t0DeltaTok * estTurns;

        tHookBytesSum += hookBytes;
        t0DeltaSum += t0DeltaTok;
        tFileRecSum += fileRec;
        tTokCovSum += tokCov;
        tEstTaxSum += estTax;

        const ptrs = (askObj?.hits || [])
            .map((h) => `${h.pointer}${h.code ? `[${Buffer.byteLength(h.code, "utf8")}B]` : ""}`)
            .join(", ");
        console.log(
            `${t.id.padEnd(4)} | ${t.category.slice(0, 9).padEnd(9)} | ${String(hookBytes).padStart(5)}B | ` +
                `+${String(t0DeltaTok).padStart(5)} tok | ${`${matchedFiles.length}/${oracle.files.length}`.padStart(7)} | ` +
                `${`${matchedToks.length}/${oracle.tokens.length}`.padStart(7)} | ${needCols(nc)} | ${String(estTurns).padStart(8)} | ` +
                `+${(estTax / 1000).toFixed(1).padStart(6)}k | ${ptrs}`
        );
    }

    if (tCount > 0) {
        console.log(
            `TOTAL T1-T12: Hook=${(tHookBytesSum / 1000).toFixed(1)}kB | AvgT0Delta=+${Math.round(t0DeltaSum / tCount)} tok | ` +
                `AvgFileRec=${((tFileRecSum / tCount) * 100).toFixed(1)}% | AvgTokCov=${((tTokCovSum / tCount) * 100).toFixed(1)}% | ` +
                `TotalEstT0CumTax=+${(tEstTaxSum / 1000).toFixed(1)}k tok\n`
        );
    }

    console.log("=== Suite 2: SWE-bench Pro S1–S8 (Multi-File Python, Go, JS, TS Edits) ===");
    console.log("Task | Lang       | HookB  | T0DeltaTok | GoldFileRec | SymCov  | Need | Loc  | EstTurns | EstT0CumTax | HitPointers");

    let sHookBytesSum = 0;
    let s0DeltaSum = 0;
    let sFileRecSum = 0;
    let sSymCovSum = 0;
    let sEstTaxSum = 0;
    let sCount = 0;

    for (const t of SWEBENCH_TASKS) {
        const repoDir = `/tmp/plexer-swebench-base/indexed/${t.id}`;
        if (!existsSync(repoDir)) continue;
        sCount++;
        const g = loadGraphCached(contextDirFor(repoDir));
        const orient = g ? formatOrientation(g) : "";
        const instr = t.instruction_md.replace(/\/app\b/g, repoDir).replace(/\/testbed\b/g, repoDir).trim();
        const promptStr = [`Working directory: ${repoDir}`, "", instr].join("\n");
        const askObj = queryPromptContext(repoDir, promptStr);
        const ctx = askObj ? relevantRetrieval(askObj, {}) || "" : "";
        const hookBytes = Buffer.byteLength(ctx, "utf8");
        const orientTok = estimateBpeTokens(orient, false);
        const hookTok = estimateBpeTokens(ctx, true);
        const t0DeltaTok = skillTokens + orientTok + hookTok;

        const GOLD_OVERRIDE = {
            S1: ["qutebrowser/browser/webkit/network/networkreply.py"],
            S4: ["internal/storage/cache/cache.go", "internal/storage/storage.go"],
            S6: ["src/posts/queue.js", "src/topics/merge.js"],
        };
        const goldFiles = (GOLD_OVERRIDE[t.id] || t.gold_files || []).filter(
            (f) => !/test/i.test(f) && !f.startsWith("changelogs/") && !f.endsWith(".md") && !f.endsWith(".yml")
        );
        const hitFiles = new Set((askObj?.hits || []).map((h) => (h.pointer || "").split(":")[0]));
        const matchedGold = goldFiles.filter((f) => hitFiles.has(f) || ctx.includes(f));
        const fileRec = goldFiles.length ? matchedGold.length / goldFiles.length : 1;

        const patchSyms = extractPatchSymbols(t.patch);
        const matchedSyms = patchSyms.filter((s) => ctx.includes(s));
        const symCov = patchSyms.length ? matchedSyms.length / patchSyms.length : 1;

        const nc = recordFeatures(t.id, "S", ctx, g, t0DeltaTok, hookTok, true);
        recordGeminiFeatures(t.id, "S", repoDir, promptStr, g, orientTok, true);
        const baseTurns = Math.max(2, goldFiles.length);
        const missingPenalty = (1 - fileRec) * 3 + (1 - symCov) * 1.5;
        const estTurns = Math.round(baseTurns + missingPenalty);
        const estTax = t0DeltaTok * estTurns;

        sHookBytesSum += hookBytes;
        s0DeltaSum += t0DeltaTok;
        sFileRecSum += fileRec;
        sSymCovSum += symCov;
        sEstTaxSum += estTax;

        const ptrs = (askObj?.hits || [])
            .map((h) => `${h.pointer}${h.code ? `[${Buffer.byteLength(h.code, "utf8")}B]` : ""}`)
            .join(", ");
        console.log(
            `${t.id.padEnd(4)} | ${t.repo_language.slice(0, 10).padEnd(10)} | ${String(hookBytes).padStart(5)}B | ` +
                `+${String(t0DeltaTok).padStart(5)} tok | ${`${matchedGold.length}/${goldFiles.length}`.padStart(11)} | ` +
                `${`${matchedSyms.length}/${patchSyms.length}`.padStart(7)} | ${needCols(nc)} | ${String(estTurns).padStart(8)} | ` +
                `+${(estTax / 1000).toFixed(1).padStart(6)}k | ${ptrs}`
        );
    }

    if (sCount > 0) {
        console.log(
            `TOTAL S1-S8 : Hook=${(sHookBytesSum / 1000).toFixed(1)}kB | AvgT0Delta=+${Math.round(s0DeltaSum / sCount)} tok | ` +
                `AvgGoldFileRec=${((sFileRecSum / sCount) * 100).toFixed(1)}% | AvgSymCov=${((sSymCovSum / sCount) * 100).toFixed(1)}% | ` +
                `TotalEstT0CumTax=+${(sEstTaxSum / 1000).toFixed(1)}k tok\n`
        );
    }

    console.log("=== Suite 3: Large-Repo & Discriminative Suite L1–L8 (Go, TS, Python, JS) ===");
    console.log("Task | Lang (Size)     | HookB  | T0DeltaTok | GoldFileRec | TokCov  | Need | Loc  | EstTurns | EstT0CumTax | HitPointers");

    let lHookBytesSum = 0;
    let l0DeltaSum = 0;
    let lFileRecSum = 0;
    let lTokCovSum = 0;
    let lEstTaxSum = 0;
    let lCount = 0;

    for (const t of LARGE_TASKS) {
        const repoDir = `/tmp/plexer-swebench-base/indexed/${t.baseId}`;
        if (!existsSync(repoDir)) continue;
        lCount++;
        const g = loadGraphCached(contextDirFor(repoDir));
        const orient = g ? formatOrientation(g) : "";
        const promptStr = t.prompt(repoDir);
        const askObj = queryPromptContext(repoDir, promptStr);
        const ctx = askObj ? relevantRetrieval(askObj, {}) || "" : "";
        const hookBytes = Buffer.byteLength(ctx, "utf8");
        const orientTok = estimateBpeTokens(orient, false);
        const hookTok = estimateBpeTokens(ctx, true);
        const t0DeltaTok = skillTokens + orientTok + hookTok;

        const goldFiles = t.goldFiles || [];
        const hitFiles = new Set((askObj?.hits || []).map((h) => (h.pointer || "").split(":")[0]));
        const matchedGold = goldFiles.filter((f) => hitFiles.has(f) || ctx.includes(f));
        const fileRec = goldFiles.length ? matchedGold.length / goldFiles.length : 1;

        const oracleTokens = t.oracleTokens || [];
        const matchedToks = oracleTokens.filter((tk) => ctx.toLowerCase().includes(tk.toLowerCase()));
        const tokCov = oracleTokens.length ? matchedToks.length / oracleTokens.length : 1;

        const nc = recordFeatures(t.id, "L", ctx, g, t0DeltaTok, hookTok, t.category === "code-edit");
        recordGeminiFeatures(t.id, "L", repoDir, promptStr, g, orientTok, t.category === "code-edit");
        const missingPenalty = (1 - fileRec) * 2.5 + (1 - tokCov) * 1.5;
        const estTurns = Math.max(1, Math.round((t.expectedTurns || 2) + missingPenalty));
        const estTax = t0DeltaTok * estTurns;

        lHookBytesSum += hookBytes;
        l0DeltaSum += t0DeltaTok;
        lFileRecSum += fileRec;
        lTokCovSum += tokCov;
        lEstTaxSum += estTax;

        const ptrs = (askObj?.hits || [])
            .map((h) => `${h.pointer}${h.code ? `[${Buffer.byteLength(h.code, "utf8")}B]` : ""}`)
            .join(", ");
        const langSize = `${t.language.slice(0, 6)} (${t.sizeBucket[0].toUpperCase()}:${t.repoFiles})`.padEnd(15);
        console.log(
            `${t.id.padEnd(4)} | ${langSize} | ${String(hookBytes).padStart(5)}B | ` +
                `+${String(t0DeltaTok).padStart(5)} tok | ${`${matchedGold.length}/${goldFiles.length}`.padStart(11)} | ` +
                `${`${matchedToks.length}/${oracleTokens.length}`.padStart(7)} | ${needCols(nc)} | ${String(estTurns).padStart(8)} | ` +
                `+${(estTax / 1000).toFixed(1).padStart(6)}k | ${ptrs}`
        );
    }

    if (lCount > 0) {
        console.log(
            `TOTAL L1-L8 : Hook=${(lHookBytesSum / 1000).toFixed(1)}kB | AvgT0Delta=+${Math.round(l0DeltaSum / lCount)} tok | ` +
                `AvgGoldFileRec=${((lFileRecSum / lCount) * 100).toFixed(1)}% | AvgTokCov=${((lTokCovSum / lCount) * 100).toFixed(1)}% | ` +
                `TotalEstT0CumTax=+${(lEstTaxSum / 1000).toFixed(1)}k tok`
        );
    }

    const elapsedMs = Math.round(performance.now() - t0Start);
    console.log(`\nCompleted ${tCount + sCount + lCount}-task offline evaluation in ${elapsedMs}ms ($0 API cost).`);
    const missingTotal = (TASKS.length - tCount) + (SWEBENCH_TASKS.length - sCount) + (LARGE_TASKS.length - lCount);
    if (missingTotal > 0) {
        console.log(
            `Base repo status: T=${tCount}/${TASKS.length}, S=${sCount}/${SWEBENCH_TASKS.length}, L=${lCount}/${LARGE_TASKS.length} present ` +
                `(${missingTotal} missing — run \`node bench/eval-fast.js --ensure-base\` or \`node bench/eval-fast.js --fixtures-only\`).`
        );
    }
}

async function evalFixturesOnly() {
    const t0Start = performance.now();
    const { buildGraph } = await import("../src/graph/build.js");
    const fixtures = [
        { name: "ts-service", query: "how are JSON web token signatures verified with key rotation", gold: "src/auth/token-verifier.ts" },
        { name: "py-worker", query: "how are scheduled cron tasks ordered by priority heap", gold: "worker/scheduler.py" },
        { name: "go-engine", query: "how are write ahead log records framed and validated", gold: "internal/wal/segment.go" },
        { name: "luau-reactive", query: "how do reactive signals and effects propagate updates", gold: "src/Graph.luau" },
        { name: "rust-compiler", query: "where are schema type references checked for cycles", gold: "src/resolve.rs" },
        { name: "docs-polyglot", query: "how are dependency cycles detected in health checks", gold: "cli/health.js" },
    ];
    console.log("=== Fixtures-Only Offline Turn-0 Evaluation (zero repo leakage) ===");
    const scratch = mkdtempSync(join(tmpdir(), "plexer-eval-fx-"));
    let hits = 0;
    let tokSum = 0;
    try {
        for (const fx of fixtures) {
            const srcDir = resolve(import.meta.dirname, "fixtures", fx.name);
            if (!existsSync(srcDir)) continue;
            const isoDir = join(scratch, fx.name);
            cpSync(srcDir, isoDir, { recursive: true });
            await buildGraph(isoDir, { graphOnly: true, force: true });
            const askObj = queryPromptContext(isoDir, fx.query);
            const ctx = askObj ? relevantRetrieval(askObj, {}) || "" : "";
            const tok = estimateBpeTokens(ctx, true);
            tokSum += tok;
            const hitPtrs = (askObj?.hits || []).map((h) => String(h.pointer || ""));
            const candPtrs = (askObj?.candidateMap || []).map((c) => String(c.pointer || c.path || ""));
            const matched =
                hitPtrs.some((p) => p.includes(fx.gold)) ||
                candPtrs.some((p) => p.includes(fx.gold)) ||
                ctx.includes(fx.gold);
            if (matched) hits += 1;
            console.log(`${fx.name.padEnd(14)} | T0Hook=${String(tok).padStart(4)} tok | GoldMatch=${matched ? "PASS" : "MISS"} | ${fx.gold}`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
    const ms = Math.round(performance.now() - t0Start);
    console.log(`Fixtures summary: ${hits}/${fixtures.length} gold hits | AvgHook=${Math.round(tokSum / Math.max(1, fixtures.length))} tok | ${ms}ms ($0 API cost).`);
}

if (FIXTURES_ONLY) {
    await evalFixturesOnly();
    process.exit(0);
}

if (process.argv.includes("--ensure-base") || process.argv.includes("--reindex")) {
    const reindex = process.argv.includes("--reindex");
    const abRepos = new Set(TASKS.map((t) => t.repo));
    const sweIds = new Set([...SWEBENCH_TASKS.map((t) => t.id), ...LARGE_TASKS.map((t) => t.baseId)]);
    await ensureAbBaseRepos(abRepos, reindex ? { reindex: true } : {});
    await ensureSwebenchBaseRepos(sweIds, reindex ? { reindex: true } : {});
}

evalSuite();
const avgOf = (map, suite, k) => {
    const xs = [...map.values()].filter((f) => f.suite === suite);
    return xs.reduce((a, f) => a + f[k], 0) / Math.max(1, xs.length);
};
const holdAvgOf = (map, k) => {
    const hold = [...map.values()].filter((f) => HOLDOUT.has(f.id));
    return hold.reduce((a, f) => a + f[k], 0) / Math.max(1, hold.length);
};
console.log(
    `NeedCov  T=${(avgOf(FEATURES, "T", "needCov") * 100).toFixed(1)}% S=${(avgOf(FEATURES, "S", "needCov") * 100).toFixed(1)}% L=${(avgOf(FEATURES, "L", "needCov") * 100).toFixed(1)}% holdout=${(holdAvgOf(FEATURES, "needCov") * 100).toFixed(1)}% | ` +
        `LocCov T=${(avgOf(FEATURES, "T", "locCov") * 100).toFixed(1)}% S=${(avgOf(FEATURES, "S", "locCov") * 100).toFixed(1)}% L=${(avgOf(FEATURES, "L", "locCov") * 100).toFixed(1)}% holdout=${(holdAvgOf(FEATURES, "locCov") * 100).toFixed(1)}%`
);
console.log(
    `GEMINI_NeedCov T=${(avgOf(GEMINI_FEATURES, "T", "needCov") * 100).toFixed(1)}% S=${(avgOf(GEMINI_FEATURES, "S", "needCov") * 100).toFixed(1)}% L=${(avgOf(GEMINI_FEATURES, "L", "needCov") * 100).toFixed(1)}% holdout=${(holdAvgOf(GEMINI_FEATURES, "needCov") * 100).toFixed(1)}% | ` +
        `GEMINI_LocCov T=${(avgOf(GEMINI_FEATURES, "T", "locCov") * 100).toFixed(1)}% S=${(avgOf(GEMINI_FEATURES, "S", "locCov") * 100).toFixed(1)}% L=${(avgOf(GEMINI_FEATURES, "L", "locCov") * 100).toFixed(1)}% holdout=${(holdAvgOf(GEMINI_FEATURES, "locCov") * 100).toFixed(1)}%`
);
if (process.argv.includes("--missing")) {
    for (const f of FEATURES.values()) {
        const top = f.missing.slice(0, 5).map((m) => `${m.id}(w${m.w},${m.lines}L,${Math.round(m.frac * 100)}%${m.pointed ? ",ptr" : ""})`);
        if (top.length) console.log(`  ${f.id.padEnd(4)} missing: ${top.join("  ")}`);
    }
}
predictLive();
