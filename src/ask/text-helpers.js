/**
 * Lightweight snippet redundancy & near-target suggestion helpers.
 */
import { basename } from "node:path";
import { pathUnderPrefix } from "../util/paths.js";
import { stemToken, tokenize } from "./tokenize.js";

export function isRedundantSnippet(snippet, code, pointer = null) {
    if (!snippet || !code)
        return false;
    const snip = snippet.trim();
    if (!snip)
        return false;
    const codeLines = code.split("\n");
    const ptrMatch = typeof pointer === "string" ? /:L?(\d+)(?:-L?\d+)?$/.exec(pointer) : null;
    if (ptrMatch) {
        const barePrefix = `${ptrMatch[1]}:`;
        const legacyPrefix = `L${ptrMatch[1]}:`;
        const target = codeLines.find((l) => l.startsWith(barePrefix) || l.startsWith(legacyPrefix));
        if (target) {
            const matchedLen = target.startsWith(legacyPrefix) ? legacyPrefix.length : barePrefix.length;
            const cleaned = target.slice(matchedLen).trim();
            return Boolean(cleaned && (cleaned.startsWith(snip) || snip.startsWith(cleaned)));
        }
    }
    for (const raw of codeLines) {
        const t = raw.trim();
        if (!t || t.startsWith("//") || t.startsWith("…"))
            continue;
        const cleaned = t.replace(/^L?\d+:\s*/, "").trim();
        if (!cleaned)
            continue;
        return Boolean(cleaned.startsWith(snip) || snip.startsWith(cleaned));
    }
    return false;
}

export function boundedEditDistance(a, b, maxDist) {
    const la = a.length;
    const lb = b.length;
    if (Math.abs(la - lb) > maxDist)
        return maxDist + 1;
    let prevPrev = null;
    let prev = Array.from({ length: lb + 1 }, (_, j) => j);
    for (let i = 1; i <= la; i++) {
        const curr = [i];
        let rowMin = i;
        const ca = a.charCodeAt(i - 1);
        for (let j = 1; j <= lb; j++) {
            const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
            let val = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            if (prevPrev && i > 1 && j > 1 && ca === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === b.charCodeAt(j - 1))
                val = Math.min(val, prevPrev[j - 2] + 1);
            curr.push(val);
            if (val < rowMin)
                rowMin = val;
        }
        if (rowMin > maxDist)
            return maxDist + 1;
        prevPrev = prev;
        prev = curr;
    }
    return prev[lb];
}

export function tokenOverlapScore(qToks, candText) {
    if (!qToks.size)
        return 0;
    const cToks = new Set();
    for (const t of tokenize(candText)) {
        cToks.add(t);
        cToks.add(stemToken(t));
    }
    if (!cToks.size)
        return 0;
    let shared = 0;
    for (const qt of qToks) {
        if (cToks.has(qt))
            shared++;
    }
    return shared > 0 ? (2 * shared) / (qToks.size + cToks.size) : 0;
}

export function scoreNearCandidate(qFlat, qToks, candRaw) {
    const cFlat = String(candRaw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!qFlat || !cFlat)
        return 0;
    if (qFlat === cFlat)
        return 0.98;
    const minLen = Math.min(qFlat.length, cFlat.length);
    const maxLen = Math.max(qFlat.length, cFlat.length);
    let best = tokenOverlapScore(qToks, candRaw);
    if (minLen >= 3 && (cFlat.includes(qFlat) || qFlat.includes(cFlat))) {
        const bonus = cFlat.startsWith(qFlat) || cFlat.endsWith(qFlat) ? 0.66 : 0.56;
        best = Math.max(best, bonus + 0.3 * (minLen / maxLen));
    }
    const maxDist = Math.max(2, Math.floor(maxLen * 0.45));
    const dist = boundedEditDistance(qFlat, cFlat, maxDist);
    if (dist <= maxDist)
        best = Math.max(best, 1 - dist / maxLen);
    return best;
}

export function buildNearQueryTokens(query) {
    const qToks = new Set();
    for (const t of tokenize(query)) {
        qToks.add(t);
        qToks.add(stemToken(t));
    }
    return qToks;
}

