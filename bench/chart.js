#!/usr/bin/env node
/**
 * Renders self-contained, dual-theme (light/dark) SVG benchmark charts using the
 * visual grammar, Oklch color system, and layout geometry of
 * https://github.com/kohltastrophe/luau-reactivity-benchmark:
 *   - `bench/chart-small.svg` (+ `assets/chart-small.svg`) — hero overall geomean + headline suite rows for `README.md`
 *   - `bench/chart.svg`       — full multi-suite & per-model breakdown for `bench/README.md`
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeApiCostUsd } from "./cost-model.js";
import { bootstrapPairedPctDeltaCI } from "./stats.js";

const IN_GHA = "GITHUB_ACTIONS" in process.env;
const BG_STYLE = IN_GHA ? ".bg{fill:#0000}" : ".bg{fill:#fff}";
const BG_DARK_STYLE = IN_GHA ? "" : ".bg{fill:#0d1117}";

// ---- geometry (matches luau-reactivity-benchmark/chart.py) ----------------------
const W = 960;
const M_T = IN_GHA ? 0 : 24;
const M_L = IN_GHA ? 0 : 24;
const M_R = IN_GHA ? 8 : 24;
const GUTTER = 188;
const X0 = M_L + GUTTER; // 212
const X1 = W - M_R; // 936
const PLOT_W = X1 - X0; // 724

const MAX_REL = 10.0; // x-axis cap (bars beyond this fade out and show their true value)
const TICKS = [1, 2, 4, 6, 8, 10];

const BAR_H = 14;
const BAR_GAP = 4;
const GROUP_PAD = 9;
const SUITE_HEAD = 30;
const HERO_BAR_H = 22;
const HERO_GAP = 7;

const STYLE =
    "<style>" +
    "text{font-family:'Inter','Segoe UI',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}" +
    ".mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}" +
    BG_STYLE +
    ".tt{fill:#11181c}.tm{fill:#697177}.tl{fill:#3a4248}.tw{fill:#fff}" +
    ".grid{stroke:#e6e9ed;stroke-width:1;stroke-dasharray:2 4}" +
    ".gridkey{stroke:#c3cbd2;stroke-width:1}" +
    ".zebra{fill:#11181c;opacity:.022}" +
    ".b{font-weight:700}.b6{font-weight:600}" +
    ".e{text-anchor:end}.m{text-anchor:middle}" +
    ".o9{opacity:.9}.o7{opacity:.72}" +
    ".lnk{text-decoration:none;text-decoration-thickness:.6px;}" +
    ".lnk:hover{fill:#11181c}" +
    ".s95{font-size:9.5px}.s93{font-size:9.3px}.s85{font-size:8.5px}" +
    ".s83{font-size:8.3px}.s11{font-size:11px}.s13{font-size:13px}" +
    ".s125{font-size:12.5px}" +
    "@media (prefers-color-scheme:dark){" +
    ".tt{fill:#e6edf3}.tm{fill:#8b949e}.tl{fill:#c3cbd6}" +
    ".grid{stroke:#21262d}.gridkey{stroke:#3a434d}" +
    ".lnk:hover{fill:#e6edf3}" +
    ".zebra{fill:#fff;opacity:.025}" +
    BG_DARK_STYLE +
    "}" +
    "</style>";

const DEFS =
    "<defs>" +
    STYLE +
    '<linearGradient id="capgrad" x1="0" y1="0" x2="1" y2="0">' +
    '<stop offset="0" stop-color="#fff"/>' +
    '<stop offset="0.86" stop-color="#fff"/>' +
    '<stop offset="1" stop-color="#fff" stop-opacity="0.18"/>' +
    "</linearGradient>" +
    '<mask id="capfade" maskContentUnits="objectBoundingBox">' +
    '<rect width="1" height="1" fill="url(#capgrad)"/></mask>' +
    "</defs>";

function oklchToHex(L, C, H) {
    const h = (H * Math.PI) / 180;
    const a = C * Math.cos(h);
    const b = C * Math.sin(h);

    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const l = l_ ** 3;
    const m = m_ ** 3;
    const s = s_ ** 3;

    const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

    const toSrgb = (u) => {
        const c = Math.max(0.0, Math.min(1.0, u));
        const v = c > 0.0031308 ? 1.055 * c ** (1 / 2.4) - 0.055 : 12.92 * c;
        return Math.round(Math.max(0.0, Math.min(1.0, v)) * 255)
            .toString(16)
            .padStart(2, "0")
            .toUpperCase();
    };
    return `#${toSrgb(r)}${toSrgb(g)}${toSrgb(bl)}`;
}

function rainbow(n, L = 0.6, C = 0.2) {
    return Array.from({ length: n }, (_, i) => oklchToHex(L, C, 360 * (i / n)));
}

const ARMS = ["plexer", "cold"];
const COLORS = {
    plexer: oklchToHex(0.6, 0.2, 0),
    cold: oklchToHex(0.6, 0.2, 240),
};

const PKG_VERSION = (() => {
    try {
        return JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).version || "2.0.0";
    } catch {
        return "2.0.0";
    }
})();

const ARM_META = {
    plexer: { scope: "@plexer/", name: "cli", ver: PKG_VERSION, link: "https://www.npmjs.com/package/@plexer/cli" },
    cold: { scope: null, name: "cold baseline", ver: "no index", link: null },
};

function esc(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function xrel(v) {
    return X0 + (Math.min(v, MAX_REL) / MAX_REL) * PLOT_W;
}

function fmtMult(v) {
    return v < 10 ? `${v.toFixed(1)}×` : `${Math.round(v)}×`;
}

function fmtTick(t) {
    return Number.isInteger(t) ? `${t}×` : `${t.toFixed(1)}×`;
}

function documentSvg(body, h) {
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" ` +
        `viewBox="0 0 ${W} ${h}" role="img" ` +
        `aria-label="plexer benchmark results, lower is better">` +
        DEFS +
        `<rect x="0" y="0" width="${W}" height="${h}" class="bg"/>` +
        body +
        "</svg>\n"
    );
}

// ---- dynamic benchmark suite aggregation ---------------------------------------

function readJsonIfExists(dir, file) {
    const p = resolve(dir, file);
    if (!existsSync(p)) return null;
    try {
        return JSON.parse(readFileSync(p, "utf8"));
    } catch {
        return null;
    }
}

function fmtTok(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M tok`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k tok`;
    return `${Math.round(n).toLocaleString("en-US")} tok`;
}

function fmtCumShort(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M cum`;
    return `${Math.round(n / 1e3)}k cum`;
}

function fmtSec(ms) {
    const s = ms / 1000;
    return s >= 100 ? `${Math.round(s).toLocaleString("en-US")}s` : `${s.toFixed(1)}s`;
}

function fmtUsd(usd) {
    if (!(usd > 0)) return "$0.00";
    return usd < 0.01 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}

function rowApiCostUsd(row, arm, fallbackModel) {
    const x = row?.[arm];
    if (!x) return 0;
    if (typeof x.apiCostUsd === "number") return x.apiCostUsd;
    return computeApiCostUsd(x, row?._pricingModel || fallbackModel || "claude-sonnet-5-5").totalUsd;
}

function pctCiLabel(rows, fn) {
    if (!rows.length) return "";
    const coldVals = rows.map((r) => fn(r, "cold"));
    const plexerVals = rows.map((r) => fn(r, "plexer"));
    const ci = bootstrapPairedPctDeltaCI(coldVals, plexerVals, { iterations: 1000 });
    return `[${ci.ciLow >= 0 ? "+" : ""}${ci.ciLow.toFixed(0)}..${ci.ciHigh >= 0 ? "+" : ""}${ci.ciHigh.toFixed(0)}% CI]`;
}

function pctDelta(base, val) {
    if (!(base > 0)) return "0.0%";
    const d = ((val - base) / base) * 100;
    return `${d > 0 ? "+" : ""}${d.toFixed(1)}%`;
}

function pctDeltaInt(base, val) {
    if (!(base > 0)) return "0%";
    const d = Math.round(((val - base) / base) * 100);
    return `${d > 0 ? "+" : ""}${d}%`;
}

function countWTL(tasks, metricFn) {
    let w = 0;
    let t = 0;
    let l = 0;
    for (const row of tasks) {
        const pv = metricFn(row.plexer);
        const cv = metricFn(row.cold);
        if (pv < cv) w++;
        else if (pv > cv) l++;
        else t++;
    }
    return t === 0 && l === 0 ? `${w}W/0L` : `${w}W/${t}T/${l}L`;
}

function postT1Of(x) {
    return typeof x.postTurn1UncachedTokens === "number" && x.postTurn1UncachedTokens > 0
        ? x.postTurn1UncachedTokens
        : Math.max(0, (x.finalContextTokens || 0) - (x.turn1ContextTokens || 0));
}

function growthOf(x) {
    return typeof x.netContextGrowthTokens === "number" && x.netContextGrowthTokens > 0
        ? x.netContextGrowthTokens
        : Math.max(0, (x.finalContextTokens || 0) - (x.turn1ContextTokens || 0));
}

function isStrictResolved(x) {
    if (!x) return 0;
    if (typeof x.resolved === "boolean") return x.resolved ? 1 : 0;
    if (typeof x.fileRecall === "number" && typeof x.symRecall === "number" && typeof x.tokenRecall === "number") {
        return x.fileRecall === 1 && x.symRecall >= 0.75 && (x.dockerPassed === true || x.tokenRecall >= 0.7) ? 1 : 0;
    }
    if (typeof x.fileRecall === "number") return x.fileRecall === 1 && (x.score ?? 0) >= 6 ? 1 : 0;
    return (x.score ?? 0) >= 7 ? 1 : 0;
}

const COMPACTION_SUITE = {
    title: "engine source compaction",
    sub: "ask --source tokens vs. raw target files across 6 repos (14,475 nodes · 29,088 edges · 100% Recall@1)",
    groups: [
        {
            label: "plexer",
            baseline: "1,181 tok",
            bars: [
                { arm: "plexer", val: 1181, delta: "-95.9%", amount: "1,181 tok", extra: "14.0 ms ask --source · 0.18 ms callers" },
                { arm: "cold", val: 28541, amount: "28,541 raw tok", extra: "1,973 nodes · 6,126 edges" },
            ],
        },
        {
            label: "flux",
            baseline: "1,290 tok",
            bars: [
                { arm: "plexer", val: 1290, delta: "-95.3%", amount: "1,290 tok", extra: "6.8 ms ask --source · 0.28 ms callers" },
                { arm: "cold", val: 27441, amount: "27,441 raw tok", extra: "1,445 nodes · 2,027 edges" },
            ],
        },
        {
            label: "z",
            baseline: "1,234 tok",
            bars: [
                { arm: "plexer", val: 1234, delta: "-91.8%", amount: "1,234 tok", extra: "20.6 ms ask --source · 0.58 ms callers" },
                { arm: "cold", val: 15116, amount: "15,116 raw tok", extra: "3,614 nodes · 6,437 edges" },
            ],
        },
        {
            label: "sert",
            baseline: "938 tok",
            bars: [
                { arm: "plexer", val: 938, delta: "-91.3%", amount: "938 tok", extra: "11.6 ms ask --source · 1.74 ms callers" },
                { arm: "cold", val: 10757, amount: "10,757 raw tok", extra: "2,926 nodes · 6,070 edges" },
            ],
        },
        {
            label: "kohls-admin",
            baseline: "1,161 tok",
            bars: [
                { arm: "plexer", val: 1161, delta: "-89.0%", amount: "1,161 tok", extra: "11.9 ms ask --source · 0.80 ms callers" },
                { arm: "cold", val: 10574, amount: "10,574 raw tok", extra: "2,547 nodes · 3,659 edges" },
            ],
        },
        {
            label: "building-tools",
            baseline: "1,346 tok",
            bars: [
                { arm: "plexer", val: 1346, delta: "-74.6%", amount: "1,346 tok", extra: "10.5 ms ask --source · 0.99 ms callers" },
                { arm: "cold", val: 5306, amount: "5,306 raw tok", extra: "1,970 nodes · 4,769 edges" },
            ],
        },
    ],
};

export function buildBenchmarkData(benchDir = import.meta.dirname) {
    const sum = (rows, arm, fn) => rows.reduce((a, r) => a + fn(r[arm]), 0);

    // 1. T1–T12 12-task engineering suite
    const tModelSpecs = [
        { label: "orch-neon+h2-h", file: "results-orch-neon-high-hydrogen-high.json", pricingModel: "gemini-4-neon", isClaude: false, isOrchHigh: true },
        { label: "orch-neon-h+h2-xh", file: "results-orch-neon-high-hydrogen-xhigh.json", pricingModel: "gemini-4-neon", isClaude: false, isOrchHybrid: true },
        { label: "orch-neon+h2-xh", file: "results-orch-neon-xhigh-hydrogen-xhigh.json", pricingModel: "gemini-4-neon", isClaude: false, isOrchXhigh: true },
        { label: "neon-medium", file: "results-neon-medium.json", pricingModel: "gemini-4-neon", isClaude: false, isNeon: true },
        { label: "carbon-medium", file: "results-carbon-medium.json", pricingModel: "gemini-4-carbon", isClaude: false, isCarbon: true },
        { label: "hydrogen-medium", file: "results-hydrogen-medium.json", pricingModel: "gemini-4-hydrogen", isClaude: false },
        { label: "opus-5.5", file: "results-opus.json", pricingModel: "claude-opus-5-5", isClaude: true },
        { label: "sonnet-5.5", file: "results-sonnet.json", pricingModel: "claude-sonnet-5-5", isClaude: true },
    ];
    const tModels = [];
    for (const spec of tModelSpecs) {
        const j = readJsonIfExists(benchDir, spec.file);
        const rows = (j?.tasks || []).filter((t) => t.cold && t.plexer).map((t) => ({ ...t, _pricingModel: spec.pricingModel }));
        if (rows.length === 12) tModels.push({ ...spec, rows, trials: j?.trials || 1 });
    }
    const tAllRows = tModels.flatMap((m) => m.rows);
    const tColdTok = sum(tAllRows, "cold", (x) => x.toolOutputTokens || 0);
    const tPlexerTok = sum(tAllRows, "plexer", (x) => x.toolOutputTokens || 0);
    const tColdCum = sum(tAllRows, "cold", (x) => x.cumulativeInputTokens || 0);
    const tPlexerCum = sum(tAllRows, "plexer", (x) => x.cumulativeInputTokens || 0);
    const tColdCtx = sum(tAllRows, "cold", (x) => x.finalContextTokens || 0);
    const tPlexerCtx = sum(tAllRows, "plexer", (x) => x.finalContextTokens || 0);
    const tColdCalls = sum(tAllRows, "cold", (x) => x.calls || 0);
    const tPlexerCalls = sum(tAllRows, "plexer", (x) => x.calls || 0);
    const tColdTurns = sum(tAllRows, "cold", (x) => x.turns || 0);
    const tPlexerTurns = sum(tAllRows, "plexer", (x) => x.turns || 0);
    const tColdTotal = sum(tAllRows, "cold", (x) => x.totalMs || x.searchMs || 0);
    const tPlexerTotal = sum(tAllRows, "plexer", (x) => x.totalMs || x.searchMs || 0);
    const tColdSearch = sum(tAllRows, "cold", (x) => x.searchMs || 0);
    const tPlexerSearch = sum(tAllRows, "plexer", (x) => x.searchMs || 0);
    const tColdUsd = tAllRows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
    const tPlexerUsd = tAllRows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
    const tColdScore = sum(tAllRows, "cold", (x) => x.score || 0);
    const tPlexerScore = sum(tAllRows, "plexer", (x) => x.score || 0);
    const tMaxScore = sum(tAllRows, "plexer", (x) => x.maxScore || 8);

    const tHeadline = {
        title: "Engineering tasks",
        sub: `12 tasks across 6 repos (${tAllRows.length} paired runs) · ${tColdScore}/${tMaxScore} → ${tPlexerScore}/${tMaxScore} (${((tPlexerScore / Math.max(1, tMaxScore)) * 100).toFixed(0)}%) task score`,
        groups: [
            {
                label: "tool output",
                baseline: fmtTok(tPlexerTok),
                bars: [
                    { arm: "plexer", val: tPlexerTok, delta: pctDelta(tColdTok, tPlexerTok), amount: fmtTok(tPlexerTok), extra: `${countWTL(tAllRows, (x) => x.toolOutputTokens || 0)} · ${pctCiLabel(tAllRows, (r, a) => r[a].toolOutputTokens || 0)}` },
                    { arm: "cold", val: tColdTok, amount: fmtTok(tColdTok), extra: `${tAllRows.length} tasks` },
                ],
            },
            {
                label: "api cost ($)",
                baseline: fmtUsd(tPlexerUsd),
                bars: [
                    { arm: "plexer", val: Math.max(0.001, tPlexerUsd), delta: pctDelta(tColdUsd, tPlexerUsd), amount: fmtUsd(tPlexerUsd), extra: `${fmtTok(tPlexerCum)} (${pctDelta(tColdCum, tPlexerCum)}) · ${(tPlexerCtx / 1e3).toFixed(1)}k ctx` },
                    { arm: "cold", val: Math.max(0.001, tColdUsd), amount: fmtUsd(tColdUsd), extra: `${fmtTok(tColdCum)} · ${(tColdCtx / 1e3).toFixed(1)}k ctx` },
                ],
            },
            {
                label: "tool calls",
                baseline: `${tPlexerCalls} calls`,
                bars: [
                    { arm: "plexer", val: tPlexerCalls, delta: pctDelta(tColdCalls, tPlexerCalls), amount: `${tPlexerCalls} calls`, extra: `${tPlexerTurns} turns · ${countWTL(tAllRows, (x) => x.calls || 0)}` },
                    { arm: "cold", val: tColdCalls, amount: `${tColdCalls} calls`, extra: `${tColdTurns} turns` },
                ],
            },
            {
                label: "wall time",
                baseline: fmtSec(tPlexerTotal),
                bars: [
                    { arm: "plexer", val: tPlexerTotal, delta: pctDelta(tColdTotal, tPlexerTotal), amount: fmtSec(tPlexerTotal), extra: `search ${fmtSec(tPlexerSearch)} (${pctDelta(tColdSearch, tPlexerSearch)}) · ${countWTL(tAllRows, (x) => x.totalMs || x.searchMs || 0)}` },
                    { arm: "cold", val: tColdTotal, amount: fmtSec(tColdTotal), extra: `search ${fmtSec(tColdSearch)} · ${tColdScore}/${tMaxScore} score` },
                ],
            },
        ],
    };

    const tDetail = {
        title: "T1–T12 per-model breakdown",
        sub: "tool output tokens, tool calls, API cost ($), and end-to-end wall time across 12 tasks per model",
        groups: tModels.map((m) => {
            const pTok = sum(m.rows, "plexer", (x) => x.toolOutputTokens || 0);
            const cTok = sum(m.rows, "cold", (x) => x.toolOutputTokens || 0);
            const pCalls = sum(m.rows, "plexer", (x) => x.calls || 0);
            const cCalls = sum(m.rows, "cold", (x) => x.calls || 0);
            const pUsd = m.rows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
            const cUsd = m.rows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
            const pWall = sum(m.rows, "plexer", (x) => x.totalMs || x.searchMs || 0);
            const cWall = sum(m.rows, "cold", (x) => x.totalMs || x.searchMs || 0);
            const pScore = sum(m.rows, "plexer", (x) => x.score || 0);
            const cScore = sum(m.rows, "cold", (x) => x.score || 0);
            const maxS = sum(m.rows, "plexer", (x) => x.maxScore || 8);
            const pExtra = `${pCalls} calls (${pctDeltaInt(cCalls, pCalls)}) · ${fmtUsd(pUsd)} (${pctDeltaInt(cUsd, pUsd)}) · ${fmtSec(pWall)} · ${pScore}/${maxS}`;
            const cExtra = `${cCalls} calls · ${fmtUsd(cUsd)} · ${fmtSec(cWall)} · ${cScore}/${maxS}`;
            return {
                label: m.label,
                baseline: fmtTok(pTok),
                bars: [
                    { arm: "plexer", val: pTok, delta: pctDelta(cTok, pTok), amount: fmtTok(pTok), extra: pExtra },
                    { arm: "cold", val: cTok, amount: fmtTok(cTok), extra: cExtra },
                ],
            };
        }),
    };

    // 2. ScaleAI/SWE-bench_Pro V2 (S1–S8)
    const sweModelSpecs = [
        { label: "orch-neon+h2-h", file: "results-swebench-orch-neon-high-hydrogen-high.json", pricingModel: "gemini-4-neon", isClaude: false, isOrchHigh: true },
        { label: "orch-neon-h+h2-xh", file: "results-swebench-orch-neon-high-hydrogen-xhigh.json", pricingModel: "gemini-4-neon", isClaude: false, isOrchHybrid: true },
        { label: "orch-neon+h2-xh", file: "results-swebench-orch-neon-xhigh-hydrogen-xhigh.json", pricingModel: "gemini-4-neon", isClaude: false, isOrchXhigh: true },
        { label: "neon-medium", file: "results-swebench-neon-medium.json", pricingModel: "gemini-4-neon", isClaude: false, isNeon: true },
        { label: "carbon-medium", file: "results-swebench-carbon-medium.json", pricingModel: "gemini-4-carbon", isClaude: false, isCarbon: true },
        { label: "hydrogen-medium", file: "results-swebench-hydrogen-medium.json", pricingModel: "gemini-4-hydrogen", isClaude: false },
        { label: "opus-5.5", file: "results-swebench-opus.json", pricingModel: "claude-opus-5-5", isClaude: true },
        { label: "sonnet-5.5", file: "results-swebench-sonnet.json", pricingModel: "claude-sonnet-5-5", isClaude: true },
    ];
    const sweModels = [];
    for (const spec of sweModelSpecs) {
        const j = readJsonIfExists(benchDir, spec.file);
        const rows = (j?.tasks || []).filter((t) => t.cold && t.plexer).map((t) => ({ ...t, _pricingModel: spec.pricingModel }));
        if (rows.length > 0) sweModels.push({ ...spec, rows, trials: j?.trials || 1, useDocker: j?.useDocker });
    }
    const sAllRows = sweModels.flatMap((m) => m.rows);
    const sColdTok = sum(sAllRows, "cold", (x) => x.toolOutputTokens || 0);
    const sPlexerTok = sum(sAllRows, "plexer", (x) => x.toolOutputTokens || 0);
    const sColdCum = sum(sAllRows, "cold", (x) => x.cumulativeInputTokens || 0);
    const sPlexerCum = sum(sAllRows, "plexer", (x) => x.cumulativeInputTokens || 0);
    const sColdCalls = sum(sAllRows, "cold", (x) => x.calls || 0);
    const sPlexerCalls = sum(sAllRows, "plexer", (x) => x.calls || 0);
    const sColdWall = sum(sAllRows, "cold", (x) => x.totalMs || x.searchMs || 0);
    const sPlexerWall = sum(sAllRows, "plexer", (x) => x.totalMs || x.searchMs || 0);
    const sColdSearch = sum(sAllRows, "cold", (x) => x.searchMs || 0);
    const sPlexerSearch = sum(sAllRows, "plexer", (x) => x.searchMs || 0);
    const sColdUsd = sAllRows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
    const sPlexerUsd = sAllRows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
    const sColdScore = sum(sAllRows, "cold", (x) => x.score || 0);
    const sPlexerScore = sum(sAllRows, "plexer", (x) => x.score || 0);
    const sMaxScore = sum(sAllRows, "plexer", (x) => x.maxScore || 8);

    const sweHeadline = {
        title: "SWE-bench Pro V2",
        sub: `8 OSS issues across Python, Go, JS, and TS (${sAllRows.length} paired runs) · 100% gold file recall`,
        groups: [
            {
                label: "tool output",
                baseline: fmtTok(sPlexerTok),
                bars: [
                    { arm: "plexer", val: sPlexerTok, delta: pctDelta(sColdTok, sPlexerTok), amount: fmtTok(sPlexerTok), extra: countWTL(sAllRows, (x) => x.toolOutputTokens || 0) },
                    { arm: "cold", val: sColdTok, amount: fmtTok(sColdTok), extra: `${sAllRows.length} tasks` },
                ],
            },
            {
                label: "api cost ($)",
                baseline: fmtUsd(sPlexerUsd),
                bars: [
                    { arm: "plexer", val: Math.max(0.001, sPlexerUsd), delta: pctDelta(sColdUsd, sPlexerUsd), amount: fmtUsd(sPlexerUsd), extra: `${fmtTok(sPlexerCum)} (${pctDelta(sColdCum, sPlexerCum)}) · ${sPlexerCalls} calls` },
                    { arm: "cold", val: Math.max(0.001, sColdUsd), amount: fmtUsd(sColdUsd), extra: `${fmtTok(sColdCum)} · ${sColdCalls} calls` },
                ],
            },
            {
                label: "wall time",
                baseline: fmtSec(sPlexerWall),
                bars: [
                    { arm: "plexer", val: sPlexerWall, delta: pctDelta(sColdWall, sPlexerWall), amount: fmtSec(sPlexerWall), extra: `search ${fmtSec(sPlexerSearch)} (${pctDelta(sColdSearch, sPlexerSearch)}) · ${sPlexerScore}/${sMaxScore}` },
                    { arm: "cold", val: sColdWall, amount: fmtSec(sColdWall), extra: `search ${fmtSec(sColdSearch)} · ${sColdScore}/${sMaxScore}` },
                ],
            },
        ],
    };

    const sweDetail = {
        title: "SWE-bench Pro V2 per-model",
        sub: "S1–S8 across qutebrowser (Python), flipt (Go), NodeBB (JS), and tutanota (TS)",
        groups: sweModels.map((m) => {
            const pTok = sum(m.rows, "plexer", (x) => x.toolOutputTokens || 0);
            const cTok = sum(m.rows, "cold", (x) => x.toolOutputTokens || 0);
            const pCalls = sum(m.rows, "plexer", (x) => x.calls || 0);
            const cCalls = sum(m.rows, "cold", (x) => x.calls || 0);
            const pUsd = m.rows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
            const cUsd = m.rows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
            const pWall = sum(m.rows, "plexer", (x) => x.totalMs || x.searchMs || 0);
            const cWall = sum(m.rows, "cold", (x) => x.totalMs || x.searchMs || 0);
            const pScore = sum(m.rows, "plexer", (x) => x.score || 0);
            const cScore = sum(m.rows, "cold", (x) => x.score || 0);
            const maxS = sum(m.rows, "plexer", (x) => x.maxScore || 8);
            const pExtra = `${pCalls} calls (${pctDeltaInt(cCalls, pCalls)}) · ${fmtUsd(pUsd)} (${pctDeltaInt(cUsd, pUsd)}) · ${fmtSec(pWall)} · ${pScore}/${maxS}`;
            const cExtra = `${cCalls} calls · ${fmtUsd(cUsd)} · ${fmtSec(cWall)} · ${cScore}/${maxS}`;
            return {
                label: m.label,
                baseline: fmtTok(pTok),
                bars: [
                    { arm: "plexer", val: pTok, delta: pctDelta(cTok, pTok), amount: fmtTok(pTok), extra: pExtra },
                    { arm: "cold", val: cTok, amount: fmtTok(cTok), extra: cExtra },
                ],
            };
        }),
    };

    // 3. Large-repo & discriminative suite (L1–L8)
    const largeModelSpecs = [
        { label: "orch-neon+h2-h", file: "results-large-orch-neon-high-hydrogen-high.json", pricingModel: "gemini-4-neon", isOrchHigh: true, isCarbon: false },
        { label: "orch-neon-h+h2-xh", file: "results-large-orch-neon-high-hydrogen-xhigh.json", pricingModel: "gemini-4-neon", isOrchHybrid: true, isCarbon: false },
        { label: "orch-neon+h2-xh", file: "results-large-orch-neon-xhigh-hydrogen-xhigh.json", pricingModel: "gemini-4-neon", isOrchXhigh: true, isCarbon: false },
        { label: "neon-medium", file: "results-large-neon-medium.json", pricingModel: "gemini-4-neon", isNeon: true, isCarbon: false },
        { label: "carbon-medium", file: "results-large-carbon-medium.json", pricingModel: "gemini-4-carbon", isCarbon: true },
        { label: "hydrogen-medium", file: "results-large-hydrogen-medium.json", pricingModel: "gemini-4-hydrogen", isCarbon: false },
        { label: "opus-5.5", file: "results-large-opus.json", pricingModel: "claude-opus-5-5", isCarbon: false },
        { label: "sonnet-5.5", file: "results-large-sonnet.json", pricingModel: "claude-sonnet-5-5", isCarbon: false },
    ];
    const largeModels = [];
    for (const spec of largeModelSpecs) {
        const j = readJsonIfExists(benchDir, spec.file);
        const rows = (j?.tasks || []).filter((t) => t.cold && t.plexer).map((t) => ({ ...t, _pricingModel: spec.pricingModel }));
        if (rows.length > 0) largeModels.push({ ...spec, rows, trials: j?.trials || 1, useDocker: j?.useDocker });
    }
    const lAllRows = largeModels.flatMap((m) => m.rows);
    let largeHeadline = null;
    let largeDetail = null;
    if (lAllRows.length > 0) {
        const lPlexerTok = sum(lAllRows, "plexer", (x) => x.toolOutputTokens || 0);
        const lColdTok = sum(lAllRows, "cold", (x) => x.toolOutputTokens || 0);
        const lPlexerCalls = sum(lAllRows, "plexer", (x) => x.calls || 0);
        const lColdCalls = sum(lAllRows, "cold", (x) => x.calls || 0);
        const lPlexerUsd = lAllRows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
        const lColdUsd = lAllRows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
        const lPlexerWall = sum(lAllRows, "plexer", (x) => x.totalMs || x.searchMs || 0);
        const lColdWall = sum(lAllRows, "cold", (x) => x.totalMs || x.searchMs || 0);
        const lPlexerRes = sum(lAllRows, "plexer", isStrictResolved);
        const lColdRes = sum(lAllRows, "cold", isStrictResolved);

        largeHeadline = {
            title: "Large OSS repositories",
            sub: `8 multi-file tasks across 440–1,350+ file repos (${lAllRows.length} paired runs) · ${lPlexerRes}/${lAllRows.length} solved`,
            groups: [
                {
                    label: "tool output",
                    baseline: fmtTok(lPlexerTok),
                    bars: [
                        { arm: "plexer", val: lPlexerTok, delta: pctDelta(lColdTok, lPlexerTok), amount: fmtTok(lPlexerTok), extra: `${lPlexerCalls} calls · ${lPlexerRes}/${lAllRows.length} resolved` },
                        { arm: "cold", val: lColdTok, amount: fmtTok(lColdTok), extra: `${lColdCalls} calls · ${lColdRes}/${lAllRows.length} resolved` },
                    ],
                },
                {
                    label: "api cost ($)",
                    baseline: fmtUsd(lPlexerUsd),
                    bars: [
                        { arm: "plexer", val: Math.max(0.001, lPlexerUsd), delta: pctDelta(lColdUsd, lPlexerUsd), amount: fmtUsd(lPlexerUsd), extra: `wall ${fmtSec(lPlexerWall)} (${pctDelta(lColdWall, lPlexerWall)})` },
                        { arm: "cold", val: Math.max(0.001, lColdUsd), amount: fmtUsd(lColdUsd), extra: `wall ${fmtSec(lColdWall)} · ${lAllRows.length} sessions` },
                    ],
                },
            ],
        };

        largeDetail = {
            title: "Large-repo suite L1–L8 per-model",
            sub: "pocketbase, tutanota, NodeBB, flipt, and qutebrowser (tool output, API cost $, wall time)",
            groups: largeModels.map((m) => {
                const pTok = sum(m.rows, "plexer", (x) => x.toolOutputTokens || 0);
                const cTok = sum(m.rows, "cold", (x) => x.toolOutputTokens || 0);
                const pCalls = sum(m.rows, "plexer", (x) => x.calls || 0);
                const cCalls = sum(m.rows, "cold", (x) => x.calls || 0);
                const pUsd = m.rows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
                const cUsd = m.rows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
                const pRes = sum(m.rows, "plexer", isStrictResolved);
                const cRes = sum(m.rows, "cold", isStrictResolved);
                return {
                    label: m.label,
                    baseline: fmtTok(pTok),
                    bars: [
                        { arm: "plexer", val: pTok, delta: pctDelta(cTok, pTok), amount: fmtTok(pTok), extra: `${pCalls} calls · ${fmtUsd(pUsd)} (${pctDeltaInt(cUsd, pUsd)}) · ${pRes}/${m.rows.length}` },
                        { arm: "cold", val: cTok, amount: fmtTok(cTok), extra: `${cCalls} calls · ${fmtUsd(cUsd)} · ${cRes}/${m.rows.length}` },
                    ],
                };
            }),
        };
    }

    // 4. Optional v2 Scale Ladder & Train vs Holdout suite (auto-detected results-v2-*.json)
    const v2Files = readdirSync(benchDir).filter((f) => /^results-v2-.*\.json$/i.test(f)).sort();
    const v2Models = [];
    for (const file of v2Files) {
        const j = readJsonIfExists(benchDir, file);
        const rows = (j?.tasks || []).filter((t) => t.cold && t.plexer).map((t) => ({ ...t, _pricingModel: j?.model || "claude-sonnet-5-5" }));
        if (rows.length > 0) v2Models.push({ label: j?.model || file, file, rows, trials: j?.trials || 1, useDocker: j?.useDocker !== false });
    }
    const v2AllRows = v2Models.flatMap((m) => m.rows);
    let v2Headline = null;
    if (v2AllRows.length > 0) {
        const v2PlexerTok = sum(v2AllRows, "plexer", (x) => x.toolOutputTokens || 0);
        const v2ColdTok = sum(v2AllRows, "cold", (x) => x.toolOutputTokens || 0);
        const v2PlexerUsd = v2AllRows.reduce((a, r) => a + rowApiCostUsd(r, "plexer"), 0);
        const v2ColdUsd = v2AllRows.reduce((a, r) => a + rowApiCostUsd(r, "cold"), 0);
        const v2PlexerWall = sum(v2AllRows, "plexer", (x) => x.totalMs || x.searchMs || 0);
        const v2ColdWall = sum(v2AllRows, "cold", (x) => x.totalMs || x.searchMs || 0);
        const trainRows = v2AllRows.filter((r) => !r.holdout && !r.negativeControl);
        const holdRows = v2AllRows.filter((r) => Boolean(r.holdout));
        const trainPass = sum(trainRows, "plexer", isStrictResolved);
        const holdPass = sum(holdRows, "plexer", isStrictResolved);
        const maxTrials = Math.max(...v2Models.map((m) => m.trials || 1));
        v2Headline = {
            title: "v2 Scale Ladder (Small → Mega)",
            sub: `De-leaked OSS suite (${v2AllRows.length} pairs · N=${maxTrials} trials) · Train ${trainPass}/${trainRows.length || 0} · Holdout ${holdPass}/${holdRows.length || 0}`,
            groups: [
                {
                    label: "tool output",
                    baseline: fmtTok(v2PlexerTok),
                    bars: [
                        { arm: "plexer", val: v2PlexerTok, delta: pctDelta(v2ColdTok, v2PlexerTok), amount: fmtTok(v2PlexerTok), extra: `${pctCiLabel(v2AllRows, (r, a) => r[a].toolOutputTokens || 0)}` },
                        { arm: "cold", val: v2ColdTok, amount: fmtTok(v2ColdTok), extra: `${v2AllRows.length} pairs` },
                    ],
                },
                {
                    label: "api cost ($)",
                    baseline: fmtUsd(v2PlexerUsd),
                    bars: [
                        { arm: "plexer", val: Math.max(0.001, v2PlexerUsd), delta: pctDelta(v2ColdUsd, v2PlexerUsd), amount: fmtUsd(v2PlexerUsd), extra: `wall ${fmtSec(v2PlexerWall)} (${pctDelta(v2ColdWall, v2PlexerWall)})` },
                        { arm: "cold", val: Math.max(0.001, v2ColdUsd), amount: fmtUsd(v2ColdUsd), extra: `wall ${fmtSec(v2ColdWall)}` },
                    ],
                },
            ],
        };
    }

    const headlineSuites = [tHeadline, sweHeadline, ...(largeHeadline ? [largeHeadline] : []), ...(v2Headline ? [v2Headline] : [])];
    const liveDetailSuites = [tDetail, sweDetail, ...(largeDetail ? [largeDetail] : [])];
    const detailSuites = [...liveDetailSuites, COMPACTION_SUITE];

    const hasNeon =
        tModels.some((m) => m.isNeon) ||
        sweModels.some((m) => m.isNeon) ||
        largeModels.some((m) => m.isNeon);

    const hasCarbon =
        tModels.some((m) => m.isCarbon) ||
        sweModels.some((m) => m.isCarbon) ||
        largeModels.some((m) => m.isCarbon);

    const hasOrchHigh =
        tModels.some((m) => m.isOrchHigh) ||
        sweModels.some((m) => m.isOrchHigh) ||
        largeModels.some((m) => m.isOrchHigh);

    const hasOrchHybrid =
        tModels.some((m) => m.isOrchHybrid) ||
        sweModels.some((m) => m.isOrchHybrid) ||
        largeModels.some((m) => m.isOrchHybrid);

    const hasOrchXhigh =
        tModels.some((m) => m.isOrchXhigh) ||
        sweModels.some((m) => m.isOrchXhigh) ||
        largeModels.some((m) => m.isOrchXhigh);

    const allAgentGroups = [
        ...headlineSuites.flatMap((s) => s.groups),
        ...liveDetailSuites.flatMap((s) => s.groups),
    ];
    const logs = { plexer: [], cold: [] };
    for (const g of allAgentGroups) {
        const best = Math.min(...g.bars.map((b) => b.val));
        for (const b of g.bars) {
            if (best > 0 && b.val > 0) logs[b.arm].push(Math.log(b.val / best));
        }
    }
    const geo = {};
    for (const arm of ARMS) {
        const xs = logs[arm];
        geo[arm] = xs.length ? Math.exp(xs.reduce((a, b) => a + b, 0) / xs.length) : 1.0;
    }

    const totalPairedCount = tAllRows.length + sAllRows.length + lAllRows.length + v2AllRows.length;
    const trialBadge = v2AllRows.length > 0 && Math.max(...v2Models.map((m) => m.trials || 1)) >= 2
        ? `N=${Math.max(...v2Models.map((m) => m.trials || 1))} · 95% CI`
        : "N=1 (unreplicated)";
    const verificationBadge = sweModels.some((m) => m.useDocker) || v2Models.some((m) => m.useDocker)
        ? "exec-verified"
        : "heuristic+rubric";
    return {
        headlineSuites,
        detailSuites,
        geo,
        rowCount: allAgentGroups.length,
        hasNeon,
        hasCarbon,
        hasOrchHigh,
        hasOrchHybrid,
        hasOrchXhigh,
        totalPairedCount,
        hasLarge: lAllRows.length > 0,
        hasV2: v2AllRows.length > 0,
        trialBadge,
        verificationBadge,
    };
}

export function renderChart(includeDetail, benchDir = import.meta.dirname) {
    const { headlineSuites, detailSuites, geo, rowCount, hasNeon, hasCarbon, hasOrchHigh, hasOrchHybrid, hasOrchXhigh, totalPairedCount, hasLarge, hasV2, trialBadge, verificationBadge } = buildBenchmarkData(benchDir);
    const front = [];
    const behind = [];

    // ---- header ----------------------------------------------------------------
    front.push(
        `<text x="${M_L}" y="${16 + M_T}" font-size="23" font-weight="800" class="tt">plexer benchmark</text>`
    );
    const suiteCodes = ["T1–T12", "S1–S8", hasLarge ? "L1–L8" : null, hasV2 ? "V1–V14" : null].filter(Boolean).join(" · ");
    front.push(
        `<text x="${M_L}" y="${37 + M_T}" class="tm s125">${totalPairedCount} paired runs <tspan class="mono">(${suiteCodes})</tspan> · ${esc(trialBadge)} · ${esc(verificationBadge)} · shorter = lower cost</text>`
    );

    // ---- shared x-axis: 1.0× to 4.0× scale for both hero and detail -----------
    let y = 60 + M_T;
    for (const t of TICKS) {
        front.push(`<text x="${xrel(t).toFixed(1)}" y="${y}" class="tm mono m s95">${fmtTick(t)}</text>`);
    }
    front.push(`<text x="${X0 - 14}" y="${y}" class="tm e s95">relative volume / time, lower is better →</text>`);
    const axisTop = y + 6;

    function bar(by, arm, rel, h = BAR_H, rx = 3) {
        const w = Math.max(2.5, xrel(rel) - X0);
        const mask = rel > MAX_REL ? ' mask="url(#capfade)"' : "";
        front.push(
            `<rect x="${X0}" y="${by}" width="${w.toFixed(1)}" height="${h}" rx="${rx}" fill="${COLORS[arm]}"${mask}/>`
        );
        return w;
    }

    function barLabel(by, arm, mult, amount, w, extra = "") {
        const cy = by + BAR_H / 2 + 3.3;
        const extraStr = extra ? ` · ${extra}` : "";
        const text = mult ? `${arm} ${mult} ${amount}${extraStr}` : `${arm} ${amount}${extraStr}`;
        const fitsOutsideRight = X0 + w + 7 + 4.9 * text.length <= X1;
        if (w > 18 + 4.3 * text.length || (!fitsOutsideRight && w > 180)) {
            front.push(
                `<text x="${X0 + 9}" y="${cy.toFixed(1)}" class="tw s93">` +
                    `<tspan class="o9">${esc(arm)}</tspan>` +
                    (mult ? `<tspan class="b" dx="5">${esc(mult)}</tspan>` : "") +
                    `<tspan class="o7 s83" dx="5">${esc(amount + extraStr)}</tspan></text>`
            );
        } else {
            front.push(
                `<text x="${(X0 + w + 7).toFixed(1)}" y="${cy.toFixed(1)}" class="tl s93">` +
                    `<tspan>${esc(arm)}</tspan>` +
                    (mult ? `<tspan class="tt b" dx="5">${esc(mult)}</tspan>` : "") +
                    `<tspan class="tm s83" dx="5">${esc(amount + extraStr)}</tspan></text>`
            );
        }
    }

    let gi = 0;

    function groupHead(gy, n, label, baseline) {
        const gh = n * BAR_H + (n - 1) * BAR_GAP;
        if (gi % 2 === 1) {
            behind.push(
                `<rect x="${M_L}" y="${(gy - 4).toFixed(1)}" width="${W - M_L - M_R}" height="${(gh + 8).toFixed(1)}" rx="4" class="zebra"/>`
            );
        }
        gi += 1;
        front.push(
            `<text x="${X0 - 14}" y="${(gy + gh / 2 + 1).toFixed(1)}" class="tl mono e b6 s11">${esc(label)}</text>`
        );
        if (baseline) {
            front.push(
                `<text x="${X0 - 14}" y="${(gy + gh / 2 + 13).toFixed(1)}" class="tm mono e s85">${esc(baseline)}</text>`
            );
        }
        return gh;
    }

    function sectionHead(sy, title, sub) {
        front.push(
            `<text x="${M_L}" y="${sy + 14}" class="tt b s13">${esc(title)}<tspan class="tm s11" font-weight="500" dx="8">${esc(sub)}</tspan></text>`
        );
        return sy + SUITE_HEAD;
    }

    // ---- hero: overall geometric mean (doubles as the legend) ------------------
    y = axisTop + 18;
    const geminiModels = [
        hasNeon && "Neon",
        hasCarbon && "Carbon",
        "Hydrogen",
    ].filter(Boolean);
    const orchTiers = [hasOrchHigh && "High", hasOrchHybrid && "High+XHigh", hasOrchXhigh && "XHigh"].filter(Boolean);
    const modelLineup = [
        geminiModels.length ? `Gemini 4 ${geminiModels.join("/")}` : null,
        orchTiers.length ? `Orchestrator (Neon+H2 ${orchTiers.join("/")})` : null,
        "Claude Opus/Sonnet 5.5",
    ]
        .filter(Boolean)
        .join(", ");
    front.push(`<text x="${M_L}" y="${y}" class="tl b s11" letter-spacing="0.5">OVERALL · GEOMETRIC MEAN</text>`);
    front.push(
        `<text x="${X1}" y="${y}" class="tm e" font-size="10">over ${rowCount} live benchmark rows · ${modelLineup}</text>`
    );
    y += 12;

    for (const arm of ARMS) {
        const g = geo[arm];
        bar(y, arm, g, HERO_BAR_H, 4);
        const cy = y + HERO_BAR_H / 2 + 4.5;
        const meta = ARM_META[arm];
        let nameSvg = meta.scope
            ? `<tspan class="tm">${esc(meta.scope)}</tspan>${esc(meta.name)}`
            : esc(meta.name);
        if (meta.link) {
            nameSvg = `<a href="${esc(meta.link)}" class="lnk" target="_blank">${nameSvg}</a>`;
        }
        const verSvg = meta.ver ? `<tspan class="tm s85" font-weight="500" dx="5">${esc(meta.ver)}</tspan>` : "";
        front.push(`<text x="${X0 - 12}" y="${cy.toFixed(1)}" class="tt b e s125">${nameSvg}${verSvg}</text>`);
        front.push(`<text x="${X0 + 10}" y="${cy.toFixed(1)}" class="tw b s125">${g.toFixed(2)}×</text>`);
        y += HERO_BAR_H + HERO_GAP;
    }

    // ---- suites ----------------------------------------------------------------
    y += 12;
    front.push(
        `<text x="${M_L}" y="${y}" class="tl b s11" letter-spacing="0.5">${includeDetail ? "PER-SUITE &amp; PER-MODEL BREAKDOWN" : "HEADLINE SUITES"}</text>`
    );
    y += 12;

    const suitesToRender = includeDetail ? [...headlineSuites, ...detailSuites] : headlineSuites;

    for (const suite of suitesToRender) {
        y = sectionHead(y, suite.title, suite.sub);
        for (const group of suite.groups) {
            const best = Math.min(...group.bars.map((b) => b.val));
            const gh = groupHead(y, group.bars.length, group.label, group.baseline);
            let by = y;
            for (const b of group.bars) {
                const rel = b.val / best;
                const w = bar(by, b.arm, rel);
                const multStr = b.delta ? `${fmtMult(rel)} (${b.delta})` : fmtMult(rel);
                barLabel(by, b.arm, multStr, b.amount, w, b.extra);
                by += BAR_H + BAR_GAP;
            }
            y += gh + GROUP_PAD;
        }
        y += 8;
    }

    // ---- gridlines (drawn behind everything) -----------------------------------
    for (const t of TICKS) {
        const tx = xrel(t);
        behind.push(
            `<line x1="${tx.toFixed(1)}" y1="${axisTop + 2}" x2="${tx.toFixed(1)}" y2="${(y - 4).toFixed(1)}" class="${t === 1 ? "gridkey" : "grid"}"/>`
        );
    }

    const totalH = y + 60;
    const footerSvg =
        `<text x="${M_L}" y="${totalH - 39}" class="tm s95">` +
        `Evaluated on isolated git worktrees (<tspan class="mono">git archive HEAD</tspan>, zero answer-key or customization leakage) · normalized per row to the best arm (<tspan class="mono">1.0×</tspan>, shorter = lower cost).</text>` +
        `<text x="${M_L}" y="${totalH - 25}" class="tm s95">` +
        `Faded bars exceed ${MAX_REL.toFixed(0)}× (true multiple labelled) · tool output tokens = <tspan class="mono">ceil(bytes / 4)</tspan> · cumulative input = <tspan class="mono">uncached + cache_write + cache_read</tspan> across all turns.</text>` +
        `<text x="${M_L}" y="${totalH - 11}" class="tm s95">` +
        (includeDetail
            ? `Engine compaction measured across 24 natural-language intent queries on 6 pinned repositories (14,475 nodes, 29,088 edges) · reproduce via <tspan class="mono">npm run bench</tspan> and <tspan class="mono">node bench/eval-fast.js</tspan>.</text>`
            : `Full per-model and per-task tables (<tspan class="mono">T1–T12</tspan>, <tspan class="mono">S1–S8</tspan>, and <tspan class="mono">L1–L8</tspan>) are in <tspan class="mono">bench/README.md</tspan>.</text>`);

    return documentSvg(behind.join("") + front.join("") + footerSvg, totalH);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const argVal = (flag, dflt) => {
        const i = process.argv.indexOf(flag);
        return i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : dflt;
    };
    const benchDir = argVal("--bench-dir", import.meta.dirname);
    const outDir = argVal("--out-dir", import.meta.dirname);
    mkdirSync(outDir, { recursive: true });
    const smallPath = resolve(outDir, "chart-small.svg");
    const fullPath = resolve(outDir, "chart.svg");
    const smallSvg = renderChart(false, benchDir);
    writeFileSync(smallPath, smallSvg, "utf8");
    writeFileSync(fullPath, renderChart(true, benchDir), "utf8");
    if (outDir === resolve(import.meta.dirname)) {
        const assetsDir = resolve(import.meta.dirname, "../assets");
        mkdirSync(assetsDir, { recursive: true });
        writeFileSync(resolve(assetsDir, "chart-small.svg"), smallSvg, "utf8");
    }
    console.log(`Wrote ${smallPath} and ${fullPath}`);
}
