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
};
const WARM_REPO_PREFIX = {
    opus: { cold: 6583, plexer: 7210 },
    sonnet: { cold: 6710, plexer: 7337 },
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
        t1CacheWrite: 0,
        t1CacheRead: 0,
        finalContext: fallbackRow?.finalContextTokens || 0,
        ms: fallbackRow?.totalMs || 0,
        searchMs: fallbackRow?.searchMs || 0,
    };
    if (path && existsSync(path)) {
        const seenMsg = new Set();
        let reqIdx = 0;
        for (const line of readFileSync(path, "utf8").split("\n")) {
            if (!line) continue;
            let j;
            try {
                j = JSON.parse(line);
            } catch {
                continue;
            }
            if (j.type === "assistant") {
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
                    if (reqIdx === 1) {
                        m.t1CacheWrite = inp + cw;
                        m.t1CacheRead = cr;
                    }
                    m.input += inp;
                    m.cacheWrite += cw;
                    m.cacheRead += cr;
                    m.output += u.output_tokens || 0;
                    m.finalContext = inp + cw + cr;
                }
            } else if (j.type === "result") {
                m.ms = j.duration_ms || m.ms;
                const u = j.usage || {};
                // The result event carries authoritative session totals; prefer them.
                m.input = u.input_tokens ?? m.input;
                m.cacheWrite = u.cache_creation_input_tokens ?? m.cacheWrite;
                m.cacheRead = u.cache_read_input_tokens ?? m.cacheRead;
                m.output = u.output_tokens ?? m.output;
            }
        }
        m.turns = Math.max(0, reqIdx - 1);
    } else if (fallbackRow) {
        m.calls = fallbackRow.calls || 0;
        m.input = fallbackRow.uncachedInputTokens || 0;
        m.cacheWrite = fallbackRow.finalContextTokens || 0;
        m.cacheRead = Math.max(0, (fallbackRow.cachedInputTokens || 0) - (fallbackRow.finalContextTokens || 0));
        m.output = fallbackRow.totalModelOutputTokens || 0;
    }
    m.uncached = m.input + m.cacheWrite;
    const warmPrefix = WARM_REPO_PREFIX[model]?.[arm] ?? WARM_REPO_PREFIX[model]?.cold ?? 6600;
    m.warmUncached = m.finalContext > 0 ? Math.max(0, m.finalContext - warmPrefix + 2 * (m.turns + 1)) : m.uncached;
    m.postT1Uncached = Math.max(0, m.uncached - m.t1CacheWrite);
    m.cumIn = m.input + m.cacheWrite + m.cacheRead;
    m.cost = m.input + 1.25 * m.cacheWrite + 0.1 * m.cacheRead + 5 * m.output;
    return m;
}

