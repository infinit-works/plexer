/**
 * Pure zero-I/O tokenization, literal extraction, and morphological stemming
 * shared across build-time indexing and query-time retrieval.
 */
const STOP = new Set([
    "the", "a", "an", "of", "to", "in", "is", "are", "how", "does", "do", "what",
    "where", "which", "that", "this", "it", "for", "on", "and", "or", "with",
    "i", "we", "get", "set", "use", "used", "using", "when", "why", "can",
    "from", "via", "into", "between", "based", "by", "as", "at", "be",
]);

/**
 * Split prose + identifiers into lowercased subword tokens (ACRONYMWord, camelCase, snake, kebab).
 */
export function tokenize(text) {
    if (!text || typeof text !== "string")
        return [];
    return text
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Split camelCase/ACRONYM/snake/kebab/dots into lowercased identifiers WITHOUT
 * dropping short verbs or stopwords (`get`, `set`, `use`, `on`, `is`, `do`, `id`, etc.).
 */
export function tokenizeExact(text) {
    if (!text || typeof text !== "string")
        return [];
    return text
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2);
}

function hasLowerAscii(tok) {
    for (let i = 0; i < tok.length; i++) {
        const c = tok.charCodeAt(i);
        if (c >= 97 && c <= 122)
            return true;
    }
    return false;
}

/**
 * Populate regular stopword-filtered counts (`regularMap`) and dropped-token `exact_ident`
 * counts (`exactMap`) from a single camelCase-aware split pass.
 */
export function tokenizeRegularAndExact(text, regularMap = null, exactMap = null) {
    if (!text || typeof text !== "string")
        return;
    const norm = hasUpperAsciiOrUnderscore(text)
        ? text.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
        : text.toLowerCase();
    const parts = norm.split(/[^a-z0-9]+/);
    for (let i = 0; i < parts.length; i++) {
        const t = parts[i];
        if (t.length < 2)
            continue;
        const isStop = STOP.has(t);
        if (regularMap && !isStop) {
            regularMap.set(t, (regularMap.get(t) ?? 0) + 1);
        }
        if (exactMap && (isStop || !hasLowerAscii(t))) {
            exactMap.set(t, (exactMap.get(t) ?? 0) + 1);
        }
    }
}

