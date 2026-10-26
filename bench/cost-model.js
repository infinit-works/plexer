#!/usr/bin/env node
/**
 * Live-calibrated cost model (`bench/cost-model.js`, $0, offline).
 *
 * Fits, per model family, how live wall time / output / cumulative input tokens scale
 * with the quantities an offline evaluator can predict (turns, Turn-0 injection size),
 * using every recorded live run in `bench/results-*.json`. `eval-fast.js` uses these fits
 * to turn offline coverage into `EstWall` / `EstCum`, instead of hand-tuned penalties.
 *
 *   wall_ms  ≈ w0 + w1·turns + w2·outTok          (model latency is mostly decode time)
 *   outTok   ≈ o0 + o1·turns
 *   cumIn    ≈ c0 + c1·(turns+1) + c2·(turns+1)·t0Tok   (Turn-0 tokens are re-billed every turn)
 *
 * Usage: node bench/cost-model.js   — prints coefficients, R², leave-one-out MAPE.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const RESULT_FILES = {
    opus: ["results-opus.json", "results-swebench-opus.json"],
    sonnet: ["results-sonnet.json", "results-swebench-sonnet.json"],
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
export function fitStats(X, y) {
    const c = ols(X, y);
    const my = y.reduce((a, v) => a + v, 0) / y.length;
    const ssr = y.reduce((a, v, i) => a + (v - dot(c, X[i])) ** 2, 0);
    const sst = y.reduce((a, v) => a + (v - my) ** 2, 0);
    let ape = 0;
    for (let i = 0; i < y.length; i++) {
        const ci = ols(X.filter((_, k) => k !== i), y.filter((_, k) => k !== i));
        ape += Math.abs(dot(ci, X[i]) - y[i]) / Math.max(1, Math.abs(y[i]));
    }
    return { c, r2: 1 - ssr / sst, looMape: ape / y.length };
}

/**
 * Load per-task live rows: {family, suite, id, arm, turns, calls, out, ms, apiMs, cum, final}.
 * `t0Tok` is filled in later by the caller (it is an offline quantity).
 */
export function loadRows(benchDir = import.meta.dirname) {
    const rows = [];
    for (const [family, files] of Object.entries(RESULT_FILES)) {
        for (const f of files) {
            const p = resolve(benchDir, f);
            if (!existsSync(p)) continue;
            const r = JSON.parse(readFileSync(p, "utf8"));
            for (const t of r.tasks ?? []) {
                for (const arm of ["cold", "plexer"]) {
                    const x = t[arm];
                    if (!x) continue;
                    rows.push({
                        family,
                        suite: f.includes("swebench") ? "S" : "T",
                        id: t.id,
                        arm,
                        turns: x.turns,
                        calls: x.calls,
                        out: x.totalModelOutputTokens,
                        ms: x.totalMs,
                        cum: x.cumulativeInputTokens,
                        final: x.finalContextTokens,
                        score: x.score,
                    });
                }
            }
        }
    }
    return rows;
}

/** Fit the three cost equations for one family. `t0Of(row)` supplies Turn-0 tokens. */
export function fitFamily(rows, t0Of = () => 0) {
    const wall = fitStats(rows.map((r) => [1, r.turns, r.out]), rows.map((r) => r.ms));
    const out = fitStats(rows.map((r) => [1, r.turns]), rows.map((r) => r.out));
    const baseCum = fitStats(
        rows.map((r) => [1, r.turns + 1]),
        rows.map((r) => r.cum - (r.turns + 1) * t0Of(r))
    );
    const cum = { ...baseCum, c: [baseCum.c[0], baseCum.c[1], 1] };
    return { wall, out, cum, n: rows.length };
}

/** Predict {wallMs, outTok, cumIn} for a given turn count and Turn-0 token load. */
export function predict(model, turns, t0Tok) {
    const outTok = Math.max(0, dot(model.out.c, [1, turns]));
    return {
        outTok,
        wallMs: Math.max(0, dot(model.wall.c, [1, turns, outTok])),
        cumIn: Math.max(0, dot(model.cum.c, [1, turns + 1, (turns + 1) * t0Tok])),
    };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const rows = loadRows();
    for (const family of Object.keys(RESULT_FILES)) {
        const R = rows.filter((r) => r.family === family);
        if (!R.length) continue;
        const m = fitFamily(R);
        const f = (s) => `[${s.c.map((v) => v.toFixed(v > 100 ? 0 : 2)).join(", ")}] R²=${s.r2.toFixed(3)} LOO-MAPE=${(s.looMape * 100).toFixed(1)}%`;
        console.log(`${family} (n=${m.n})`);
        console.log(`  wall_ms ~ 1, turns, outTok      ${f(m.wall)}`);
        console.log(`  outTok  ~ 1, turns              ${f(m.out)}`);
        console.log(`  cumIn   ~ 1, turns+1, (t+1)·t0  ${f(m.cum)}   (t0=0 here; eval-fast refits with offline t0)`);
    }
}
