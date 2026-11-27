/**
 * Zero-dependency statistical summary and paired hypothesis-testing helpers
 * for `plexer` multi-trial live A/B benchmarks (`bench/stats.js`).
 */

/**
 * Compute sorted finite numeric array copy.
 * @param {number[]} xs
 * @returns {number[]}
 */
function sortedFinite(xs) {
    return (Array.isArray(xs) ? xs : [])
        .filter((v) => typeof v === "number" && Number.isFinite(v))
        .sort((a, b) => a - b);
}

/**
 * Deterministic Mulberry32 PRNG.
 * @param {number} [seed=0x504c5852]
 * @returns {() => number}
 */
export function seededRng(seed = 0x504c5852) {
    let a = seed >>> 0;
    return function next() {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Linear-interpolated empirical quantile (`0 <= q <= 1`).
 * @param {number[]} xs
 * @param {number} q
 * @returns {number}
 */
export function quantile(xs, q) {
    const s = sortedFinite(xs);
    if (s.length === 0) return 0;
    if (q <= 0) return s[0];
    if (q >= 1) return s[s.length - 1];
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const frac = pos - lo;
    return s[lo] * (1 - frac) + s[hi] * frac;
}

/**
 * Median of numeric values.
 * @param {number[]} xs
 * @returns {number}
 */
export function median(xs) {
    return quantile(xs, 0.5);
}

/**
 * Interquartile summary (`{ p25, median, p75, iqr }`).
 * @param {number[]} xs
 * @returns {{ p25: number, median: number, p75: number, iqr: number }}
 */
export function iqr(xs) {
    const s = sortedFinite(xs);
    if (s.length === 0) {
        return { p25: 0, median: 0, p75: 0, iqr: 0 };
    }
    const p25 = quantile(s, 0.25);
    const med = quantile(s, 0.5);
    const p75 = quantile(s, 0.75);
    return { p25, median: med, p75, iqr: Math.max(0, p75 - p25) };
}

function sampleStatistic(xs, stat) {
    if (stat === "mean") {
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    }
    if (stat === "sum") {
        return xs.reduce((a, b) => a + b, 0);
    }
    return median(xs);
}

/**
 * Seeded percentile bootstrap confidence interval over `values`.
 */
export function bootstrapCI(
    values,
    { stat = "median", iterations = 10000, alpha = 0.05, seed = 0x504c5852 } = {}
) {
    const xs = (Array.isArray(values) ? values : []).filter(
        (v) => typeof v === "number" && Number.isFinite(v)
    );
    const n = xs.length;
    if (n === 0) {
        return { estimate: 0, ciLow: 0, ciHigh: 0, iterations: 0, alpha };
    }
    const estimate = sampleStatistic(xs, stat);
    if (n === 1) {
        return { estimate, ciLow: estimate, ciHigh: estimate, iterations: 0, alpha };
    }
    const rand = seededRng(seed);
    const dist = new Array(iterations);
    const sample = new Array(n);
    for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < n; i++) {
            sample[i] = xs[Math.floor(rand() * n)];
        }
        dist[it] = sampleStatistic(sample, stat);
    }
    dist.sort((a, b) => a - b);
    return {
        estimate,
        ciLow: quantile(dist, alpha / 2),
        ciHigh: quantile(dist, 1 - alpha / 2),
        iterations,
        alpha,
    };
}

/**
 * Seeded paired bootstrap confidence interval for `% delta = ((plexer - cold) / cold) * 100`.
 */