const QUOTED_LITERAL_RE = /'([^'\\\n]{3,120})'|"([^"\\\n]{3,120})"|`([^`\\\n]{3,120})`/g;
const QUOTED_FLAG_RE = /(?:^|\s)(--?[a-zA-Z][a-zA-Z0-9_-]*)(?=$|[\s=])/g;
const PRIMITIVE_TYPE_ANN_RE = /:(?:string|number|boolean|any|void|null|undefined|int|str|bool|float|usize|u32|i32)\b/i;
const REGEX_LITERAL_RE = /^\/[^/\n]+\/(?:[dgimsuvy]{1,6})?$/;
const STRUCTURED_PATTERNS = [
    /(?:^|[\s(,[\]{}"'`=])(--[a-z][a-zA-Z0-9_-]*)/g,
    /(\{![rsa]\}|\{[^}\s]{1,24}![rsa]\}|\{[0-9a-zA-Z_.:!-]{2,24}\})/g,
    /\b([a-zA-Z][a-zA-Z0-9_.-]{0,31}:[a-zA-Z0-9_.*:/-]{1,48})/g,
    /(?:^|[\s"'(`=,:])(\/(?:[a-zA-Z0-9_.:*{}-]+\/?)+)/g,
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|E[A-Z]{3,}[A-Z0-9]*|[A-Z]{2,}[0-9]{2,})\b/g,
];

function hasUpperAsciiOrUnderscore(text) {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 65 && c <= 90)
            return true;
    }
    return false;
}

function structuredPatternEligible(text, pIdx) {
    if (pIdx === 0)
        return text.includes("--");
    if (pIdx === 1)
        return text.includes("{");
    if (pIdx === 2)
        return text.includes(":");
    if (pIdx === 3)
        return text.includes("/");
    return hasUpperAsciiOrUnderscore(text);
}

function normalizeLiteralToken(raw) {
    if (!raw)
        return "";
    const tok = raw.trim().toLowerCase();
    if (tok.length < 3 || tok.length > 64)
        return "";
    if (!/[a-z0-9]/.test(tok))
        return "";
    return tok;
}

function recordQuotedLiterals(text, record) {
    QUOTED_LITERAL_RE.lastIndex = 0;
    for (const m of text.matchAll(QUOTED_LITERAL_RE)) {
        const inner = (m[1] ?? m[2] ?? m[3] ?? "").trim();
        if (!inner)
            continue;
        const startOffset = (m.index ?? 0) + 1;
        if (!/\s/.test(inner)) {
            if (!inner.startsWith("//") && !inner.startsWith("${"))
                record(startOffset, inner);
            continue;
        }
        if (inner.length <= 48 && inner.split(/\s+/).length <= 4 && !inner.includes("${"))
            record(startOffset, inner.replace(/\s+/g, " "));
        QUOTED_FLAG_RE.lastIndex = 0;
        for (const fm of inner.matchAll(QUOTED_FLAG_RE)) {
            const flag = fm[1];
            const flagOff = startOffset + (fm.index ?? 0) + fm[0].indexOf(flag);
            record(flagOff, flag);
        }
    }
}

function isWrappedInQuotes(text, start, len) {
    if (start <= 0 || start + len >= text.length)
        return false;
    const prev = text[start - 1];
    const next = text[start + len];
    return (prev === "\"" && next === "\"") || (prev === "'" && next === "'") || (prev === "`" && next === "`");
}

function isInsideLineComment(text, matchOffset) {
    const lineStart = text.lastIndexOf("\n", matchOffset - 1) + 1;
    const prefix = text.slice(lineStart, matchOffset);
    return /(?:^|\s)(?:\/\/|--(?:\s|$))/.test(prefix);
}

function recordStructuredLiterals(text, record) {
    for (let pIdx = 0; pIdx < STRUCTURED_PATTERNS.length; pIdx++) {
        if (!structuredPatternEligible(text, pIdx))
            continue;
        const re = STRUCTURED_PATTERNS[pIdx];
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            const raw = m[1];
            if (!raw || raw.startsWith("//") || /^https?:$/.test(raw))
                continue;
            if (pIdx === 2 && PRIMITIVE_TYPE_ANN_RE.test(raw))
                continue;
            const matchOffset = (m.index ?? 0) + m[0].indexOf(raw);
            if ((pIdx === 0 || pIdx === 3) && isInsideLineComment(text, matchOffset))
                continue;
            if (pIdx === 3) {
                if (raw.startsWith("/*") || raw.endsWith("*/") || raw.includes("/*") || raw.includes("*/"))
                    continue;
                if (!isWrappedInQuotes(text, matchOffset, raw.length) && REGEX_LITERAL_RE.test(raw))
                    continue;
            }
            record(matchOffset, raw);
            const fmt = raw.match(/^\{[^}\s]+(![rsa])\}$/);
            if (fmt)
                record(matchOffset + 1, `{${fmt[1]}}`);
        }
    }
}

/**
 * Extract quoted string/template literals and structured keys/codes (`>= 3` chars).
 */
export function extractLiterals(text) {
    if (!text || typeof text !== "string")
        return [];
    const out = [];
    const seen = new Set();
    const record = (offset, raw) => {
        const tok = normalizeLiteralToken(raw);
        if (!tok)
            return;
        const key = `${offset}:${tok}`;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push(tok);
    };
    if (text.includes("'") || text.includes('"') || text.includes("`"))
        recordQuotedLiterals(text, record);
    recordStructuredLiterals(text, record);
    return out;
}

/** True if `tokenize()` drops `tok` (short tokens, stopwords, or non-alpha tokens). */
export function isTokenDroppedByTokenize(tok) {
    return !tok || tok.length <= 1 || STOP.has(tok) || !hasLowerAscii(tok);
}

