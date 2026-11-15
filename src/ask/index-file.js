/**
 * Multi-channel SQLite BM25 posting store (`index.sqlite`) and tokenization/stemming
 * utilities shared across build-time indexing and query-time retrieval (`plexer ask`).
 *
 * Channels indexed per document (`ask_docs` / `ask_postings` / `ask_df`):
 *   - `name`: stopword-filtered identifier tokens from symbol/section name
 *   - `path`: stopword-filtered path tokens
 *   - `sig`: stopword-filtered signature / markdown breadcrumb tokens
 *   - `summary`: stopword-filtered summary / first prose line tokens
 *   - `literals`: extracted string/template literals, structured keys, flags, routes, error codes
 *   - `body`: stopword-filtered body prose/code tokens
 *   - `stem`: morphological stems across text fields (`stemCounts`)
 *   - `exact_ident`: exact lowercased identifier splits retaining short verbs/stopwords (`get`, `set`, `on`, `id`, ...)
 *
 * Legacy `.cache/ask-index.json` callers (`readAskIndex`, `loadAskIndexCached`) remain supported
 * cleanly by hydrating symbol/file (`kind != 'doc'`) postings from `index.sqlite`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { loadFileCached, registerGraphCacheClearer } from "../context/graph-store.js";
import { CACHE_DIR } from "../context/node-file.js";
import { WALK_RELATIONS } from "../context/symbol-query.js";
import {
    checkpointSqliteStore,
    cleanupLegacyCacheFiles,
    getAllSqliteMeta,
    openSqliteStore,
    prepareArrayStmt,
    prepareStmt,
    sameWalRevision,
    setSqliteMetaMany,
    sqliteStoreExists,
    sqliteStorePath,
    sqliteWalRevision,
    withSqliteTransaction,
} from "../storage/sqlite-store.js";
import { toPosixPath } from "../util/paths.js";
import { contentHash, searchBody } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import { spanRange } from "../util/span.js";
import { readJson } from "../util/state.js";

/** Words too common/short to carry query intent — dropped before scoring. */
const STOP = new Set([
    "the", "a", "an", "of", "to", "in", "is", "are", "how", "does", "do", "what",
    "where", "which", "that", "this", "it", "for", "on", "and", "or", "with",
    "i", "we", "get", "set", "use", "used", "using", "when", "why", "can",
    "from", "via", "into", "between", "based", "by", "as", "at", "be",
]);

export const ASK_CHANNELS = [
    "name",
    "path",
    "sig",
    "summary",
    "literals",
    "body",
    "stem",
    "exact_ident",
];

function emptyFieldLens() {
    return {
        name: 0,
        path: 0,
        sig: 0,
        summary: 0,
        literals: 0,
        body: 0,
        stem: 0,
        exact_ident: 0,
    };
}

/**
 * Split prose + identifiers into lowercased subword tokens (ACRONYMWord, camelCase, snake, kebab).
 * Shared by build-time indexing and query-time retrieval.
 */
export function tokenize(text) {
    if (!text || typeof text !== "string")
        return [];
    return text
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // HTMLParser → HTML Parser
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → camel Case
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

const QUOTED_LITERAL_RE = /'([^'\\\n]{3,120})'|"([^"\\\n]{3,120})"|`([^`\\\n]{3,120})`/g;
const STRUCTURED_PATTERNS = [
    /(?:^|[\s(,[\]{}"'`=])(--[a-zA-Z0-9][a-zA-Z0-9_-]*|-[a-zA-Z0-9][a-zA-Z0-9_-]+)/g,
    /(\{![rsa]\}|\{[^}\s]{1,24}![rsa]\}|\{[0-9a-zA-Z_.:!-]{2,24}\})/g,
    /\b([a-zA-Z][a-zA-Z0-9_.-]{0,31}:[a-zA-Z0-9_.*:/-]{1,48})/g,
    /(?:^|[\s"'(`=,:])(\/(?:[a-zA-Z0-9_.:*{}-]+\/?)+)/g,
    /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|E[A-Z]{3,}[A-Z0-9]*|[A-Z]{2,}[0-9]{2,})\b/g,
];

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
    }
}

function recordStructuredLiterals(text, record) {
    for (const re of STRUCTURED_PATTERNS) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
            const raw = m[1];
            if (!raw || raw.startsWith("//") || /^https?:$/.test(raw))
                continue;
            const matchOffset = (m.index ?? 0) + m[0].indexOf(raw);
            record(matchOffset, raw);
            const fmt = raw.match(/^\{[^}\s]+(![rsa])\}$/);
            if (fmt)
                record(matchOffset + 1, `{${fmt[1]}}`);
        }
    }
}

/**
 * Extract quoted string/template literals and structured keys/codes (`>= 3` chars,
 * e.g. `confirm:email`, `{!r}`, `--flag`, error codes, route paths) as clean lowercased tokens.
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
    recordQuotedLiterals(text, record);
    recordStructuredLiterals(text, record);
    return out;
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

function stripPluralSuffix(w) {
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
    ["cframe", ["coordin", "fram"]],
    ["mtime", ["modify", "tim"]],
    ["prop", ["property"]],
    ["props", ["property"]],
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
export const ASK_INDEX_VERSION = 3;

/** Absolute path to the legacy ask sidecar location (`<outDir>/.cache/ask-index.json`). */
export function askIndexPath(outDir) {
    return join(outDir, CACHE_DIR, ASK_INDEX_FILE);
}

function pairs(m) {
    return [...m.entries()];
}

/** Sum of a token→count bag's counts (a document's field length). */
export function bagLen(p) {
    let n = 0;
    if (p instanceof Map) {
        for (const c of p.values())
            n += c;
    }
    else if (Array.isArray(p)) {
        for (const [, c] of p)
            n += c;
    }
    return n;
}

function isQualifiedCompoundOwner(owner, bare) {
    return Boolean(owner &&
        !bare.includes("_") &&
        !/[A-Z]/.test(bare.slice(1)) &&
        owner !== "Command" &&
        !/^(?:module|exports|window|global|self|this)$/i.test(owner) &&
        !owner.startsWith("Socket"));
}