export function bootstrapPairedPctDeltaCI(
    coldVals,
    plexerVals,
    { iterations = 10000, alpha = 0.05, seed = 0x504c5852, mode = "sum" } = {}
) {
    const n = Math.min(coldVals?.length || 0, plexerVals?.length || 0);
    const pairs = [];
    for (let i = 0; i < n; i++) {
        const c = coldVals[i];
        const p = plexerVals[i];
        if (Number.isFinite(c) && Number.isFinite(p)) {
            pairs.push([c, p]);
        }
    }
    if (pairs.length === 0) {
        return { estimate: 0, ciLow: 0, ciHigh: 0, iterations: 0, alpha };
    }

    const evalPairs = (arr) => {
        if (mode === "medianRatio") {
            const deltas = arr
                .filter(([c]) => c > 0)
                .map(([c, p]) => ((p - c) / c) * 100);
            return deltas.length ? median(deltas) : 0;
        }
        let sumC = 0;
        let sumP = 0;
        for (const [c, p] of arr) {
            sumC += c;
            sumP += p;
        }
        return sumC > 0 ? ((sumP - sumC) / sumC) * 100 : 0;
    };

    const estimate = evalPairs(pairs);
    if (pairs.length === 1) {
        return { estimate, ciLow: estimate, ciHigh: estimate, iterations: 0, alpha };
    }

    const rand = seededRng(seed);
    const dist = new Array(iterations);
    const sample = new Array(pairs.length);
    for (let it = 0; it < iterations; it++) {
        for (let i = 0; i < pairs.length; i++) {
            sample[i] = pairs[Math.floor(rand() * pairs.length)];
        }
        dist[it] = evalPairs(sample);
    }
    dist.sort((a, b) => a - b);
    return {
        estimate,
        ciLow: quantile(dist, alpha / 2),
        ciHigh: quantile(dist, 1 - alpha / 2),
        iterations,
        alpha,
    };
}

/**
 * Standard normal CDF approximation (`erf` via Abramowitz & Stegun 7.1.26).
 */
function normalCdf(z) {
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

/**
 * Two-sided paired Wilcoxon signed-rank test on `(coldVals[i], plexerVals[i])`.
 * Uses exact dynamic programming on doubled ranks when `nonZeroN <= 25`,
 * and normal approximation with continuity + tie correction for larger `nonZeroN`.
 */
export function wilcoxonSignedRank(coldVals, plexerVals) {
    const n = Math.min(coldVals?.length || 0, plexerVals?.length || 0);
    const diffs = [];
    for (let i = 0; i < n; i++) {
        const d = coldVals[i] - plexerVals[i];
        if (Number.isFinite(d) && d !== 0) {
            diffs.push({ sign: d > 0 ? 1 : -1, abs: Math.abs(d) });
        }
    }
    const nonZeroN = diffs.length;
    if (nonZeroN === 0) {
        return { n, nonZeroN: 0, Wplus: 0, Wminus: 0, W: 0, pValue: 1, significant05: false };
    }

    diffs.sort((a, b) => a.abs - b.abs);
    let Wplus = 0;
    let Wminus = 0;
    let tieCorrection = 0;
    const doubledRanks = new Array(nonZeroN);

    let i = 0;
    while (i < nonZeroN) {
        let j = i + 1;
        while (j < nonZeroN && diffs[j].abs === diffs[i].abs) j++;
        const avgRank = (i + 1 + j) / 2;
        const count = j - i;
        if (count > 1) {
            tieCorrection += count ** 3 - count;
        }
        for (let k = i; k < j; k++) {
            doubledRanks[k] = Math.round(avgRank * 2);
            if (diffs[k].sign > 0) Wplus += avgRank;
            else Wminus += avgRank;
        }
        i = j;
    }

    const W = Math.min(Wplus, Wminus);
    let pValue = 1;
    if (nonZeroN <= 25) {
        const totalSum2 = doubledRanks.reduce((a, b) => a + b, 0);
        const w2 = Math.round(W * 2);
        const dp = new Float64Array(totalSum2 + 1);
        dp[0] = 1;
        let maxSoFar = 0;
        for (const r2 of doubledRanks) {
            for (let s = maxSoFar; s >= 0; s--) {
                dp[s + r2] += dp[s];
            }
            maxSoFar += r2;
        }
        let tail = 0;
        for (let s = 0; s <= w2; s++) {
            tail += dp[s];
        }
        const totalWays = 2 ** nonZeroN;
        pValue = Math.min(1, (2 * tail) / totalWays);
    } else {
        const mean = (nonZeroN * (nonZeroN + 1)) / 4;
        const variance =
            (nonZeroN * (nonZeroN + 1) * (2 * nonZeroN + 1) - tieCorrection / 2) / 24;
        if (variance <= 0) {
            pValue = 1;
        } else {
            const z = (Math.abs(W - mean) - 0.5) / Math.sqrt(variance);
            pValue = Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.max(0, z)))));
        }
    }

    return {
        n,
        nonZeroN,
        Wplus,
        Wminus,
        W,
        pValue: Number(pValue.toFixed(6)),
        significant05: pValue < 0.05,
    };
}