export function suggestClosestFiles(query, paths, max = 3) {
    const qNorm = String(query ?? "").replace(/\\/g, "/").replace(/^\.?\/+/, "").trim();
    const qBase = basename(qNorm);
    const qFlatFull = qNorm.toLowerCase().replace(/[^a-z0-9]/g, "");
    const qFlatBase = qBase.toLowerCase().replace(/[^a-z0-9]/g, "");
    const qFlatStem = qBase.replace(/\.[a-z0-9]+$/i, "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!qFlatBase)
        return [];
    const qToks = buildNearQueryTokens(qNorm);
    const hasSlash = qNorm.includes("/");
    const hasExt = /\.[a-z0-9]+$/i.test(qBase);
    const scored = [];
    for (const p of paths) {
        const pBase = basename(p);
        const pStem = pBase.replace(/\.[a-z0-9]+$/i, "");
        const sBase = scoreNearCandidate(hasExt ? qFlatBase : qFlatStem, qToks, hasExt ? pBase : pStem);
        const sFull = hasSlash ? scoreNearCandidate(qFlatFull, qToks, p) : 0;
        const s = hasSlash ? Math.max(sFull, sBase * 0.9) : sBase;
        if (s >= 0.44)
            scored.push({ p, s });
    }
    scored.sort((a, b) => b.s - a.s || a.p.length - b.p.length || a.p.localeCompare(b.p));
    return scored.slice(0, max).map((x) => x.p);
}

export function suggestClosestSymbols(query, nodes, opts = {}) {
    const max = opts.max ?? 3;
    const withSpan = Boolean(opts.withSpan);
    const withPath = Boolean(opts.withPath);
    const qStr = String(query ?? "").trim();
    const qBare = qStr.split(/[.:#]/).pop() ?? qStr;
    const qFlatFull = qStr.toLowerCase().replace(/[^a-z0-9]/g, "");
    const qFlatBare = qBare.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!qFlatBare)
        return [];
    const qToks = buildNearQueryTokens(qStr);
    const hasQual = /[.:#]/.test(qStr);
    const bestByLabel = new Map();
    for (const n of nodes) {
        if (!n?.name || n.kind === "file")
            continue;
        const bare = n.name.split(/[.:#]/).pop() ?? n.name;
        const qual = n.owner && !/[.:#]/.test(n.name) ? `${n.owner}.${bare}` : n.name;
        const sBare = scoreNearCandidate(qFlatBare, qToks, bare);
        const sQual = hasQual ? scoreNearCandidate(qFlatFull, qToks, qual) : 0;
        const s = Math.max(sBare, sQual) + (n.exported ? 0.02 : 0);
        if (s < 0.45)
            continue;
        const suffix = withSpan && n.span ? ` (${n.span})` : withPath && n.path ? ` (${n.path}${n.span ? `:${n.span}` : ""})` : "";
        const label = `${qual}${suffix}`;
        if (s > (bestByLabel.get(label) ?? 0))
            bestByLabel.set(label, s);
    }
    return [...bestByLabel.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, max)
        .map(([label]) => label);
}

export function suggestNearTargets(graph, query, inPrefix, max = 3) {
    if (!graph?.nodes?.length)
        return [];
    const scoped = inPrefix ? graph.nodes.filter((n) => pathUnderPrefix(n.path, inPrefix)) : graph.nodes;
    const q = String(query ?? "").trim();
    const sepPos = q.indexOf(":");
    if (sepPos > 0 && !q.includes("::") && (q.slice(0, sepPos).includes("/") || /\.[a-z0-9]{1,5}$/i.test(q.slice(0, sepPos)))) {
        const filePart = q.slice(0, sepPos);
        const symPart = q.slice(sepPos + 1);
        const paths = [...new Set(scoped.map((n) => n.path).filter(Boolean))];
        const bestFiles = suggestClosestFiles(filePart, paths, 2);
        const targetFile = paths.find((p) => p === filePart || p.endsWith(`/${filePart}`)) ?? bestFiles[0];
        if (targetFile) {
            const fNodes = scoped.filter((n) => n.path === targetFile && n.kind !== "file");
            const syms = suggestClosestSymbols(symPart, fNodes, { max });
            if (syms.length)
                return syms.map((s) => `${targetFile}:${s}`);
        }
    }
    const looksLikeFile = q.includes("/") || (/\.[a-z0-9]{1,5}$/i.test(q) && !q.includes("#"));
    if (looksLikeFile) {
        const paths = [...new Set(scoped.map((n) => n.path).filter(Boolean))];
        const fileHits = suggestClosestFiles(q, paths, max);
        if (fileHits.length)
            return fileHits;
    }
    return suggestClosestSymbols(q, scoped, { max });
}