export function recordNodeCompoundVocab(n, compoundSymbols) {
    if (n.path) {
        const base = basename(n.path).replace(/\.[a-z0-9]+$/i, "");
        if (base.length >= 6)
            compoundSymbols.set(base.toLowerCase(), base);
    }
    if (n.kind === "file" || !n.name)
        return;
    const bare = n.name.split(/[.:#]/).pop() ?? "";
    const bareToks = tokenize(bare);
    if (bare.length >= 6 && (!bare.includes("_") || bareToks.length >= 3 || bareToks.some((t) => t.length >= 7))) {
        compoundSymbols.set(bare.toLowerCase(), bare);
        const flat = bare.replace(/^_+/, "").replaceAll("_", "").toLowerCase();
        if (flat.length >= 6 && !compoundSymbols.has(flat))
            compoundSymbols.set(flat, bare);
        const strippedPrefix = bare.replace(/^(?:_?(?:on|handle|is)_|(?:on|handle|is|get)(?=[A-Z]))/, "");
        const flatStripped = strippedPrefix.replaceAll("_", "").toLowerCase();
        if (flatStripped.length >= 6 && !compoundSymbols.has(flatStripped))
            compoundSymbols.set(flatStripped, bare);
    }
    if (isQualifiedCompoundOwner(n.owner, bare)) {
        const qualKey = `${stemToken(n.owner.toLowerCase())}${stemToken(bare.toLowerCase())}`;
        if (qualKey.length >= 8 && !compoundSymbols.has(qualKey))
            compoundSymbols.set(qualKey, `${n.owner}.${bare}`);
    }
}

function buildAskVocab(nodes) {
    const compoundSymbols = new Map();
    const nameTokSet = new Set();
    const nameStems = new Map();
    const pathTokSet = new Set();
    for (const n of nodes) {
        recordNodeCompoundVocab(n, compoundSymbols);
        for (const t of tokenize(n.path ?? "")) {
            if (t.length >= 3)
                pathTokSet.add(t);
        }
        if (n.kind === "file")
            continue;
        const seenStems = new Set();
        for (const t of tokenize(n.name ?? "")) {
            if (t.length < 3)
                continue;
            nameTokSet.add(t);
            const s = stemToken(t);
            if (!seenStems.has(s)) {
                seenStems.add(s);
                nameStems.set(s, (nameStems.get(s) ?? 0) + 1);
            }
        }
    }
    return {
        compoundSymbols: pairs(compoundSymbols),
        nameToks: [...nameTokSet].sort(),
        nameStemCounts: pairs(nameStems),
        pathToks: [...pathTokSet].sort(),
    };
}

function deserializeVocab(rawVocab, docCount) {
    const v = rawVocab && typeof rawVocab === "object" ? rawVocab : {};
    return {
        nDocs: Number(docCount) || 100,
        nameTokens: new Set(v.nameToks ?? []),
        nameStems: new Map(v.nameStemCounts ?? []),
        pathTokens: new Set(v.pathToks ?? []),
        compoundSymbols: new Map(v.compoundSymbols ?? []),
    };
}

function inferRepoRoot(outDir, opts) {
    if (opts?.root)
        return resolve(opts.root);
    const absOut = resolve(outDir);
    if (basename(absOut) === "plexer")
        return dirname(absOut);
    if (existsSync(join(absOut, "README.md")) || existsSync(join(absOut, "docs")) || existsSync(join(absOut, ".git")))
        return absOut;
    return null;
}

function collectRootReadmeDocs(repoRoot, found, seen) {
    for (const candidate of ["README.md", "readme.md"]) {
        const abs = join(repoRoot, candidate);
        const key = candidate.toLowerCase();
        if (existsSync(abs) && !seen.has(key)) {
            seen.add(key);
            found.push({ relPath: candidate, absPath: abs });
        }
    }
}

function collectMarkdownFromDirEntries(repoRoot, cur, entries, stack, found, seen) {
    for (const ent of entries) {
        if (ent.name.startsWith(".") || ent.name === "node_modules" || ent.name === "plexer" || ent.isSymbolicLink())
            continue;
        const full = join(cur, ent.name);
        if (ent.isDirectory()) {
            stack.push(full);
            continue;
        }
        if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
            const rel = toPosixPath(full.slice(repoRoot.length + 1));
            if (!seen.has(rel)) {
                seen.add(rel);
                found.push({ relPath: rel, absPath: full });
            }
        }
    }
}

export function collectMarkdownDocFiles(repoRoot) {
    if (!repoRoot || !existsSync(repoRoot))
        return [];
    const found = [];
    const seen = new Set();
    collectRootReadmeDocs(repoRoot, found, seen);
    const docsDir = join(repoRoot, "docs");
    if (existsSync(docsDir)) {
        const stack = [docsDir];
        while (stack.length > 0) {
            const cur = stack.pop();
            let entries;
            try {
                entries = readdirSync(cur, { withFileTypes: true });
            }
            catch {
                continue;
            }
            collectMarkdownFromDirEntries(repoRoot, cur, entries, stack, found, seen);
        }
    }
    return found.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function digestDocHashes(items) {
    if (!items || items.length === 0)
        return "empty";
    return contentHash(items.map(([rel, hash]) => `${rel}\0${hash}`).join("\n"));
}

/**
 * Deterministic digest over markdown docs (`README.md`, `readme.md`, `docs/**\/*.md`)
 * so `buildGraph` detects `.md`-only edits/additions/deletions without scanning `.wiring`.
 */
export function computeMarkdownDocsDigest(repoRoot) {
    const mdFiles = collectMarkdownDocFiles(repoRoot);
    const items = [];
    for (const { relPath, absPath } of mdFiles) {
        try {
            const raw = readFileSync(absPath, "utf8");
            items.push([relPath, contentHash(raw)]);
        }
        catch {
            /* ignore unreadable doc */
        }
    }
    return digestDocHashes(items);
}

function slugHeading(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48) || "section";
}

function firstMarkdownProseLine(lines) {
    let inFence = false;
    for (const raw of lines) {
        const t = raw.trim();
        if (/^(```|~~~)/.test(t)) {
            inFence = !inFence;
            continue;
        }
        if (inFence || !t)
            continue;
        if (/^(---|===|\*\*\*|<!--|\[!\[|<img\b)/i.test(t))
            continue;
        if (/^#{1,6}\s+/.test(t))
            continue;
        return t.replace(/^[-*+]\s+/, "").slice(0, 220);
    }
    return "";
}

/**
 * Split a markdown file into H1-H3 sections (`kind: "doc"`).
 * Uses `{ name: heading, signature: breadcrumb, summary: firstProseLine, body_text, exported: true }`.
 */
function parseMarkdownSections(relPath, content) {
    if (!content)
        return [];
    const lines = content.split(/\r?\n/);
    const sections = [];
    const stack = ["", "", ""];
    let inFence = false;
    let cur = null;

    const flush = (endLine) => {
        if (!cur)
            return;
        const bodyLines = lines.slice(cur.startLine, endLine);
        const bodyText = searchBody(bodyLines.join("\n"), 5000);
        const summary = firstMarkdownProseLine(bodyLines) || null;
        if (cur.name || bodyText) {
            sections.push({
                id: `doc:${relPath}#${cur.startLine}:${slugHeading(cur.name)}`,
                path: relPath,
                kind: "doc",
                name: cur.name,
                span: `L${cur.startLine}-L${Math.max(cur.startLine, endLine)}`,
                signature: cur.breadcrumb,
                summary,
                exported: true,
                body_text: bodyText,
            });
        }
        cur = null;
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (/^(```|~~~)/.test(trimmed)) {
            inFence = !inFence;
            continue;
        }
        if (!inFence) {
            const m = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
            if (m) {
                const lineNum = i + 1;
                flush(i);
                const level = m[1].length;
                const heading = m[2].trim();
                stack[level - 1] = heading;
                for (let k = level; k < 3; k++)
                    stack[k] = "";
                const breadcrumb = stack.filter(Boolean).join(" > ") || heading;
                cur = {
                    startLine: lineNum,
                    name: heading,
                    breadcrumb,
                };
            }
        }
    }
    flush(lines.length);

    if (sections.length === 0) {
        const text = searchBody(content, 5000);
        if (text) {
            const fallbackName = basename(relPath).replace(/\.md$/i, "");
            sections.push({
                id: `doc:${relPath}#1:${slugHeading(fallbackName)}`,
                path: relPath,
                kind: "doc",
                name: fallbackName,
                span: `L1-L${Math.max(1, lines.length)}`,
                signature: relPath,
                summary: firstMarkdownProseLine(lines) || null,
                exported: true,
                body_text: text,
            });
        }
    }
    return sections;
}