/**
 * Exact two-sided paired binomial sign test.
 */
export function pairedSignTest(coldVals, plexerVals, { lowerIsBetter = true } = {}) {
    const n = Math.min(coldVals?.length || 0, plexerVals?.length || 0);
    let wins = 0;
    let ties = 0;
    let losses = 0;
    for (let i = 0; i < n; i++) {
        const c = coldVals[i];
        const p = plexerVals[i];
        if (!Number.isFinite(c) || !Number.isFinite(p)) continue;
        if (p === c) {
            ties++;
        } else if ((lowerIsBetter && p < c) || (!lowerIsBetter && p > c)) {
            wins++;
        } else {
            losses++;
        }
    }
    const m = wins + losses;
    if (m === 0) {
        return { wins, ties, losses, n, pValue: 1 };
    }
    const kMax = Math.min(wins, losses);
    // Compute exact binomial sum sum_{i=0..kMax} C(m, i) * 0.5^m safely using ratio recurrence
    let probTerm = Math.pow(0.5, m);
    let cumProb = probTerm;
    for (let i = 0; i < kMax; i++) {
        probTerm = (probTerm * (m - i)) / (i + 1);
        cumProb += probTerm;
    }
    const pValue = Math.min(1, Math.max(0, 2 * cumProb));
    return {
        wins,
        ties,
        losses,
        n,
        pValue: Number(pValue.toFixed(6)),
    };
}

const AGGREGATED_NUMERIC_METRICS = [
    "totalMs",
    "searchMs",
    "apiCostUsd",
    "cumulativeInputTokens",
    "postTurn1UncachedTokens",
    "netContextGrowthTokens",
    "toolOutputTokens",
    "uncachedInputTokens",
    "cacheWriteTokens",
    "cacheReadTokens",
    "cachedInputTokens",
    "totalModelOutputTokens",
    "calls",
    "turns",
    "finalContextTokens",
    "score",
];

function extractMetricValue(armResult, key) {
    if (!armResult) return null;
    if (key === "apiCostUsd") {
        if (typeof armResult.apiCostUsd === "number") return armResult.apiCostUsd;
        if (armResult.apiCost && typeof armResult.apiCost.totalUsd === "number") return armResult.apiCost.totalUsd;
        return null;
    }
    return typeof armResult[key] === "number" && Number.isFinite(armResult[key]) ? armResult[key] : null;
}

/**
 * Aggregate `N` repeated trial results for a single `(task, arm)` into median/IQR and resolved rates.
 */
export function aggregateTrials(trialArmResults) {
    const trials = Array.isArray(trialArmResults) ? trialArmResults.filter(Boolean) : [];
    const n = trials.length;
    if (n === 0) {
        return { trials: 0, unreplicated: true, trialStats: {} };
    }

    const latest = trials[trials.length - 1];
    const aggregated = { ...latest, trials: n, unreplicated: n < 2, trialStats: {} };

    for (const metric of AGGREGATED_NUMERIC_METRICS) {
        const vals = trials.map((t) => extractMetricValue(t, metric)).filter((v) => v !== null);
        if (vals.length > 0) {
            const summary = iqr(vals);
            aggregated[metric] = Number.isInteger(vals[0]) && Number.isInteger(summary.median)
                ? summary.median
                : metric === "apiCostUsd"
                  ? Number(summary.median.toFixed(6))
                  : Math.round(summary.median * 100) / 100;
            aggregated.trialStats[metric] = {
                ...summary,
                samples: vals,
            };
        }
    }

    const resolvedVals = trials.map((t) => t.resolved).filter((v) => typeof v === "boolean");
    if (resolvedVals.length > 0) {
        const passed = resolvedVals.filter(Boolean).length;
        aggregated.resolvedCount = passed;
        aggregated.resolvedTotal = resolvedVals.length;
        aggregated.resolvedRate = Number((passed / resolvedVals.length).toFixed(4));
        aggregated.resolved = passed > resolvedVals.length / 2;
    } else if (trials.some((t) => t.resolved === null)) {
        aggregated.resolved = null;
        aggregated.resolvedCount = 0;
        aggregated.resolvedTotal = 0;
        aggregated.resolvedRate = null;
    }

    return aggregated;
}

