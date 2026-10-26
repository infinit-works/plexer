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
 * Usage: node bench/trail-table.js [--suite qa|edit|all|swe]
 *   qa   = T1–T8 (questions, the closest match to Trail's sweep)   [default]
 *   edit = T9–T12, swe = S1–S8, all = T1–T12
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

export function parseRun(path, fallbackRow = null) {
    const m = {
        calls: 0,
        input: 0,
        cacheWrite: 0,
        cacheRead: 0,
        output: 0,
        ms: fallbackRow?.totalMs || 0,
        searchMs: fallbackRow?.searchMs || 0,
    };
    if (path && existsSync(path)) {
        const seenMsg = new Set();
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
                    m.input += u.input_tokens || 0;
                    m.cacheWrite += u.cache_creation_input_tokens || 0;
                    m.cacheRead += u.cache_read_input_tokens || 0;
                    m.output += u.output_tokens || 0;
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
    } else if (fallbackRow) {
        m.calls = fallbackRow.calls || 0;
        m.input = fallbackRow.uncachedInputTokens || 0;
        m.cacheWrite = fallbackRow.finalContextTokens || 0;
        m.cacheRead = Math.max(0, (fallbackRow.cachedInputTokens || 0) - (fallbackRow.finalContextTokens || 0));
        m.output = fallbackRow.totalModelOutputTokens || 0;
    }
    m.uncached = m.input + m.cacheWrite;
    m.cumIn = m.input + m.cacheWrite + m.cacheRead;
    m.cost = m.input + 1.25 * m.cacheWrite + 0.1 * m.cacheRead + 5 * m.output;
    return m;
}

function main() {
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
                if (p || armRow) acc[arm].push(parseRun(p, armRow));
            }
        }
        const n = Math.min(acc.cold.length, acc.plexer.length);
        if (!n) continue;
        const mean = (arr, k) => arr.slice(0, n).reduce((a, x) => a + x[k], 0) / n;
        const rows = [
            ["Tool calls", "calls", (v) => v.toFixed(1)],
            ["Uncached input tokens (input + cache_write)", "uncached", (v) => Math.round(v).toLocaleString("en-US")],
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