/**
 * Lightweight normalized PageRank prior in `[0, 1]` over WALK_RELATIONS edges
 * so SQLite-only `ask` has immediate structural authority weights without building CSR from disk.
 */
function buildStaticWalkAdjacency(nodes, edges) {
    const n = nodes.length;
    const idxById = new Map();
    for (let i = 0; i < n; i++)
        idxById.set(nodes[i].id, i);
    const adj = Array.from({ length: n }, () => []);
    let hasAnyEdge = false;
    for (const e of edges) {
        if (!WALK_RELATIONS.has(e.relation))
            continue;
        const u = idxById.get(e.source);
        const v = idxById.get(e.target);
        if (u === undefined || v === undefined || u === v)
            continue;
        adj[u].push(v);
        hasAnyEdge = true;
    }
    return hasAnyEdge ? adj : null;
}

function stepStaticPagerankIter(adj, rank, next, n, d, invN) {
    let sinkMass = 0;
    next.fill(0);
    for (let i = 0; i < n; i++) {
        const targets = adj[i];
        if (targets.length === 0) {
            sinkMass += rank[i];
            continue;
        }
        const share = (d * rank[i]) / targets.length;
        for (let j = 0; j < targets.length; j++)
            next[targets[j]] += share;
    }
    const teleport = (1 - d) * invN + d * sinkMass * invN;
    for (let i = 0; i < n; i++)
        next[i] += teleport;
}

function normalizeStaticPagerankMap(nodes, rank) {
    const out = new Map();
    let maxRank = 0;
    for (let i = 0; i < nodes.length; i++) {
        if (rank[i] > maxRank)
            maxRank = rank[i];
    }
    if (maxRank <= 0)
        return out;
    for (let i = 0; i < nodes.length; i++)
        out.set(nodes[i].id, Number((rank[i] / maxRank).toFixed(6)));
    return out;
}

function computeStaticPageranks(nodes, edges) {
    const n = nodes.length;
    if (n === 0 || !Array.isArray(edges) || edges.length === 0)
        return new Map();
    const adj = buildStaticWalkAdjacency(nodes, edges);
    if (!adj)
        return new Map();
    let rank = new Float64Array(n).fill(1 / n);
    let next = new Float64Array(n);
    const invN = 1 / n;
    for (let iter = 0; iter < 15; iter++) {
        stepStaticPagerankIter(adj, rank, next, n, 0.85, invN);
        const tmp = rank;
        rank = next;
        next = tmp;
    }
    return normalizeStaticPagerankMap(nodes, rank);
}

function resolveBodyTextForNode(n, repoRoot, fileLineCache) {
    if (typeof n.body_text === "string")
        return n.body_text;
    if (!repoRoot || !n.path || !n.span)
        return "";
    let lines = fileLineCache.get(n.path);
    if (lines === undefined) {
        const text = readSourceFile(join(repoRoot, n.path));
        lines = text ? text.split(/\r?\n/) : null;
        fileLineCache.set(n.path, lines);
    }
    if (!lines)
        return "";
    const range = spanRange(n.span);
    if (!range)
        return "";
    const slice = lines.slice(Math.max(0, range.start - 1), Math.min(lines.length, range.end)).join("\n");
    return searchBody(slice, n.kind === "file" ? 16000 : 5000);
}

function buildChannelPostings(doc, bodyText) {
    const nameMap = counts(tokenize(doc.name ?? ""));
    const pathMap = counts(tokenize(doc.path ?? ""));
    const sigMap = counts(tokenize(doc.signature ?? ""));
    const summaryMap = counts(tokenize(doc.summary ?? ""));
    const litText = `${doc.signature ?? ""} ${doc.summary ?? ""} ${bodyText ?? ""}`;
    const literalsMap = counts(extractLiterals(litText));
    const bodyMap = counts(tokenize(bodyText ?? ""));

    // Combined token frequencies across non-literal lexical fields drive the `stem` channel.
    const allTokenCounts = new Map();
    for (const m of [nameMap, pathMap, sigMap, summaryMap, bodyMap]) {
        for (const [tok, tf] of m) {
            allTokenCounts.set(tok, (allTokenCounts.get(tok) ?? 0) + tf);
        }
    }
    const stemMap = stemCounts(allTokenCounts);

    const exactText = `${doc.name ?? ""} ${doc.path ?? ""} ${doc.signature ?? ""} ${doc.summary ?? ""} ${bodyText ?? ""}`;
    const exactMap = counts(tokenizeExact(exactText));

    const channels = {
        name: nameMap,
        path: pathMap,
        sig: sigMap,
        summary: summaryMap,
        literals: literalsMap,
        body: bodyMap,
        stem: stemMap,
        exact_ident: exactMap,
    };
    const fieldLens = {
        name: bagLen(nameMap),
        path: bagLen(pathMap),
        sig: bagLen(sigMap),
        summary: bagLen(summaryMap),
        literals: bagLen(literalsMap),
        body: bagLen(bodyMap),
        stem: bagLen(stemMap),
        exact_ident: bagLen(exactMap),
    };
    return { channels, fieldLens };
}

