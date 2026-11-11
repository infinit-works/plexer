#!/usr/bin/env node
/**
 * Residual-read replay (`bench/replay.js`, $0, offline).
 *
 * Mines the recorded Claude Code transcripts of past live A/B runs for the source
 * spans an agent actually had to read or locate to finish each task, and writes
 * them to `bench/needed-spans.json` — a committed fixture, so offline evaluation
 * keeps working after `/tmp` is cleared.
 *
 * Usage:
 *   node bench/replay.js [--arms cold|cold,plexer] [--out bench/needed-spans.json]
 *
 * What counts as a "need" (per task, weighted by how many distinct runs needed it):
 *  - `reads`:      ranged reads — `sed -n A,Bp F`, `nl … F | sed -n A,Bp`, `head/tail -n N F`,
 *                  `awk 'NR>=A && NR<=B' F`, and the `Read` tool with `offset`/`limit`.
 *  - `wholeFiles`: unranged reads — `cat F`, `Read F` without a range.
 *  - `hits`:       grep-style `path:line:` (or single-file `line:`) hits in tool results;
 *                  these are *location* needs (the agent wanted to know where, not read).
 *  - `gold`:       for SWE-bench tasks, the hunks of the maintainers' gold patch (edit targets).
 *
 * Defaults to the **cold** arm only so the fixture describes what a task needs, not what
 * a particular plexer hook version failed to deliver. Test files are excluded: the hook
 * deliberately doesn't inline tests.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const argv = process.argv.slice(2);
const argVal = (name, dflt) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const DEFAULT_SPANS = resolve(import.meta.dirname, "needed-spans.json");
const ARMS = new Set(argVal("--arms", "cold").split(","));
const OUT = resolve(argVal("--out", DEFAULT_SPANS));

export const LOG_ROOTS = [
    { dir: "/tmp/plexer-claude-logs", suite: "T" },
    { dir: "/tmp/plexer-swebench-logs", suite: "S" },
    { dir: "/tmp/plexer-large-logs", suite: "L" },
];

export const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__|testdata|fixtures)\/|[._-](test|spec)\.[a-z]+$|_test\.go$/i;
const SRC_EXT = /\.(luau|lua|js|mjs|cjs|ts|tsx|jsx|py|go|rs|rb|java|kt|c|cc|cpp|h|hpp|cs|php|swift)$/i;

/** Strip the per-run worktree prefix so paths are repo-relative. */
export function normPath(p, cwd) {
    if (!p) return null;
    let s = String(p).replace(/^['"]|['"]$/g, "");
    if (cwd && s.startsWith(cwd + "/")) s = s.slice(cwd.length + 1);
    s = s.replace(/^\/tmp\/plexer-(?:ab|swebench|large)-[^/]+\/[^/]+\//, "").replace(/^\/(?:app|testbed)\//, "");
    s = s.replace(/^\.\//, "");
    if (s.startsWith("/") || s.includes("*") || s.includes("$")) return null;
    return SRC_EXT.test(s) ? s : null;
}

/** Minimal shell word splitter: honours single/double quotes and backslashes. */
function words(seg) {
    const out = [];
    let cur = "";
    let q = null;
    let has = false;
    for (let i = 0; i < seg.length; i++) {
        const c = seg[i];
        if (q) {
            if (c === q) q = null;
            else if (c === "\\" && q === '"' && i + 1 < seg.length) cur += seg[++i];
            else cur += c;
        } else if (c === "'" || c === '"') {
            q = c;
            has = true;
        } else if (/\s/.test(c)) {
            if (cur || has) out.push(cur);
            cur = "";
            has = false;
        } else if (c === "\\" && i + 1 < seg.length) cur += seg[++i];
        else cur += c;
    }
    if (cur || has) out.push(cur);
    return out;
}

/** Split a Bash command into pipelines (by `;`, `&&`, `||`, newline), each a list of stages. */
function pipelines(cmd) {
    // Drop heredoc bodies (python edits etc.) — they are writes, not reads.
    const noHeredoc = cmd.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, "");
    return noHeredoc
        .split(/\n|;|&&|\|\|/)
        .map((p) => p.split(/\|/).map((s) => words(s.trim())).filter((w) => w.length));
}

/** Parse ranged/unranged reads out of one Bash command. Returns [{file, a, b}] (a/b null = whole). */
export function readsFromBash(cmd, cwd) {
    const out = [];
    const sedRange = (expr) => {
        const m = /^(\d+)(?:,(\d+))?p$/.exec(expr || "");
        return m ? [Number(m[1]), Number(m[2] || m[1])] : null;
    };
    for (const stages of pipelines(cmd)) {
        const first = stages[0];
        if (!first) continue;
        const prog = first[0];
        const rest = first.slice(1);
        const files = rest.filter((w) => !w.startsWith("-")).map((w) => normPath(w, cwd)).filter(Boolean);
        if (prog === "sed") {
            const ni = rest.indexOf("-n");
            const r = ni >= 0 ? sedRange(rest[ni + 1]) : null;
            if (r) for (const f of files) out.push({ file: f, a: r[0], b: r[1] });
        } else if ((prog === "cat" || prog === "nl") && stages.length > 1 && stages[1][0] === "sed") {
            const s = stages[1];
            const ni = s.indexOf("-n");
            const r = ni >= 0 ? sedRange(s[ni + 1]) : null;
            if (r) for (const f of files) out.push({ file: f, a: r[0], b: r[1] });
        } else if (prog === "cat" || prog === "nl" || prog === "less") {
            for (const f of files) out.push({ file: f, a: null, b: null });
        } else if (prog === "head" || prog === "tail") {
            let n = 10;
            for (let i = 0; i < rest.length; i++) {
                const m = /^-(?:n)?(\d+)$/.exec(rest[i]);
                if (m) n = Number(m[1]);
                else if (rest[i] === "-n" && /^\d+$/.test(rest[i + 1] || "")) n = Number(rest[i + 1]);
            }
            const fs = rest.filter((w, i) => !w.startsWith("-") && !(rest[i - 1] === "-n")).map((w) => normPath(w, cwd)).filter(Boolean);
            // tail's absolute range is unknown without the file length; record head only.
            if (prog === "head") for (const f of fs) out.push({ file: f, a: 1, b: n });
        } else if (prog === "awk") {
            const expr = rest.find((w) => /NR\s*>=?\s*\d+/.test(w));
            const m = expr && /NR\s*>=?\s*(\d+)\s*&&\s*NR\s*<=?\s*(\d+)/.exec(expr);
            if (m) for (const f of files) out.push({ file: f, a: Number(m[1]), b: Number(m[2]) });
        }
    }
    return out;
}

/** grep-style `path:line:` hits (or `line:` for a single-file grep) in a tool result. */
export function hitsFromResult(text, cwd, singleFile) {
    const out = [];
    for (const line of String(text || "").split("\n")) {
        let m = /^(\S+?\.[A-Za-z]+)[:-](\d+)[:-]/.exec(line);
        if (m) {
            const f = normPath(m[1], cwd);
            if (f) {
                out.push({ file: f, line: Number(m[2]) });
                continue;
            }
        }
        if (singleFile && (m = /^(\d+)[:-]/.exec(line))) out.push({ file: singleFile, line: Number(m[1]) });
    }
    return out;
}

function singleGrepFile(cmd, cwd) {
    for (const stages of pipelines(cmd)) {
        const w = stages[0];
        if (!w || (w[0] !== "grep" && w[0] !== "rg")) continue;
        if (w.some((x) => /^-\w*r/.test(x))) continue;
        const files = w.slice(1).filter((x) => !x.startsWith("-")).slice(1).map((x) => normPath(x, cwd)).filter(Boolean);
        if (files.length === 1) return files[0];
    }
    return null;
}

/** Extract one run's needs from a stream-json transcript. */
export function needsFromTranscript(path) {
    const reads = [];
    const whole = new Set();
    const hits = [];
    let cwd = null;
    const pending = new Map(); // tool_use_id -> singleFile hint
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line) continue;
        let j;
        try {
            j = JSON.parse(line);
        } catch {
            continue;
        }
        if (j.type === "system" && j.subtype === "init") cwd = j.cwd;
        if (j.type === "assistant") {
            for (const c of j.message?.content || []) {
                if (c.type !== "tool_use") continue;
                const inp = c.input || {};
                if (c.name === "Bash" && inp.command) {
                    for (const r of readsFromBash(inp.command, cwd)) (r.a == null ? whole.add(r.file) : reads.push(r));
                    pending.set(c.id, singleGrepFile(inp.command, cwd));
                } else if (c.name === "Read" && inp.file_path) {
                    const f = normPath(inp.file_path, cwd);
                    if (!f) continue;
                    if (inp.offset || inp.limit) {
                        const a = Number(inp.offset || 1);
                        reads.push({ file: f, a, b: a + Number(inp.limit || 2000) - 1 });
                    } else whole.add(f);
                } else if (c.name === "Grep") {
                    pending.set(c.id, inp.path ? normPath(inp.path, cwd) : null);
                }
            }
        } else if (j.type === "user") {
            for (const c of j.message?.content || []) {
                if (c.type !== "tool_result" || !pending.has(c.tool_use_id)) continue;
                const t = typeof c.content === "string" ? c.content : (c.content || []).map((x) => x.text || "").join("\n");
                hits.push(...hitsFromResult(t, cwd, pending.get(c.tool_use_id)));
            }
        }
    }
    const keep = (f) => !TEST_PATH.test(f);
    return {
        reads: reads.filter((r) => keep(r.file) && r.b >= r.a && r.b - r.a < 2000),
        whole: [...whole].filter(keep),
        hits: hits.filter((h) => keep(h.file)),
    };
}

/** Gold patch hunks → old-file line ranges per file (edit targets). */
export function goldRanges(patch) {
    const out = [];
    let file = null;
    for (const line of String(patch || "").split("\n")) {
        const fm = /^--- a\/(.+)$/.exec(line);
        if (fm) {
            file = fm[1];
            continue;
        }
        const hm = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
        if (hm && file && !TEST_PATH.test(file)) {
            const a = Number(hm[1]);
            const n = Number(hm[2] ?? 1);
            out.push({ file, a, b: a + Math.max(0, n - 1) });
        }
    }
    return out;
}

function main() {
    const seedPath = existsSync(OUT) ? OUT : existsSync(DEFAULT_SPANS) ? DEFAULT_SPANS : null;
    let prevTasks = {};
    if (seedPath) {
        try {
            prevTasks = JSON.parse(readFileSync(seedPath, "utf8")).tasks || {};
        } catch {
            prevTasks = {};
        }
    }
    const fixture = { generated: new Date().toISOString(), arms: [...ARMS], tasks: {} };
    const minedTaskIds = new Set();
    const add = (id) =>
        (fixture.tasks[id] ??= { runs: [], reads: {}, wholeFiles: {}, hits: {}, gold: {} });
    for (const { dir } of LOG_ROOTS) {
        if (!existsSync(dir)) continue;
        for (const model of readdirSync(dir)) {
            const mdir = `${dir}/${model}`;
            if (!existsSync(mdir) || !/^(opus|sonnet)$/.test(model)) continue;
            for (const f of readdirSync(mdir)) {
                const m = /^([TSL]\d+)-(cold|plexer)\.jsonl$/.exec(f);
                if (!m || !ARMS.has(m[2])) continue;
                const need = needsFromTranscript(`${mdir}/${f}`);
                const t = add(m[1]);
                minedTaskIds.add(m[1]);
                const run = `${model}/${m[2]}`;
                t.runs.push(run);
                // Weight = number of distinct runs; per-run dedupe of identical ranges.
                const seen = new Set();
                for (const r of need.reads) {
                    const k = `${r.file}:${r.a}-${r.b}`;
                    if (seen.has(k)) continue;
                    seen.add(k);
                    (t.reads[r.file] ??= []).push([r.a, r.b, run]);
                }
                for (const w of need.whole) (t.wholeFiles[w] ??= []).includes(run) || t.wholeFiles[w].push(run);
                const hs = new Set();
                for (const h of need.hits) {
                    const k = `${h.file}:${h.line}`;
                    if (hs.has(k)) continue;
                    hs.add(k);
                    (t.hits[h.file] ??= []).push([h.line, run]);
                }
            }
        }
    }
    const swePath = resolve(import.meta.dirname, "swebench/tasks.json");
    if (existsSync(swePath)) {
        for (const st of JSON.parse(readFileSync(swePath, "utf8"))) {
            const t = add(st.id);
            for (const g of goldRanges(st.patch)) (t.gold[g.file] ??= []).push([g.a, g.b]);
        }
    }
    // Preserve ground-truth spans from existing needed-spans.json for any suite/task whose /tmp logs aren't present.
    for (const [id, prevTask] of Object.entries(prevTasks)) {
        if (minedTaskIds.has(id)) continue;
        if (!fixture.tasks[id]) {
            fixture.tasks[id] = prevTask;
        } else {
            fixture.tasks[id] = {
                ...prevTask,
                gold: Object.keys(fixture.tasks[id].gold || {}).length
                    ? fixture.tasks[id].gold
                    : (prevTask.gold || {}),
            };
        }
    }
    writeFileSync(OUT, JSON.stringify(fixture, null, 1) + "\n");
    const ids = Object.keys(fixture.tasks).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const id of ids) {
        const t = fixture.tasks[id];
        const nr = Object.values(t.reads).reduce((a, x) => a + x.length, 0);
        const nh = Object.values(t.hits).reduce((a, x) => a + x.length, 0);
        console.log(
            `${id.padEnd(4)} runs=${t.runs.length} reads=${nr} wholeFiles=${Object.keys(t.wholeFiles).length} hits=${nh} goldFiles=${Object.keys(t.gold).length}`
        );
    }
    console.log(`wrote ${OUT}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
