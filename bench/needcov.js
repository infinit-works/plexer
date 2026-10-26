/**
 * NeedCov — how much of what agents actually needed is already in the Turn-0 injection.
 *
 * Inputs: the hook text (`relevantRetrieval` output), the repo graph (for symbol spans),
 * and one task's entry from `bench/needed-spans.json` (see `bench/replay.js`).
 *
 * Needs are grouped by innermost enclosing symbol and weighted by how many distinct runs
 * needed them, so a span one run skimmed counts less than a span every run read:
 *  - `needCov`: Σ_sym w·|inlined ∩ readLines| / |readLines|  ÷ Σ w   (ranged reads + gold hunks)
 *  - `locCov`:  share of needed symbols (reads + grep hits) whose span is named by a pointer
 *               or inlined — i.e. the agent would know where to look without searching.
 *  - `fileCov`: share of needed files (any kind of need) the injection names.
 */

const PTR = /([\w./@-]+\.[A-Za-z]+):L(\d+)(?:-L(\d+))?/g;

/** Parse hook text into inlined line sets and pointer ranges per file. */
export function parseInjection(ctx) {
    const inl = new Map();
    const ptrs = new Map();
    const addPtr = (f, a, b) => (ptrs.get(f) ?? ptrs.set(f, []).get(f)).push([a, b]);
    const addLine = (f, n) => f && (inl.get(f) ?? inl.set(f, new Set()).get(f)).add(n);
    let cur = null;
    for (const line of String(ctx || "").split("\n")) {
        for (const m of line.matchAll(PTR)) addPtr(m[1], Number(m[2]), Number(m[3] || m[2]));
        const head = /^\s*\d+\.\s.*?:\s([\w./@-]+\.[A-Za-z]+):L\d+/.exec(line);
        if (head) {
            cur = head[1];
            continue;
        }
        const helper = /^(?:\/\/\s*)+[^:]+:\s.*\(([\w./@-]+\.[A-Za-z]+):L\d+/.exec(line);
        if (helper) {
            cur = helper[1];
            continue;
        }
        const cs = /\(([\w./@-]+\.[A-Za-z]+):L\d+(?:-L\d+)?\)\s*→\s*L(\d+):/.exec(line);
        if (cs) {
            addLine(cs[1], Number(cs[2]));
            continue;
        }
        const code = /^L(\d+):/.exec(line);
        if (code) addLine(cur, Number(code[1]));
    }
    return { inl, ptrs };
}

const parseSpan = (s) => {
    const m = /^L(\d+)(?:-L(\d+))?$/.exec(s || "");
    return m ? [Number(m[1]), Number(m[2] || m[1])] : null;
};

/** Index graph nodes by file → [{id, a, b}] sorted by span length (innermost first). */
export function symbolIndex(g) {
    const byFile = new Map();
    for (const n of g?.nodes ?? []) {
        const sp = parseSpan(n.span);
        if (!sp || !n.path) continue;
        if (n.kind === "file" || n.kind === "module") continue;
        (byFile.get(n.path) ?? byFile.set(n.path, []).get(n.path)).push({ id: n.id, a: sp[0], b: sp[1] });
    }
    for (const arr of byFile.values()) arr.sort((x, y) => x.b - x.a - (y.b - y.a));
    return byFile;
}

function enclosing(symIdx, file, line) {
    for (const s of symIdx.get(file) ?? []) if (s.a <= line && line <= s.b) return s;
    // Top-level code: bucket by 25-line windows so it still counts as a need.
    const a = Math.floor((line - 1) / 25) * 25 + 1;
    return { id: `${file}#L${a}`, a, b: a + 24 };
}

/**
 * Compute coverage of one task's needs by one injection.
 * @param {string} ctx hook text
 * @param {object} g graph ({nodes})
 * @param {object} need fixture entry ({runs, reads, wholeFiles, hits, gold})
 * @param {{goldWeight?: number, hitWeight?: number}} [opts]
 */
export function needCoverage(ctx, g, need, opts = {}) {
    const goldWeight = opts.goldWeight ?? 2;
    const hitWeight = opts.hitWeight ?? 0.5;
    const { inl, ptrs } = parseInjection(ctx);
    const symIdx = symbolIndex(g);
    const known = (f) => symIdx.has(f);
    // sym id -> {file, a, b, lines:Set, runs:Set, gold:boolean}
    const syms = new Map();
    const touch = (file, line, run, kind) => {
        const s = enclosing(symIdx, file, line);
        const e = syms.get(s.id) ?? syms.set(s.id, { file, a: s.a, b: s.b, lines: new Set(), runs: new Set(), hitRuns: new Set(), gold: false }).get(s.id);
        if (kind === "read") {
            e.lines.add(line);
            e.runs.add(run);
        } else if (kind === "gold") {
            e.lines.add(line);
            e.gold = true;
        } else e.hitRuns.add(run);
    };
    for (const [file, arr] of Object.entries(need?.reads ?? {})) {
        if (!known(file)) continue;
        for (const [a, b, run] of arr) for (let n = a; n <= b; n++) touch(file, n, run, "read");
    }
    for (const [file, arr] of Object.entries(need?.gold ?? {})) {
        if (!known(file)) continue;
        for (const [a, b] of arr) for (let n = a; n <= b; n++) touch(file, n, "gold", "gold");
    }
    for (const [file, arr] of Object.entries(need?.hits ?? {})) {
        if (!known(file)) continue;
        for (const [line, run] of arr) touch(file, line, run, "hit");
    }

    let wSum = 0;
    let wCov = 0;
    let locW = 0;
    let locCovW = 0;
    const missing = [];
    for (const [id, e] of syms) {
        // Clip reads to the symbol's span (a read window spilling over a neighbour
        // only needs the part inside each symbol).
        const lines = [...e.lines].filter((n) => n >= e.a && n <= e.b);
        const fileInl = inl.get(e.file);
        const pointed = (ptrs.get(e.file) ?? []).some(([a, b]) => a <= e.b && b >= e.a);
        const inlinedAny = fileInl && lines.some((n) => fileInl.has(n));
        const lw = e.runs.size + (e.gold ? goldWeight : 0) + hitWeight * e.hitRuns.size;
        locW += lw;
        if (pointed || inlinedAny) locCovW += lw;
        if (!lines.length) continue;
        const w = e.runs.size + (e.gold ? goldWeight : 0);
        if (!w) continue;
        const frac = fileInl ? lines.filter((n) => fileInl.has(n)).length / lines.length : 0;
        wSum += w;
        wCov += w * frac;
        if (frac < 0.6) missing.push({ id, w, frac: Number(frac.toFixed(2)), lines: lines.length, pointed });
    }
    const needFiles = new Set(
        [
            ...Object.keys(need?.reads ?? {}),
            ...Object.keys(need?.wholeFiles ?? {}),
            ...Object.keys(need?.gold ?? {}),
        ].filter(known)
    );
    const named = [...needFiles].filter((f) => inl.has(f) || ptrs.has(f) || String(ctx).includes(f));
    missing.sort((x, y) => y.w * (1 - y.frac) * Math.sqrt(y.lines) - x.w * (1 - x.frac) * Math.sqrt(x.lines));
    return {
        needCov: wSum ? wCov / wSum : 1,
        uncoveredW: wSum - wCov,
        needW: wSum,
        locCov: locW ? locCovW / locW : 1,
        fileCov: needFiles.size ? named.length / needFiles.size : 1,
        needFiles: needFiles.size,
        missing,
    };
}
