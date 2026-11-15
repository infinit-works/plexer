/**
 * Turning a blast-radius or callers report into quoted source evidence.
 */
import {
    escapeRegExp,
    fileReader,
    needlesForName,
    parseSpan,
    plural,
    referenceLine,
    referenceLines,
    spanRange,
    spanStart,
    wordRe,
} from "../util/span.js";

export {
    escapeRegExp,
    fileReader,
    needlesForName,
    parseSpan,
    plural,
    referenceLine,
    referenceLines,
    spanRange,
    spanStart,
    wordRe,
};
export const MAX_EVIDENCE = 4;
const MAX_LINES = 6;

function labelFor(name, path, span) {
    const r = spanRange(span);
    return r ? `${name} · ${path}:${r.start}-${r.end}` : `${name} · ${path}`;
}

function fold(lines) {
    if (lines.length <= MAX_LINES)
        return { lines };
    return { lines: lines.slice(0, MAX_LINES), more: lines.length - MAX_LINES };
}

const asEvidenceLines = (lines) => lines.map((l) => ({ n: l.n, sign: l.sign, text: l.text }));

function hunksIn(file, span) {
    const out = [];
    let dropped = 0;
    for (const h of file.hunks) {
        if (span && (h.end < span.start || h.start > span.end))
            continue;
        out.push(...asEvidenceLines(h.lines));
        dropped += h.dropped;
    }
    return { lines: out, dropped };
}

/** Evidence for one changed symbol: what this diff did to it. */
export function seedEvidence(seed, file) {
    if (!file)
        return null;
    const span = seed.wholeFile ? null : spanRange(seed.span);
    const { lines, dropped } = hunksIn(file, span);
    if (lines.length === 0 && dropped === 0)
        return null;
    const folded = fold(lines);
    const more = (folded.more ?? 0) + dropped;
    return {
        label: seed.wholeFile ? seed.path : labelFor(seed.name, seed.path, seed.span),
        note: file.status === "added" ? "new file" : seed.wholeFile ? "outside any symbol" : undefined,
        lines: folded.lines,
        more: more > 0 ? more : undefined,
    };
}

export function impactedEvidence(sym, reach, read) {
    const needles = reach.nameNeedles ?? reach.names.map((name) => ({ name, needles: needlesForName(name) }));
    const reList = reach.nameRegexes ?? needles.flatMap((n) => n.needles ?? (n.re ? [n.re] : []));
    const byName = referenceLine(sym.path, sym.span, reList, read);
    if (byName) {
        const hit = needles.find((n) => (n.needles ?? (n.re ? [n.re] : [])).some((re) => re.test(byName.text)))?.name;
        return {
            label: labelFor(sym.name, sym.path, sym.span),
            note: `${sym.relation} ${hit}`,
            lines: [{ n: byName.n, sign: " ", text: byName.text }],
        };
    }
    const byModule = referenceLine(sym.path, sym.span, reach.modules, read);
    if (byModule) {
        return {
            label: labelFor(sym.name, sym.path, sym.span),
            note: sym.relation,
            lines: [{ n: byModule.n, sign: " ", text: byModule.text }],
        };
    }
    return null;
}

export function reachTerms(seeds, changed) {
    const names = [...new Set(seeds.filter((s) => !s.wholeFile).map((s) => s.name))].sort((a, b) => b.length - a.length);
    const stems = [...new Set(changed.map((f) => f.path.replace(/\.[^./]+$/, "").split("/").pop() ?? ""))].filter(Boolean);
    const nameNeedles = names.map((name) => ({ name, needles: needlesForName(name) }));
    return {
        names,
        nameNeedles,
        nameRegexes: nameNeedles.flatMap((n) => n.needles),
        modules: stems.map((stem) => new RegExp(`["'\`][^"'\`]*\\b${escapeRegExp(stem)}(\\.[a-z]+)?["'\`]`)),
    };
}