function normalizeAvgLens(raw) {
    const out = emptyFieldLens();
    if (!raw || typeof raw !== "object")
        return out;
    for (const ch of ASK_CHANNELS) {
        const v = Number(raw[ch]);
        out[ch] = Number.isFinite(v) ? v : 0;
    }
    return out;
}

function computeAvgLensAndDfSql(store) {
    const rows = prepareStmt(store, "SELECT field_lens_json FROM ask_docs").all();
    const docCount = rows.length;
    const sums = emptyFieldLens();
    for (const r of rows) {
        try {
            const lens = JSON.parse(r.field_lens_json);
            for (const ch of ASK_CHANNELS) {
                sums[ch] += Number(lens?.[ch] ?? 0);
            }
        }
        catch {
            /* ignore malformed row */
        }
    }
    const avgLens = emptyFieldLens();
    if (docCount > 0) {
        for (const ch of ASK_CHANNELS) {
            avgLens[ch] = sums[ch] / docCount;
        }
    }
    return { docCount, avgLens };
}

function normalizeWriteOpts(thirdArg) {
    if (!thirdArg)
        return {};
    if (thirdArg instanceof Set || Array.isArray(thirdArg)) {
        return { dirtyPaths: new Set(thirdArg) };
    }
    if (typeof thirdArg === "object") {
        // Legacy callers passed `prior` object ({ version, docs, df, ... })
        if ("version" in thirdArg && Array.isArray(thirdArg.docs)) {
            return { prior: thirdArg };
        }
        return thirdArg;
    }
    return {};
}

/**
 * Write multi-channel BM25 postings (`name`, `path`, `sig`, `summary`, `literals`,
 * `body`, `stem`, `exact_ident`) plus markdown `doc` sections into `<outDir>/.cache/index.sqlite`
 * inside a single `BEGIN IMMEDIATE ... COMMIT` transaction.
 *
 * Supports incremental `dirtyPaths` / `deletedPaths` updates when `index.sqlite` is populated.
 */
function loadAskMarkdownDocs(repoRoot, includeDocs) {
    if (includeDocs === false)
        return { mdNodes: [], docsDigest: "disabled" };
    const mdFiles = collectMarkdownDocFiles(repoRoot);
    const mdNodes = [];
    const mdHashItems = [];
    for (const { relPath, absPath } of mdFiles) {
        try {
            const raw = readFileSync(absPath, "utf8");
            mdHashItems.push([relPath, contentHash(raw)]);
            mdNodes.push(...parseMarkdownSections(relPath, raw));
        }
        catch {
            /* ignore unreadable doc */
        }
    }
    return { mdNodes, docsDigest: digestDocHashes(mdHashItems) };
}

function insertSingleAskDoc(n, docId, pageranks, repoRoot, fileLineCache, insertDoc, insertPosting, onDfTerm) {
    const bodyText = n.kind === "doc" ? (n.body_text ?? "") : resolveBodyTextForNode(n, repoRoot, fileLineCache);
    const { channels, fieldLens } = buildChannelPostings(n, bodyText);
    const pr = n.kind === "doc" ? 0 : (pageranks.get(n.id) ?? 0);
    insertDoc.run(
        docId, n.id, n.path ?? "", n.kind ?? "unknown", n.name ?? "", n.span ?? "L1-L1",
        n.signature ?? null, n.summary ?? null, n.exported ? 1 : 0, JSON.stringify(fieldLens), pr,
    );
    for (const ch of ASK_CHANNELS) {
        for (const [term, tf] of channels[ch]) {
            insertPosting.run(ch, term, docId, tf);
            onDfTerm(ch, term);
        }
    }
    return fieldLens;
}