const SUITE_PAIRED_METRICS = [
    { key: "totalMs", lowerIsBetter: true },
    { key: "searchMs", lowerIsBetter: true },
    { key: "apiCostUsd", lowerIsBetter: true },
    { key: "cumulativeInputTokens", lowerIsBetter: true },
    { key: "postTurn1UncachedTokens", lowerIsBetter: true },
    { key: "netContextGrowthTokens", lowerIsBetter: true },
    { key: "toolOutputTokens", lowerIsBetter: true },
    { key: "calls", lowerIsBetter: true },
];

function summarizeSubset(rows, { iterations = 2000, seed = 0x504c5852 } = {}) {
    const valid = rows.filter((r) => r?.cold && r?.plexer);
    const metrics = {};

    for (const spec of SUITE_PAIRED_METRICS) {
        const coldVals = [];
        const plexerVals = [];
        for (const r of valid) {
            const cv = extractMetricValue(r.cold, spec.key);
            const pv = extractMetricValue(r.plexer, spec.key);
            if (cv !== null && pv !== null) {
                coldVals.push(cv);
                plexerVals.push(pv);
            }
        }
        const coldSum = coldVals.reduce((a, b) => a + b, 0);
        const plexerSum = plexerVals.reduce((a, b) => a + b, 0);
        const pctDelta = coldSum > 0 ? ((plexerSum - coldSum) / coldSum) * 100 : 0;
        const ci = bootstrapPairedPctDeltaCI(coldVals, plexerVals, {
            iterations,
            seed,
            mode: "sum",
        });
        const wilcoxon = wilcoxonSignedRank(coldVals, plexerVals);
        const signTest = pairedSignTest(coldVals, plexerVals, { lowerIsBetter: spec.lowerIsBetter });
        metrics[spec.key] = {
            n: coldVals.length,
            coldTotal: spec.key === "apiCostUsd" ? Number(coldSum.toFixed(6)) : coldSum,
            plexerTotal: spec.key === "apiCostUsd" ? Number(plexerSum.toFixed(6)) : plexerSum,
            coldMedian: median(coldVals),
            plexerMedian: median(plexerVals),
            pctDelta: Number(pctDelta.toFixed(2)),
            pctDeltaCI95: [Number(ci.ciLow.toFixed(2)), Number(ci.ciHigh.toFixed(2))],
            wilcoxonP: wilcoxon.pValue,
            signTestP: signTest.pValue,
            wtl: `${signTest.wins}W/${signTest.ties}T/${signTest.losses}L`,
        };
    }

    const coldResolved = valid.filter((r) => r.cold.resolved === true).length;
    const plexerResolved = valid.filter((r) => r.plexer.resolved === true).length;
    const resolvedDenom = valid.filter(
        (r) => typeof r.cold.resolved === "boolean" && typeof r.plexer.resolved === "boolean"
    ).length;

    return {
        tasks: valid.length,
        resolved: {
            cold: coldResolved,
            plexer: plexerResolved,
            verifiedPairs: resolvedDenom,
            coldRate: resolvedDenom > 0 ? Number((coldResolved / resolvedDenom).toFixed(4)) : null,
            plexerRate: resolvedDenom > 0 ? Number((plexerResolved / resolvedDenom).toFixed(4)) : null,
        },
        metrics,
    };
}

/**
 * Compute full paired statistical summary across all rows plus train/holdout/negativeControl/tier splits.
 */
export function summarizePairedSuite(taskRows, opts = {}) {
    const rows = Array.isArray(taskRows) ? taskRows.filter((r) => r?.cold && r?.plexer) : [];
    const byTier = {};
    for (const r of rows) {
        const tier = r.tier || r.sizeBucket || "unspecified";
        if (!byTier[tier]) byTier[tier] = [];
        byTier[tier].push(r);
    }
    const tierSummaries = {};
    for (const [tier, subset] of Object.entries(byTier)) {
        tierSummaries[tier] = summarizeSubset(subset, opts);
    }

    return {
        overall: summarizeSubset(rows, opts),
        train: summarizeSubset(rows.filter((r) => !r.holdout && !r.negativeControl), opts),
        holdout: summarizeSubset(rows.filter((r) => Boolean(r.holdout)), opts),
        negativeControl: summarizeSubset(rows.filter((r) => Boolean(r.negativeControl)), opts),
        byTier: tierSummaries,
    };
}
