/**
 * Shared AST definition scoping, enclosing container lookup, and leading doc-comment extraction.
 */
export const KIND = {
    function: "function",
    method: "method",
    class: "class",
    interface: "interface",
    type: "type",
    struct: "struct",
    enum: "enum",
    module: "module",
    constant: "constant",
    variable: "variable",
    field: "variable",
    object: "class",
    property: "variable",
};

function collectDelimitedCommentLines(lines, startRow, isOpenLine) {
    const commentLines = [];
    let r = startRow;
    while (r >= 0) {
        const line = lines[r].trim();
        commentLines.unshift(line);
        r--;
        if (isOpenLine(line) || commentLines.length > 30) break;
    }
    return commentLines;
}

const PREPROC_DIRECTIVE_RE = /^#\s*(?:include|define|ifdef|ifndef|if|elif|else|endif|undef|pragma|region|endregion|line|error|warning)\b/;
const C_PREPROC_LANGS = new Set(["c", "cpp", "c_sharp", "objc"]);

function collectPrecedingCommentLines(lines, startRow, lang = "") {
    let r = startRow - 1;
    let skipped = 0;
    while (r >= 0 && skipped < 4 && /^(@[A-Za-z_]|#\[)/.test(lines[r].trim())) {
        r--;
        skipped++;
    }
    if (r < 0) return [];
    const last = lines[r].trim();
    if (last.endsWith("*/")) return collectDelimitedCommentLines(lines, r, (l) => l.includes("/*"));
    if (last.endsWith("]]") || last.endsWith("]=]")) {
        return collectDelimitedCommentLines(lines, r, (l) => /^--\[=*\[/.test(l));
    }
    const isPreprocLang = C_PREPROC_LANGS.has(lang);
    const commentLines = [];
    while (r >= 0 && commentLines.length < 25) {
        const line = lines[r].trim();
        if (isPreprocLang && PREPROC_DIRECTIVE_RE.test(line)) break;
        if (!/^(\/\/|---?|\*\s|#(?!!|\[))/.test(line)) break;
        commentLines.unshift(line);
        r--;
    }
    return commentLines;
}

function summarizeCommentBlock(commentLines) {
    const paraParts = [];
    for (const raw of commentLines) {
        const cleaned = raw
            .replace(/^(\/\*\*+|\/*\*+\/|\*+|\/{2,3}!|--+\[=*\[|\]=*\]|--+|#+'?)\s*/, "")
            .replace(/\*+\/\s*$/, "")
            .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
            .replace(/<[^>]+>/g, "")
            .trim();
        const isIgnorable =
            !cleaned ||
            /^(@\w+|eslint-|prettier-|ts-|nolint|noinspection|luacheck:|selene:|!strict|!nocheck|!native|!optimize|TODO\b|FIXME\b)/i.test(cleaned) ||
            /^[-=*_~]{3,}$/.test(cleaned);
        if (isIgnorable) {
            if (paraParts.length > 0) break;
            continue;
        }
        paraParts.push(cleaned);
        if (paraParts.join(" ").length >= 220) break;
    }
    if (paraParts.length === 0) return null;
    const joined = paraParts.join(" ");
    return joined.length > 220 ? `${joined.slice(0, 217)}...` : joined;
}

function extractPythonDocstringSummary(bodyText) {
    const pyMatch = bodyText.match(/^[ \t]*(?:async\s+)?(?:def|class)\s+[^\n]+:\s*\n[ \t]*r?(?:"""([\s\S]*?)"""|'''([\s\S]*?)''')/);
    const doc = pyMatch?.[1] ?? pyMatch?.[2];
    if (!doc) return null;
    for (const raw of doc.split("\n")) {
        const cleaned = raw.trim();
        if (cleaned) return cleaned.length > 140 ? `${cleaned.slice(0, 137)}...` : cleaned;
    }
    return null;
}

export function extractLeadingSummary(lines, startRow, bodyText = "", lang = "") {
    if (Array.isArray(lines) && startRow > 0) {
        const summary = summarizeCommentBlock(collectPrecedingCommentLines(lines, startRow, lang));
        if (summary) return summary;
    }
    return bodyText ? extractPythonDocstringSummary(bodyText) : null;
}

const ENCLOSING_DEF_INDEX = new WeakMap();

function buildEnclosingSegments(defs) {
    const points = new Set();
    const valid = [];
    for (let i = 0; i < defs.length; i++) {
        const d = defs[i];
        if (d.startIndex < d.endIndex) {
            points.add(d.startIndex);
            points.add(d.endIndex);
            valid.push({ def: d, start: d.startIndex, end: d.endIndex, span: d.endIndex - d.startIndex, idx: i });
        }
    }
    const coords = [...points].sort((a, b) => a - b);
    if (coords.length < 2)
        return [];
    const starts = new Map();
    const ends = new Map();
    for (const item of valid) {
        let sList = starts.get(item.start);
        if (!sList)
            starts.set(item.start, (sList = []));
        sList.push(item);
        let eList = ends.get(item.end);
        if (!eList)
            ends.set(item.end, (eList = []));
        eList.push(item);
    }
    const active = new Set();
    const segments = [];
    for (let i = 0; i < coords.length - 1; i++) {
        const pos = coords[i];
        for (const item of ends.get(pos) ?? [])
            active.delete(item);
        for (const item of starts.get(pos) ?? [])
            active.add(item);
        if (active.size === 0)
            continue;
        let bestItem = null;
        for (const item of active) {
            if (!bestItem || item.span < bestItem.span || (item.span === bestItem.span && item.idx < bestItem.idx)) {
                bestItem = item;
            }
        }
        if (bestItem) {
            const nextPos = coords[i + 1];
            const prev = segments[segments.length - 1];
            if (prev && prev.end === pos && prev.def === bestItem.def) {
                prev.end = nextPos;
            }
            else {
                segments.push({ start: pos, end: nextPos, def: bestItem.def });
            }
        }
    }
    return segments;
}

export function enclosingDef(defs, at) {
    if (!defs || defs.length === 0)
        return undefined;
    if (defs.length <= 16) {
        let best;
        let bestSpan = Infinity;
        for (const d of defs) {
            if (d.startIndex <= at && at < d.endIndex) {
                const span = d.endIndex - d.startIndex;
                if (span < bestSpan) {
                    bestSpan = span;
                    best = d;
                }
            }
        }
        return best;
    }
    let cached = ENCLOSING_DEF_INDEX.get(defs);
    if (!cached || cached.length !== defs.length) {
        cached = { length: defs.length, segments: buildEnclosingSegments(defs) };
        ENCLOSING_DEF_INDEX.set(defs, cached);
    }
    const segs = cached.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const seg = segs[mid];
        if (at < seg.start)
            hi = mid - 1;
        else if (at >= seg.end)
            lo = mid + 1;
        else
            return seg.def;
    }
    return undefined;
}

const DEF_CONTAINER = /(definition|declaration|specifier|declarator|_item)$/;
// Never climb out of a nested definition into an enclosing container declaration (e.g. Zig fn inside struct_declaration).
const TYPE_CONTAINER = /^(struct|enum|union|opaque|class|interface|trait|module)_(declaration|definition)$/;

function nextNamedSibling(n) {
    const tagged = n;
    if ("nextNamedSibling" in tagged)
        return tagged.nextNamedSibling ?? null;
    const p = n.parent;
    if (!p?.namedChild)
        return null;
    const count = p.namedChildCount ?? 0;
    for (let i = 0; i < count - 1; i++) {
        const c = p.namedChild(i);
        if (c && c.startIndex === n.startIndex && c.endIndex === n.endIndex)
            return p.namedChild(i + 1);
    }
    return null;
}

export function defScope(node, langName) {
    let n = node;
    while (n.parent && DEF_CONTAINER.test(n.parent.type) && !TYPE_CONTAINER.test(n.parent.type))
        n = n.parent;
    if (langName === "dart") {
        const body = nextNamedSibling(n);
        if (body?.type === "function_body") {
            return {
                type: n.type,
                text: n.text,
                startIndex: n.startIndex,
                endIndex: body.endIndex,
                startPosition: n.startPosition,
                endPosition: body.endPosition,
                parent: n.parent,
            };
        }
    }
    return n;
}
