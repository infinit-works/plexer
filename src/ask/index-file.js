/**
 * Build-time sidecar for `plexer ask` — `<outDir>/.cache/ask-index.json`.
 *
 * `ask`'s lexical pass tokenizes every symbol node's name/path/body on every
 * query; at 32k nodes that re-tokenization is ~45% of query time (profiled).
 * `plexer build` writes this sidecar once, with the token→count bags per node
 * plus the corpus-wide document frequencies, so a query just reads counts
 * instead of re-splitting every node's text. It's a derived cache, not
 * checked-in graph data, so it lives under the gitignored `.cache/` dir
 * (see `CACHE_DIR` in `context/node-file.js`) rather than `.graph/`.
 *
 * `tokenize`/`counts` live here (not duplicated in `ask.js`) so build-time and
 * query-time text-splitting are provably the same function — the sidecar can
 * only be a correct cache of `ask.js`'s own math if both sides call the same
 * code. `ask.js` imports both back from here.
 *
 * Concept (markdown) docs are NOT part of this sidecar — there are only dozens
 * of them, they're still tokenized live at query time, and their doc-frequency
 * contribution is folded into the stored `df` at query time (see `ask.js`),
 * which is why `df` here counts symbol/file nodes only.
 */
import { join } from "node:path";
import { CACHE_DIR } from "../context/node-file.js";
import { readJson, writeJsonAtomic } from "../util/state.js";
/** Words too common/short to carry query intent — dropped before scoring. */
const STOP = new Set([
    "the", "a", "an", "of", "to", "in", "is", "are", "how", "does", "do", "what",
    "where", "which", "that", "this", "it", "for", "on", "and", "or", "with",
    "i", "we", "get", "set", "use", "used", "using", "when", "why", "can",
    "from", "via", "into", "between", "based", "by", "as", "at", "be",
]);
/** Split prose + identifiers into lowercased subword tokens (ACRONYMWord, camelCase, snake, kebab).
 * The single source of truth for tokenization — shared by build-time indexing
 * (this file) and query-time fallback (`ask.js`) so the sidecar is a provably
 * exact cache of the live path. */
