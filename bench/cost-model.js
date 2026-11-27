/**
 * Live-calibrated cost model & published cache-aware USD pricing (`bench/cost-model.js`).
 *
 * Fits, per model family, how live wall time / output / cumulative input tokens scale
 * with the quantities an offline evaluator can predict (turns, Turn-0 injection size),
 * using every recorded live run in `bench/results-*.json`. `eval-fast.js` uses these fits
 * to turn offline coverage into `EstWall` / `EstCum`, instead of hand-tuned penalties.
 *
 *   wall_ms  ≈ w0 + w1·turns + w2·outTok          (model latency is mostly decode time)
 *   outTok   ≈ o0 + o1·turns
 *   cumIn    ≈ c0 + c1·(turns+1) + c2·(turns+1)·t0Tok   (Turn-0 tokens are re-billed every turn)
 *   uncIn    ≈ u0 + u1·turns + t0Tok              (tokens written to prompt cache once per session)
 *   cost     ≈ 1.25·uncIn + 0.1·(cumIn - uncIn) + 5·outTok (Anthropic cache-aware API cost units)
 *
 * Also provides versioned published per-1M-token USD pricing (`MODEL_PRICING_USD_PER_M`)
 * and `computeApiCostUsd()` for reporting real cache-aware dollar costs alongside tokens.
 *
 * Usage: node bench/cost-model.js   — prints coefficients, R², leave-one-out MAPE.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PRICING_TABLE_VERSION = "2026-11";

/** Published per-1M-token USD pricing rates (`$/1M` tokens). */
export const MODEL_PRICING_USD_PER_M = {
    "claude-opus-5-5": { uncachedInput: 15.0, cacheWrite: 18.75, cacheRead: 1.5, output: 75.0 },
    "claude-sonnet-5-5": { uncachedInput: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
    "gemini-4-neon": { uncachedInput: 2.5, cacheWrite: 2.5, cacheRead: 0.25, output: 15.0 },
    "gemini-4-carbon": { uncachedInput: 2.0, cacheWrite: 2.0, cacheRead: 0.2, output: 12.0 },
    "gemini-4-hydrogen": { uncachedInput: 0.5, cacheWrite: 0.5, cacheRead: 0.05, output: 3.0 },
};

const roundUsd = (x) => Number((Number.isFinite(x) ? x : 0).toFixed(6));

/**
 * Resolve pricing entry for a model name or benchmark alias.
 */
export function resolveModelPricing(modelName = "claude-sonnet-5-5") {
    const raw = String(modelName || "").trim().toLowerCase();
    if (!raw) {
        return { modelKey: "claude-sonnet-5-5", ...MODEL_PRICING_USD_PER_M["claude-sonnet-5-5"], unknownModel: true };
    }
    if (MODEL_PRICING_USD_PER_M[raw]) {
        return { modelKey: raw, ...MODEL_PRICING_USD_PER_M[raw], unknownModel: false };
    }
    if (raw.includes("opus")) {
        return { modelKey: "claude-opus-5-5", ...MODEL_PRICING_USD_PER_M["claude-opus-5-5"], unknownModel: false };
    }
    if (raw.includes("sonnet")) {
        return { modelKey: "claude-sonnet-5-5", ...MODEL_PRICING_USD_PER_M["claude-sonnet-5-5"], unknownModel: false };
    }
    if (raw.includes("neon")) {
        return { modelKey: "gemini-4-neon", ...MODEL_PRICING_USD_PER_M["gemini-4-neon"], unknownModel: false };
    }
    if (raw.includes("carbon")) {
        return { modelKey: "gemini-4-carbon", ...MODEL_PRICING_USD_PER_M["gemini-4-carbon"], unknownModel: false };
    }
    if (raw.includes("hydrogen") || raw.includes("h2")) {
        return { modelKey: "gemini-4-hydrogen", ...MODEL_PRICING_USD_PER_M["gemini-4-hydrogen"], unknownModel: false };
    }
    return { modelKey: "claude-sonnet-5-5", ...MODEL_PRICING_USD_PER_M["claude-sonnet-5-5"], unknownModel: true };
}

function priceSliceUsd(metrics, modelName) {
    const pricing = resolveModelPricing(modelName);
    const hasExplicitSplit =
        typeof metrics?.cacheWriteTokens === "number" &&
        typeof metrics?.cacheReadTokens === "number";
    const legacyCacheSplit = !hasExplicitSplit;
    const uncached = Math.max(0, metrics?.uncachedInputTokens || 0);
    const cacheWrite = hasExplicitSplit ? Math.max(0, metrics.cacheWriteTokens) : 0;
    const cacheRead = hasExplicitSplit
        ? Math.max(0, metrics.cacheReadTokens)
        : Math.max(0, metrics?.cachedInputTokens || 0);
    const output = Math.max(0, metrics?.totalModelOutputTokens || 0);

    const inputUsd = (uncached * pricing.uncachedInput) / 1e6;
    const cacheWriteUsd = (cacheWrite * pricing.cacheWrite) / 1e6;
    const cacheReadUsd = (cacheRead * pricing.cacheRead) / 1e6;
    const outputUsd = (output * pricing.output) / 1e6;
    return {
        modelKey: pricing.modelKey,
        inputUsd: roundUsd(inputUsd),
        cacheWriteUsd: roundUsd(cacheWriteUsd),
        cacheReadUsd: roundUsd(cacheReadUsd),
        outputUsd: roundUsd(outputUsd),
        totalUsd: roundUsd(inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd),
        legacyCacheSplit,
    };
}

/**
 * Compute real cache-aware API cost (`$`) for an arm metrics object.
 * Uses `armMetrics.modelBreakdown` when multi-model (Orchestrator) breakdown is present.
 */
export function computeApiCostUsd(armMetrics, modelName = "claude-sonnet-5-5") {
    if (!armMetrics) {
        return {
            totalUsd: 0,
            inputUsd: 0,
            cacheWriteUsd: 0,
            cacheReadUsd: 0,
            outputUsd: 0,
            pricingVersion: PRICING_TABLE_VERSION,
            legacyCacheSplit: true,
            byModel: {},
        };
    }

    const mb = armMetrics.modelBreakdown;
    if (mb && typeof mb === "object" && Object.keys(mb).length > 0) {
        let inputUsd = 0;
        let cacheWriteUsd = 0;
        let cacheReadUsd = 0;
        let outputUsd = 0;
        let legacyCacheSplit = false;
        const byModel = {};
        for (const [subModel, subMetrics] of Object.entries(mb)) {
            const part = priceSliceUsd(subMetrics, subModel);
            inputUsd += part.inputUsd;
            cacheWriteUsd += part.cacheWriteUsd;
            cacheReadUsd += part.cacheReadUsd;
            outputUsd += part.outputUsd;
            if (part.legacyCacheSplit) legacyCacheSplit = true;
            byModel[subModel] = part;
        }
        return {
            totalUsd: roundUsd(inputUsd + cacheWriteUsd + cacheReadUsd + outputUsd),
            inputUsd: roundUsd(inputUsd),
            cacheWriteUsd: roundUsd(cacheWriteUsd),
            cacheReadUsd: roundUsd(cacheReadUsd),
            outputUsd: roundUsd(outputUsd),
            pricingVersion: PRICING_TABLE_VERSION,
            legacyCacheSplit,
            byModel,
        };
    }

    const single = priceSliceUsd(armMetrics, modelName);
    return {
        totalUsd: single.totalUsd,
        inputUsd: single.inputUsd,
        cacheWriteUsd: single.cacheWriteUsd,
        cacheReadUsd: single.cacheReadUsd,
        outputUsd: single.outputUsd,
        pricingVersion: PRICING_TABLE_VERSION,
        legacyCacheSplit: single.legacyCacheSplit,
        byModel: { [single.modelKey]: single },
    };
}

export const RESULT_FILES = {
    opus: ["results-opus.json", "results-swebench-opus.json", "results-large-opus.json"],
    sonnet: ["results-sonnet.json", "results-swebench-sonnet.json", "results-large-sonnet.json"],
};

export const OPTIONAL_RESULT_FILES = {
    "neon-medium": [
        "results-neon-medium.json",
        "results-swebench-neon-medium.json",
        "results-large-neon-medium.json",
    ],
    "carbon-medium": [
        "results-carbon-medium.json",
        "results-swebench-carbon-medium.json",
        "results-large-carbon-medium.json",
    ],
    "hydrogen-medium": [
        "results-hydrogen-medium.json",
        "results-swebench-hydrogen-medium.json",
        "results-large-hydrogen-medium.json",
    ],
    "orch-neon-high-hydrogen-high": [
        "results-orch-neon-high-hydrogen-high.json",
        "results-swebench-orch-neon-high-hydrogen-high.json",
        "results-large-orch-neon-high-hydrogen-high.json",
    ],
    "orch-neon-high-hydrogen-xhigh": [
        "results-orch-neon-high-hydrogen-xhigh.json",
        "results-swebench-orch-neon-high-hydrogen-xhigh.json",
        "results-large-orch-neon-high-hydrogen-xhigh.json",
    ],
    "orch-neon-xhigh-hydrogen-xhigh": [
        "results-orch-neon-xhigh-hydrogen-xhigh.json",
        "results-swebench-orch-neon-xhigh-hydrogen-xhigh.json",
        "results-large-orch-neon-xhigh-hydrogen-xhigh.json",
    ],
};

/** Ordinary least squares via normal equations (Gauss-Jordan). Returns coefficient array. */
export function ols(X, y, ridge = 1e-9) {
    const n = X[0].length;
    const A = Array.from({ length: n }, () => Array(n + 1).fill(0));
    X.forEach((x, i) => {
        for (let j = 0; j < n; j++) {
            A[j][n] += x[j] * y[i];
            for (let k = 0; k < n; k++) A[j][k] += x[j] * x[k];
        }
    });
    for (let j = 0; j < n; j++) A[j][j] += ridge;
    for (let i = 0; i < n; i++) {
        let p = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
        [A[i], A[p]] = [A[p], A[i]];
        const piv = A[i][i] || 1e-12;
        for (let k = i; k <= n; k++) A[i][k] /= piv;
        for (let r = 0; r < n; r++) {
            if (r === i) continue;
            const m = A[r][i];
            for (let k = i; k <= n; k++) A[r][k] -= m * A[i][k];
        }
    }
    return A.map((row) => row[n]);
}

export const dot = (c, x) => c.reduce((a, ci, i) => a + ci * x[i], 0);

/** R² and leave-one-out mean absolute percentage error of a linear fit. */
export function fitStats(X, y, ridge = 1e-9) {
    const c = ols(X, y, ridge);
    const my = y.reduce((a, v) => a + v, 0) / y.length;
    const ssr = y.reduce((a, v, i) => a + (v - dot(c, X[i])) ** 2, 0);
    const sst = y.reduce((a, v) => a + (v - my) ** 2, 0);
    let ape = 0;
    for (let i = 0; i < y.length; i++) {
        const ci = ols(X.filter((_, k) => k !== i), y.filter((_, k) => k !== i), ridge);
        ape += Math.abs(dot(ci, X[i]) - y[i]) / Math.max(1, Math.abs(y[i]));
    }
    return { c, r2: 1 - ssr / sst, looMape: ape / y.length };
}

const WARM_PREFIX_TOKENS = {
    opus: 6583,
    sonnet: 6710,
};

const CLAUDE_DEFAULT_FAMILIES = new Set(Object.keys(RESULT_FILES));

function extractUsdBreakdown(x, family, fallbackUnc, fallbackCacheRead) {
    const metricInput = !x.modelBreakdown && x.uncachedInputTokens === undefined
        ? { ...x, uncachedInputTokens: fallbackUnc, cachedInputTokens: x.cachedInputTokens ?? fallbackCacheRead }
        : x;
    const apiCost = computeApiCostUsd(metricInput, family);
    let neonUsd = 0;
    let h2Usd = 0;
    let neonOut = 0;
    let h2Out = 0;
    let neonUnc = 0;
    let h2Unc = 0;
    if (x.modelBreakdown && typeof x.modelBreakdown === "object") {
        for (const [subModel, sub] of Object.entries(x.modelBreakdown)) {
            const low = subModel.toLowerCase();
            const part = apiCost.byModel?.[subModel];
            if (low.includes("neon")) {
                neonUsd += part?.totalUsd ?? 0;
                neonOut += sub?.totalModelOutputTokens || 0;
                neonUnc += sub?.uncachedInputTokens || 0;
            } else if (low.includes("hydrogen") || low.includes("h2")) {
                h2Usd += part?.totalUsd ?? 0;
                h2Out += sub?.totalModelOutputTokens || 0;
                h2Unc += sub?.uncachedInputTokens || 0;
            }
        }
    }
    return {
        usd: apiCost.totalUsd,
        inputUsd: apiCost.inputUsd,
        cacheReadUsd: apiCost.cacheReadUsd + apiCost.cacheWriteUsd,
        outputUsd: apiCost.outputUsd,
        neonUsd: roundUsd(neonUsd),
        h2Usd: roundUsd(h2Usd),
        neonOut,
        h2Out,
        neonUnc,
        h2Unc,
    };
}

/**
 * Load per-task live rows: {family, suite, id, arm, turns, calls, out, ms, apiMs, cum, final, unc, cacheRead, cost, usd, neonUsd, h2Usd, neonOut, h2Out}.
 * `t0Tok` is filled in later by the caller (it is an offline quantity).
 * Default `opus`/`sonnet` rows stay strictly pinned to `RESULT_FILES` for `eval-fast.js` calibration,
 * while optional families (`neon-medium`, `carbon-medium`, `hydrogen-medium`, `orch-neon-high-hydrogen-high`, `orch-neon-high-hydrogen-xhigh`, `orch-neon-xhigh-hydrogen-xhigh`) are loaded when present.
 */
export function loadRows(benchDir = import.meta.dirname, options = {}) {
    const { includeOptional = true, families = null } = options;
    const fileMap = includeOptional ? { ...RESULT_FILES, ...OPTIONAL_RESULT_FILES } : RESULT_FILES;
    const selectedFamilies = families ? new Set(families) : null;
    const rows = [];
    for (const [family, files] of Object.entries(fileMap)) {
        if (selectedFamilies && !selectedFamilies.has(family)) continue;
        const warmPrefix = WARM_PREFIX_TOKENS[family] ?? 6600;
        const isClaudeDefault = CLAUDE_DEFAULT_FAMILIES.has(family);
        for (const f of files) {
            const p = resolve(benchDir, f);
            if (!existsSync(p)) continue;
            const r = JSON.parse(readFileSync(p, "utf8"));
            for (const t of r.tasks ?? []) {
                for (const arm of ["cold", "plexer"]) {
                    const x = t[arm];
                    if (!x) continue;
                    const unc =
                        !isClaudeDefault && (x.uncachedInputTokens || 0) > 1000
                            ? x.uncachedInputTokens
                            : Math.max(0, x.finalContextTokens - warmPrefix + 2 * (x.turns + 1));
                    const cacheRead = Math.max(0, x.cumulativeInputTokens - unc);
                    const usdInfo = extractUsdBreakdown(x, family, unc, cacheRead);
                    const cost = isClaudeDefault
                        ? 1.25 * unc + 0.1 * cacheRead + 5 * x.totalModelOutputTokens
                        : usdInfo.usd * 1e6;
                    rows.push({
                        family,
                        suite: f.includes("swebench") ? "S" : f.includes("large") ? "L" : "T",
                        id: t.id,
                        arm,
                        turns: x.turns,
                        calls: x.calls,
                        out: x.totalModelOutputTokens,
                        ms: x.totalMs,
                        cum: x.cumulativeInputTokens,
                        final: x.finalContextTokens,
                        unc,
                        cacheRead,
                        cost,
                        usd: usdInfo.usd,
                        inputUsd: usdInfo.inputUsd,
                        cacheReadUsd: usdInfo.cacheReadUsd,
                        outputUsd: usdInfo.outputUsd,
                        neonUsd: usdInfo.neonUsd,
                        h2Usd: usdInfo.h2Usd,
                        neonOut: usdInfo.neonOut,
                        h2Out: usdInfo.h2Out,
                        neonUnc: usdInfo.neonUnc,
                        h2Unc: usdInfo.h2Unc,
                        score: x.score,
                    });
                }
            }
        }
    }
    return rows;
}

function calibrateEffectiveUsdRates(rows) {
    const family = rows[0]?.family ?? "";
    const plexerRows = rows.filter((r) => r.arm === "plexer");
    const sample = plexerRows.length ? plexerRows : rows;
    const sum = (k) => sample.reduce((a, r) => a + (r[k] || 0), 0);
    const totalUnc = sum("unc");
    const totalCr = sum("cacheRead");
    const totalOut = sum("out");
    const fallback = resolveModelPricing(family.includes("orch") ? "gemini-4-neon" : family);
    return {
        unc: totalUnc > 0 ? (sum("inputUsd") * 1e6) / totalUnc : fallback.uncachedInput,
        cr: totalCr > 0 ? (sum("cacheReadUsd") * 1e6) / totalCr : fallback.cacheRead,
        out: totalOut > 0 ? (sum("outputUsd") * 1e6) / totalOut : fallback.output,
        isClaudeDefault: CLAUDE_DEFAULT_FAMILIES.has(family),
    };
}

function fitOutputModel(rows, t0Of) {
    const isClaudeDefault = CLAUDE_DEFAULT_FAMILIES.has(rows[0]?.family ?? "");
    const yOut = rows.map((r) => r.out);
    const t0Vals = rows.map((r) => t0Of(r));
    if (!isClaudeDefault && t0Vals.some((v) => v > 0)) {
        const X3 = rows.map((r, i) => [1, r.turns, t0Vals[i]]);
        const res = fitStats(X3, yOut, 1e-4);
        if (Number.isFinite(res.c[2]) && res.c[2] >= 0) {
            return res;
        }
    }
    const base = fitStats(rows.map((r) => [1, r.turns]), yOut);
    return { ...base, c: [base.c[0], base.c[1], 0] };
}

/** Fit the cost equations for one family. `t0Of(row)` supplies Turn-0 tokens. */
export function fitFamily(rows, t0Of = () => 0) {
    const wall = fitStats(rows.map((r) => [1, r.turns, r.out]), rows.map((r) => r.ms));
    const out = fitOutputModel(rows, t0Of);
    const baseCum = fitStats(
        rows.map((r) => [1, r.turns + 1]),
        rows.map((r) => r.cum - (r.turns + 1) * t0Of(r))
    );
    const cum = { ...baseCum, c: [baseCum.c[0], baseCum.c[1], 1] };
    const baseUnc = fitStats(
        rows.map((r) => [1, r.turns]),
        rows.map((r) => r.unc - t0Of(r))
    );
    const unc = { ...baseUnc, c: [baseUnc.c[0], baseUnc.c[1], 1] };
    const rates = calibrateEffectiveUsdRates(rows);
    return { wall, out, cum, unc, rates, n: rows.length };
}

/** Predict {wallMs, outTok, cumIn, uncIn, cost, usd} for a given turn count and Turn-0 token load. */
export function predict(model, turns, t0Tok = 0) {
    const outC = model.out.c.length >= 3 ? model.out.c : [model.out.c[0], model.out.c[1], 0];
    const outTok = Math.max(0, dot(outC, [1, turns, Math.max(0, t0Tok)]));
    const cumIn = Math.max(0, dot(model.cum.c, [1, turns + 1, (turns + 1) * t0Tok]));
    const uncIn = Math.max(0, dot(model.unc.c, [1, turns, t0Tok]));
    const cacheRead = Math.max(0, cumIn - uncIn);
    const r = model.rates;
    const usd = r
        ? (uncIn * r.unc + cacheRead * r.cr + outTok * r.out) / 1e6
        : (1.25 * uncIn + 0.1 * cacheRead + 5 * outTok) / 1e6;
    const cost = r && !r.isClaudeDefault
        ? usd * 1e6
        : 1.25 * uncIn + 0.1 * cacheRead + 5 * outTok;
    return {
        outTok,
        wallMs: Math.max(0, dot(model.wall.c, [1, turns, outTok])),
        cumIn,
        uncIn,
        cost,
        usd,
    };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const rows = loadRows(import.meta.dirname, { includeOptional: true });
    for (const family of [...Object.keys(RESULT_FILES), ...Object.keys(OPTIONAL_RESULT_FILES)]) {
        const R = rows.filter((r) => r.family === family);
        if (!R.length) continue;
        const m = fitFamily(R);
        const f = (s) => `[${s.c.map((v) => v.toFixed(v > 100 ? 0 : 2)).join(", ")}] R²=${s.r2.toFixed(3)} LOO-MAPE=${(s.looMape * 100).toFixed(1)}%`;
        const coldUsd = R.filter((r) => r.arm === "cold").reduce((a, r) => a + r.usd, 0);
        const plexUsd = R.filter((r) => r.arm === "plexer").reduce((a, r) => a + r.usd, 0);
        console.log(`${family} (n=${m.n}) | cold=$${coldUsd.toFixed(3)} plexer=$${plexUsd.toFixed(3)} | rates=$[${m.rates.unc.toFixed(2)}, ${m.rates.cr.toFixed(2)}, ${m.rates.out.toFixed(2)}]/M`);
        console.log(`  wall_ms ~ 1, turns, outTok      ${f(m.wall)}`);
        console.log(`  outTok  ~ 1, turns, t0Tok       ${f(m.out)}`);
        console.log(`  cumIn   ~ 1, turns+1, (t+1)·t0  ${f(m.cum)}   (t0=0 here; eval-fast refits with offline t0)`);
        console.log(`  uncIn   ~ 1, turns, t0          ${f(m.unc)}   (t0=0 here; eval-fast refits with offline t0)`);
    }
}