const PROTECTED_ING = new Set([
    "string", "spring", "thing", "bring", "ring", "king", "ping", "sing", "wing",
    "cling", "fling", "sling", "sting", "swing", "wring",
    "anything", "nothing", "something", "everything",
]);
const PROTECTED_ER_OR = new Set([
    "number", "member", "buffer", "header", "footer", "render", "filter", "trigger",
    "center", "master", "cluster", "counter", "integer", "docker", "folder", "pointer",
    "order", "error", "color", "vector", "cursor", "tensor", "mirror", "anchor",
    "author", "vendor", "factor", "sensor", "sector",
]);

export function stripPluralSuffix(w) {
    if (w.length > 4 && w.endsWith("ies"))
        return `${w.slice(0, -3)}y`;
    if (w.length > 4 && /(ches|shes|xes|zes|ses)$/.test(w))
        return w.slice(0, -2);
    if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w))
        return w.slice(0, -1);
    return w;
}

/** Fast, deterministic morphological stemmer for code identifiers and natural-language queries. */
export function stemToken(raw) {
    let w = raw;
    if (w.length <= 3)
        return w;
    w = stripPluralSuffix(w);
    if (w.length > 5 && w.endsWith("ing") && !PROTECTED_ING.has(w) && /[aeiouy]/.test(w.slice(0, -3))) {
        w = w.slice(0, -3);
        if (/([bcdgklmnprstvz])\1$/.test(w))
            w = w.slice(0, -1);
    }
    else if (w.length > 5 && w.endsWith("tion")) {
        w = w.slice(0, -3);
    }
    else if (w.length > 4 && w.endsWith("ed")) {
        w = w.slice(0, -2);
        if (w.endsWith("i"))
            w = `${w.slice(0, -1)}y`;
        else if (/([bcdgklmnprstvz])\1$/.test(w))
            w = w.slice(0, -1);
    }
    else if (w.length > 5 && /(er|or)$/.test(w) && !PROTECTED_ER_OR.has(w)) {
        w = w.slice(0, -2);
        // Porter double-consonant rule after -er/-or: exclude l, s, z so caller->call, processor->process, accessor->access.
        if (/([bdgkmnprt])\1$/.test(w))
            w = w.slice(0, -1);
    }
    if (w.length > 4 && w.endsWith("e") && !w.endsWith("ee")) {
        w = w.slice(0, -1);
    }
    if (w.length > 6 && w.endsWith("icat")) {
        w = `${w.slice(0, -4)}y`;
    }
    else if (w.length > 5 && w.endsWith("at")) {
        w = w.slice(0, -2);
    }
    return w;
}

const COMPOUND_STEMS = new Map([
    ["varint", ["variabl", "integ", "integer"]],
    ["varints", ["variabl", "integ", "integer"]],
    ["uint", ["unsign", "integ", "integer"]],
    ["sint", ["sign", "integ", "integer"]],
    ["bitwidth", ["bit", "width"]],
    ["bitwidths", ["bit", "width"]],
    ["bits", ["binary", "bit"]],
    ["cframe", ["coordin", "fram"]],
    ["mtime", ["modify", "time"]],
    ["prop", ["property"]],
    ["props", ["property"]],
]);

/** Build a stem → max-term-frequency map from a token count map. */
export function stemCounts(tokenMap, targetMap = null) {
    const m = targetMap ?? new Map();
    if (targetMap)
        m.clear();
    for (const [tok, count] of tokenMap) {
        const stem = stemToken(tok);
        const prev = m.get(stem) ?? 0;
        if (count > prev)
            m.set(stem, count);
        const parts = COMPOUND_STEMS.get(tok);
        if (parts) {
            for (const sub of parts) {
                if (count > (m.get(sub) ?? 0))
                    m.set(sub, count);
            }
        }
    }
    return m;
}

/** Term-frequency count map. */
export function counts(tokens, targetMap = null) {
    const m = targetMap ?? new Map();
    if (targetMap)
        m.clear();
    for (const t of tokens)
        m.set(t, (m.get(t) ?? 0) + 1);
    return m;
}
