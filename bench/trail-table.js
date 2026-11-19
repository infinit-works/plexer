#!/usr/bin/env node
/**
 * Trail-comparable summary (`bench/trail-table.js`, $0, offline).
 *
 * Re-reads the recorded Claude Code transcripts and reports per-task means in the metric
 * definitions Trail-Code's README benchmark uses, so the numbers can be put side by side:
 *  - tool calls
 *  - uncached input tokens   = Σ (input_tokens + cache_creation_input_tokens) over requests
 *                              (tokens not served from the prompt cache)
 *  - cache-aware cost units  = input·1 + cache_write·1.25 + cache_read·0.1 + output·5
 *                              (input-token equivalents; Anthropic's relative list prices)
 *  - latency                 = the CLI's `duration_ms` for the whole task
 *
 * Usage: node bench/trail-table.js [--suite qa|edit|all|swe|3arm]
 *   qa   = T1–T8 (questions, the closest match to Trail's sweep)   [default]
 *   edit = T9–T12, swe = S1–S8, all = T1–T12
 *   3arm = All 3-arm head-to-head runs (Cold vs Trail vs plexer across T4,T5,T9 + S1–S8)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const suiteArg = (process.argv.indexOf("--suite") >= 0 && process.argv[process.argv.indexOf("--suite") + 1]) || "qa";
const SUITES = {
    qa: { dir: "/tmp/plexer-claude-logs", resPrefix: "results-", ids: ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8"] },
    edit: { dir: "/tmp/plexer-claude-logs", resPrefix: "results-", ids: ["T9", "T10", "T11", "T12"] },
    all: { dir: "/tmp/plexer-claude-logs", resPrefix: "results-", ids: Array.from({ length: 12 }, (_, i) => `T${i + 1}`) },
    swe: { dir: "/tmp/plexer-swebench-logs", resPrefix: "results-swebench-", ids: Array.from({ length: 8 }, (_, i) => `S${i + 1}`) },
    large: { dir: "/tmp/plexer-large-logs", resPrefix: "results-large-", ids: Array.from({ length: 8 }, (_, i) => `L${i + 1}`) },
};
const WARM_REPO_PREFIX = {
    opus: { cold: 6583, trail: 7100, plexer: 7210 },
    sonnet: { cold: 6710, trail: 7220, plexer: 7337 },
};

let cachedConvMap = null;
function getClaudeProjectTranscripts() {
    if (cachedConvMap) return cachedConvMap;
    cachedConvMap = new Map();
    const projDir = join(homedir(), ".claude", "projects");
    if (!existsSync(projDir)) return cachedConvMap;
    for (const d of readdirSync(projDir)) {
        const dp = join(projDir, d);
        try {
            if (!statSync(dp).isDirectory()) continue;
            for (const f of readdirSync(dp)) {
                if (f.endsWith(".jsonl")) cachedConvMap.set(f.replace(/\.jsonl$/, ""), join(dp, f));
            }
        } catch {}
    }
    return cachedConvMap;
}

export function parseRun(path, fallbackRow = null, model = "opus", arm = "cold") {
    const m = {
        calls: 0,
        turns: fallbackRow?.turns || 0,
        input: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        t1CacheWrite: fallbackRow?.turn1UncachedTokens || 0,
        t1CacheRead: 0,
        t1Context: fallbackRow?.turn1ContextTokens || 0,
        postT1Uncached: fallbackRow?.postTurn1UncachedTokens || 0,
        netContextGrowth: fallbackRow?.netContextGrowthTokens || 0,
        toolOutputTokens: fallbackRow?.toolOutputTokens || 0,
        finalContext: fallbackRow?.finalContextTokens || 0,
        ms: fallbackRow?.totalMs || 0,
        searchMs: fallbackRow?.searchMs || 0,
    };
    let parsedClaudeEvents = false;
    if (path && existsSync(path)) {
        const seenMsg = new Set();
        let reqIdx = 0;
        let prevCtx = 0;
        let postT1 = 0;
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (!line) continue;
            let j;
            try {
                j = JSON.parse(line);
            } catch {
                continue;
            }
            if (j.type === "assistant") {
                parsedClaudeEvents = true;
                for (const c of j.message?.content || []) if (c.type === "tool_use") m.calls++;
                // One API request can stream as several assistant events sharing a message id.
                const id = j.message?.id;
                if (id && seenMsg.has(id)) continue;
                if (id) seenMsg.add(id);
                const u = j.message?.usage;
                if (u) {
                    reqIdx++;
                    const inp = u.input_tokens || 0;
                    const cw = u.cache_creation_input_tokens || 0;
                    const cr = u.cache_read_input_tokens || 0;
                    const stepUnc = inp + cw;
                    const stepCtx = stepUnc + cr;
                    if (reqIdx === 1) {
                        m.t1CacheWrite = stepUnc;
                        m.t1CacheRead = cr;
                        m.t1Context = stepCtx;
                    } else {
                        if (cr === 0 && prevCtx > 0 && stepUnc > prevCtx * 0.8) {
                            postT1 += Math.max(0, stepCtx - prevCtx);
                        } else {
                            postT1 += stepUnc;
                        }
                    }
                    if (stepCtx > 0) prevCtx = stepCtx;
                    m.input += inp;
                    m.cacheWrite += cw;
                    m.cacheRead += cr;
                    m.output += u.output_tokens || 0;
                    m.finalContext = stepCtx;
                }
            } else if (j.type === "result") {
                parsedClaudeEvents = true;
                m.ms = j.duration_ms || m.ms;
                const u = j.usage || {};
                // The result event carries authoritative session totals; prefer them.
                m.input = u.input_tokens ?? m.input;
                m.cacheWrite = u.cache_creation_input_tokens ?? m.cacheWrite;
                m.cacheRead = u.cache_read_input_tokens ?? m.cacheRead;
                m.output = u.output_tokens ?? m.output;
            }
        }
        if (parsedClaudeEvents) {
            m.turns = Math.max(0, reqIdx - 1);
            m.postT1Uncached = postT1;
            m.netContextGrowth = Math.max(0, m.finalContext - m.t1Context);
        }
    }
    if (!parsedClaudeEvents && fallbackRow) {
        m.calls = fallbackRow.calls ?? fallbackRow.totalToolCalls ?? 0;
        m.turns = fallbackRow.turns ?? fallbackRow.turnsCount ?? 0;
        if ((fallbackRow.uncachedInputTokens || 0) > 1000) {
            m.input = fallbackRow.uncachedInputTokens || 0;
            m.cacheWrite = 0;
            m.cacheRead = fallbackRow.cachedInputTokens || 0;
        } else {
            m.input = fallbackRow.uncachedInputTokens || 0;
            m.cacheWrite = fallbackRow.finalContextTokens || 0;
            m.cacheRead = Math.max(0, (fallbackRow.cachedInputTokens || 0) - (fallbackRow.finalContextTokens || 0));
        }
        m.output = fallbackRow.totalModelOutputTokens || 0;
    }
    m.uncached = m.input + m.cacheWrite;
    const warmPrefix = WARM_REPO_PREFIX[model]?.[arm] ?? WARM_REPO_PREFIX[model]?.cold ?? 6600;
    m.warmUncached = m.finalContext > 0 ? Math.max(0, m.finalContext - warmPrefix + 2 * (m.turns + 1)) : m.uncached;
    if (!m.postT1Uncached && m.t1CacheWrite > 0) {
        m.postT1Uncached = Math.max(0, m.uncached - m.t1CacheWrite);
    }
    m.cumIn = m.input + m.cacheWrite + m.cacheRead;
    m.cost = m.input + 1.25 * m.cacheWrite + 0.1 * m.cacheRead + 5 * m.output;
    return m;
}

export function isResolvedRow(x) {
    if (!x) return 0;
    if (typeof x.resolved === "boolean") return x.resolved ? 1 : 0;
    if (
        typeof x.fileRecall === "number" &&
        typeof x.symRecall === "number" &&
        typeof x.tokenRecall === "number"
    ) {
        return x.fileRecall === 1 &&
            x.symRecall >= 0.75 &&
            (x.dockerPassed === true || x.tokenRecall >= 0.7)
            ? 1
            : 0;
    }
    if (typeof x.fileRecall === "number") return x.fileRecall === 1 && (x.score ?? 0) >= 6 ? 1 : 0;
    return (x.score ?? 0) >= 7 ? 1 : 0;
}

function run3ArmSummary(benchDir = import.meta.dirname) {
    const pct = (a, b) => (a > 0 ? `${(((b - a) / a) * 100).toFixed(1)}%` : "0.0%");
    const files = [
        ["Claude Code Opus (S1–S8)", "results-swebench-opus.json", "results-swebench-opus-trail.json"],
        ["Claude Code Sonnet (S1–S8)", "results-swebench-sonnet.json", "results-swebench-sonnet-trail.json"],
        ["AGY Opus (T4,T5,T9)", "results-opus-agy.json", null],
        ["AGY Sonnet (T4,T5,T9)", "results-sonnet-agy.json", null],
        ["AGY Neon (T4,T5,T9)", "results-neon-medium.json", null],
        ["AGY Carbon (T4,T5,T9)", "results-carbon-medium.json", null],
        ["AGY Argon (T4,T5,T9)", "results-argon-medium.json", null],
        ["AGY Hydrogen (T4,T5,T9)", "results-hydrogen-medium.json", null],
        ["AGY Opus (S1–S8)", "results-swebench-opus-agy.json", null],
        ["AGY Sonnet (S1–S8)", "results-swebench-sonnet-agy.json", null],
        ["AGY Neon (S1–S8)", "results-swebench-neon-medium.json", null],
        ["AGY Carbon (S1–S8)", "results-swebench-carbon-medium.json", null],
        ["AGY Argon (S1–S8)", "results-swebench-argon-medium.json", null],
        ["AGY Hydrogen (S1–S8)", "results-swebench-hydrogen-medium.json", null],
        ["Claude Code Opus (L1–L8)", "results-large-opus.json", null],
        ["Claude Code Sonnet (L1–L8)", "results-large-sonnet.json", null],
        ["AGY Neon (L1–L8)", "results-large-neon-medium.json", null],
        ["AGY Carbon (L1–L8)", "results-large-carbon-medium.json", null],
        ["AGY Argon (L1–L8)", "results-large-argon-medium.json", null],
        ["AGY Hydrogen (L1–L8)", "results-large-hydrogen-medium.json", null],
    ];
    console.log("3-Arm Head-to-Head Summary (Cold vs Trail vs plexer across shared tasks)\n");
    console.log("| Suite | Tasks | Cold Raw Unc | Trail Raw Unc | plexer Raw Unc | Cold Post-T1 Unc | Trail Post-T1 Unc | plexer Post-T1 Unc | Cold Net Growth | Trail Net Growth | plexer Net Growth | Cold Cumul | Trail Cumul | plexer Cumul | Cold Calls | Trail Calls | plexer Calls | Cold Score | Trail Score | plexer Score | Cold Resolved | Trail Resolved | plexer Resolved |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const emptyTot = () => ({ unc: 0, postT1: 0, growth: 0, toolTok: 0, cum: 0, calls: 0, score: 0, maxScore: 0, resolved: 0 });
    const tot = {
        n: 0,
        cold: emptyTot(),
        trail: emptyTot(),
        plexer: emptyTot(),
    };
    const sizeBuckets = {
        "Small (<250 files)": { n: 0, cold: emptyTot(), trail: emptyTot(), plexer: emptyTot() },
        "Medium (350–750 files)": { n: 0, cold: emptyTot(), trail: emptyTot(), plexer: emptyTot() },
        "Large (700–1350+ files)": { n: 0, cold: emptyTot(), trail: emptyTot(), plexer: emptyTot() },
    };
    const taskBucketOf = (t) => {
        if (t.id?.startsWith("T")) return "Small (<250 files)";
        if (t.id === "S5" || t.id === "S6" || t.id === "S7" || t.id === "S8" || t.id === "L2" || t.id === "L6" || t.id === "L8" || (t.fileCount && t.fileCount >= 700)) {
            return "Large (700–1350+ files)";
        }
        return "Medium (350–750 files)";
    };
    for (const [label, f, trailFile] of files) {
        const p = resolve(benchDir, f);
        if (!existsSync(p)) continue;
        const j = JSON.parse(readFileSync(p, "utf8"));
        const trailMap = new Map();
        if (trailFile) {
            const tp = resolve(benchDir, trailFile);
            if (existsSync(tp)) {
                const tj = JSON.parse(readFileSync(tp, "utf8"));
                for (const t of tj.tasks || []) if (t.trail) trailMap.set(t.id, t.trail);
            }
        }
        const shared = (j.tasks || [])
            .map((t) => ({ ...t, trail: t.trail || trailMap.get(t.id) }))
            .filter((t) => t.cold && t.trail && t.plexer);
        if (!shared.length) continue;
        const sumArm = (arm, fn) => shared.reduce((a, t) => a + fn(t[arm]), 0);
        const uncOf = (x) =>
            x.uncachedInputTokens > 1000
                ? x.uncachedInputTokens
                : (x.finalContextTokens || 0) + (x.uncachedInputTokens || 0);
        const postT1Of = (x) =>
            typeof x.postTurn1UncachedTokens === "number" && x.postTurn1UncachedTokens > 0
                ? x.postTurn1UncachedTokens
                : Math.max(0, (x.finalContextTokens || 0) - (x.turn1ContextTokens || 0));
        const growthOf = (x) =>
            typeof x.netContextGrowthTokens === "number" && x.netContextGrowthTokens > 0
                ? x.netContextGrowthTokens
                : Math.max(0, (x.finalContextTokens || 0) - (x.turn1ContextTokens || 0));
        for (const arm of ["cold", "trail", "plexer"]) {
            tot[arm].unc += sumArm(arm, uncOf);
            tot[arm].postT1 += sumArm(arm, postT1Of);
            tot[arm].growth += sumArm(arm, growthOf);
            tot[arm].toolTok += sumArm(arm, (x) => x.toolOutputTokens || 0);
            tot[arm].cum += sumArm(arm, (x) => x.cumulativeInputTokens || 0);
            tot[arm].calls += sumArm(arm, (x) => x.calls || 0);
            tot[arm].score += sumArm(arm, (x) => x.score || 0);
            tot[arm].maxScore += sumArm(arm, (x) => x.maxScore || 8);
            tot[arm].resolved += sumArm(arm, isResolvedRow);
        }
        for (const t of shared) {
            const b = sizeBuckets[taskBucketOf(t)];
            b.n += 1;
            for (const arm of ["cold", "trail", "plexer"]) {
                const x = t[arm];
                b[arm].unc += uncOf(x);
                b[arm].postT1 += postT1Of(x);
                b[arm].growth += growthOf(x);
                b[arm].cum += x.cumulativeInputTokens || 0;
                b[arm].calls += x.calls || 0;
                b[arm].score += x.score || 0;
                b[arm].maxScore += x.maxScore || 8;
                b[arm].resolved += isResolvedRow(x);
            }
        }
        tot.n += shared.length;
        const fmtK = (v) => `${(v / shared.length / 1000).toFixed(1)}k`;
        const fmtM = (v) => `${(v / shared.length / 1000).toFixed(0)}k`;
        const fmtC = (v) => (v / shared.length).toFixed(1);
        const fmtS = (arm) => `${sumArm(arm, (x) => x.score || 0)}/${sumArm(arm, (x) => x.maxScore || 8)}`;
        const fmtR = (arm) => `${sumArm(arm, isResolvedRow)}/${shared.length} (${Math.round((sumArm(arm, isResolvedRow) / shared.length) * 100)}%)`;
        console.log(
            `| ${label} | ${shared.length} | ${fmtK(sumArm("cold", uncOf))} | ${fmtK(sumArm("trail", uncOf))} | ${fmtK(sumArm("plexer", uncOf))} | ${fmtK(sumArm("cold", postT1Of))} | ${fmtK(sumArm("trail", postT1Of))} | ${fmtK(sumArm("plexer", postT1Of))} | ${fmtK(sumArm("cold", growthOf))} | ${fmtK(sumArm("trail", growthOf))} | ${fmtK(sumArm("plexer", growthOf))} | ${fmtM(sumArm("cold", (x) => x.cumulativeInputTokens || 0))} | ${fmtM(sumArm("trail", (x) => x.cumulativeInputTokens || 0))} | ${fmtM(sumArm("plexer", (x) => x.cumulativeInputTokens || 0))} | ${fmtC(sumArm("cold", (x) => x.calls || 0))} | ${fmtC(sumArm("trail", (x) => x.calls || 0))} | ${fmtC(sumArm("plexer", (x) => x.calls || 0))} | ${fmtS("cold")} | ${fmtS("trail")} | ${fmtS("plexer")} | ${fmtR("cold")} | ${fmtR("trail")} | ${fmtR("plexer")} |`
        );
    }
    if (tot.n > 0) {
        const fmtT = (v) => `${(v / 1000).toFixed(0)}k`;
        const fmtTS = (arm) => `${tot[arm].score}/${tot[arm].maxScore} (${((tot[arm].score / tot[arm].maxScore) * 100).toFixed(1)}%)`;
        const fmtTR = (arm) => `${tot[arm].resolved}/${tot.n} (${((tot[arm].resolved / tot.n) * 100).toFixed(1)}%)`;
        console.log(
            `| **TOTAL (${tot.n} tasks/arm)** | **${tot.n}** | **${fmtT(tot.cold.unc)}** | **${fmtT(tot.trail.unc)} (${pct(tot.cold.unc, tot.trail.unc)})** | **${fmtT(tot.plexer.unc)} (${pct(tot.cold.unc, tot.plexer.unc)})** | **${fmtT(tot.cold.postT1)}** | **${fmtT(tot.trail.postT1)} (${pct(tot.cold.postT1, tot.trail.postT1)})** | **${fmtT(tot.plexer.postT1)} (${pct(tot.cold.postT1, tot.plexer.postT1)})** | **${fmtT(tot.cold.growth)}** | **${fmtT(tot.trail.growth)} (${pct(tot.cold.growth, tot.trail.growth)})** | **${fmtT(tot.plexer.growth)} (${pct(tot.cold.growth, tot.plexer.growth)})** | **${fmtT(tot.cold.cum)}** | **${fmtT(tot.trail.cum)} (${pct(tot.cold.cum, tot.trail.cum)})** | **${fmtT(tot.plexer.cum)} (${pct(tot.cold.cum, tot.plexer.cum)})** | **${tot.cold.calls}** | **${tot.trail.calls} (${pct(tot.cold.calls, tot.trail.calls)})** | **${tot.plexer.calls} (${pct(tot.cold.calls, tot.plexer.calls)})** | **${fmtTS("cold")}** | **${fmtTS("trail")}** | **${fmtTS("plexer")}** | **${fmtTR("cold")}** | **${fmtTR("trail")}** | **${fmtTR("plexer")}** |`
        );
        console.log("\nRepo-Size Scaling Breakdown (Cold vs Trail vs plexer):\n");
        console.log("| Repo Size Bucket | Tasks | Cold Post-T1 Unc | Trail Post-T1 Unc | plexer Post-T1 Unc | Cold Cumul | Trail Cumul | plexer Cumul | Cold Calls | Trail Calls | plexer Calls | Cold Resolved | Trail Resolved | plexer Resolved |");
        console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
        for (const [bName, b] of Object.entries(sizeBuckets)) {
            if (!b.n) continue;
            const fk = (v) => `${(v / b.n / 1000).toFixed(1)}k`;
            const fm = (v) => `${(v / b.n / 1000).toFixed(0)}k`;
            const fc = (v) => (v / b.n).toFixed(1);
            const fr = (arm) => `${b[arm].resolved}/${b.n} (${Math.round((b[arm].resolved / b.n) * 100)}%)`;
            console.log(
                `| ${bName} | ${b.n} | ${fk(b.cold.postT1)} | ${fk(b.trail.postT1)} (${pct(b.cold.postT1, b.trail.postT1)}) | ${fk(b.plexer.postT1)} (${pct(b.cold.postT1, b.plexer.postT1)}) | ${fm(b.cold.cum)} | ${fm(b.trail.cum)} (${pct(b.cold.cum, b.trail.cum)}) | ${fm(b.plexer.cum)} (${pct(b.cold.cum, b.plexer.cum)}) | ${fc(b.cold.calls)} | ${fc(b.trail.calls)} | ${fc(b.plexer.calls)} | ${fr("cold")} | ${fr("trail")} | ${fr("plexer")} |`
            );
        }
    }
}

function main() {
    const benchDirIdx = process.argv.indexOf("--bench-dir");
    const benchDir = benchDirIdx >= 0 && process.argv[benchDirIdx + 1] ? resolve(process.argv[benchDirIdx + 1]) : import.meta.dirname;
    if (suiteArg === "3arm") {
        run3ArmSummary(benchDir);
        return;
    }
    const s = SUITES[suiteArg];
    if (!s) throw new Error(`unknown suite ${suiteArg}`);
    const modelsIdx = process.argv.indexOf("--models");
    const defaultModels = ["opus", "sonnet"];
    for (const m of ["neon-medium", "carbon-medium"]) {
        const p = resolve(benchDir, `${s.resPrefix}${m}.json`);
        if (!existsSync(p)) continue;
        const cj = JSON.parse(readFileSync(p, "utf8"));
        const idsPresent = new Set((cj.tasks || []).filter((t) => t.cold && t.plexer).map((t) => t.id));
        if (s.ids.every((id) => idsPresent.has(id))) defaultModels.push(m);
    }
    const models =
        modelsIdx >= 0 && process.argv[modelsIdx + 1]
            ? process.argv[modelsIdx + 1].split(",").map((m) => m.trim()).filter(Boolean)
            : defaultModels;
    const pct = (a, b) => (a > 0 ? `${(((b - a) / a) * 100).toFixed(0)}%` : "0%");
    console.log(`Trail-comparable means per task — suite=${suiteArg} (${s.ids[0]}–${s.ids.at(-1)})\n`);
    const convMap = getClaudeProjectTranscripts();
    let headerPrinted = false;
    let tableHasTrail = false;
    for (const model of models) {
        const resPath = resolve(benchDir, `${s.resPrefix}${model}.json`);
        const resJson = existsSync(resPath) ? JSON.parse(readFileSync(resPath, "utf8")) : { tasks: [] };
        const byId = new Map((resJson.tasks || []).map((t) => [t.id, t]));
        const acc = { cold: [], trail: [], plexer: [] };
        for (const id of s.ids) {
            const taskRow = byId.get(id);
            for (const arm of ["cold", "trail", "plexer"]) {
                const armRow = taskRow?.[arm] || null;
                const tmpPath = `${s.dir}/${model}/${id}-${arm}.jsonl`;
                const projPath = armRow?.conversationId ? convMap.get(armRow.conversationId) : null;
                const p = projPath && existsSync(projPath) ? projPath : existsSync(tmpPath) ? tmpPath : null;
                if (p || armRow) acc[arm].push(parseRun(p, armRow, model, arm));
            }
        }
        const n = Math.min(acc.cold.length, acc.plexer.length);
        if (!n) continue;
        const hasTrail = acc.trail.length === n;
        if (!headerPrinted) {
            tableHasTrail = hasTrail;
            if (tableHasTrail) {
                console.log("| Model | Metric (mean/task) | Cold | Trail | plexer | Δ vs Cold | Δ vs Trail |");
                console.log("|---|---|---:|---:|---:|---:|---:|");
            } else {
                console.log("| Model | Metric (mean/task) | Cold | plexer | Δ |");
                console.log("|---|---|---:|---:|---:|");
            }
            headerPrinted = true;
        }
        const mean = (arr, k) => arr.slice(0, n).reduce((a, x) => a + x[k], 0) / n;
        const rows = [
            ["Tool calls", "calls", (v) => v.toFixed(1)],
            ["Uncached input tokens (raw worktree)", "uncached", (v) => Math.round(v).toLocaleString("en-US")],
            ["Uncached input tokens (warm repo cache)", "warmUncached", (v) => Math.round(v).toLocaleString("en-US")],
            ["Post-Turn-1 exploration uncached tokens", "postT1Uncached", (v) => Math.round(v).toLocaleString("en-US")],
            ["Cumulative input tokens (all turns)", "cumIn", (v) => Math.round(v).toLocaleString("en-US")],
            ["Cache-aware cost (input-tok equiv.)", "cost", (v) => Math.round(v).toLocaleString("en-US")],
            ["Search wall time (s)", "searchMs", (v) => (v / 1000).toFixed(1)],
            ["Total latency (s)", "ms", (v) => (v / 1000).toFixed(1)],
        ];
        for (const [label, k, fmt] of rows) {
            const c = mean(acc.cold, k);
            const p = mean(acc.plexer, k);
            if (tableHasTrail) {
                if (hasTrail) {
                    const tr = mean(acc.trail, k);
                    console.log(`| ${model} | ${label} | ${fmt(c)} | ${fmt(tr)} | ${fmt(p)} | ${pct(c, p)} | ${pct(tr, p)} |`);
                } else {
                    console.log(`| ${model} | ${label} | ${fmt(c)} | — | ${fmt(p)} | ${pct(c, p)} | — |`);
                }
            } else {
                console.log(`| ${model} | ${label} | ${fmt(c)} | ${fmt(p)} | ${pct(c, p)} |`);
            }
        }
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    main();
}