export function tokenize(text) {
    return text
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTMLParser → HTML Parser
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1 && !STOP.has(t));
}
/** Fast, deterministic morphological stemmer for code identifiers and natural-language queries. */
export function stemToken(raw) {
    let w = raw;
    if (w.length <= 3)
        return w;
    if (w.length > 4 && w.endsWith("ies")) {
        w = w.slice(0, -3) + "y";
    }
    else if (w.length > 4 && /(ches|shes|xes|zes|ses)$/.test(w)) {
        w = w.slice(0, -2);
    }
    else if (w.length > 3 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) {
        w = w.slice(0, -1);
    }
    if (w.length > 5 && w.endsWith("ing")) {
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
            w = w.slice(0, -1) + "y";
        else if (/([bcdgklmnprstvz])\1$/.test(w))
            w = w.slice(0, -1);
    }
    else if (w.length > 5 && /(er|or)$/.test(w)) {
        w = w.slice(0, -2);
    }
    if (w.length > 4 && w.endsWith("e") && !w.endsWith("ee")) {
        w = w.slice(0, -1);
    }
    if (w.length > 6 && w.endsWith("icat")) {
        w = w.slice(0, -4) + "y";
    }
    else if (w.length > 5 && w.endsWith("at")) {
        w = w.slice(0, -2);
    }
    return w;
}
const COMPOUND_STEMS = new Map([
    ["varint", ["variabl", "integ"]],
    ["varints", ["variabl", "integ"]],
    ["uint", ["unsign", "integ"]],
    ["sint", ["sign", "integ"]],
    ["bitwidth", ["bit", "width"]],
    ["bitwidths", ["bit", "width"]],
    ["cframe", ["coordin", "fram"]],
    ["mtime", ["modify", "tim"]],
]);
/** Build a stem → max-term-frequency map from a token count map. */
export function stemCounts(tokenMap) {
    const m = new Map();
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
export function counts(tokens) {
    const m = new Map();
    for (const t of tokens)
        m.set(t, (m.get(t) ?? 0) + 1);
    return m;
}
export const ASK_INDEX_FILE = "ask-index.json";
const ASK_INDEX_VERSION = 2;
/** Absolute path to the ask sidecar for a context dir: `<dir>/.cache/ask-index.json`.
 * `.cache/` is the established uncommitted-cache location — this sidecar is a
 * derived, regenerate-anytime cache, not checked-in graph data. */
export function askIndexPath(outDir) {
    return join(outDir, CACHE_DIR, ASK_INDEX_FILE);
}
function pairs(m) {
    return [...m.entries()];
}
/** Sum of a token→count bag's counts (a document's field length). */
export function bagLen(p) {
    let n = 0;
    for (const [, c] of p)
        n += c;
    return n;
}
/**
 * Tokenize every node in `graph` (exactly as `ask.js`'s lexical pass does) and
 * write the resulting bags + document frequencies to
 * `<outDir>/.cache/ask-index.json`. Returns the path written. Deterministic:
 * nodes are indexed in id order, so an unchanged graph produces a
 * byte-identical sidecar. Reuses prior token bags when `body_hash` + `summary`
 * match.
 */
export function writeAskIndex(outDir, graph, prior = readAskIndex(outDir)) {
    const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
    const priorById = prior && prior.version === ASK_INDEX_VERSION
        ? new Map(prior.docs.map((d) => [d.id, d]))
        : null;
    const docs = [];
    const df = new Map();
    for (const n of nodes) {
        const h = n.body_hash ? `${n.body_hash}:${n.name}:${n.path}:${n.signature ?? ""}:${n.summary ?? ""}` : "";
        const prev = h ? priorById?.get(n.id) : undefined;
        if (prev && prev.h === h) {
            docs.push(prev);
            const seen = new Set();
            for (const [t] of prev.name)
                seen.add(t);
            for (const [t] of prev.path)
                seen.add(t);
            for (const [t] of prev.body)
                seen.add(t);
            for (const t of seen)
                df.set(t, (df.get(t) ?? 0) + 1);
            continue;
        }
        const name = counts(tokenize(n.name));
        const path = counts(tokenize(n.path));
        const body = counts(tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`));
        const doc = { id: n.id, h, name: pairs(name), path: pairs(path), body: pairs(body) };
        docs.push(doc);
        const bag = new Set([...name.keys(), ...path.keys(), ...body.keys()]);
        for (const t of bag)
            df.set(t, (df.get(t) ?? 0) + 1);
    }
    const avgBodyLen = docs.length
        ? docs.reduce((a, d) => a + bagLen(d.body), 0) / docs.length
        : 0;
    const index = {
        version: ASK_INDEX_VERSION,
        avgBodyLen,
        df: pairs(df),
        docCount: nodes.length,
        docs,
    };
    const outPath = askIndexPath(outDir);
    writeJsonAtomic(outPath, index, true);
    return outPath;
}
/** Read the ask sidecar. Returns null on a missing file, unparseable JSON, an
 * unrecognized shape, an unknown `version`, or a `docCount` that doesn't match
 * the number of docs actually stored (a corrupted/truncated sidecar would
 * otherwise silently skew IDF) — any of which means the caller should fall
 * back to live tokenization, never crash or trust bad data. */
export function readAskIndex(outDir) {
    const raw = readJson(askIndexPath(outDir));
    if (!raw ||
        typeof raw !== "object" ||
        (raw.version !== 1 && raw.version !== ASK_INDEX_VERSION) ||
        typeof raw.docCount !== "number" ||
        typeof raw.avgBodyLen !== "number" ||
        !Array.isArray(raw.df) ||
        !Array.isArray(raw.docs) ||
        raw.docCount !== raw.docs.length) {
        return null;
    }
    return raw;
}