function run3ArmSummary() {
    const pct = (a, b) => `${(((b - a) / a) * 100).toFixed(1)}%`;
    const files = [
        ["Claude Code Opus (S1–S8)", "results-swebench-opus.json", "results-swebench-opus-trail.json"],
        ["Claude Code Sonnet (S1–S8)", "results-swebench-sonnet.json", "results-swebench-sonnet-trail.json"],
        ["AGY Opus (T4,T5,T9)", "results-opus-agy.json", null],
        ["AGY Sonnet (T4,T5,T9)", "results-sonnet-agy.json", null],
        ["AGY Argon (T4,T5,T9)", "results-argon-medium.json", null],
        ["AGY Opus (S1–S8)", "results-swebench-opus-agy.json", null],
        ["AGY Sonnet (S1–S8)", "results-swebench-sonnet-agy.json", null],
        ["AGY Argon (S1–S8)", "results-swebench-argon-medium.json", null],
    ];
    console.log("3-Arm Head-to-Head Summary (Cold vs Trail vs plexer across shared tasks)\n");
    console.log("| Suite | Tasks | Cold Uncached | Trail Uncached | plexer Uncached | plexer vs Cold | plexer vs Trail | Cold Cumul | Trail Cumul | plexer Cumul | Cold Calls | Trail Calls | plexer Calls |");
    console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    const tot = {
        n: 0,
        cold: { unc: 0, cum: 0, calls: 0 },
        trail: { unc: 0, cum: 0, calls: 0 },
        plexer: { unc: 0, cum: 0, calls: 0 },
    };
    for (const [label, f, trailFile] of files) {
        const p = resolve(import.meta.dirname, f);
        if (!existsSync(p)) continue;
        const j = JSON.parse(readFileSync(p, "utf8"));
        const trailMap = new Map();
        if (trailFile) {
            const tp = resolve(import.meta.dirname, trailFile);
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
        const cUnc = sumArm("cold", uncOf);
        const tUnc = sumArm("trail", uncOf);
        const pUnc = sumArm("plexer", uncOf);
        const cCum = sumArm("cold", (x) => x.cumulativeInputTokens || 0);
        const tCum = sumArm("trail", (x) => x.cumulativeInputTokens || 0);
        const pCum = sumArm("plexer", (x) => x.cumulativeInputTokens || 0);
        const cCalls = sumArm("cold", (x) => x.calls || 0);
        const tCalls = sumArm("trail", (x) => x.calls || 0);
        const pCalls = sumArm("plexer", (x) => x.calls || 0);
        tot.n += shared.length;
        tot.cold.unc += cUnc; tot.cold.cum += cCum; tot.cold.calls += cCalls;
        tot.trail.unc += tUnc; tot.trail.cum += tCum; tot.trail.calls += tCalls;
        tot.plexer.unc += pUnc; tot.plexer.cum += pCum; tot.plexer.calls += pCalls;
        const fmtK = (v) => `${(v / shared.length / 1000).toFixed(1)}k`;
        const fmtM = (v) => `${(v / shared.length / 1000).toFixed(0)}k`;
        const fmtC = (v) => (v / shared.length).toFixed(1);
        console.log(
            `| ${label} | ${shared.length} | ${fmtK(cUnc)} | ${fmtK(tUnc)} | ${fmtK(pUnc)} | ${pct(cUnc, pUnc)} | ${pct(tUnc, pUnc)} | ${fmtM(cCum)} | ${fmtM(tCum)} | ${fmtM(pCum)} | ${fmtC(cCalls)} | ${fmtC(tCalls)} | ${fmtC(pCalls)} |`
        );
    }
    if (tot.n > 0) {
        const fmtT = (v) => `${(v / 1000).toFixed(0)}k`;
        console.log(
            `| **TOTAL (${tot.n} tasks/arm)** | **${tot.n}** | **${fmtT(tot.cold.unc)}** | **${fmtT(tot.trail.unc)}** | **${fmtT(tot.plexer.unc)}** | **${pct(tot.cold.unc, tot.plexer.unc)}** | **${pct(tot.trail.unc, tot.plexer.unc)}** | **${fmtT(tot.cold.cum)}** | **${fmtT(tot.trail.cum)}** | **${fmtT(tot.plexer.cum)}** | **${tot.cold.calls}** | **${tot.trail.calls}** | **${tot.plexer.calls}** |`
        );
    }
}

function main() {
    if (suiteArg === "3arm") {
        run3ArmSummary();
        return;
    }
    const s = SUITES[suiteArg];
    if (!s) throw new Error(`unknown suite ${suiteArg}`);
    const pct = (a, b) => `${(((b - a) / a) * 100).toFixed(0)}%`;
    console.log(`Trail-comparable means per task — suite=${suiteArg} (${s.ids[0]}–${s.ids.at(-1)})\n`);
    console.log("| Model | Metric (mean/task) | Cold | plexer | Δ |");
    console.log("|---|---|---:|---:|---:|");
    const convMap = getClaudeProjectTranscripts();
    for (const model of ["opus", "sonnet"]) {
        const resPath = resolve(import.meta.dirname, `${s.resPrefix}${model}.json`);
        const resJson = existsSync(resPath) ? JSON.parse(readFileSync(resPath, "utf8")) : { tasks: [] };
        const byId = new Map((resJson.tasks || []).map((t) => [t.id, t]));
        const acc = { cold: [], plexer: [] };
        for (const id of s.ids) {
            const taskRow = byId.get(id);
            for (const arm of ["cold", "plexer"]) {
                const armRow = taskRow?.[arm] || null;
                const tmpPath = `${s.dir}/${model}/${id}-${arm}.jsonl`;
                const projPath = armRow?.conversationId ? convMap.get(armRow.conversationId) : null;
                const p = projPath && existsSync(projPath) ? projPath : existsSync(tmpPath) ? tmpPath : null;
                if (p || armRow) acc[arm].push(parseRun(p, armRow, model, arm));
            }
        }
        const n = Math.min(acc.cold.length, acc.plexer.length);
        if (!n) continue;
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
            console.log(`| ${model} | ${label} | ${fmt(c)} | ${fmt(p)} | ${pct(c, p)} |`);
        }
    }
}

main();