function writeFullAskIndexTx(store, allDocs, pageranks, repoRoot, fileLineCache, vocab, docsDigest) {
    store.db.exec(`
        DELETE FROM ask_df;
        DELETE FROM ask_postings;
        DELETE FROM ask_docs;
    `);
    const insertDoc = prepareStmt(
        store,
        `INSERT INTO ask_docs(
            doc_id, node_id, path, kind, name, span, signature, summary, exported, field_lens_json, pagerank
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPosting = prepareStmt(store, "INSERT INTO ask_postings(channel, term, doc_id, tf) VALUES (?, ?, ?, ?)");
    const insertDf = prepareStmt(store, "INSERT INTO ask_df(channel, term, df) VALUES (?, ?, ?)");
    const dfByChannel = new Map(ASK_CHANNELS.map((ch) => [ch, new Map()]));
    const lensSums = emptyFieldLens();
    const recordDf = (ch, term) => {
        const dfMap = dfByChannel.get(ch);
        dfMap.set(term, (dfMap.get(term) ?? 0) + 1);
    };
    for (let i = 0; i < allDocs.length; i++) {
        const fieldLens = insertSingleAskDoc(
            allDocs[i], i + 1, pageranks, repoRoot, fileLineCache, insertDoc, insertPosting, recordDf,
        );
        for (const ch of ASK_CHANNELS)
            lensSums[ch] += fieldLens[ch];
    }
    for (const [ch, dfMap] of dfByChannel) {
        for (const [term, df] of dfMap)
            insertDf.run(ch, term, df);
    }
    const docCount = allDocs.length;
    const avgLens = emptyFieldLens();
    if (docCount > 0) {
        for (const ch of ASK_CHANNELS)
            avgLens[ch] = lensSums[ch] / docCount;
    }
    setSqliteMetaMany(store, {
        doc_count: String(docCount),
        avg_lens_json: JSON.stringify(avgLens),
        vocab_json: JSON.stringify(vocab),
        docs_hash: docsDigest,
    });
}

function collectIncrementalAskStaleDocs(store, codeNodes, touchedPaths) {
    const existingDocRows = prepareStmt(store, "SELECT doc_id, node_id, path, kind, pagerank FROM ask_docs").all();
    const existingNodeIds = new Set();
    let maxDocId = 0;
    const staleDocIds = [];
    const docIdsByPath = new Map();
    for (const r of existingDocRows) {
        if (r.doc_id > maxDocId)
            maxDocId = r.doc_id;
        existingNodeIds.add(r.node_id);
        if (r.kind === "doc" || touchedPaths.has(r.path)) {
            staleDocIds.push(r.doc_id);
        }
        else {
            const arr = docIdsByPath.get(r.path) ?? [];
            arr.push(r.doc_id);
            docIdsByPath.set(r.path, arr);
        }
    }
    for (const n of codeNodes) {
        if (touchedPaths.has(n.path) || existingNodeIds.has(n.id))
            continue;
        touchedPaths.add(n.path);
        for (const id of docIdsByPath.get(n.path) ?? [])
            staleDocIds.push(id);
        docIdsByPath.delete(n.path);
    }
    return { existingDocRows, maxDocId, staleDocIds };
}

function applyAskDfDeltaStatements(store, dfDelta) {
    const selectDf = prepareStmt(store, "SELECT df FROM ask_df WHERE channel = ? AND term = ?");
    const upsertDf = prepareStmt(store, "INSERT OR REPLACE INTO ask_df(channel, term, df) VALUES (?, ?, ?)");
    const deleteDf = prepareStmt(store, "DELETE FROM ask_df WHERE channel = ? AND term = ?");
    for (const [k, delta] of dfDelta) {
        if (delta === 0)
            continue;
        const sep = k.indexOf("\0");
        const ch = k.slice(0, sep);
        const term = k.slice(sep + 1);
        const curRow = selectDf.get(ch, term);
        const nextDf = (curRow ? Number(curRow.df) : 0) + delta;
        if (nextDf <= 0)
            deleteDf.run(ch, term);
        else
            upsertDf.run(ch, term, nextDf);
    }
}

function writeIncrementalAskIndexTx(store, codeNodes, mdNodes, dirtyPaths, deletedPaths, pageranks, repoRoot, fileLineCache, vocab, docsDigest) {
    const touchedPaths = new Set([...(dirtyPaths ?? []), ...(deletedPaths ?? [])]);
    const { existingDocRows, maxDocId, staleDocIds } = collectIncrementalAskStaleDocs(store, codeNodes, touchedPaths);
    const dfDelta = new Map();
    const bumpDf = (ch, term, delta) => {
        const k = `${ch}\0${term}`;
        dfDelta.set(k, (dfDelta.get(k) ?? 0) + delta);
    };
    const selectDocPostings = prepareStmt(store, "SELECT channel, term FROM ask_postings WHERE doc_id = ?");
    const deletePostingsByDoc = prepareStmt(store, "DELETE FROM ask_postings WHERE doc_id = ?");
    const deleteDocById = prepareStmt(store, "DELETE FROM ask_docs WHERE doc_id = ?");
    for (const oldDocId of staleDocIds) {
        for (const row of selectDocPostings.all(oldDocId))
            bumpDf(row.channel, row.term, -1);
        deletePostingsByDoc.run(oldDocId);
        deleteDocById.run(oldDocId);
    }

    const insertDoc = prepareStmt(
        store,
        `INSERT INTO ask_docs(
            doc_id, node_id, path, kind, name, span, signature, summary, exported, field_lens_json, pagerank
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertPosting = prepareStmt(store, "INSERT INTO ask_postings(channel, term, doc_id, tf) VALUES (?, ?, ?, ?)");
    const nodesToInsert = [
        ...codeNodes.filter((n) => touchedPaths.has(n.path) && !deletedPaths?.has(n.path)),
        ...mdNodes,
    ];
    let nextDocId = maxDocId + 1;
    for (const n of nodesToInsert) {
        insertSingleAskDoc(n, nextDocId++, pageranks, repoRoot, fileLineCache, insertDoc, insertPosting, (ch, term) => bumpDf(ch, term, 1));
    }

    if (pageranks.size > 0) {
        const updatePr = prepareStmt(store, "UPDATE ask_docs SET pagerank = ? WHERE doc_id = ?");
        for (const r of existingDocRows) {
            if (r.kind === "doc" || touchedPaths.has(r.path))
                continue;
            const nextPr = pageranks.get(r.node_id) ?? 0;
            if (Math.abs((r.pagerank ?? 0) - nextPr) > 1e-6)
                updatePr.run(nextPr, r.doc_id);
        }
    }

    applyAskDfDeltaStatements(store, dfDelta);
    const { docCount, avgLens } = computeAvgLensAndDfSql(store);
    setSqliteMetaMany(store, {
        doc_count: String(docCount),
        avg_lens_json: JSON.stringify(avgLens),
        vocab_json: JSON.stringify(vocab),
        docs_hash: docsDigest,
    });
}

export function writeAskIndex(outDir, graph, optsOrPrior) {
    const opts = normalizeWriteOpts(optsOrPrior);
    const store = openSqliteStore(outDir, { create: true });
    const repoRoot = inferRepoRoot(outDir, opts);
    const codeNodes = [...(graph?.nodes ?? [])].sort((a, b) => a.id.localeCompare(b.id));
    const pageranks = opts.pageranks ?? computeStaticPageranks(codeNodes, graph?.edges ?? []);
    const { mdNodes, docsDigest } = loadAskMarkdownDocs(repoRoot, opts.includeDocs);

    const dirtyPaths = opts.dirtyPaths ? new Set(opts.dirtyPaths) : null;
    const deletedPaths = opts.deletedPaths ? new Set(opts.deletedPaths) : null;
    const forceFull = opts.fullRebuild === true || (!dirtyPaths && !deletedPaths);
    const existingDocCount = Number(prepareStmt(store, "SELECT COUNT(*) AS cnt FROM ask_docs").get()?.cnt ?? 0);
    const canIncremental = !forceFull && existingDocCount > 0;

    withSqliteTransaction(store, () => {
        const vocab = buildAskVocab(codeNodes);
        const fileLineCache = new Map();
        if (!canIncremental) {
            writeFullAskIndexTx(store, [...codeNodes, ...mdNodes], pageranks, repoRoot, fileLineCache, vocab, docsDigest);
            return;
        }
        writeIncrementalAskIndexTx(
            store, codeNodes, mdNodes, dirtyPaths, deletedPaths, pageranks, repoRoot, fileLineCache, vocab, docsDigest,
        );
    });

    if (store.txDepth === 0)
        checkpointSqliteStore(outDir, "PASSIVE");
    cleanupLegacyCacheFiles(outDir);
    invalidateLocalAskCaches(outDir);
    return sqliteStorePath(outDir);
}

function readAskSqliteIndexMeta(store) {
    let meta;
    try {
        meta = getAllSqliteMeta(store);
    }
    catch {
        return null;
    }
    let docCount = Number(meta.doc_count ?? 0);
    if (!Number.isFinite(docCount) || docCount <= 0) {
        docCount = Number(prepareStmt(store, "SELECT COUNT(*) AS cnt FROM ask_docs").get()?.cnt ?? 0);
        if (docCount <= 0)
            return null;
    }
    let avgLens = emptyFieldLens();
    if (meta.avg_lens_json) {
        try { avgLens = normalizeAvgLens(JSON.parse(meta.avg_lens_json)); }
        catch { avgLens = emptyFieldLens(); }
    }
    let vocab = deserializeVocab(null, docCount);
    if (meta.vocab_json) {
        try { vocab = deserializeVocab(JSON.parse(meta.vocab_json), docCount); }
        catch { /* fallback empty vocab */ }
    }
    return { docCount, avgLens, vocab };
}

function collectNormalizedChannelTerms(rawTerms) {
    const termSet = new Set();
    for (const t of rawTerms) {
        if (typeof t !== "string")
            continue;
        const norm = t.trim().toLowerCase();
        if (norm)
            termSet.add(norm);
    }
    return [...termSet];
}

const askIndexCache = new Map();
const askIndexSqliteCache = new Map();
const askVocabCache = new Map();
const askQuerySnapshotCache = new Map();

function invalidateLocalAskCaches(outDir) {
    if (outDir !== undefined && outDir !== null) {
        const key = resolve(outDir);
        askIndexCache.delete(askIndexPath(outDir));
        askIndexCache.delete(askIndexPath(key));
        askIndexSqliteCache.delete(key);
        askVocabCache.delete(key);
        askQuerySnapshotCache.delete(key);
        return;
    }
    askIndexCache.clear();
    askIndexSqliteCache.clear();
    askVocabCache.clear();
    askQuerySnapshotCache.clear();
}

registerGraphCacheClearer((outDir) => {
    invalidateLocalAskCaches(outDir);
});

const MAX_CACHED_POSTING_TERMS_PER_CHAN = 2048;
const EMPTY_POSTING_ROWS = Object.freeze([]);

function setBoundedChannelPosting(chanCache, term, value) {
    if (!chanCache.has(term) && chanCache.size >= MAX_CACHED_POSTING_TERMS_PER_CHAN) {
        const oldest = chanCache.keys().next().value;
        if (oldest !== undefined)
            chanCache.delete(oldest);
    }
    chanCache.set(term, value);
}

function collectMissingCachedPostings(terms, chanCache, dfMap, postMap, hitDocIds) {
    if (!chanCache)
        return terms;
    const missing = [];
    for (const term of terms) {
        const cached = chanCache.get(term);
        if (!cached) {
            missing.push(term);
            continue;
        }
        if (cached.df > 0)
            dfMap.set(term, cached.df);
        if (cached.rows.length > 0) {
            postMap.set(term, cached.rows);
            for (const [docId] of cached.rows)
                hitDocIds.add(docId);
        }
    }
    return missing;
}

function fetchTermPostingsPairs(arrayStmt, objStmt, ch, term) {
    if (arrayStmt)
        return arrayStmt.all(ch, term);
    const postRows = objStmt.all(ch, term);
    if (postRows.length === 0)
        return EMPTY_POSTING_ROWS;
    const arr = new Array(postRows.length);
    for (let i = 0; i < postRows.length; i++) {
        const r = postRows[i];
        arr[i] = [Number(r.doc_id), Number(r.tf)];
    }
    return arr;
}

function queryChannelPostingsChunked(store, ch, terms, dfMap, postMap, hitDocIds, _chunk, chanCache = null) {
    const targetTerms = collectMissingCachedPostings(terms, chanCache, dfMap, postMap, hitDocIds);
    if (targetTerms.length === 0)
        return;
    const sql = "SELECT doc_id, tf FROM ask_postings WHERE channel = ? AND term = ?";
    const arrayStmt = prepareArrayStmt(store, sql);
    const objStmt = arrayStmt ? null : prepareStmt(store, sql);
    for (const t of targetTerms) {
        const rows = fetchTermPostingsPairs(arrayStmt, objStmt, ch, t);
        if (rows.length > 0) {
            for (let i = 0; i < rows.length; i++)
                hitDocIds.add(rows[i][0]);
            dfMap.set(t, rows.length);
            postMap.set(t, rows);
            if (chanCache)
                setBoundedChannelPosting(chanCache, t, { df: rows.length, rows });
        }
        else if (chanCache) {
            setBoundedChannelPosting(chanCache, t, { df: 0, rows: EMPTY_POSTING_ROWS });
        }
    }
}

const ASK_DOCS_SELECT_SQL = "SELECT doc_id, node_id, path, kind, name, span, signature, summary, exported, field_lens_json, pagerank FROM ask_docs";

class AskHydratedDoc {
    constructor(r, isArray = false) {
        const a = isArray ? r : [
            r.doc_id, r.node_id, r.path, r.kind, r.name, r.span,
            r.signature, r.summary, r.exported, r.field_lens_json, r.pagerank,
        ];
        this.docId = Number(a[0]);
        this.nodeId = a[1];
        this.path = a[2];
        this.kind = a[3];
        this.name = a[4];
        this.span = a[5];
        this.signature = a[6] ?? null;
        this.summary = a[7] ?? null;
        this.exported = Boolean(a[8]);
        this.pagerank = Number(a[10] ?? 0);
        this._fieldLensJson = a[9];
        this._fieldLens = null;
        this._normSpan = undefined;
        this._lexStatic = null;
    }

    get fieldLens() {
        if (this._fieldLens !== null)
            return this._fieldLens;
        let parsed = null;
        if (this._fieldLensJson) {
            try { parsed = JSON.parse(this._fieldLensJson); }
            catch { parsed = null; }
            this._fieldLensJson = null;
        }
        return (this._fieldLens = parsed && typeof parsed === "object" ? parsed : emptyFieldLens());
    }
}

function fetchAskDocRows(store, sql, args) {
    const arrStmt = prepareArrayStmt(store, sql);
    if (arrStmt)
        return { rows: args ? arrStmt.all(...args) : arrStmt.all(), isArray: true };
    const objStmt = prepareStmt(store, sql);
    return { rows: args ? objStmt.all(...args) : objStmt.all(), isArray: false };
}

function hydrateMissingAskDocs(store, missingIds, totalDocs, chunk, snapshot, docsById) {
    if (snapshot && !snapshot.allDocsLoaded && missingIds.length >= 400 && totalDocs > 0 && (totalDocs <= 5000 || missingIds.length * 4 >= totalDocs)) {
        const { rows, isArray } = fetchAskDocRows(store, ASK_DOCS_SELECT_SQL, null);
        for (let i = 0; i < rows.length; i++) {
            const doc = new AskHydratedDoc(rows[i], isArray);
            if (!docsById.has(doc.docId))
                docsById.set(doc.docId, doc);
        }
        snapshot.allDocsLoaded = true;
        return;
    }
    for (let off = 0; off < missingIds.length; off += chunk) {
        const slice = missingIds.slice(off, off + chunk);
        const placeholders = slice.map(() => "?").join(",");
        const { rows, isArray } = fetchAskDocRows(store, `${ASK_DOCS_SELECT_SQL} WHERE doc_id IN (${placeholders})`, slice);
        for (let i = 0; i < rows.length; i++) {
            const doc = new AskHydratedDoc(rows[i], isArray);
            docsById.set(doc.docId, doc);
        }
    }
}

function loadAskHitDocsByIds(store, hitDocIds, chunk, snapshot) {
    const docs = new Map();
    if (hitDocIds.size === 0) return docs;
    const docsById = snapshot ? snapshot.docsById : new Map();
    const missingIds = [];
    if (!snapshot?.allDocsLoaded) {
        for (const id of hitDocIds) {
            if (!docsById.has(id)) missingIds.push(id);
        }
    }
    if (missingIds.length > 0)
        hydrateMissingAskDocs(store, missingIds, snapshot?.metaInfo?.docCount ?? 0, chunk, snapshot, docsById);
    for (const id of hitDocIds) {
        const doc = docsById.get(id);
        if (doc) docs.set(id, doc);
    }
    return docs;
}

function getOrLoadAskQuerySnapshot(outDir, store) {
    const key = resolve(outDir);
    const rev = sqliteWalRevision(key);
    const dataVersion = Number(prepareStmt(store, "PRAGMA data_version").get()?.data_version ?? 0);
    const cached = askQuerySnapshotCache.get(key);
    if (rev && cached && sameWalRevision(cached.rev, rev) && cached.dataVersion === dataVersion) {
        return cached;
    }
    const metaInfo = readAskSqliteIndexMeta(store);
    if (!metaInfo) return null;
    const entry = { rev, dataVersion, metaInfo, docsById: new Map(), postingsByChan: new Map(), allDocsLoaded: false };
    askQuerySnapshotCache.set(key, entry);
    return entry;
}

export function queryAskPostings(outDir, termsByChannel = {}) {
    const store = openSqliteStore(outDir, { create: false });
    if (!store) return null;
    const snapshot = getOrLoadAskQuerySnapshot(outDir, store);
    if (!snapshot) return null;

    const df = {};
    const postings = {};
    for (const ch of ASK_CHANNELS) {
        df[ch] = new Map();
        postings[ch] = new Map();
    }
    const hitDocIds = new Set();
    const CHUNK = 250;
    for (const ch of ASK_CHANNELS) {
        const rawTerms = termsByChannel?.[ch];
        if (!rawTerms) continue;
        const terms = collectNormalizedChannelTerms(rawTerms);
        if (terms.length > 0) {
            let chanCache = snapshot.postingsByChan.get(ch);
            if (!chanCache)
                snapshot.postingsByChan.set(ch, (chanCache = new Map()));
            queryChannelPostingsChunked(store, ch, terms, df[ch], postings[ch], hitDocIds, CHUNK, chanCache);
        }
    }

    return {
        docCount: snapshot.metaInfo.docCount,
        avgLens: snapshot.metaInfo.avgLens,
        df,
        docs: loadAskHitDocsByIds(store, hitDocIds, CHUNK, snapshot),
        postings,
        vocab: snapshot.metaInfo.vocab,
    };
}

class LazySqliteDfMap extends Map {
    constructor(load) {
        super();
        this._load = load;
    }

    get(k) {
        if (super.has(k))
            return super.get(k);
        const v = this._load(k);
        super.set(k, v);
        return v;
    }
}

function queryVocabDocIds(activeStore, sql, keyVal) {
    const arrStmt = prepareArrayStmt(activeStore, sql);
    if (arrStmt)
        return { rows: arrStmt.all(String(keyVal)), isArray: true };
    return { rows: prepareStmt(activeStore, sql).all(String(keyVal)), isArray: false };
}

function countNonDocRowIds(rows, isArray, docKindIds, dedupSet) {
    if (rows.length === 0)
        return 0;
    if (rows.length === 1) {
        const singleId = isArray ? Number(rows[0][0]) : Number(rows[0].doc_id);
        return docKindIds.has(singleId) ? 0 : 1;
    }
    if (dedupSet) {
        dedupSet.clear();
        for (let i = 0; i < rows.length; i++) {
            const id = isArray ? Number(rows[i][0]) : Number(rows[i].doc_id);
            if (!docKindIds.has(id))
                dedupSet.add(id);
        }
        return dedupSet.size;
    }
    let count = 0;
    for (let i = 0; i < rows.length; i++) {
        const id = isArray ? Number(rows[i][0]) : Number(rows[i].doc_id);
        if (!docKindIds.has(id))
            count++;
    }
    return count;
}

function attachLazySqliteVocabDfMaps(value, key, initialStore, docKindIds) {
    let cachedStore = initialStore;
    const getStore = () => {
        if (!cachedStore || cachedStore.closed)
            cachedStore = openSqliteStore(key, { create: false });
        return cachedStore;
    };
    const seenDocIds = new Set();
    const dfSql = "SELECT doc_id FROM ask_postings WHERE channel IN ('name', 'path', 'sig', 'summary', 'body') AND term = ?";
    const stemSql = "SELECT doc_id FROM ask_postings WHERE channel = 'stem' AND term = ?";
    value.dfMap = new LazySqliteDfMap((term) => {
        const activeStore = getStore();
        if (!activeStore)
            return 0;
        const { rows, isArray } = queryVocabDocIds(activeStore, dfSql, term);
        return countNonDocRowIds(rows, isArray, docKindIds, seenDocIds);
    });
    value.stemDf = new LazySqliteDfMap((stem) => {
        const activeStore = getStore();
        if (!activeStore)
            return 0;
        if (docKindIds.size === 0)
            return Number(prepareStmt(activeStore, "SELECT df FROM ask_df WHERE channel = 'stem' AND term = ?").get(String(stem))?.df ?? 0);
        const { rows, isArray } = queryVocabDocIds(activeStore, stemSql, stem);
        return countNonDocRowIds(rows, isArray, docKindIds, null);
    });
}

/**
 * Load ask vocabulary `{ nDocs, dfMap, stemDf, nameTokens, nameStems, pathTokens, compoundSymbols }`
 * directly from SQLite `meta.vocab_json` with lazy per-term DF lookups (excluding `kind = 'doc'`).
 */
export function loadAskVocabCached(outDir) {
    const key = resolve(outDir);
    const rev = sqliteWalRevision(key);
    if (!rev) {
        askVocabCache.delete(key);
        const legacy = loadAskIndexCached(outDir);
        return legacy?.vocabHydrated ?? null;
    }
    const cached = askVocabCache.get(key);
    if (cached && sameWalRevision(cached.rev, rev))
        return cached.value;
    const store = openSqliteStore(key, { create: false });
    if (!store)
        return null;
    let parsedVocab = null;
    try {
        const vocabJson = getAllSqliteMeta(store).vocab_json;
        if (!vocabJson) {
            askVocabCache.set(key, { rev, value: null });
            return null;
        }
        parsedVocab = JSON.parse(vocabJson);
    }
    catch {
        return null;
    }
    const codeDocCount = Number(prepareStmt(store, "SELECT COUNT(*) AS c FROM ask_docs WHERE kind != 'doc'").get()?.c ?? 0);
    const docKindIds = new Set(prepareStmt(store, "SELECT doc_id FROM ask_docs WHERE kind = 'doc'").all().map((r) => Number(r.doc_id)));
    const value = deserializeVocab(parsedVocab, codeDocCount || 100);
    attachLazySqliteVocabDfMaps(value, key, store, docKindIds);
    askVocabCache.set(key, { rev, value });
    return value;
}

function buildVocabHydrated(raw, dfMap, stemDfMap) {
    const vocab = raw.vocab ?? {};
    return {
        dfMap,
        stemDf: stemDfMap,
        nameTokens: new Set(vocab.nameToks ?? []),
        nameStems: new Map(vocab.nameStemCounts ?? []),
        pathTokens: new Set(vocab.pathToks ?? []),
        compoundSymbols: new Map(vocab.compoundSymbols ?? []),
        nDocs: raw.docCount || 100,
    };
}

function hydrateAskIndex(raw) {
    if (!raw)
        return null;
    const dfMap = new Map(raw.df);
    const stemDfMap = new Map();
    const byId = new Map();
    for (const d of raw.docs) {
        const name = new Map(d.name);
        const path = new Map(d.path);
        const body = new Map(d.body);
        const nameStems = stemCounts(name);
        const pathStems = stemCounts(path);
        const bodyStems = stemCounts(body);
        const docStems = new Set([...nameStems.keys(), ...pathStems.keys(), ...bodyStems.keys()]);
        for (const st of docStems) {
            stemDfMap.set(st, (stemDfMap.get(st) ?? 0) + 1);
        }
        byId.set(d.id, {
            id: d.id,
            name,
            path,
            body,
            nameStems,
            pathStems,
            bodyStems,
            bodyLen: bagLen(d.body),
        });
    }
    Object.defineProperties(raw, {
        _hydrated: {
            value: { dfMap, stemDfMap, byId },
            enumerable: false,
            configurable: true,
        },
        vocabHydrated: {
            value: buildVocabHydrated(raw, dfMap, stemDfMap),
            enumerable: false,
            configurable: true,
        },
    });
    return raw;
}

function readAskIndexFromSqlite(outDir) {
    const store = openSqliteStore(outDir, { create: false });
    if (!store)
        return null;
    let meta;
    try {
        meta = getAllSqliteMeta(store);
    }
    catch {
        return null;
    }
    if (!meta.vocab_json)
        return null;

    let rawVocab;
    try {
        rawVocab = JSON.parse(meta.vocab_json);
    }
    catch {
        return null;
    }

    const docRows = prepareStmt(
        store,
        "SELECT doc_id, node_id FROM ask_docs WHERE kind != 'doc' ORDER BY node_id"
    ).all();
    const docIdToIdx = new Map();
    const docs = new Array(docRows.length);
    for (let i = 0; i < docRows.length; i++) {
        const r = docRows[i];
        docIdToIdx.set(Number(r.doc_id), i);
        docs[i] = {
            id: r.node_id,
            h: "",
            name: new Map(),
            path: new Map(),
            body: new Map(),
        };
    }

    const postingRows = prepareStmt(
        store,
        "SELECT channel, term, doc_id, tf FROM ask_postings WHERE channel IN ('name', 'path', 'sig', 'summary', 'body')"
    ).all();

    for (const r of postingRows) {
        const idx = docIdToIdx.get(Number(r.doc_id));
        if (idx === undefined)
            continue;
        const d = docs[idx];
        const tf = Number(r.tf);
        if (r.channel === "name") {
            d.name.set(r.term, tf);
        }
        else if (r.channel === "path") {
            d.path.set(r.term, tf);
        }
        else {
            // Reconstruct legacy `body` by merging `sig` + `summary` + `body`
            d.body.set(r.term, (d.body.get(r.term) ?? 0) + tf);
        }
    }

    const df = new Map();
    let totalBodyLen = 0;
    for (let i = 0; i < docs.length; i++) {
        const d = docs[i];
        const bag = new Set([...d.name.keys(), ...d.path.keys(), ...d.body.keys()]);
        for (const t of bag)
            df.set(t, (df.get(t) ?? 0) + 1);
        for (const c of d.body.values())
            totalBodyLen += c;
        docs[i] = {
            id: d.id,
            h: "",
            name: [...d.name.entries()],
            path: [...d.path.entries()],
            body: [...d.body.entries()],
        };
    }

    return {
        version: ASK_INDEX_VERSION,
        avgBodyLen: docs.length ? totalBodyLen / docs.length : 0,
        df: [...df.entries()],
        docCount: docs.length,
        vocab: rawVocab,
        docs,
    };
}

/**
 * Backward-compatible reader for the ask index. Hydrates symbol/file docs (`kind != 'doc'`)
 * from `<outDir>/.cache/index.sqlite` when present, falling back to legacy `.cache/ask-index.json`.
 */
export function readAskIndex(outDir) {
    if (sqliteStoreExists(outDir)) {
        const fromSql = readAskIndexFromSqlite(outDir);
        if (fromSql)
            return fromSql;
    }
    const raw = readJson(askIndexPath(outDir));
    if (!raw ||
        typeof raw !== "object" ||
        raw.version !== ASK_INDEX_VERSION ||
        !raw.vocab ||
        typeof raw.vocab !== "object" ||
        typeof raw.docCount !== "number" ||
        typeof raw.avgBodyLen !== "number" ||
        !Array.isArray(raw.df) ||
        !Array.isArray(raw.docs) ||
        raw.docCount !== raw.docs.length) {
        return null;
    }
    return raw;
}

/**
 * Cached hydrated reader preserving `_hydrated` and `vocabHydrated` properties for legacy callers
 * while keying invalidation on SQLite main+WAL revision.
 */
export function loadAskIndexCached(outDir) {
    const key = resolve(outDir);
    const rev = sqliteWalRevision(key);
    if (rev) {
        const cached = askIndexSqliteCache.get(key);
        if (cached && sameWalRevision(cached.rev, rev)) {
            return cached.value;
        }
        const hydrated = hydrateAskIndex(readAskIndexFromSqlite(key));
        if (hydrated) {
            askIndexSqliteCache.set(key, { rev, value: hydrated });
            return hydrated;
        }
        askIndexSqliteCache.delete(key);
    }
    const path = askIndexPath(outDir);
    return loadFileCached(askIndexCache, path, () => hydrateAskIndex(readAskIndex(outDir)));
}
