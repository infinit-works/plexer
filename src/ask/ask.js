/**
 * `plexer ask "<task>"` — the ACTIVE channel.
 *
 * One tool that routes a plain-words query to the right graph and returns a lean,
 * ranked context pack (prose + exact `file:line` + related), never raw JSON and
 * never whole files:
 *
 *   - Structural intent ("what calls X", "callers of X", "what does X import")
 *     → walk the wiring graph's edges and return the neighbour symbols with spans.
 *   - Everything else → lexical rank over concept nodes (prose) and wiring symbols
 *     (name + signature + summary), returning the best few with pointers.
 *
 * v1 is deterministic and $0 (term-overlap scoring, no LLM, no embeddings). The
 * output is markdown so it drops straight into an agent's context.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { loadGraphCached, registerGraphCacheClearer } from "../context/graph-store.js";
import { contextDirFor } from "../context/node-file.js";
import { assertPrefixIndexed, scopeLabel, scopeOf, scopesHereClause, scopesOfGraph } from "../context/scopes.js";
import { resolveSymbol } from "../context/symbol-query.js";
import { isGeneratedPath, isTestPath, normalizePathPrefix, pathUnderPrefix, pushMap } from "../util/paths.js";
import { combineComparableScopes, rankScopesAndFuse, } from "./fuse.js";
import { rankFilesBounded, } from "./file-rank.js";
import { fileFirstRoundRobin, roundRobinQueues } from "./file-selection.js";
import { personalizedPageRank, personalizedPageRankPrepared, preparePageRankPartitions, } from "./graph-rank.js";
import { fileReader, isSensitiveOrDotPath, needlesForName, parseSpan, plural, referenceLines, resolveSafeRepoFile, spanRange, spanStart } from "../util/span.js";
import * as indexFile from "./index-file.js";
const { bagLen, counts, loadAskIndexCached, stemCounts, stemToken, tokenize } = indexFile;

const RAW_FILE_NAME_RE = /\b[a-z0-9_.-]+\.(?:bb|c|cc|cjs|clj|cljc|cljs|cpp|cs|cts|cxx|dart|ex|exs|go|h|hh|hpp|java|js|jsx|kt|kts|lua|luau|mjs|ml|mli|mts|nix|php|py|pyi|r|rb|rs|sc|scala|sol|swift|ts|tsx|vue|zig|svelte|astro|md)\b/g;

function fallbackTokenizeExact(text) {
    if (!text)
        return [];
    return String(text)
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2);
}

function fallbackExtractLiterals(text) {
    if (!text)
        return [];
    const out = [];
    const seen = new Set();
    const push = (val) => {
        const norm = String(val ?? "").trim().toLowerCase();
        if (norm.length >= 3 && norm.length <= 64 && /[a-z0-9]/.test(norm) && !seen.has(norm)) {
            seen.add(norm);
            out.push(norm);
        }
    };
    const s = String(text);
    for (const m of s.matchAll(/(['"`])([^'"`\n]{3,120})\1/g)) {
        const inner = m[2].trim();
        if (!inner || inner.startsWith("//") || inner.includes("${"))
            continue;
        if (!/\s/.test(inner))
            push(inner);
        else if (inner.length <= 48 && inner.split(/\s+/).length <= 4)
            push(inner.replace(/\s+/g, " "));
    }
    for (const m of s.matchAll(/(\{![rsa]\}|\{[^}\s]{1,24}![rsa]\}|\{[0-9a-zA-Z_.:!-]{2,24}\})/g))
        push(m[1]);
    for (const m of s.matchAll(/(?:^|[^A-Za-z0-9%])(%[sdfrx])/g))
        push(m[1]);
    for (const m of s.matchAll(/\b([A-Za-z][A-Za-z0-9_.-]{0,31}:[A-Za-z0-9_.*:/-]{1,48})\b/g)) {
        if (!/^https?:/i.test(m[1]))
            push(m[1]);
    }
    for (const m of s.matchAll(/(?:^|[\s'"`(,=:])(\/(?:[A-Za-z0-9_.:*{}-]+\/?)+)/g))
        push(m[1]);
    for (const m of s.matchAll(/(?:^|[\s(,[\]{}"'`=])(--?[A-Za-z0-9][A-Za-z0-9_-]*)/g))
        push(m[1]);
    for (const m of s.matchAll(/\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|E[A-Z]{3,}[A-Z0-9]*|[A-Z]{2,}[0-9]{2,})\b/g))
        push(m[1]);
    return out;
}

const tokenizeExact = typeof indexFile.tokenizeExact === "function" ? indexFile.tokenizeExact : fallbackTokenizeExact;
const extractLiterals = typeof indexFile.extractLiterals === "function" ? indexFile.extractLiterals : fallbackExtractLiterals;
const queryAskPostings = typeof indexFile.queryAskPostings === "function" ? indexFile.queryAskPostings : null;
const loadAskVocabCached = typeof indexFile.loadAskVocabCached === "function" ? indexFile.loadAskVocabCached : null;

const BM25F_K1 = 2.2;
const BM25F_FIELDS = [
    { key: "name", b: 0.4, weight: 5.5 },
    { key: "path", b: 0.5, weight: 2.8 },
    { key: "sig", b: 0.5, weight: 2.0 },
    { key: "summary", b: 0.6, weight: 1.1 },
    { key: "literals", b: 0.5, weight: 4.2 },
    { key: "body", b: 0.75, weight: 0.9 },
];
const BM25F_EXACT_IDENT_B = 0.35;
const BM25F_EXACT_IDENT_W = 2.0;
const LITERAL_FAST_HINT_RE = /['"`{/:_-]/;
const DOC_RANK_FACTOR = 0.78;
/** Lowercase stopwords mirroring `tokenize()` so unstopped exactIdent only overrides them for code anchors. */
const PROSE_STOPWORDS = new Set([
    "the", "a", "an", "of", "to", "in", "is", "are", "how", "does", "do", "what",
    "where", "which", "that", "this", "it", "for", "on", "and", "or", "with",
    "we", "get", "set", "use", "used", "using", "when", "why", "can",
    "from", "via", "into", "between", "based", "by", "as", "at", "be",
]);

function computeBm25fTermScore(nTf, pTf, sTf, sumTf, lTf, bTf, fieldLens, effBodyLen, avgLens, idfVal) {
    let pseudoTf = 0;
    if (nTf > 0) {
        const norm = Math.max(0.85, 0.6 + 0.4 * ((fieldLens.name ?? 0) / Math.max(1, avgLens.name ?? 1)));
        pseudoTf += 5.5 * (nTf / norm);
    }
    if (pTf > 0) {
        const norm = Math.max(0.85, 0.5 + 0.5 * ((fieldLens.path ?? 0) / Math.max(1, avgLens.path ?? 1)));
        pseudoTf += 2.8 * (pTf / norm);
    }
    if (sTf > 0) {
        const norm = Math.max(0.85, 0.5 + 0.5 * ((fieldLens.sig ?? 0) / Math.max(1, avgLens.sig ?? 1)));
        pseudoTf += 2.0 * (sTf / norm);
    }
    if (sumTf > 0) {
        const norm = Math.max(0.85, 0.4 + 0.6 * ((fieldLens.summary ?? 0) / Math.max(1, avgLens.summary ?? 1)));
        pseudoTf += 1.1 * (sumTf / norm);
    }
    if (lTf > 0) {
        const norm = Math.max(0.85, 0.5 + 0.5 * ((fieldLens.literals ?? 0) / Math.max(1, avgLens.literals ?? 1)));
        pseudoTf += 4.2 * (lTf / norm);
    }
    if (bTf > 0) {
        const norm = Math.max(0.85, 0.25 + 0.75 * (effBodyLen / Math.max(1, avgLens.body ?? 1)));
        pseudoTf += 0.9 * (bTf / norm);
    }
    if (pseudoTf <= 0)
        return 0;
    return idfVal * ((pseudoTf * (BM25F_K1 + 1)) / (pseudoTf + BM25F_K1));
}

function parseMarkdownSections(relPath, content) {
    const lines = content.split("\n");
    const sections = [];
    const stack = [null, null, null];
    let inFence = false;
    let fenceChar = "";
    let current = null;
    const flush = (endLine) => {
        if (!current)
            return;
        const slice = lines.slice(current.startLine - 1, endLine);
        let summary = "";
        for (let i = 1; i < slice.length; i++) {
            const trimmed = slice[i].trim();
            if (!trimmed || /^```|^~~~|^#{1,6}\s/.test(trimmed))
                continue;
            summary = trimmed.slice(0, 160);
            break;
        }
        sections.push({
            id: `doc:${relPath}#L${current.startLine}`,
            kind: "doc",
            path: relPath,
            name: current.title,
            signature: current.breadcrumb,
            summary,
            body_text: slice.join("\n").slice(0, 4000),
            span: `L${current.startLine}-L${Math.max(current.startLine, endLine)}`,
            exported: true,
        });
        current = null;
    };
    for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx];
        const fenceM = /^\s*(`{3,}|~{3,})/.exec(line);
        if (fenceM) {
            if (!inFence) {
                inFence = true;
                fenceChar = fenceM[1][0];
            }
            else if (line.trim().startsWith(fenceChar.repeat(3))) {
                inFence = false;
                fenceChar = "";
            }
            continue;
        }
        if (inFence)
            continue;
        const hM = /^(#{1,3})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
        if (!hM)
            continue;
        flush(idx);
        const level = hM[1].length;
        const title = hM[2].trim();
        stack[level - 1] = title;
        for (let l = level; l < 3; l++)
            stack[l] = null;
        const breadcrumb = stack.filter(Boolean).join(" > ");
        current = { startLine: idx + 1, title, breadcrumb };
    }
    flush(lines.length);
    return sections;
}

function collectMarkdownFiles(root) {
    if (!root)
        return [];
    const out = [];
    try {
        for (const entry of readdirSync(root, { withFileTypes: true })) {
            if (entry.isFile() && /^readme\.md$/i.test(entry.name))
                out.push({ abs: join(root, entry.name), rel: entry.name });
        }
    }
    catch {
        return [];
    }
    const docsDir = join(root, "docs");
    const walk = (dir, relBase, depth) => {
        if (depth > 5)
            return;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules")
                continue;
            const abs = join(dir, entry.name);
            const rel = `${relBase}/${entry.name}`;
            if (entry.isDirectory())
                walk(abs, rel, depth + 1);
            else if (entry.isFile() && /\.md$/i.test(entry.name))
                out.push({ abs, rel });
        }
    };
    if (existsSync(docsDir))
        walk(docsDir, "docs", 0);
    return out;
}

function scanMarkdownDocNodes(root, graph) {
    if (!root)
        return [];
    const files = collectMarkdownFiles(root);
    if (files.length === 0)
        return [];
    let stamp = "";
    for (const f of files) {
        try {
            const st = statSync(f.abs);
            stamp += `${f.rel}:${st.mtimeMs}:${st.size};`;
        }
        catch {
            // ignore stat error
        }
    }
    if (graph?._mdDocCache?.stamp === stamp)
        return graph._mdDocCache.nodes;
    const nodes = [];
    for (const f of files) {
        try {
            const content = readFileSync(f.abs, "utf8");
            nodes.push(...parseMarkdownSections(f.rel, content));
        }
        catch {
            // ignore unreadable markdown file
        }
    }
    if (graph) {
        Object.defineProperty(graph, "_mdDocCache", {
            value: { stamp, nodes },
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return nodes;
}
/** Max source lines to inline per hit when `--full` is enabled. */
const MAX_SPAN_LINES = 80;
/** Max lines to inline contiguously for the top hit (and rank 2) before switching to windowed excerpts. */
const MAX_CONTIGUOUS_TOP_LINES = 65;
const MAX_CONTIGUOUS_SECONDARY_LINES = 24;
/** Max source lines across contiguous windows when excerpting a long (>65 line) symbol. */
const MAX_CRUX_LINES = 30;
/** Number of top hits that receive inlined source when `--source` is used. */
const SOURCE_TOP_HITS = 2;
function loadCorpus(outDir, root = null) {
    const graph = loadGraphCached(outDir);
    if (queryAskPostings && loadAskVocabCached) {
        let cachedIdx;
        let loaded = false;
        return {
            root,
            outDir,
            graph,
            get askIndex() {
                if (!loaded) {
                    cachedIdx = loadAskIndexCached(outDir);
                    loaded = true;
                }
                return cachedIdx;
            },
        };
    }
    return { root, outDir, graph, askIndex: loadAskIndexCached(outDir) };
}
/** Score a document's token counts against the query counts (name field
 * pre-weighted by caller). Each shared term is weighted by its inverse document
 * frequency (`idf`), so a word that appears in many nodes — "overlay" across a
 * whole widget subsystem, or a repeated word in a pasted issue body — counts for
 * far less than a rare, discriminating identifier ("scrolling"). Without idf,
 * pure term-frequency lets an incidental common word dominate the ranking; this
 * is the lexical half of the keyword-collision fix (graph-rank is the other). */
/** Test files rarely answer "how does X work" / "where is Y" — they mirror the
 * real symbol's tokens, so a test can out-score the definition on a lexical tie
 * and land as the top hit (observed: an `ask` returning a `Test…` function first,
 * sending the agent to the wrong file). A multiplicative de-rank keeps tests in
 * the results (they still matter for "where are the tests") but below the real
 * definition. Covers Go (`_test.go`), JS/TS (`.test.` / `.spec.`), and test dirs. */
export { isGeneratedPath, isTestPath };
const TEST_RANK_PENALTY = 0.35;
const GENERATED_RANK_PENALTY = 0.25;
function fastTermCount(doc, docStems, t, alt, stem) {
    const exact = doc.get(t);
    if (exact)
        return exact;
    const plural = doc.get(alt);
    if (plural)
        return plural * 0.9;
    if (stem && docStems) {
        const st = docStems.get(stem);
        if (st)
            return st * 0.85;
    }
    return 0;
}
function termCount(doc, docStems, t, qStemOf) {
    const exact = doc.get(t);
    if (exact)
        return exact;
    const plural = t.endsWith("s") ? doc.get(t.slice(0, -1)) : doc.get(`${t}s`);
    if (plural)
        return plural * 0.9;
    if (docStems) {
        const stem = qStemOf?.get(t) ?? stemToken(t);
        if (stem.length >= 4) {
            const st = docStems.get(stem);
            if (st)
                return st * 0.85;
        }
    }
    return 0;
}
function score(query, doc, idf, docStems, qStemOf, dfltIdf = 1) {
    let s = 0;
    for (const [t, qn] of query) {
        const dn = termCount(doc, docStems, t, qStemOf);
        if (dn) {
            const wIdf = idf.get(t) ?? dfltIdf;
            s += qn * dn * wIdf;
        }
    }
    return s;
}
/** Inverse document frequency over the scored corpus. `df` counts how many
 * documents (concept nodes + symbol nodes) contain each token; N is the corpus
 * size. `log(1 + N/(1+df))` is the smoothed standard form: monotonically
 * decreasing in df, always positive, ~0 extra weight for a token in every doc. */
function idfFromDf(df, n) {
    const idf = new Map();
    for (const [t, d] of df)
        idf.set(t, Math.log(1 + n / (1 + d)));
    return idf;
}
/** Query-only O(|Q|) IDF from the pre-hydrated sidecar `dfMap`.
 * Produces identical exact-token IDF values while avoiding an O(|V|) Map clone on every query. */
function computeIdfFromIndex(index, queryTerms) {
    const dfMap = index._hydrated?.dfMap ?? new Map(index.df);
    const stemDfMap = index._hydrated?.stemDfMap;
    const n = index.docCount;
    const idf = new Map();
    const keys = queryTerms ?? dfMap.keys();
    for (const t of keys) {
        const alt = t.endsWith("s") ? t.slice(0, -1) : `${t}s`;
        const stem = stemToken(t);
        const stemDf = stem.length >= 4 && stemDfMap ? Math.round((stemDfMap.get(stem) ?? 0) * 0.65) : 0;
        const d = Math.max(dfMap.get(t) ?? 0, dfMap.get(alt) ?? 0, stemDf);
        if (d > 0)
            idf.set(t, Math.log(1 + n / (1 + d)));
    }
    return idf;
}
// ── Structural intent ──────────────────────────────────────────────────────
const INCOMING_RELS = ["calls", "interface_dispatch", "reexports", "references", "implements", "extends"];
const INCOMING_RELS_WITH_IMPORTS = [...INCOMING_RELS, "imports"];
const OUTGOING_RELS = ["calls", "interface_dispatch", "reexports", "references", "imports", "implements", "extends"];
const STRUCTURAL_STOPWORDS = new Set([
    "caller", "callers", "callee", "callees", "call", "calls", "called", "calling",
    "into", "from", "what", "who", "where", "which", "how", "when", "does", "do",
    "is", "are", "used", "uses", "using", "import", "imports", "depends", "depend",
    "blast", "radius", "reference", "references", "direct", "all", "every", "across",
    "function", "functions", "method", "methods", "helper", "helpers", "module",
    "modules", "class", "file", "files", "symbol", "symbols", "by", "of", "for",
    "to", "in", "on", "the", "a", "an", "and", "or",
]);

const STRUCTURAL_INCOMING_PATTERNS = [
    /\b(?:callers?|references?|usages?)\s+(?:of|for)\s+(?:the\s+)?(?:(?:function|method|symbol|class|interface|trait|struct|module|file)\s+)?`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?/i,
    /\bblast\s+radius\s+(?:of|for)\s+(?:the\s+)?(?:(?:function|method|symbol|class|interface|trait|struct|module|file)\s+)?`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?/i,
    /\bcalls?\s+into\s+`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?/i,
    /\b(?:who|what)\s+(?:calls|invokes|imports|uses|references|depends\s+on)\s+(?:into\s+)?(?:the\s+)?`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?/i,
    /\b(?:which|what)\s+(?:modules?|files?|functions?|methods?|callers?|symbols?)\s+(?:call|calls|import|imports|use|uses|depend\s+on)\s+`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?/i,
];
const STRUCTURAL_OUTGOING_PATTERNS = [
    /\bcallees?\s+(?:of|for)\s+(?:the\s+)?(?:(?:function|method|symbol|class|interface|trait|struct|module|file)\s+)?`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?/i,
    /\bwhat\s+does\s+`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?\s+(?:call|calls|invoke|invokes|import|imports|depend\s+on|depends\s+on|use|uses)\b/i,
    /\b`?([A-Za-z_][A-Za-z0-9_.:/#-]*)`?\s+(?:calls?|imports?)\s+what\b/i,
];

function parseStructuralQuery(query) {
    // Keep semantic phrases like "dynamic imports" on the lexical BM25F + PPR path.
    if (/\bdynamic\s+imports?\b/i.test(query) && !/\b(?:callers?|callees?|who\s+calls|what\s+calls|what\s+does|blast\s+radius)\b/i.test(query))
        return null;
    for (const re of STRUCTURAL_OUTGOING_PATTERNS) {
        const m = re.exec(query);
        if (m)
            return { outgoing: true, includeImports: true, syntaxSubject: cleanSubjectCandidate(m[1]) };
    }
    for (const re of STRUCTURAL_INCOMING_PATTERNS) {
        const m = re.exec(query);
        if (m)
            return {
                outgoing: false,
                includeImports: /\b(?:imports?|blast\s+radius|depends\s+on)\b/i.test(query),
                syntaxSubject: cleanSubjectCandidate(m[1]),
            };
    }
    return null;
}

function cleanSubjectCandidate(raw) {
    return String(raw ?? "").replace(/[?.,;:!)]+$/, "").trim();
}

/** Collect candidate structural subject tokens in syntactic priority order:
 * explicit syntax capture first, then backticked/qualified identifiers, then
 * remaining non-stopword identifier tokens in query order (never blindly longest-first). */
function subjectCandidates(query, syntaxSubject) {
    const ordered = [];
    const seen = new Set();
    const push = (raw) => {
        const w = cleanSubjectCandidate(raw);
        if (!w)
            return;
        const lower = w.toLowerCase();
        if (!w.includes(".") && !w.includes(":") && !w.includes("/") && STRUCTURAL_STOPWORDS.has(lower))
            return;
        if (!seen.has(w)) {
            seen.add(w);
            ordered.push(w);
        }
    };
    if (syntaxSubject)
        push(syntaxSubject);
    for (const m of query.matchAll(/`([A-Za-z_][A-Za-z0-9_.:/#-]*)`/g))
        push(m[1]);
    for (const w of query.split(/[^A-Za-z0-9_.:/#-]+/)) {
        if (w && (w.includes(".") || w.includes(":") || w.includes("/")))
            push(w);
    }
    for (const w of query.split(/[^A-Za-z0-9_.:/#-]+/))
        push(w);
    return ordered;
}

function findSubjectNodes(query, graph, inPrefix, syntaxSubject) {
    const candidates = subjectCandidates(query, syntaxSubject);
    for (const w of candidates) {
        let nodes = resolveSymbol(graph, w);
        if (inPrefix)
            nodes = nodes.filter((n) => pathUnderPrefix(n.path, inPrefix));
        if (nodes.length > 0)
            return { nodes, tried: w };
    }
    return { nodes: [], tried: candidates[0] ?? query };
}
function fallthroughNoteFor(subject) {
    return (`structural index: no entries for '${subject}' — showing lexical matches; ` +
        `for precise edges try plexer callers '${subject}', or plexer grep '${subject}' for every reference (loosen the pattern if it returns nothing)`);
}
function structuralAdjacency(graph, outgoing, includeImports = false) {
    const prop = outgoing ? "_structAdjOut" : (includeImports ? "_structAdjInImports" : "_structAdjIn");
    if (graph[prop])
        return graph[prop];
    const rels = new Set(outgoing ? OUTGOING_RELS : (includeImports ? INCOMING_RELS_WITH_IMPORTS : INCOMING_RELS));
    const adj = new Map();
    for (const e of graph.edges) {
        if (!rels.has(e.relation))
            continue;
        const anchor = outgoing ? e.source : e.target;
        const other = outgoing ? e.target : e.source;
        pushMap(adj, anchor, { other, relation: e.relation });
    }
    Object.defineProperty(graph, prop, { value: adj, enumerable: false, configurable: true });
    return adj;
}
function structural(query, graph, limit, inPrefix) {
    const parsed = parseStructuralQuery(query);
    if (!parsed)
        return null;
    const { nodes: subjects, tried } = findSubjectNodes(query, graph, inPrefix, parsed.syntaxSubject);
    if (subjects.length === 0)
        return { fallthroughNote: fallthroughNoteFor(tried) };
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const outgoing = parsed.outgoing;
    const includeImports = parsed.includeImports || (!outgoing && subjects.every((s) => s.kind === "file"));
    const adj = structuralAdjacency(graph, outgoing, includeImports);
    const hits = [];
    const seen = new Set();
    for (const s of subjects) {
        for (const { other, relation } of adj.get(s.id) ?? []) {
            if (seen.has(other + relation))
                continue;
            seen.add(other + relation);
            const node = byId.get(other);
            hits.push({
                kind: outgoing ? "callee" : "caller",
                title: node ? node.name : other, // unresolved import target → raw module string
                pointer: node ? `${node.path}:${node.span}` : other,
                snippet: node?.summary?.split("\n")[0].trim() || node?.signature || "",
                relation,
                score: 1,
            });
        }
    }
    // Subject resolved but the graph has no indexed edges for it — same "loud,
    // never a bare empty" contract as `plexer callers`/`callees` — fall through
    // to lexical rather than returning a structural result with zero hits.
    if (hits.length === 0)
        return { fallthroughNote: fallthroughNoteFor(subjects[0].name) };
    hits.sort((a, b) => Number(isTestPath(a.pointer)) - Number(isTestPath(b.pointer)) || a.pointer.localeCompare(b.pointer));
    return {
        result: {
            query,
            mode: "structural",
            confidenceTier: "high",
            subject: subjects[0].name,
            hits: hits.slice(0, limit),
            note: outgoing
                ? `outgoing edges from ${subjects[0].name}`
                : `callers / references of ${subjects[0].name}`,
        },
    };
}
// ── Lexical rank ─────────────────────────────────────────────────────────────
/** How much a node's graph-centrality (0..1) can lift its blended score. A
 * lexically-perfect node scores 1.0 on the lexical axis; a graph weight of 0.5
 * lets connectivity reorder near-ties and separate a connected hit from an
 * isolated same-word collision, without letting structure override a clear
 * lexical winner. */
const GRAPH_WEIGHT = 0.5;
/** A node the query never word-matched is pulled into the results only if the
 * walk gives it at least this share of the top node's mass — i.e. it is
 * genuinely central to the matched cluster, not incidentally reachable. This is
 * what surfaces the config/helper a task depends on but didn't name. */
const RESCUE_FLOOR = 0.15;
/** Term presence with plural and stem folding — "packs" finds "pack" and
 * "validating" finds "validate", so natural-language inflections don't read as
 * a miss against identifier tokens. */
function hasTerm(f, t, fStems, qStemOf, preAlt = undefined) {
    const fEmpty = f.size === 0;
    const sEmpty = !fStems || fStems.size === 0;
    if (fEmpty && sEmpty)
        return false;
    if (!fEmpty) {
        const alt = preAlt ?? (t.endsWith("s") ? t.slice(0, -1) : `${t}s`);
        if (f.has(t) || f.has(alt))
            return true;
    }
    if (!sEmpty) {
        const stem = qStemOf?.get(t) ?? stemToken(t);
        if (stem.length >= 4 && fStems.has(stem))
            return true;
    }
    return false;
}
/** Idf-weighted share (0..1) of the query a document matches: each query term
 * counts by its rarity, so this separates task prompts from chatter in a way a
 * raw term count can't. A conversational prompt's words are either off-corpus
 * (rare → heavy, unmatched → sinks the ratio) or generic code words ("list",
 * "write": common → near-weightless even when they collide with a symbol name);
 * a task prompt matches exactly its rare, discriminating identifiers. Terms the
 * corpus has never seen take `dfltIdf` (the df=0 weight). */
/** The match-STRENGTH share behind `coverageStrong`: idf-weighted share of the
 * query matched in the node's NAME field ONLY. The PATH field is deliberately
 * excluded — a coincidental generic directory (`gateway/`) or file basename
 * (`gateway.ts`) in an unrelated repo would otherwise clear the strength gate
 * and float that repo to the top; an on-topic path-organized repo is still
 * rescued by the broad-coverage HIGH_FLOOR clause instead. For the same reason
 * a `kind:"file"` node contributes zero strength: its `name` is a basename (a
 * path component), not a symbol name, so a file whose basename happens to share
 * a query word is not a strong match. */
function strongShare(q, node, doc, idf, dfltIdf, qStemOf) {
    if (node.kind === "file")
        return 0;
    return matchedIdfShare(q, [doc.name], idf, dfltIdf, [doc.nameStems], qStemOf);
}
function matchedIdfShare(q, fields, idf, dfltIdf, fieldStems, qStemOf) {
    let matched = 0;
    let total = 0;
    for (const t of q.keys()) {
        const w = idf.get(t) ?? dfltIdf;
        total += w;
        const alt = t.endsWith("s") ? t.slice(0, -1) : `${t}s`;
        for (let i = 0; i < fields.length; i++) {
            if (hasTerm(fields[i], t, fieldStems?.[i], qStemOf, alt)) {
                matched += w;
                break;
            }
        }
    }
    return total > 0 ? matched / total : 0;
}
/** Normalized query-term IDF mass used by file-level union coverage. Presence
 * comes from the exact term-contribution maps, so plural folding cannot
 * manufacture evidence that the lexical scorer did not award. */
function normalizedQueryWeights(q, idf, dfltIdf) {
    let total = 0;
    for (const t of q.keys())
        total += idf.get(t) ?? dfltIdf;
    if (total <= 0)
        return new Map();
    return new Map([...q.keys()].map((term) => [term, (idf.get(term) ?? dfltIdf) / total]));
}
function memoizePathFlag(predicate) {
    const cache = new Map();
    return (path) => {
        let v = cache.get(path);
        if (v === undefined) {
            v = predicate(path);
            cache.set(path, v);
        }
        return v;
    };
}
const cachedTestPath = memoizePathFlag(isTestPath);
const cachedGenPath = memoizePathFlag(isGeneratedPath);
function isProseHeavyBody(n, body, bodyLen, spanLines) {
    if (bodyLen <= 0)
        return false;
    if (n.kind === "file")
        return body.size >= 400 && body.size / bodyLen >= 0.42;
    if (body.size < 60)
        return false;
    const summaryLines = n.summary ? Math.min(4, n.summary.split("\n").length) : 0;
    const uniqPerLine = body.size / Math.max(8, spanLines + summaryLines);
    return uniqPerLine >= 3.5 && body.size / bodyLen >= 0.46;
}
function parseDocSpanLineCount(span) {
    if (!span)
        return 1;
    const dash = span.indexOf("-");
    const a = Number(span.slice(span[0] === "L" ? 1 : 0, dash >= 0 ? dash : undefined));
    const b = dash >= 0 ? Number(span.slice(dash + (span[dash + 1] === "L" ? 2 : 1))) : a;
    return b >= a && a > 0 ? b - a + 1 : 1;
}
function resolveDocTokenFields(n, hydratedById, rawDocById, sigText, sumText, bodyTextForExt) {
    const hd = hydratedById?.get(n.id);
    if (hd) {
        return {
            name: hd.name,
            path: hd.path,
            body: hd.body,
            nameStems: hd.nameStems,
            pathStems: hd.pathStems,
            bodyStems: hd.bodyStems,
            bodyLen: hd.bodyLen,
            hydrated: true,
        };
    }
    const d = rawDocById?.get(n.id);
    const name = d ? new Map(d.name) : counts(tokenize(n.name));
    const path = d ? new Map(d.path) : counts(tokenize(n.path));
    const bodyText = n.kind === "doc" || bodyTextForExt ? bodyTextForExt : `${sigText} ${sumText}`;
    const body = d ? new Map(d.body) : counts(tokenize(bodyText));
    return {
        name,
        path,
        body,
        nameStems: stemCounts(name),
        pathStems: stemCounts(path),
        bodyStems: stemCounts(body),
        bodyLen: bagLen(body),
        hydrated: false,
    };
}
function buildSymbolDocRecord(n, hydratedById, rawDocById) {
    const slashIdx = n.path ? n.path.lastIndexOf("/") : -1;
    const baseNameLower = (slashIdx >= 0 ? n.path.slice(slashIdx + 1) : (n.path ?? "")).toLowerCase();
    const extDotIdx = baseNameLower.lastIndexOf(".");
    const fileStemLower = extDotIdx >= 0 ? baseNameLower.slice(0, extDotIdx) : baseNameLower;
    const ownerLower = n.owner ? n.owner.toLowerCase() : "";
    const singleWordMethod = Boolean(ownerLower && !n.name.includes("_") && !/[A-Z]/.test(n.name.slice(1)));
    const spanLines = parseDocSpanLineCount(n.span);
    const sigText = n.signature ?? "";
    const sumText = n.summary ?? "";
    const sig = sigText ? counts(tokenize(sigText)) : new Map();
    const summary = sumText ? counts(tokenize(sumText)) : new Map();
    const bodyTextForExt = n.body_text ?? "";
    const rawExtText = bodyTextForExt ? `${n.name ?? ""} ${sigText} ${sumText} ${bodyTextForExt}` : `${n.name ?? ""} ${sigText} ${sumText}`;
    const literals = LITERAL_FAST_HINT_RE.test(rawExtText) ? counts(extractLiterals(rawExtText)) : new Map();
    const nameExact = n.kind === "file" ? null : new Set(tokenizeExact(n.name ?? ""));
    const exactIdent = counts(tokenizeExact(bodyTextForExt ? `${n.name ?? ""} ${sigText} ${bodyTextForExt}` : `${n.name ?? ""} ${sigText}`));
    const docFields = resolveDocTokenFields(n, hydratedById, rawDocById, sigText, sumText, bodyTextForExt);
    const proseHeavy = !docFields.hydrated && n.kind === "doc"
        ? false
        : isProseHeavyBody(n, docFields.body, docFields.bodyLen, spanLines);
    return {
        n,
        name: docFields.name,
        path: docFields.path,
        sig,
        summary,
        literals,
        body: docFields.body,
        exactIdent,
        nameExact,
        nameStems: docFields.nameStems,
        pathStems: docFields.pathStems,
        sigStems: sig.size > 0 ? stemCounts(sig) : new Map(),
        summaryStems: summary.size > 0 ? stemCounts(summary) : new Map(),
        bodyStems: docFields.bodyStems,
        fieldLens: {
            name: bagLen(docFields.name),
            path: bagLen(docFields.path),
            sig: bagLen(sig),
            summary: bagLen(summary),
            literals: bagLen(literals),
            body: docFields.bodyLen,
            exact_ident: bagLen(exactIdent),
        },
        bodyLen: docFields.bodyLen,
        spanLines,
        proseHeavy,
        baseNameLower,
        fileStemLower,
        ownerLower,
        singleWordMethod,
    };
}
function resolveAskIndexMaps(corpus, graph) {
    let hydratedById = null;
    let rawDocById = null;
    if (corpus.askIndex && graph && corpus.askIndex.docs.length === graph.nodes.length) {
        const hydrated = corpus.askIndex._hydrated;
        if (hydrated) {
            if (graph._askIndexIdCheck !== corpus.askIndex) {
                const ok = graph.nodes.every((n) => hydrated.byId.has(n.id));
                Object.defineProperty(graph, "_askIndexIdCheckOk", { value: ok, enumerable: false, configurable: true, writable: true });
                Object.defineProperty(graph, "_askIndexIdCheck", { value: corpus.askIndex, enumerable: false, configurable: true, writable: true });
            }
            if (graph._askIndexIdCheckOk)
                hydratedById = hydrated.byId;
        }
        else {
            const map = new Map(corpus.askIndex.docs.map((d) => [d.id, d]));
            if (graph.nodes.every((n) => map.has(n.id)))
                rawDocById = map;
        }
    }
    return { hydratedById, rawDocById, askIndex: hydratedById || rawDocById ? corpus.askIndex : null };
}

function getOrCacheBaseSymbolDocs(graph, graphNodes, askIndex, inPrefix, hydratedById, rawDocById) {
    const cacheKey = askIndex ?? null;
    const firstId = graphNodes[0]?.id ?? null;
    if (!inPrefix && graph && graph._symbolDocsAskIndex === cacheKey && graph._symbolDocsNodeLen === graphNodes.length && graph._symbolDocsFirstId === firstId)
        return graph._symbolDocs;
    const baseDocs = graphNodes.map((n) => buildSymbolDocRecord(n, hydratedById, rawDocById));
    if (!inPrefix && graph) {
        Object.defineProperty(graph, "_symbolDocs", { value: baseDocs, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_symbolDocsAskIndex", { value: cacheKey, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_symbolDocsNodeLen", { value: graphNodes.length, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_symbolDocsFirstId", { value: firstId, enumerable: false, configurable: true, writable: true });
    }
    return baseDocs;
}

function prepareLexicalSymbolDocs(corpus, graph, inPrefix, mdDocs = []) {
    const { hydratedById, rawDocById, askIndex } = resolveAskIndexMaps(corpus, graph);
    const allNodes = graph?.nodes ?? [];
    const graphNodes = inPrefix ? allNodes.filter((n) => pathUnderPrefix(n.path, inPrefix)) : allNodes;
    const filteredMdDocs = inPrefix ? mdDocs.filter((n) => pathUnderPrefix(n.path, inPrefix)) : mdDocs;
    const baseDocs = getOrCacheBaseSymbolDocs(graph, graphNodes, askIndex, inPrefix, hydratedById, rawDocById);
    const docRecords = filteredMdDocs.length > 0 ? [...baseDocs, ...filteredMdDocs.map((n) => buildSymbolDocRecord(n, null, null))] : baseDocs;
    return { hydratedById, askIndex, symbolDocs: docRecords };
}

function getBareSymbolNameLower(name) {
    const sepIdx = Math.max(name.lastIndexOf("#"), name.lastIndexOf("."));
    return (sepIdx >= 0 ? name.slice(sepIdx + 1) : name).toLowerCase();
}

function getExactNameIdentMultiplier(isQualMatch, isExactFullName, isCodeIdent) {
    if (isQualMatch)
        return 2.15;
    if (isExactFullName)
        return 1.65;
    return isCodeIdent ? 1.25 : 1.08;
}

function scoreExactIdentifierNameMatch(n, bare, isQualMatch, nameScore, matchedInName, matchedCount, qState) {
    const isSingleTokenBare = tokenize(bare).length === 1;
    const isCodeIdent = !isSingleTokenBare || Boolean(qState.identLikeWords?.has(bare));
    const isExactFullName = isQualMatch || matchedInName >= 2 ||
        (isSingleTokenBare && isCodeIdent && (qState.qLen <= 3 || matchedCount * 2 >= qState.qLen));
    let updated = nameScore * getExactNameIdentMultiplier(isQualMatch, isExactFullName, isCodeIdent);
    const suppressErrorType = !qState.wantsErrorType && bare.endsWith("error") &&
        (matchedInName >= 3 || (matchedInName >= 2 && n.kind === "class" && qState.qLen >= 8));
    if (suppressErrorType)
        updated *= 0.62;
    return { nameScore: updated, exactCompoundName: isExactFullName };
}

function boostNameByRawIdentifiers(n, nameScore, matchedInName, matchedCount, fileStemLower, ownerLower, qState) {
    const rawIdentifiers = qState.rawIdentifiers;
    if (rawIdentifiers.size === 0)
        return { nameScore, exactCompoundName: false };
    const bare = getBareSymbolNameLower(n.name);
    const qual = ownerLower ? `${ownerLower}.${bare}` : "";
    const qualFile = fileStemLower ? `${fileStemLower}.${bare}` : "";
    const isQualMatch = Boolean((qual && rawIdentifiers.has(qual)) || (qualFile && rawIdentifiers.has(qualFile)));
    if (!isQualMatch && !(bare.length >= 4 && rawIdentifiers.has(bare)))
        return { nameScore, exactCompoundName: false };
    return scoreExactIdentifierNameMatch(n, bare, isQualMatch, nameScore, matchedInName, matchedCount, qState);
}

function isPrimaryFileStemMatch(n, fileStem, fileStemRoot, matchedInPath, matchedCount, query) {
    const bareLower = n.name.toLowerCase();
    if (n.kind !== "file") {
        if (bareLower === fileStem)
            return true;
        return fileStemRoot.length >= 4 && stemToken(bareLower) === fileStemRoot;
    }
    return matchedInPath >= 1 && matchedCount >= 3 && !/[a-z][A-Z]|[._]/.test(query);
}

function boostPathByFileStem(n, nameScore, pathScore, baseNameLower, matchedInPath, matchedCount, qState) {
    if (qState.rawIdentifiers.size === 0)
        return { nameScore, pathScore, exactCompoundName: false };
    const dotIdx = baseNameLower.indexOf(".");
    const fileStem = dotIdx >= 0 ? baseNameLower.slice(0, dotIdx) : baseNameLower;
    const fileStemRoot = stemToken(fileStem);
    const hasFileStem = (fileStem.length >= 4 && qState.rawIdentifiers.has(fileStem)) ||
        (fileStem.length >= 3 && fileStemRoot.length >= 3 && Boolean(qState.qStems?.includes(fileStemRoot)));
    if (!hasFileStem)
        return { nameScore, pathScore, exactCompoundName: false };
    const isPrimary = isPrimaryFileStemMatch(n, fileStem, fileStemRoot, matchedInPath, matchedCount, qState.query);
    return {
        nameScore: isPrimary && n.kind === "file" ? nameScore * 1.5 : nameScore,
        pathScore: pathScore * (isPrimary ? 2.1 : 1.25),
        exactCompoundName: fileStem.length >= 4 && isPrimary && matchedCount >= 3,
    };
}

function boostLexicalPathCompound(n, nameScore, pathScore, matchedInPath, matchedCount, baseNameLower, qState) {
    if (pathScore <= 0)
        return { nameScore, pathScore, exactCompoundName: false };
    let nextPath = pathScore;
    if (matchedInPath >= 2)
        nextPath *= 1 + 0.25 * Math.min(2, matchedInPath - 1);
    if (!baseNameLower)
        return { nameScore, pathScore: nextPath, exactCompoundName: false };
    if (qState.rawFileNames.has(baseNameLower))
        return { nameScore, pathScore: nextPath * 4.0, exactCompoundName: true };
    return boostPathByFileStem(n, nameScore, nextPath, baseNameLower, matchedInPath, matchedCount, qState);
}

function applyLexicalCompoundBoosts(n, nameScore, pathScore, matchedInName, matchedInPath, matchedCount, baseNameLower, fileStemLower, ownerLower, qState) {
    let exactCompoundName = false;
    if (nameScore > 0 && n.kind !== "file") {
        if (matchedInName >= 2) {
            const corrob = qState.qLen < 5 || matchedCount > matchedInName || matchedInPath > 0 || (matchedInName >= 3 && matchedInName * 2 >= qState.qLen);
            nameScore *= 1 + (corrob ? 0.35 : 0.12) * Math.min(3, matchedInName - 1);
        }
        const identRes = boostNameByRawIdentifiers(n, nameScore, matchedInName, matchedCount, fileStemLower, ownerLower, qState);
        nameScore = identRes.nameScore;
        exactCompoundName = identRes.exactCompoundName;
    }
    const pathRes = boostLexicalPathCompound(n, nameScore, pathScore, matchedInPath, matchedCount, baseNameLower, qState);
    return {
        nameScore: pathRes.nameScore,
        pathScore: pathRes.pathScore,
        exactCompoundName: exactCompoundName || pathRes.exactCompoundName,
    };
}

function recordLexicalMatchTerm(matchState, term, isStrong) {
    if (!matchState)
        return;
    matchState.matched ??= new Set();
    matchState.matched.add(term);
    if (isStrong) {
        matchState.strong ??= new Set();
        matchState.strong.add(term);
    }
}

function matchOwnerFallbackTf(singleWordMethod, ownerLower, t, alt, stem) {
    if (!singleWordMethod)
        return 0;
    const hit = ownerLower === t || ownerLower === alt || Boolean(stem && ownerLower === stem) || (t.length >= 4 && ownerLower.endsWith(t));
    return hit ? 0.85 : 0;
}

function computePathHintMult(dirOnlyMatch, inFileStem, nTf) {
    if (dirOnlyMatch)
        return 0.55;
    if (!inFileStem && nTf === 0)
        return 0.85;
    return nTf > 0 ? 1.1 : 2;
}

function scoreSingleQueryTerm(i, cand, qState, isIndexFile, avgLens, effBodyLen, matchState, acc) {
    const t = qState.qTerms[i];
    const alt = qState.qAlts[i];
    const stem = qState.qStems[i];
    const wIdf = qState.qIdfs[i];
    const { n, fieldLens, fileStemLower, ownerLower, singleWordMethod } = cand;
    const rawNTf = cand.getFieldTf("name", t, alt, stem);
    const nTf = rawNTf || matchOwnerFallbackTf(singleWordMethod, ownerLower, t, alt, stem);
    const pTf = cand.getFieldTf("path", t, alt, stem);
    const sTf = cand.getFieldTf("sig", t, alt, stem);
    const sumTf = cand.getFieldTf("summary", t, alt, stem);
    const bTf = cand.getFieldTf("body", t, alt, stem);
    if (nTf === 0 && pTf === 0 && sTf === 0 && sumTf === 0 && bTf === 0)
        return;
    const inFileStem = isIndexFile || fileStemLower.includes(t) || Boolean(stem && fileStemLower.includes(stem));
    const dirOnlyMatch = pTf > 0 && nTf === 0 && sTf === 0 && sumTf === 0 && bTf === 0 && !inFileStem;
    acc.matchedCount += dirOnlyMatch ? 0.45 : 1;
    acc.matchedIdf += wIdf * (dirOnlyMatch ? 0.45 : 1);
    if (nTf > 0) {
        acc.matchedInName++;
        acc.nameHintScore += Math.min(1, nTf) * 3 * wIdf;
    }
    if (pTf > 0) {
        if (inFileStem)
            acc.matchedInPath++;
        acc.pathHintScore += Math.min(1, pTf) * computePathHintMult(dirOnlyMatch, inFileStem, nTf) * wIdf;
    }
    if (sTf > 0)
        acc.matchedInSig++;
    const adjPTf = pTf > 0 ? pTf * (dirOnlyMatch ? 0.45 : inFileStem ? 1.15 : 0.85) : 0;
    acc.fieldScoreTotal += computeBm25fTermScore(nTf, adjPTf, sTf, sumTf, 0, bTf, fieldLens, effBodyLen, avgLens, wIdf);
    recordLexicalMatchTerm(matchState, t, nTf > 0 && n.kind !== "file");
}

function scoreLexicalQueryTerms(cand, qState, avgLens, effBodyLen, matchState) {
    const isIndexFile = cand.isIndexFile ?? /^(?:init|index|mod)$/.test(cand.fileStemLower);
    const acc = {
        fieldScoreTotal: 0, nameHintScore: 0, pathHintScore: 0,
        matchedCount: 0, matchedIdf: 0, matchedInName: 0, matchedInPath: 0, matchedInSig: 0,
    };
    for (let i = 0; i < qState.qLen; i++)
        scoreSingleQueryTerm(i, cand, qState, isIndexFile, avgLens, effBodyLen, matchState, acc);
    return acc;
}

function scoreLexicalLiterals(cand, qState, avgLens, effBodyLen, matchState) {
    const { n, fieldLens } = cand;
    const { qLiterals, qLiteralIdfs } = qState;
    let hasLiteralAnchor = false;
    let literalScore = 0;
    let litMatchedCount = 0;
    for (let i = 0; i < qLiterals.length; i++) {
        const lit = qLiterals[i];
        const lTf = cand.getFieldTf("literals", lit, null, null);
        if (lTf <= 0)
            continue;
        hasLiteralAnchor = true;
        litMatchedCount++;
        literalScore += computeBm25fTermScore(0, 0, 0, 0, lTf * 1.4, 0, fieldLens, effBodyLen, avgLens, qLiteralIdfs[i]);
        recordLexicalMatchTerm(matchState, lit, true);
    }
    if (litMatchedCount > 0 && n.kind !== "file")
        literalScore = Math.max(literalScore, 3.6 * (litMatchedCount / Math.max(1, qLiterals.length))) + literalScore * 0.35;
    return { hasLiteralAnchor, literalScore };
}

function resolveCandidateNameExactSet(cand, state) {
    if (state.nameExactReady)
        return state.nameExactSet;
    state.nameExactReady = true;
    const { n } = cand;
    state.nameExactSet = n.kind === "file" ? null : (cand.nameExact ?? new Set(tokenizeExact(n.name ?? "")));
    return state.nameExactSet;
}

function scoreSingleExactIdent(i, cand, qState, qTermsSet, exactNorm, effBodyLen, matchState, state) {
    const ex = qState.qActiveExact[i];
    if (qState.qLen > 0 && qTermsSet.has(ex))
        return;
    const exTf = cand.getFieldTf("exact_ident", ex, null, null, effBodyLen);
    if (exTf <= 0)
        return;
    const inSymName = Boolean(resolveCandidateNameExactSet(cand, state)?.has(ex));
    const pseudoTf = BM25F_EXACT_IDENT_W * (exTf / Math.max(0.45, exactNorm)) * (inSymName ? 1.85 : 0.45);
    state.exactIdentScore += qState.qExactIdfs[i] * ((pseudoTf * (BM25F_K1 + 1)) / (pseudoTf + BM25F_K1));
    if (inSymName) {
        state.hasExactIdentAnchor = true;
        state.matchedInName = Math.max(state.matchedInName, 1);
        recordLexicalMatchTerm(matchState, ex, true);
    }
    else {
        recordLexicalMatchTerm(matchState, ex, false);
    }
}

function scoreLexicalExactIdents(cand, qState, qTermsSet, avgLens, effBodyLen, matchedInName, matchState) {
    const { n, fieldLens } = cand;
    const { qActiveExact, qLen, totalQueryIdf, rawCodeIdents } = qState;
    const state = { hasExactIdentAnchor: false, exactIdentScore: 0, matchedInName, nameExactReady: false, nameExactSet: null };
    if (qActiveExact.length > 0) {
        const exactNorm = (1 - BM25F_EXACT_IDENT_B) + BM25F_EXACT_IDENT_B * ((fieldLens.exact_ident ?? 0) / Math.max(1, avgLens.exact_ident ?? 1));
        for (let i = 0; i < qActiveExact.length; i++)
            scoreSingleExactIdent(i, cand, qState, qTermsSet, exactNorm, effBodyLen, matchState, state);
    }
    if (n.kind !== "file" && rawCodeIdents.size > 0) {
        const bareLower = cand.bareLower ?? getBareSymbolNameLower(n.name);
        if (rawCodeIdents.has(bareLower)) {
            state.hasExactIdentAnchor = true;
            state.exactIdentScore = qLen === 0
                ? Math.max(state.exactIdentScore * 1.65, 6.5)
                : Math.max(state.exactIdentScore * 1.35, totalQueryIdf * 0.2);
            state.matchedInName = Math.max(state.matchedInName, 1);
        }
    }
    return state;
}

function computeCompoundAndCoverageRaw(cand, qState, fieldScoreTotal, literalScore, exactIdentScore, matchedInName, matchedCount, matchedIdf, boosted, hasLiteralAnchor, hasExactIdentAnchor, nameHintScore, pathHintScore) {
    const { n, nameTokenCount } = cand;
    const { qLen, totalQueryIdf } = qState;
    const nameMult = nameHintScore > 0 ? boosted.nameScore / nameHintScore : 1;
    const pathMult = pathHintScore > 0 ? boosted.pathScore / pathHintScore : 1;
    const compoundScale = nameHintScore > 0 || pathHintScore > 0 ? Math.max(1, nameMult * 0.65 + pathMult * 0.35) : 1;
    let raw = fieldScoreTotal * compoundScale + literalScore + exactIdentScore;
    if (n.kind !== "file" && nameTokenCount >= 2 && matchedInName >= nameTokenCount && matchedCount > matchedInName)
        raw *= 1.25;
    if (qLen >= 2) {
        const rawCov = 0.5 * (matchedCount / qLen) + 0.5 * (matchedIdf / totalQueryIdf);
        const cov = (boosted.exactCompoundName || hasLiteralAnchor || hasExactIdentAnchor) ? Math.max(rawCov, 0.72) : rawCov;
        raw *= 0.2 + 0.8 * Math.pow(cov, 1.35);
    }
    else if (qLen === 1 && hasLiteralAnchor && exactIdentScore > 0) {
        raw *= 1.15;
    }
    return raw;
}

function finalizeLexicalCandidateScore(cand, ctx, qStats, litStats, exactStats, matchState) {
    const { qState, testFactor, rawLexicalById, matchedTermsById, matchedStrongTermsById, anchorInfoById } = ctx;
    const { n, proseHeavy, baseNameLower, fileStemLower, ownerLower } = cand;
    const { qLen, totalQueryIdf, rawFileNames, wantsDocs } = qState;
    let { fieldScoreTotal } = qStats;
    const { nameHintScore, pathHintScore, matchedCount, matchedIdf, matchedInPath, matchedInSig } = qStats;
    const { hasLiteralAnchor, literalScore } = litStats;
    const { hasExactIdentAnchor, exactIdentScore, matchedInName } = exactStats;
    if (matchedInName === 0 && matchedInPath === 0 && matchedInSig === 0 && !hasLiteralAnchor && !hasExactIdentAnchor && proseHeavy) {
        fieldScoreTotal = Math.min(fieldScoreTotal * 0.3, (totalQueryIdf / Math.max(1, qLen)) * 1.8);
        if (n.kind !== "file" && matchState)
            matchState.matched = null;
    }
    const boosted = applyLexicalCompoundBoosts(n, nameHintScore, pathHintScore, matchedInName, matchedInPath, matchedCount, baseNameLower, fileStemLower, ownerLower, qState);
    const raw = computeCompoundAndCoverageRaw(cand, qState, fieldScoreTotal, literalScore, exactIdentScore, matchedInName, matchedCount, matchedIdf, boosted, hasLiteralAnchor, hasExactIdentAnchor, nameHintScore, pathHintScore);
    const total = raw * testFactor(n.path) * (n.kind === "doc" && !wantsDocs ? DOC_RANK_FACTOR : 1);
    if (total <= 0)
        return null;
    if (matchState) {
        rawLexicalById.set(n.id, total);
        if (matchState.matched)
            matchedTermsById.set(n.id, matchState.matched);
        if (matchState.strong)
            matchedStrongTermsById.set(n.id, matchState.strong);
    }
    anchorInfoById.set(n.id, {
        hasFileMatch: rawFileNames.has(baseNameLower),
        hasLiteralAnchor,
        hasExactIdentAnchor,
        hasStrongAnchor: hasLiteralAnchor || hasExactIdentAnchor || boosted.exactCompoundName || (matchedInName >= 1 && matchedInName >= Math.min(2, Math.max(1, qLen))),
    });
    return total;
}

function scoreLexicalCandidate(cand, ctx) {
    const { qState, avgLens, fileComplement } = ctx;
    const { n, fieldLens, spanLines } = cand;
    const qTermsSet = qState.qTermsSet ?? (qState.qTermsSet = new Set(qState.qTerms));
    const effBodyLen = n.kind === "file"
        ? Math.max((avgLens.body ?? 1) * 0.85, Math.min(fieldLens.body * 0.35, 420))
        : Math.max(fieldLens.body, (avgLens.body ?? 1) * 0.85, (spanLines ?? 1) * 3.5);
    const matchState = fileComplement ? { matched: null, strong: null } : null;
    const qStats = scoreLexicalQueryTerms(cand, qState, avgLens, effBodyLen, matchState);
    const litStats = scoreLexicalLiterals(cand, qState, avgLens, effBodyLen, matchState);
    const exactStats = scoreLexicalExactIdents(cand, qState, qTermsSet, avgLens, effBodyLen, qStats.matchedInName, matchState);
    if (qStats.matchedCount === 0 && litStats.literalScore === 0 && exactStats.exactIdentScore === 0)
        return null;
    return finalizeLexicalCandidateScore(cand, ctx, qStats, litStats, exactStats, matchState);
}
function scoreLexicalSymbolDocs(docs, ctx) {
    const out = new Map();
    for (const d of docs) {
        const cand = {
            n: d.n,
            fieldLens: d.fieldLens,
            nameTokenCount: d.name.size,
            spanLines: d.spanLines,
            proseHeavy: d.proseHeavy,
            baseNameLower: d.baseNameLower,
            fileStemLower: d.fileStemLower,
            ownerLower: d.ownerLower,
            singleWordMethod: d.singleWordMethod,
            nameExact: d.nameExact,
            getFieldTf: (chan, t, alt, stem, effBodyLen) => {
                if (chan === "literals")
                    return d.literals.get(t) ?? 0;
                if (chan === "exact_ident") {
                    const ex = d.exactIdent.get(t) ?? 0;
                    if (ex > 0)
                        return ex;
                    if (!PROSE_STOPWORDS.has(t)) {
                        const bt = d.body.get(t) ?? 0;
                        if (bt > 0) {
                            const bNorm = effBodyLen ? (0.25 + 0.75 * (effBodyLen / Math.max(1, ctx.avgLens.body ?? 1))) : 1;
                            return bt / Math.max(1, bNorm);
                        }
                    }
                    return 0;
                }
                const map = d[chan];
                const stemMap = d[`${chan}Stems`];
                if (!map)
                    return 0;
                return fastTermCount(map, stemMap, t, alt, stem);
            },
        };
        const total = scoreLexicalCandidate(cand, ctx);
        if (total !== null)
            out.set(d.n.id, total);
    }
    return out;
}
function appendLexicalFileQueueGroup(ctx, file, leaderScore, scoreFor, scopeFor) {
    const { includeRankingMetadata, makeSymbolHit, baselineHitById, fileQueueHitsByGroup, baselineQueueHitsByGroup, fileGroups, symbolHits } = ctx;
    const effectiveQueue = !includeRankingMetadata && file.queue[0]?.kind === "file" && file.queue.some((m) => m.kind !== "file")
        ? [
            file.queue.find((m) => m.kind !== "file"),
            ...file.queue.filter((m) => m.kind !== "file" && m.id !== file.queue.find((x) => x.kind !== "file")?.id),
        ]
        : file.queue;
    const materializeFileQueue = () => effectiveQueue.flatMap((member, index) => {
        if (!includeRankingMetadata && index > 0) {
            const hit = makeSymbolHit(member.id, scoreFor(member), scopeFor?.(member.id));
            return hit ? [hit] : [];
        }
        if (index > 0) {
            const baselineHit = baselineHitById.get(member.id);
            if (baselineHit)
                return [baselineHit];
        }
        const hit = makeSymbolHit(member.id, index === 0 ? leaderScore : scoreFor(member), scopeFor?.(member.id));
        return hit ? [hit] : [];
    });
    const materializeBaselineQueue = () => effectiveQueue.flatMap((member) => {
        const hit = makeSymbolHit(member.id, scoreFor(member), scopeFor?.(member.id));
        return hit ? [hit] : [];
    });
    const hits = includeRankingMetadata
        ? materializeFileQueue()
        : (() => {
            const leader = effectiveQueue[0];
            if (!leader)
                return [];
            const hit = makeSymbolHit(leader.id, leaderScore, scopeFor?.(leader.id));
            return hit ? [hit] : [];
        })();
    if (hits.length === 0)
        return;
    const group = {
        key: `file:${file.file}`,
        hits,
        coverage: file.unionCoverage,
        coverageStrong: file.unionStrongCoverage,
    };
    fileQueueHitsByGroup.set(group.key, materializeFileQueue);
    baselineQueueHitsByGroup.set(group.key, materializeBaselineQueue);
    fileGroups.push(group);
    symbolHits.push(hits[0]);
}
function getOrBuildSqliteMultiScopeCache(graph, inPrefix, scopes) {
    const cached = graph._multiScopeGraphCache;
    if (!inPrefix && cached?.nodeLen === graph.nodes.length && cached?.edgeLen === graph.edges.length) {
        return { byScope: new Map(), scopeById: cached.scopeById, pageRankByScope: cached.pageRankByScope };
    }
    const scopeById = new Map();
    for (const n of graph.nodes) {
        if (n.path) scopeById.set(n.id, scopeOf(n.path, scopes).prefix);
    }
    let pageRankByScope;
    if (!inPrefix) {
        pageRankByScope = preparePageRankPartitions(graph, (id) => scopeById.get(id));
        Object.defineProperty(graph, "_multiScopeGraphCache", {
            value: { nodeLen: graph.nodes.length, edgeLen: graph.edges.length, scopeById, pageRankByScope },
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return { byScope: new Map(), scopeById, pageRankByScope };
}

function getOrBuildMultiScopeCache(corpus, graph, inPrefix, hydratedById, symbolDocs, scopes) {
    if (symbolDocs.length === 0 && graph) {
        return getOrBuildSqliteMultiScopeCache(graph, inPrefix, scopes);
    }
    if (!inPrefix && graph && hydratedById && graph._multiScopeCache?.askIndex === corpus.askIndex && graph._multiScopeCache?.edgeLen === graph.edges.length) {
        return graph._multiScopeCache;
    }
    const byScope = new Map();
    const scopeById = new Map();
    for (const d of symbolDocs) {
        const s = scopeOf(d.n.path, scopes).prefix;
        scopeById.set(d.n.id, s);
        pushMap(byScope, s, d);
    }
    let pageRankByScope;
    if (!inPrefix && graph && hydratedById) {
        pageRankByScope = preparePageRankPartitions(graph, (id) => scopeById.get(id));
        Object.defineProperty(graph, "_multiScopeCache", {
            value: { askIndex: corpus.askIndex, edgeLen: graph.edges.length, byScope, scopeById, pageRankByScope },
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return { byScope, scopeById, pageRankByScope };
}
function mergeMdDocsByScope(byScope, mdDocs, scopes) {
    if (mdDocs.length === 0)
        return byScope;
    const mergedByScope = new Map(byScope);
    for (const d of mdDocs) {
        const s = scopeOf(d.n.path, scopes).prefix;
        const prev = mergedByScope.get(s) ?? [];
        mergedByScope.set(s, [...prev, d]);
    }
    return mergedByScope;
}

function docMatchesScopeQueryIdent(doc, q, qStemOf, qState) {
    for (const t of q.keys()) {
        if (hasTerm(doc.name, t, doc.nameStems, qStemOf) ||
            hasTerm(doc.path, t, doc.pathStems, qStemOf) ||
            hasTerm(doc.sig, t, doc.sigStems, qStemOf))
            return true;
    }
    for (const lit of qState.qLiterals) {
        if (doc.literals.has(lit))
            return true;
    }
    for (const ex of qState.qActiveExact) {
        if (doc.exactIdent.has(ex))
            return true;
    }
    return false;
}

function populateBaselineHitsFromItems(items, scoreOf, titleOf, includeRankingMetadata, buildHit, baselineSymbolHits, baselineHitById) {
    const compare = (a, b) => scoreOf(b) - scoreOf(a) || titleOf(a).localeCompare(titleOf(b));
    let topItem = items[0];
    for (let i = 1; i < items.length; i++) {
        if (topItem && compare(items[i], topItem) < 0)
            topItem = items[i];
    }
    const chosen = includeRankingMetadata ? [...items].sort(compare) : topItem ? [topItem] : [];
    for (const item of chosen) {
        const hit = buildHit(item);
        if (hit) {
            baselineSymbolHits.push(hit);
            baselineHitById.set(item.id, hit);
        }
    }
}

function collapseMultiScopeFiles(candidates, collapseState, byId, toFileCandidate, fileQueryWeights) {
    collapseState.components = [...candidates];
    collapseState.byId = new Map(candidates.map((c) => [c.id, c]));
    const fileCandidates = candidates.map((c) => toFileCandidate(c.id, byId.get(c.id), c.lexical, c.graph, c.rankFactor, c.score));
    const rankedFiles = rankFilesBounded(fileCandidates, fileQueryWeights);
    collapseState.fileByRep = new Map(rankedFiles.map((file) => [file.representative.id, file]));
    return rankedFiles.map((file) => ({
        id: file.representative.id,
        scope: collapseState.byId.get(file.representative.id).scope,
        score: file.score,
    }));
}

function emitMultiScopeResults(ctx, fusion, collapseState) {
    const { symbolTitle, includeRankingMetadata, makeSymbolHit, baselineSymbolHits, baselineHitById, symbolHits, needsFileQueues } = ctx;
    if (!needsFileQueues) {
        for (const ranked of fusion.ranked) {
            const hit = makeSymbolHit(ranked.id, ranked.score, ranked.scope);
            if (hit)
                symbolHits.push(hit);
        }
        return;
    }
    const baselineFusion = combineComparableScopes(collapseState.components.map(({ id, scope, score }) => ({ id, scope, score })));
    const baselineScoreById = new Map(baselineFusion.ranked.map((ranked) => [ranked.id, ranked.score]));
    populateBaselineHitsFromItems(
        baselineFusion.ranked,
        (r) => r.score,
        (r) => symbolTitle(r.id),
        includeRankingMetadata,
        (r) => makeSymbolHit(r.id, r.score, r.scope),
        baselineSymbolHits,
        baselineHitById,
    );
    for (const ranked of fusion.ranked) {
        const file = collapseState.fileByRep?.get(ranked.id);
        if (!file)
            continue;
        appendLexicalFileQueueGroup(
            ctx,
            file,
            ranked.score,
            (member) => baselineScoreById.get(member.id) ?? member.baselineScore,
            (id) => collapseState.byId?.get(id)?.scope ?? ranked.scope,
        );
    }
}

function rankMultiScopeLexical(ctx, scopes) {
    const { corpus, graph, inPrefix, hydratedById, symbolDocs, sqliteScoreByScope, sqliteHasIdentByScope, q, qStemOf, qState, graphRank, byId, testFactor, fileComplement, toFileCandidate, fileQueryWeights } = ctx;
    const baseDocs = ctx.baseGraphDocs ?? symbolDocs;
    let { byScope, scopeById, pageRankByScope } = getOrBuildMultiScopeCache(corpus, graph, inPrefix, hydratedById, baseDocs, scopes);
    if (sqliteScoreByScope === null)
        byScope = mergeMdDocsByScope(byScope, ctx.mdDocRecords ?? [], scopes);
    const allScopes = new Set([...byScope.keys(), ...(sqliteScoreByScope ? sqliteScoreByScope.keys() : [])]);
    const collapseState = { components: [], byId: undefined, fileByRep: undefined };
    const fusion = rankScopesAndFuse([...allScopes].sort(), {
        lex: (s) => sqliteScoreByScope ? (sqliteScoreByScope.get(s) ?? new Map()) : scoreLexicalSymbolDocs(byScope.get(s) ?? [], ctx),
        hasIdentifierMatch: (s) => sqliteHasIdentByScope
            ? Boolean(sqliteHasIdentByScope.get(s))
            : (byScope.get(s) ?? []).some((doc) => docMatchesScopeQueryIdent(doc, q, qStemOf, qState)),
        walk: (s, seeds) => {
            if (!graphRank)
                return new Map();
            pageRankByScope ??= preparePageRankPartitions(graph, (id) => scopeById.get(id));
            const topology = pageRankByScope?.get(s);
            return topology ? personalizedPageRankPrepared(topology, seeds) : new Map();
        },
        rankFactor: (_s, id) => testFactor(byId.get(id)?.path ?? ""),
        collapseCandidates: fileComplement
            ? (candidates) => collapseMultiScopeFiles(candidates, collapseState, byId, toFileCandidate, fileQueryWeights)
            : undefined,
    }, GRAPH_WEIGHT, RESCUE_FLOOR);
    emitMultiScopeResults(ctx, fusion, collapseState);
    return fusion.federated.length > 1 || fusion.alsoMatched.length > 0
        ? { federated: fusion.federated, alsoMatched: fusion.alsoMatched }
        : undefined;
}

function buildSingleScopeCandidates(lex, pr, byId, testFactor) {
    let maxLex = 0;
    for (const total of lex.values()) {
        if (total > maxLex)
            maxLex = total;
    }
    const candidates = new Set(lex.keys());
    for (const [id, p] of pr) {
        if (p >= RESCUE_FLOOR)
            candidates.add(id);
    }
    const singleCandidates = [];
    for (const id of candidates) {
        const n = byId.get(id);
        if (!n)
            continue;
        const lexicalScore = maxLex > 0 ? (lex.get(id) ?? 0) / maxLex : 0;
        const graphScore = pr.get(id) ?? 0;
        const rankFactor = testFactor(n.path);
        const baseline = (lexicalScore + GRAPH_WEIGHT * graphScore) * rankFactor;
        if (baseline > 0)
            singleCandidates.push({ id, n, lexical: lexicalScore, graph: graphScore, rankFactor, baseline });
    }
    return singleCandidates;
}

function emitSingleScopeResults(ctx, singleCandidates, candidateById, rankedFiles) {
    const { needsFileQueues, includeRankingMetadata, makeSymbolHit, baselineSymbolHits, baselineHitById, symbolHits } = ctx;
    if (needsFileQueues && rankedFiles) {
        populateBaselineHitsFromItems(
            singleCandidates,
            (c) => c.baseline,
            (c) => `${c.n.name} · ${c.n.kind}`,
            includeRankingMetadata,
            (c) => makeSymbolHit(c.id, c.baseline),
            baselineSymbolHits,
            baselineHitById,
        );
        for (const file of rankedFiles)
            appendLexicalFileQueueGroup(ctx, file, file.score, (member) => member.baselineScore);
        return;
    }
    if (rankedFiles) {
        for (const file of rankedFiles) {
            const candidate = candidateById?.get(file.representative.id);
            const hit = candidate ? makeSymbolHit(candidate.id, file.score) : null;
            if (hit)
                symbolHits.push(hit);
        }
        return;
    }
    for (const candidate of singleCandidates) {
        const hit = makeSymbolHit(candidate.id, candidate.baseline);
        if (hit)
            symbolHits.push(hit);
    }
}

function rankSingleScopeLexical(ctx) {
    const { symbolDocs, sqliteAllLex, graphRank, graph, inPrefix, byId, testFactor, fileComplement, toFileCandidate, fileQueryWeights } = ctx;
    const lex = sqliteAllLex ?? scoreLexicalSymbolDocs(symbolDocs, ctx);
    const pr = graphRank && graph && lex.size > 0
        ? personalizedPageRank(graph, lex, inPrefix ? { nodeFilter: (id) => pathUnderPrefix(byId.get(id)?.path ?? "", inPrefix) } : {})
        : new Map();
    const singleCandidates = buildSingleScopeCandidates(lex, pr, byId, testFactor);
    const candidateById = fileComplement ? new Map(singleCandidates.map((c) => [c.id, c])) : undefined;
    const rankedFiles = fileComplement
        ? rankFilesBounded(singleCandidates.map((c) => toFileCandidate(c.id, c.n, c.lexical, c.graph, c.rankFactor, c.baseline)), fileQueryWeights)
        : undefined;
    emitSingleScopeResults(ctx, singleCandidates, candidateById, rankedFiles);
}

function promoteLockedTopLeader(baselineTop, fileQueue, includeRankingMetadata, key, matchedOf, matchedStrongOf, selectionGroupOf) {
    if (includeRankingMetadata || !baselineTop.title.endsWith(" · file") || !fileQueue[0] || fileQueue[0].title.endsWith(" · file"))
        return baselineTop;
    const lockedLeader = { ...fileQueue[0], score: baselineTop.score };
    matchedOf.set(lockedLeader, matchedOf.get(fileQueue[0]) ?? matchedOf.get(baselineTop) ?? 0);
    matchedStrongOf.set(lockedLeader, matchedStrongOf.get(fileQueue[0]) ?? matchedStrongOf.get(baselineTop) ?? 0);
    selectionGroupOf.set(lockedLeader, selectionGroupOf.get(fileQueue[0]) ?? key);
    return lockedLeader;
}

function tryLockTopBaselineGroup(ctx, unlockedGroups, baselineScored, limit) {
    const { fileTopLock, fileFirst, wantsTests, includeRankingMetadata, selectionGroupOf, matchedOf, matchedStrongOf, fileQueueHitsByGroup, baselineQueueHitsByGroup } = ctx;
    if (!fileTopLock || !fileFirst || !baselineScored[0])
        return { projectedGroups: unlockedGroups, lockedGroupKey: undefined };
    const baselineTop = baselineScored[0];
    const key = selectionGroupOf.get(baselineTop) ?? "locked:top";
    const existing = unlockedGroups.find((group) => group.key === key);
    const topUnlocked = unlockedGroups[0];
    const baselineCov = existing?.coverage ?? matchedOf.get(baselineTop) ?? 0;
    const unlockedCov = topUnlocked?.coverage ?? 0;
    const baselineGroupScore = existing?.hits[0]?.score ?? baselineTop.score;
    const unlockedTopScore = topUnlocked?.hits[0]?.score ?? 0;
    if ((!wantsTests && isTestPath(baselineTop.pointer)) || baselineCov < unlockedCov || baselineGroupScore < unlockedTopScore)
        return { projectedGroups: unlockedGroups, lockedGroupKey: undefined };
    const fileQueue = !includeRankingMetadata ? (fileQueueHitsByGroup.get(key)?.() ?? []) : [];
    const baselineQueue = includeRankingMetadata || limit > unlockedGroups.length
        ? baselineQueueHitsByGroup.get(key)?.() ?? baselineScored.filter((hit) => (selectionGroupOf.get(hit) ?? "") === key)
        : fileQueue;
    const lockedLeader = promoteLockedTopLeader(baselineTop, fileQueue, includeRankingMetadata, key, matchedOf, matchedStrongOf, selectionGroupOf);
    const locked = existing
        ? { ...existing, hits: [lockedLeader, ...baselineQueue.filter((hit) => !sameHit(hit, lockedLeader) && (includeRankingMetadata || !hit.title.endsWith(" · file")))] }
        : { key, hits: baselineQueue.length ? baselineQueue : [lockedLeader], coverage: matchedOf.get(baselineTop) ?? 0, coverageStrong: matchedStrongOf.get(baselineTop) ?? 0 };
    matchedOf.set(lockedLeader, locked.coverage);
    matchedStrongOf.set(lockedLeader, locked.coverageStrong);
    return {
        lockedGroupKey: key,
        projectedGroups: [locked, ...unlockedGroups.filter((group) => group.key !== key)],
    };
}

function applyFileTopLockAndProjectGroups(ctx, unlockedGroups, baselineScored, limit) {
    const { fileTopLock, fileFirst, includeRankingMetadata, fileQueueHitsByGroup } = ctx;
    const { projectedGroups, lockedGroupKey } = tryLockTopBaselineGroup(ctx, unlockedGroups, baselineScored, limit);
    if (!fileTopLock || !fileFirst || includeRankingMetadata)
        return projectedGroups;
    const materializeAll = limit > projectedGroups.length;
    return projectedGroups.map((group, idx) => {
        if (group.key === lockedGroupKey || (!materializeAll && idx >= 3))
            return group;
        const materialize = fileQueueHitsByGroup.get(group.key);
        if (!materialize)
            return group;
        const hits = materialize().filter((h, hIdx) => hIdx === 0 || !h.title.endsWith(" · file"));
        return { ...group, hits };
    });
}
function buildLexicalRankingMetadata(unlockedGroups, baselineScored, selectionGroupOf, matchedOf, matchedStrongOf, limit) {
    return {
        groups: unlockedGroups.slice(0, limit).map((group) => ({
            ...group,
            hits: group.hits.slice(0, limit),
            baselineHits: baselineScored
                .filter((hit) => selectionGroupOf.get(hit) === group.key)
                .slice(0, limit),
        })),
        baseline: baselineScored.slice(0, limit).map((hit, index) => ({
            group: selectionGroupOf.get(hit) ?? `ungrouped:${index}`,
            hit,
        })),
        baselineCoverage: baselineScored[0] ? matchedOf.get(baselineScored[0]) ?? 0 : undefined,
        baselineCoverageStrong: baselineScored[0] ? matchedStrongOf.get(baselineScored[0]) ?? 0 : undefined,
    };
}
class LazyHitShareMap extends Map {
    constructor(compute) {
        super();
        this._compute = compute;
    }

    get(hit) {
        if (super.has(hit))
            return super.get(hit);
        if (!hit || !this._compute)
            return undefined;
        return this._compute(hit);
    }
}

function createLexicalSymbolHitMaker(byId, getDoc, q, effQ, idf, dfltIdf, qStemOf, matchedOf, matchedStrongOf, selectionGroupOf, idOfHit) {
    const hitCache = new Map();
    const baseOfHit = new WeakMap();
    const useExactShare = q.size === 0 && effQ.size > 0;
    const ensureShares = (base) => {
        if (base.sharesReady)
            return;
        base.sharesReady = true;
        const d = getDoc(base.id);
        if (!d)
            return;
        if (useExactShare) {
            const exName = counts(tokenizeExact(base.n.name ?? ""));
            base.matched = matchedIdfShare(effQ, [d.exactIdent ?? EMPTY_TF_MAP, d.literals ?? EMPTY_TF_MAP, d.name, d.path], idf, dfltIdf);
            base.matchedStrong = base.n.kind === "file" ? 0 : matchedIdfShare(effQ, [exName, d.literals ?? EMPTY_TF_MAP, d.name], idf, dfltIdf);
        }
        else {
            base.matched = matchedIdfShare(q, [d.name, d.path, d.sig ?? EMPTY_TF_MAP, d.summary ?? EMPTY_TF_MAP, d.literals ?? EMPTY_TF_MAP, d.body], idf, dfltIdf, [d.nameStems, d.pathStems, d.sigStems ?? EMPTY_TF_MAP, d.summaryStems ?? EMPTY_TF_MAP, undefined, d.bodyStems], qStemOf);
            base.matchedStrong = strongShare(q, base.n, d, idf, dfltIdf, qStemOf);
        }
    };
    const computeHitShares = (hit, wantStrong) => {
        const base = baseOfHit.get(hit);
        if (!base)
            return undefined;
        ensureShares(base);
        matchedOf.set(hit, base.matched);
        matchedStrongOf.set(hit, base.matchedStrong);
        return wantStrong ? base.matchedStrong : base.matched;
    };
    matchedOf._compute = (hit) => computeHitShares(hit, false);
    matchedStrongOf._compute = (hit) => computeHitShares(hit, true);
    return (id, hitScore, scope) => {
        let base = hitCache.get(id);
        if (!base) {
            const n = byId.get(id);
            if (!n)
                return null;
            base = {
                id,
                n,
                title: `${n.name} · ${n.kind}`,
                pointer: n.kind === "file" ? n.path : `${n.path}:${n.span}`,
                snippet: n.summary?.split("\n")[0].trim() || n.signature || "",
                sharesReady: false,
                matched: 0,
                matchedStrong: 0,
                group: `file:${n.path}`,
            };
            hitCache.set(id, base);
        }
        const hit = {
            kind: "symbol",
            title: base.title,
            pointer: base.pointer,
            snippet: base.snippet,
            score: hitScore,
            ...(scope === undefined ? {} : { scope }),
        };
        baseOfHit.set(hit, base);
        selectionGroupOf.set(hit, base.group);
        idOfHit.set(hit, id);
        return hit;
    };
}
function extractQueryExactState(query, qTerms) {
    const rawQueryTokens = [...query.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)];
    const codeAnchoredExact = new Set();
    const rawCodeIdents = new Set();
    for (const m of rawQueryTokens) {
        const tok = m[0];
        const idx = m.index ?? 0;
        const before = idx > 0 ? query[idx - 1] : "";
        const after = query[idx + tok.length] ?? "";
        const hasBoundarySyntax = before === "`" || after === "`" || after === "(" || before === "." || after === "." || before === ":" || after === ":" || before === "#" || after === "#";
        const isCodeShape = /[a-z][A-Z]|_|^[A-Z][a-z0-9]+[A-Z]|[A-Z]{2,}|[0-9]/.test(tok);
        if (hasBoundarySyntax || isCodeShape) {
            if (tok.length >= 2)
                rawCodeIdents.add(tok.toLowerCase());
            for (const sub of tokenizeExact(tok))
                codeAnchoredExact.add(sub);
        }
    }
    for (const m of query.matchAll(/`([^`\n]+)`/g)) {
        for (const sub of tokenizeExact(m[1]))
            codeAnchoredExact.add(sub);
        const trimmed = m[1].trim().toLowerCase();
        if (/^[a-z_][a-z0-9_]*$/.test(trimmed) && trimmed.length >= 2)
            rawCodeIdents.add(trimmed);
    }
    const allQueryExact = [...new Set(tokenizeExact(query))];
    const promoteAllExact = qTerms.length === 0;
    const qActiveExact = promoteAllExact ? allQueryExact : [...codeAnchoredExact];
    if (promoteAllExact && rawCodeIdents.size === 0) {
        for (const t of qActiveExact)
            rawCodeIdents.add(t);
    }
    return { qActiveExact, rawCodeIdents, codeAnchoredExact };
}
function sqliteIdfVal(d, docCount, dfltIdf) {
    return d > 0 ? Math.log(1 + docCount / (1 + d)) : dfltIdf;
}

function sqliteDfVal(df, chan, term) {
    return df?.[chan]?.get(term) ?? 0;
}

function computeSqliteQueryIdfs(docCount, df, qState) {
    const dfltIdf = Math.log(1 + docCount);
    const { qTerms, qAlts, qStems, qLiterals, qActiveExact } = qState;
    const idf = new Map();
    const qIdfs = qTerms.map((t, idx) => {
        const alt = qAlts[idx];
        const stem = qStems[idx];
        const d = Math.max(
            sqliteDfVal(df, "name", t), sqliteDfVal(df, "path", t), sqliteDfVal(df, "sig", t),
            sqliteDfVal(df, "summary", t), sqliteDfVal(df, "body", t),
            sqliteDfVal(df, "name", alt), sqliteDfVal(df, "body", alt),
            stem ? Math.round(sqliteDfVal(df, "stem", stem) * 0.65) : 0,
        );
        const w = sqliteIdfVal(d, docCount, dfltIdf);
        idf.set(t, w);
        return w;
    });
    const qLiteralIdfs = qLiterals.map((lit) => {
        const w = sqliteIdfVal(sqliteDfVal(df, "literals", lit), docCount, dfltIdf);
        idf.set(lit, w);
        return w;
    });
    const qExactIdfs = qActiveExact.map((ex) => {
        const w = sqliteIdfVal(sqliteDfVal(df, "exact_ident", ex), docCount, dfltIdf);
        if (!idf.has(ex))
            idf.set(ex, w);
        return w;
    });
    qState.qIdfs = qIdfs;
    qState.totalQueryIdf = qIdfs.reduce((a, w) => a + w, 0) || 1;
    qState.qLiteralIdfs = qLiteralIdfs;
    qState.qExactIdfs = qExactIdfs;
    return { idf, dfltIdf };
}

const EMPTY_TF_MAP = new Map();

function createLayeredMapView(baseMap, extraMap) {
    if (!extraMap || extraMap.size === 0)
        return baseMap;
    return {
        get: (key) => baseMap.get(key) ?? extraMap.get(key),
        has: (key) => baseMap.has(key) || extraMap.has(key),
    };
}

function getSqliteDocChanMap(docTfs, chan) {
    switch (chan) {
    case "name":
        return docTfs.name;
    case "path":
        return docTfs.path;
    case "sig":
        return docTfs.sig;
    case "summary":
        return docTfs.summary;
    case "body":
        return docTfs.body;
    case "literals":
        return docTfs.literals;
    case "exact_ident":
        return docTfs.exact_ident;
    case "stem":
        return docTfs.stem;
    default:
        return null;
    }
}

function setSqliteDocChanMap(entry, chan, map) {
    switch (chan) {
    case "name":
        entry.name = map;
        return;
    case "path":
        entry.path = map;
        return;
    case "sig":
        entry.sig = map;
        return;
    case "summary":
        entry.summary = map;
        return;
    case "body":
        entry.body = map;
        return;
    case "literals":
        entry.literals = map;
        return;
    case "exact_ident":
        entry.exact_ident = map;
        return;
    case "stem":
        entry.stem = map;
    }
}

function groupSqlitePostingsByDoc(postings) {
    const tfByDoc = new Map();
    for (const [chan, chanMap] of Object.entries(postings ?? {})) {
        if (!(chanMap instanceof Map))
            continue;
        for (const [term, arr] of chanMap) {
            for (const [docId, tf] of arr) {
                let entry = tfByDoc.get(docId);
                if (!entry) {
                    entry = { name: null, path: null, sig: null, summary: null, literals: null, body: null, stem: null, exact_ident: null };
                    tfByDoc.set(docId, entry);
                }
                let tMap = getSqliteDocChanMap(entry, chan);
                if (!tMap) {
                    tMap = new Map();
                    setSqliteDocChanMap(entry, chan, tMap);
                }
                tMap.set(term, tf);
            }
        }
    }
    return tfByDoc;
}

function buildSqliteAvgLensObj(avgLens) {
    return {
        name: Math.max(1, avgLens?.name ?? 1),
        path: Math.max(1, avgLens?.path ?? 1),
        sig: Math.max(4, avgLens?.sig ?? 4),
        summary: Math.max(6, avgLens?.summary ?? 6),
        literals: Math.max(3, avgLens?.literals ?? 3),
        body: Math.max(1, avgLens?.body ?? 1),
        exact_ident: Math.max(8, avgLens?.exact_ident ?? 8),
    };
}

const COMPOUND_STEM_TARGETS = new Set([
    "variabl", "integ", "integer", "unsign", "sign", "bit", "width", "coordin", "fram", "modify", "tim", "property",
]);
const MAX_PATH_LEX_CACHE = 4096;
const pathLexCache = new Map();

function getOrCreatePathLexEntry(rawPath) {
    const key = rawPath ?? "";
    let entry = pathLexCache.get(key);
    if (entry !== undefined)
        return entry;
    const slashIdx = key ? key.lastIndexOf("/") : -1;
    const baseNameLower = (slashIdx >= 0 ? key.slice(slashIdx + 1) : key).toLowerCase();
    const extDotIdx = baseNameLower.lastIndexOf(".");
    const fileStemLower = extDotIdx >= 0 ? baseNameLower.slice(0, extDotIdx) : baseNameLower;
    entry = {
        rawPath: key,
        baseNameLower,
        fileStemLower,
        isIndexFile: /^(?:init|index|mod)$/.test(fileStemLower),
        pathBag: null,
        pathStems: null,
    };
    if (pathLexCache.size >= MAX_PATH_LEX_CACHE)
        pathLexCache.clear();
    pathLexCache.set(key, entry);
    return entry;
}

function getPathEntryBag(entry) {
    return (entry.pathBag ??= counts(tokenize(entry.rawPath)));
}

function getPathEntryStems(entry) {
    return (entry.pathStems ??= stemCounts(getPathEntryBag(entry)));
}

function canSkipStemByPrefix(stem, rawText, lex, lowerProp) {
    if (stem.length < 4 || COMPOUND_STEM_TARGETS.has(stem))
        return false;
    const low = lex[lowerProp] ?? (lex[lowerProp] = rawText.toLowerCase());
    return !low.includes(stem.slice(0, 3));
}

function checkFieldStemCached(lex, rawText, stemsProp, bagGetter, lowerProp, stem) {
    if (!rawText)
        return false;
    let stems = lex[stemsProp];
    if (!stems) {
        if (canSkipStemByPrefix(stem, rawText, lex, lowerProp))
            return false;
        stems = (lex[stemsProp] = stemCounts(lex[bagGetter]));
    }
    return stems.has(stem);
}

function matchSqliteStemTf(chan, stem, docTfs, lex) {
    if (!stem || !docTfs.stem)
        return 0;
    const st = docTfs.stem.get(stem) ?? 0;
    if (st <= 0)
        return 0;
    if (chan === "body")
        return st * 0.85;
    return lex.hasFieldStem(chan, stem) ? 0.85 : 0;
}

function ensureSqliteNormSpan(docMeta) {
    if (docMeta._normSpan !== undefined)
        return docMeta._normSpan;
    const normSpan = /^\d+(?:-\d+)?$/.test(String(docMeta.span ?? ""))
        ? `L${String(docMeta.span).replace(/-/, "-L")}`
        : docMeta.span;
    if ("_normSpan" in docMeta) {
        docMeta._normSpan = normSpan;
    }
    else {
        Object.defineProperty(docMeta, "_normSpan", {
            value: normSpan,
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return normSpan;
}

function ensureSqliteEffectiveNode(docId, docMeta, normSpan, baseById, extraById, extraNodes) {
    const id = docMeta.nodeId ?? String(docMeta.id ?? docId ?? "");
    let node = baseById.get(id) ?? extraById.get(id);
    if (!node) {
        node = {
            id,
            path: docMeta.path,
            kind: docMeta.kind,
            name: docMeta.name,
            span: normSpan,
            signature: docMeta.signature,
            summary: docMeta.summary,
            exported: docMeta.exported,
        };
        extraById.set(id, node);
        extraNodes.push(node);
    }
    return { id, node };
}

class SqliteDocLexStatic {
    constructor(docMeta, normSpan, node, owner) {
        const pathEntry = getOrCreatePathLexEntry(docMeta.path);
        const sp = spanRange(normSpan);
        const spanLines = sp ? sp.end - sp.start + 1 : 1;
        const ownerLower = owner ? owner.toLowerCase() : "";

        this._docMeta = docMeta;
        this._pathEntry = pathEntry;
        this.normSpan = normSpan;
        this.owner = owner;
        this.baseNameLower = pathEntry.baseNameLower;
        this.fileStemLower = pathEntry.fileStemLower;
        this.isIndexFile = pathEntry.isIndexFile;
        this.ownerLower = ownerLower;
        this.bareLower = getBareSymbolNameLower(docMeta.name ?? "");
        this.spanLines = spanLines;
        this.singleWordMethod = Boolean(ownerLower && !node.name.includes("_") && !/[A-Z]/.test(node.name.slice(1)));
        this._nameLower = null;
        this._sigLower = null;
        this._sumLower = null;
        this._nameBag = null;
        this._sigBag = null;
        this._sumBag = null;
        this._nameStems = null;
        this._sigStems = null;
        this._sumStems = null;
        this._fLens = null;
        this._nameExact = undefined;
    }

    get nameBag() { return (this._nameBag ??= counts(tokenize(this._docMeta.name ?? ""))); }
    get pathBag() { return getPathEntryBag(this._pathEntry); }
    get sigBag() { return (this._sigBag ??= counts(tokenize(this._docMeta.signature ?? ""))); }
    get sumBag() { return (this._sumBag ??= counts(tokenize(this._docMeta.summary ?? ""))); }
    get nameStems() { return (this._nameStems ??= stemCounts(this.nameBag)); }
    get pathStems() { return getPathEntryStems(this._pathEntry); }
    get sigStems() { return (this._sigStems ??= stemCounts(this.sigBag)); }
    get sumStems() { return (this._sumStems ??= stemCounts(this.sumBag)); }

    get fLens() {
        return (this._fLens ??= this._docMeta.fieldLens ?? {
            name: this.nameBag.size,
            path: this.pathBag.size,
            sig: this.sigBag.size,
            summary: this.sumBag.size,
            literals: 0,
            body: 1,
            exact_ident: 1,
        });
    }

    get nameExact() {
        if (this._nameExact !== undefined)
            return this._nameExact;
        return (this._nameExact = this._docMeta.kind === "file" ? null : new Set(tokenizeExact(this._docMeta.name ?? "")));
    }

    get proseHeavy() {
        return this._docMeta.kind !== "doc" && (this.fLens.body ?? 0) >= 60 && ((this.fLens.body ?? 0) / Math.max(8, this.spanLines) >= 3.5);
    }

    hasFieldStem(chan, stem) {
        if (this._fLens && (this._fLens[chan] ?? 0) === 0)
            return false;
        switch (chan) {
        case "path":
            return this._docMeta.path ? getPathEntryStems(this._pathEntry).has(stem) : false;
        case "name":
            return checkFieldStemCached(this, this._docMeta.name, "_nameStems", "nameBag", "_nameLower", stem);
        case "sig":
            return checkFieldStemCached(this, this._docMeta.signature, "_sigStems", "sigBag", "_sigLower", stem);
        case "summary":
            return checkFieldStemCached(this, this._docMeta.summary, "_sumStems", "sumBag", "_sumLower", stem);
        default:
            return false;
        }
    }
}

class SqliteLexCandidate {
    constructor(node, lex, docTfs) {
        this.n = node;
        this._lex = lex;
        this._docTfs = docTfs;
        this.spanLines = lex.spanLines;
        this.baseNameLower = lex.baseNameLower;
        this.fileStemLower = lex.fileStemLower;
        this.isIndexFile = lex.isIndexFile;
        this.ownerLower = lex.ownerLower;
        this.bareLower = lex.bareLower;
        this.singleWordMethod = lex.singleWordMethod;
    }

    get fieldLens() { return this._lex.fLens; }
    get nameTokenCount() { return this._lex.fLens.name ?? this._lex.nameBag.size; }
    get proseHeavy() { return this._lex.proseHeavy; }
    get nameExact() { return this._lex.nameExact; }

    getFieldTf(chan, t, alt, stem) {
        const docTfs = this._docTfs;
        if (chan === "literals")
            return docTfs.literals?.get(t) ?? 0;
        if (chan === "exact_ident")
            return docTfs.exact_ident?.get(t) ?? 0;
        const chanMap = getSqliteDocChanMap(docTfs, chan);
        if (chanMap) {
            const exact = chanMap.get(t);
            if (exact !== undefined && exact > 0)
                return exact;
            if (alt) {
                const p = chanMap.get(alt);
                if (p !== undefined && p > 0)
                    return p * 0.9;
            }
        }
        return matchSqliteStemTf(chan, stem, docTfs, this._lex);
    }
}

class SqliteDocRecord {
    constructor(lex, docTfs) {
        this._lex = lex;
        this.literals = docTfs.literals ?? EMPTY_TF_MAP;
        this.body = docTfs.body ?? EMPTY_TF_MAP;
        this.exactIdent = docTfs.exact_ident ?? EMPTY_TF_MAP;
        this.bodyStems = docTfs.stem ?? EMPTY_TF_MAP;
    }

    get name() { return this._lex.nameBag; }
    get path() { return this._lex.pathBag; }
    get sig() { return this._lex.sigBag; }
    get summary() { return this._lex.sumBag; }
    get nameStems() { return this._lex.nameStems; }
    get pathStems() { return this._lex.pathStems; }
    get sigStems() { return this._lex.sigStems; }
    get summaryStems() { return this._lex.sumStems; }
}

function ensureSqliteDocLexStatic(docMeta, normSpan, node) {
    const owner = node.owner ?? "";
    let lex = docMeta._lexStatic;
    if (!lex || lex.normSpan !== normSpan || lex.owner !== owner) {
        lex = new SqliteDocLexStatic(docMeta, normSpan, node, owner);
        if ("_lexStatic" in docMeta) {
            docMeta._lexStatic = lex;
        }
        else {
            Object.defineProperty(docMeta, "_lexStatic", {
                value: lex,
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
    }
    return lex;
}

function recordSqliteScopeHit(sqliteScoreByScope, sqliteHasIdentByScope, scopes, nodePath, id, total, docTfs) {
    if (!sqliteScoreByScope || !scopes)
        return;
    const sc = scopeOf(nodePath, scopes).prefix;
    let m = sqliteScoreByScope.get(sc);
    if (!m) {
        m = new Map();
        sqliteScoreByScope.set(sc, m);
    }
    m.set(id, total);
    const hasIdMatch = Boolean(
        (docTfs.name?.size ?? 0) > 0 || (docTfs.path?.size ?? 0) > 0 ||
        (docTfs.sig?.size ?? 0) > 0 || (docTfs.literals?.size ?? 0) > 0 ||
        (docTfs.exact_ident?.size ?? 0) > 0,
    );
    if (hasIdMatch)
        sqliteHasIdentByScope.set(sc, true);
}

function prepareSqlitePostingsScoring(postingsData, inPrefix, scopes, baseById, qState, _qStemOf, testFactor, fileComplement, rawLexicalById, matchedTermsById, matchedStrongTermsById, anchorInfoById) {
    const { docCount, avgLens, df, docs, postings } = postingsData;
    const { idf, dfltIdf } = computeSqliteQueryIdfs(docCount, df, qState);
    const tfByDoc = groupSqlitePostingsByDoc(postings);
    const extraById = new Map();
    const extraNodes = [];
    const sqliteDocById = new Map();
    const sqliteAllLex = new Map();
    const sqliteScoreByScope = scopes && scopes.length > 1 ? new Map() : null;
    const sqliteHasIdentByScope = scopes && scopes.length > 1 ? new Map() : null;
    const avgObj = buildSqliteAvgLensObj(avgLens);
    const scoreCtx = { qState, avgLens: avgObj, testFactor, fileComplement, rawLexicalById, matchedTermsById, matchedStrongTermsById, anchorInfoById };
    for (const [docId, docTfs] of tfByDoc) {
        const docMeta = docs?.get(docId);
        if (!docMeta || (inPrefix && !pathUnderPrefix(docMeta.path, inPrefix)))
            continue;
        const normSpan = ensureSqliteNormSpan(docMeta);
        const { id, node } = ensureSqliteEffectiveNode(docId, docMeta, normSpan, baseById, extraById, extraNodes);
        const lex = ensureSqliteDocLexStatic(docMeta, normSpan, node);
        const cand = new SqliteLexCandidate(node, lex, docTfs);
        const total = scoreLexicalCandidate(cand, scoreCtx);
        if (total === null)
            continue;
        sqliteAllLex.set(id, total);
        sqliteDocById.set(id, new SqliteDocRecord(lex, docTfs));
        recordSqliteScopeHit(sqliteScoreByScope, sqliteHasIdentByScope, scopes, node.path, id, total, docTfs);
    }
    return { effectiveById: createLayeredMapView(baseById, extraById), extraNodes, sqliteDocById, sqliteAllLex, sqliteScoreByScope, sqliteHasIdentByScope, idf, nDocs: docCount, dfltIdf, avgLens: avgObj };
}
function computeFieldAvgLens(docs) {
    if (docs.length === 0)
        return { name: 1, path: 1, sig: 4, summary: 6, literals: 3, body: 1, exact_ident: 8 };
    let name = 0, path = 0, sig = 0, sigCount = 0, summary = 0, sumCount = 0, literals = 0, litCount = 0, body = 0, exactIdent = 0;
    for (const d of docs) {
        name += d.fieldLens.name;
        path += d.fieldLens.path;
        if (d.fieldLens.sig > 0) {
            sig += d.fieldLens.sig;
            sigCount++;
        }
        if (d.fieldLens.summary > 0) {
            summary += d.fieldLens.summary;
            sumCount++;
        }
        if (d.fieldLens.literals > 0) {
            literals += d.fieldLens.literals;
            litCount++;
        }
        body += d.fieldLens.body;
        exactIdent += d.fieldLens.exact_ident;
    }
    const inv = 1 / docs.length;
    return {
        name: Math.max(1, name * inv),
        path: Math.max(1, path * inv),
        sig: Math.max(4, sigCount > 0 ? sig / sigCount : 4),
        summary: Math.max(6, sumCount > 0 ? summary / sumCount : 6),
        literals: Math.max(3, litCount > 0 ? literals / litCount : 3),
        body: Math.max(1, body * inv),
        exact_ident: Math.max(8, exactIdent * inv),
    };
}
const MAX_FALLBACK_LITERAL_FILES = 2500;
function collectUnhydratedLiteralDocsByPath(symbolDocs) {
    const byPath = new Map();
    for (const d of symbolDocs) {
        const rel = d.n?.path;
        if (!rel || d._literalsHydrated || d.n.body_text || d.n.kind === "doc" || isGeneratedPath(rel) || isSensitiveOrDotPath(rel))
            continue;
        let list = byPath.get(rel);
        if (!list) {
            list = [];
            byPath.set(rel, list);
        }
        list.push(d);
    }
    return byPath;
}

function loadCachedLiteralPathEntry(rel, docs, readLines, cache) {
    let entry = cache.get(rel);
    if (entry !== undefined)
        return entry;
    const lines = readLines(rel);
    if (!lines || lines.length === 0) {
        if (cache.size < 2500)
            cache.set(rel, null);
        return null;
    }
    const fullText = lines.join("\n");
    if (!LITERAL_FAST_HINT_RE.test(fullText)) {
        for (const d of docs)
            d._literalsHydrated = true;
        if (cache.size < 2500)
            cache.set(rel, null);
        return null;
    }
    entry = { lines, fullLower: fullText.toLowerCase() };
    if (cache.size < 2500)
        cache.set(rel, entry);
    return entry;
}

function hydratePathDocsLiterals(docs, lines) {
    let fullText = null;
    for (const d of docs) {
        let slice;
        if (d.n.kind !== "file" && d.n.span) {
            const sr = spanRange(d.n.span);
            slice = sr && sr.start >= 1 ? lines.slice(sr.start - 1, sr.end).join("\n") : (fullText ??= lines.join("\n"));
        }
        else {
            slice = (fullText ??= lines.join("\n"));
        }
        const raw = `${d.n.name ?? ""} ${d.n.signature ?? ""} ${d.n.summary ?? ""} ${slice}`;
        const lits = counts(extractLiterals(raw));
        if (lits.size > 0) {
            d.literals = lits;
            d.fieldLens.literals = bagLen(lits);
        }
        d._literalsHydrated = true;
    }
}

function hydrateFallbackLiteralsForQuery(symbolDocs, root, qLiterals) {
    if (!root || !Array.isArray(qLiterals) || qLiterals.length === 0 || symbolDocs.length === 0)
        return;
    const byPath = collectUnhydratedLiteralDocsByPath(symbolDocs);
    if (byPath.size === 0 || byPath.size > MAX_FALLBACK_LITERAL_FILES)
        return;
    const readLines = fileReader(root);
    const cache = symbolDocs._linesByPath ?? (symbolDocs._linesByPath = new Map());
    for (const [rel, docs] of byPath) {
        const entry = loadCachedLiteralPathEntry(rel, docs, readLines, cache);
        if (!entry || !qLiterals.some((lit) => entry.fullLower.includes(lit)))
            continue;
        hydratePathDocsLiterals(docs, entry.lines);
    }
}

function extractIdentLikeWordsFromQuery(query) {
    const identLikeWords = new Set();
    for (const m of query.matchAll(/`([^`\n]+)`/g)) {
        for (const w of m[1].toLowerCase().match(/[a-z0-9_.]+/g) ?? [])
            identLikeWords.add(w);
    }
    for (const m of query.matchAll(/\b[A-Za-z0-9_.:]+\b/g)) {
        const tok = m[0];
        if (/[a-z][A-Z]|^[A-Z][a-z0-9]+|[0-9_.:]/.test(tok))
            identLikeWords.add(tok.toLowerCase());
    }
    return identLikeWords;
}

function buildInitialLexicalQueryState(query) {
    const q = new Map([...counts(tokenize(query)).keys()].map((t) => [t, 1]));
    const qStemOf = new Map([...q.keys()].map((t) => [t, stemToken(t)]));
    const lowerQ = query.toLowerCase();
    const rawIdentifiers = new Set([
        ...(lowerQ.match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length >= 4),
        ...(lowerQ.match(/[a-z0-9_]+(?:\.[a-z0-9_]+)+/g) ?? []),
    ]);
    const identLikeWords = extractIdentLikeWordsFromQuery(query);
    const rawFileNames = new Set(lowerQ.match(RAW_FILE_NAME_RE) ?? []);
    const wantsTests = /\b(tests?|specs?|coverage|assert(?:ion)?s?|fixtures?|mocks?)\b/i.test(query);
    const wantsDocs = /\b(readme|docs?|documentation|guide|tutorial|install|installation|setup|architecture|overview|usage)\b/i.test(query);
    const testFactor = (path) => (!wantsTests && cachedTestPath(path) ? TEST_RANK_PENALTY : cachedGenPath(path) ? GENERATED_RANK_PENALTY : 1);
    const qTerms = [...q.keys()];
    const qAlts = qTerms.map((t) => (t.endsWith("s") ? t.slice(0, -1) : `${t}s`));
    const qStems = qTerms.map((t) => {
        const s = qStemOf.get(t) ?? stemToken(t);
        return s.length >= 4 ? s : "";
    });
    const qLiterals = extractLiterals(query);
    const { qActiveExact, rawCodeIdents, codeAnchoredExact } = extractQueryExactState(query, qTerms);
    const qState = {
        query, qTerms, qLen: qTerms.length, qAlts, qStems,
        qIdfs: [], totalQueryIdf: 1,
        qLiterals, qLiteralIdfs: [], qActiveExact, qExactIdfs: [],
        rawCodeIdents, codeAnchoredExact, rawIdentifiers, identLikeWords, rawFileNames, wantsDocs,
        wantsErrorType: /\b(?:errors?|err|exceptions?|invalid|fails?|failed|failure|throws?|thrown|throwing)\b/i.test(query),
    };
    return { q, qStemOf, wantsTests, testFactor, qTerms, qAlts, qStems, qLiterals, qActiveExact, qState };
}

function queryAskPostingsForQuery(corpus, qState, qTerms, qAlts, qStems, qLiterals, qActiveExact) {
    if (!queryAskPostings || !corpus.outDir)
        return null;
    const qPluralTerms = [...new Set([...qTerms, ...qAlts])];
    const termsByChannel = {
        name: qPluralTerms, path: qPluralTerms, sig: qPluralTerms, summary: qPluralTerms,
        literals: qLiterals, body: qPluralTerms,
        stem: [...new Set(qStems.filter(Boolean))],
        exact_ident: qActiveExact,
    };
    const postingsData = queryAskPostings(corpus.outDir, termsByChannel);
    if (postingsData && loadAskVocabCached)
        qState._vocab = loadAskVocabCached(corpus.outDir);
    return postingsData;
}

function docMatchesFallbackTerm(d, t, qStemOf) {
    return hasTerm(d.name, t, d.nameStems, qStemOf) ||
        hasTerm(d.path, t, d.pathStems, qStemOf) ||
        hasTerm(d.sig, t, d.sigStems, qStemOf) ||
        hasTerm(d.summary, t, d.summaryStems, qStemOf) ||
        hasTerm(d.body, t, d.bodyStems, qStemOf);
}

function adjustIndexIdfForMdDocs(askIndex, idf, q, qStemOf, mdDocRecords) {
    if (mdDocRecords.length === 0)
        return;
    const dfMap = askIndex._hydrated?.dfMap;
    const stemDfMap = askIndex._hydrated?.stemDfMap;
    const totalDocs = askIndex.docCount + mdDocRecords.length;
    for (const t of q.keys()) {
        let mdDf = 0;
        const alt = t.endsWith("s") ? t.slice(0, -1) : `${t}s`;
        const stem = qStemOf.get(t) ?? stemToken(t);
        for (const d of mdDocRecords) {
            if (docMatchesFallbackTerm(d, t, qStemOf))
                mdDf++;
        }
        const baseDf = dfMap
            ? Math.max(dfMap.get(t) ?? 0, dfMap.get(alt) ?? 0, stem.length >= 4 && stemDfMap ? Math.round((stemDfMap.get(stem) ?? 0) * 0.65) : 0)
            : 0;
        const dTot = baseDf + mdDf;
        if (dTot > 0)
            idf.set(t, Math.log(1 + totalDocs / (1 + dTot)));
    }
}

function computeFallbackCorpusIdf(askIndex, inPrefix, q, qStemOf, mdDocRecords, symbolDocs) {
    if (askIndex && !inPrefix) {
        const idf = computeIdfFromIndex(askIndex, q.keys());
        adjustIndexIdfForMdDocs(askIndex, idf, q, qStemOf, mdDocRecords);
        return idf;
    }
    const df = new Map();
    for (const t of q.keys()) {
        let c = 0;
        for (const d of symbolDocs) {
            if (d.name.has(t) || d.path.has(t) || d.sig.has(t) || d.summary.has(t) || d.body.has(t))
                c++;
        }
        if (c > 0)
            df.set(t, c);
    }
    return idfFromDf(df, symbolDocs.length);
}

function getOrCacheFallbackAvgLens(graph, askIndex, inPrefix, qLiterals, mdDocRecords, baseGraphDocs, symbolDocs) {
    const canCache = !inPrefix && graph && qLiterals.length === 0 && mdDocRecords.length === 0;
    if (canCache && graph._baseAvgLensAskIdx === askIndex && graph._baseAvgLensNodeLen === baseGraphDocs.length)
        return graph._baseAvgLens;
    const avgLens = computeFieldAvgLens(symbolDocs);
    if (askIndex && !inPrefix && askIndex.avgBodyLen)
        avgLens.body = Math.max(1, askIndex.avgBodyLen);
    if (canCache) {
        Object.defineProperty(graph, "_baseAvgLens", { value: avgLens, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_baseAvgLensAskIdx", { value: askIndex, enumerable: false, configurable: true, writable: true });
        Object.defineProperty(graph, "_baseAvgLensNodeLen", { value: baseGraphDocs.length, enumerable: false, configurable: true, writable: true });
    }
    return avgLens;
}

function countFallbackFieldIdf(symbolDocs, fieldName, terms, nDocs) {
    const outDf = new Map();
    if (terms.length === 0)
        return outDf;
    for (const t of terms) {
        let c = 0;
        for (const d of symbolDocs) {
            if (d[fieldName].has(t))
                c++;
        }
        if (c > 0)
            outDf.set(t, c);
    }
    return idfFromDf(outDf, nDocs);
}

function buildFallbackLexicalData(corpus, graph, inPrefix, baseById, q, qStemOf, qState, qTerms, qLiterals, qActiveExact) {
    const mdDocsAll = scanMarkdownDocNodes(corpus.root, graph);
    const mdFiltered = inPrefix ? mdDocsAll.filter((n) => pathUnderPrefix(n.path, inPrefix)) : mdDocsAll;
    let byId = baseById;
    let extraNodes = [];
    if (mdFiltered.length > 0) {
        byId = new Map(baseById);
        for (const md of mdFiltered)
            byId.set(md.id, md);
        extraNodes = mdFiltered;
    }
    const prep = prepareLexicalSymbolDocs(corpus, graph, inPrefix, []);
    const baseGraphDocs = prep.symbolDocs;
    const mdDocRecords = mdFiltered.map((n) => buildSymbolDocRecord(n, null, null));
    const symbolDocs = mdDocRecords.length > 0 ? [...baseGraphDocs, ...mdDocRecords] : baseGraphDocs;
    if (qLiterals.length > 0)
        hydrateFallbackLiteralsForQuery(symbolDocs, corpus.root, qLiterals);
    const askIndex = prep.askIndex;
    const idf = computeFallbackCorpusIdf(askIndex, inPrefix, q, qStemOf, mdDocRecords, symbolDocs);
    const nDocs = (askIndex && !inPrefix ? askIndex.docCount : baseGraphDocs.length) + mdDocRecords.length;
    const dfltIdf = Math.log(1 + nDocs);
    const avgLens = getOrCacheFallbackAvgLens(graph, askIndex, inPrefix, qLiterals, mdDocRecords, baseGraphDocs, symbolDocs);
    qState.qIdfs = qTerms.map((t) => idf.get(t) ?? dfltIdf);
    qState.totalQueryIdf = qState.qIdfs.reduce((a, w) => a + w, 0) || 1;
    const litIdfMap = countFallbackFieldIdf(symbolDocs, "literals", qLiterals, nDocs);
    const exactIdfMap = countFallbackFieldIdf(symbolDocs, "exactIdent", qActiveExact, nDocs);
    qState.qLiteralIdfs = qLiterals.map((lit) => litIdfMap.get(lit) ?? dfltIdf);
    qState.qExactIdfs = qActiveExact.map((ex) => exactIdfMap.get(ex) ?? dfltIdf);
    return {
        byId, extraNodes, symbolDocs, baseGraphDocs, mdDocRecords,
        hydratedById: prep.hydratedById,
        sqliteScoreByScope: null, sqliteHasIdentByScope: null, sqliteAllLex: null, sqliteDocById: null,
        idf, dfltIdf, avgLens,
    };
}

function buildFileCandidateRecord(id, n, lexicalScore, graphScore, rankFactor, baselineScore, symbolTitle, rawLexicalById, matchedTermsById, matchedStrongTermsById) {
    const rawLexical = rawLexicalById.get(id) ?? 0;
    return {
        id, file: n?.path ?? "", kind: n?.kind === "file" ? "file" : "symbol",
        rawLexical, lexical: lexicalScore, graph: graphScore, rankFactor, baselineScore,
        baselineTieKey: symbolTitle(id),
        matchedTerms: matchedTermsById.get(id) ?? new Set(),
        matchedStrongTerms: matchedStrongTermsById.get(id) ?? new Set(),
        eligible: Boolean(n && n.kind !== "file" && rawLexical > 0),
        spanStart: n ? spanStart(n.span, Number.POSITIVE_INFINITY) : undefined,
    };
}

function buildLexicalRankingContext(query, corpus, graphRank, inPrefix, fileFirst, fileComplement, fileTopLock, includeRankingMetadata) {
    const { q, qStemOf, wantsTests, testFactor, qTerms, qAlts, qStems, qLiterals, qActiveExact, qState } = buildInitialLexicalQueryState(query);
    const graph = corpus.graph;
    const scopes = graph ? scopesOfGraph(graph) : null;
    const rawLexicalById = new Map();
    const matchedTermsById = new Map();
    const matchedStrongTermsById = new Map();
    const anchorInfoById = new Map();
    const baseById = graph?._byId ?? new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    const postingsData = queryAskPostingsForQuery(corpus, qState, qTerms, qAlts, qStems, qLiterals, qActiveExact);
    let data;
    if (postingsData && postingsData.docCount > 0) {
        const sq = prepareSqlitePostingsScoring(postingsData, inPrefix, scopes, baseById, qState, qStemOf, testFactor, fileComplement, rawLexicalById, matchedTermsById, matchedStrongTermsById, anchorInfoById);
        data = {
            byId: sq.effectiveById, extraNodes: sq.extraNodes,
            symbolDocs: [], baseGraphDocs: [], mdDocRecords: [], hydratedById: null,
            sqliteScoreByScope: sq.sqliteScoreByScope, sqliteHasIdentByScope: sq.sqliteHasIdentByScope,
            sqliteAllLex: sq.sqliteAllLex, sqliteDocById: sq.sqliteDocById,
            idf: sq.idf, dfltIdf: sq.dfltIdf, avgLens: sq.avgLens,
        };
    }
    else {
        data = buildFallbackLexicalData(corpus, graph, inPrefix, baseById, q, qStemOf, qState, qTerms, qLiterals, qActiveExact);
    }
    const { byId, extraNodes, symbolDocs, baseGraphDocs, mdDocRecords, hydratedById, sqliteScoreByScope, sqliteHasIdentByScope, sqliteAllLex, sqliteDocById, idf, dfltIdf, avgLens } = data;
    const matchedOf = new LazyHitShareMap(null);
    const matchedStrongOf = new LazyHitShareMap(null);
    const selectionGroupOf = new Map();
    const idOfHit = new Map();
    let fallbackDocsById = null;
    const effQ = q.size > 0 ? q : new Map([...qActiveExact, ...qLiterals].map((t) => [t, 1]));
    const getDoc = (id) => sqliteDocById?.get(id) ?? hydratedById?.get(id) ?? (fallbackDocsById ??= new Map(symbolDocs.map((d) => [d.n.id, d]))).get(id);
    const makeSymbolHit = createLexicalSymbolHitMaker(byId, getDoc, q, effQ, idf, dfltIdf, qStemOf, matchedOf, matchedStrongOf, selectionGroupOf, idOfHit);
    const symbolTitle = (id) => {
        const n = byId.get(id);
        return n ? `${n.name} · ${n.kind}` : id;
    };
    const toFileCandidate = (id, n, lexicalScore, graphScore, rankFactor, baselineScore) =>
        buildFileCandidateRecord(id, n, lexicalScore, graphScore, rankFactor, baselineScore, symbolTitle, rawLexicalById, matchedTermsById, matchedStrongTermsById);
    return {
        corpus, graph, inPrefix, hydratedById, symbolDocs, baseGraphDocs, mdDocRecords, extraNodes,
        sqliteScoreByScope, sqliteHasIdentByScope, sqliteAllLex,
        q, effQ, qStemOf, qState, avgLens, graphRank, byId, testFactor, wantsTests, fileFirst,
        fileComplement, fileTopLock, includeRankingMetadata,
        needsFileQueues: fileComplement && (fileTopLock || includeRankingMetadata),
        fileQueryWeights: fileComplement ? normalizedQueryWeights(effQ, idf, dfltIdf) : new Map(),
        rawLexicalById, matchedTermsById, matchedStrongTermsById, anchorInfoById,
        makeSymbolHit, symbolTitle, toFileCandidate,
        symbolHits: [], baselineSymbolHits: [], baselineHitById: new Map(),
        fileQueueHitsByGroup: new Map(), baselineQueueHitsByGroup: new Map(), fileGroups: [],
        matchedOf, matchedStrongOf, selectionGroupOf, idOfHit, scopes,
    };
}

const COMPACT_EDGE_OUT_RELS = new Set(["calls", "interface_dispatch", "reexports", "implements"]);
const COMPACT_EDGE_IN_RELS = new Set(["calls", "interface_dispatch", "references", "reexports"]);

function getIncidentEdgeLists(nodeId, graph) {
    if (graph._inEdges || graph._outEdges)
        return { inArr: graph._inEdges?.get(nodeId) ?? [], outArr: graph._outEdges?.get(nodeId) ?? [] };
    const inArr = [];
    const outArr = [];
    for (const e of graph.edges ?? []) {
        if (e.target === nodeId)
            inArr.push(e);
        else if (e.source === nodeId)
            outArr.push(e);
    }
    return { inArr, outArr };
}

function attachCompactEdgesMeta(hit, node, byId, graph) {
    if (!node || !graph || hit.related)
        return hit;
    const { inArr, outArr } = getIncidentEdgeLists(node.id, graph);
    const rel = [];
    const seen = new Set([node.id]);
    let callerCount = 0;
    let calleeCount = 0;
    for (const e of outArr) {
        if (!COMPACT_EDGE_OUT_RELS.has(e.relation))
            continue;
        calleeCount++;
        const tn = byId.get(e.target);
        if (tn && tn.kind !== "file" && !seen.has(tn.id) && rel.length < 3) {
            seen.add(tn.id);
            rel.push(`→ ${tn.name}`);
        }
    }
    for (const e of inArr) {
        if (!COMPACT_EDGE_IN_RELS.has(e.relation))
            continue;
        callerCount++;
        const sn = byId.get(e.source);
        if (sn && sn.kind !== "file" && !isTestPath(sn.path) && !seen.has(sn.id) && rel.length < 6) {
            seen.add(sn.id);
            rel.push(`← ${sn.name}`);
        }
    }
    return { ...hit, ...(rel.length ? { related: rel } : {}), callerCount, calleeCount };
}
function buildDiverseCandidateMap(scored, unlockedGroups, idOfHit, byId, graph, cap = 8) {
    const out = [];
    const seenPointers = new Set();
    const pushHit = (h) => {
        if (!h || seenPointers.has(h.pointer) || out.length >= cap)
            return;
        seenPointers.add(h.pointer);
        const nid = idOfHit.get(h);
        out.push(attachCompactEdgesMeta(h, nid ? byId.get(nid) : null, byId, graph));
    };
    for (const h of scored)
        pushHit(h);
    if (out.length < cap && unlockedGroups.length > 0) {
        let round = 1;
        while (out.length < cap && round < 4) {
            let progressed = false;
            for (const g of unlockedGroups) {
                const h = g.hits?.[round];
                if (h) {
                    pushHit(h);
                    progressed = true;
                    if (out.length >= cap)
                        break;
                }
            }
            if (!progressed)
                break;
            round++;
        }
    }
    return out;
}
function selectLexicalDisplayHits(scored, projectedGroups, selectionGroupOf, limit, fileFirst, fileTopLock) {
    if (fileTopLock && fileFirst)
        return roundRobinQueues(projectedGroups.map((group) => group.hits), limit);
    if (!fileFirst)
        return scored;
    return fileFirstRoundRobin(scored.map((hit, index) => ({
        group: selectionGroupOf.get(hit) ?? `ungrouped:${index}`,
        value: hit,
    })), limit);
}

function computeLexicalConfidenceTier(scored, selected, idOfHit, anchorInfoById, rawLexicalById, matchedOf, matchedStrongOf, effQ) {
    if (scored.length === 0)
        return "exploratory";
    const top = selected[0] ?? scored[0];
    const secondHit = selected[1] ?? scored[1];
    const topId = top ? idOfHit.get(top) : undefined;
    const secondId = secondHit ? idOfHit.get(secondHit) : undefined;
    const topAnchors = topId ? anchorInfoById.get(topId) : null;
    const secondAnchors = secondId ? anchorInfoById.get(secondId) : null;
    if (topAnchors?.hasFileMatch || secondAnchors?.hasFileMatch)
        return "high";
    const topHasStrongAnchor = Boolean(topAnchors?.hasStrongAnchor || secondAnchors?.hasStrongAnchor);
    const strongCov = top && effQ.size > 0 ? (matchedStrongOf.get(top) ?? 0) : 0;
    const broadCov = top && effQ.size > 0 ? (matchedOf.get(top) ?? 0) : 0;
    if (!topHasStrongAnchor && strongCov < 0.25 && !(scored.length < 4 && broadCov >= 0.65))
        return "exploratory";
    if (scored.length < 4)
        return "high";
    const top4Score = scored[3]?.score ?? 0;
    const topRatio = top4Score > 0 ? (scored[0]?.score ?? 0) / top4Score : Infinity;
    const fourthId = scored[3] ? idOfHit.get(scored[3]) : undefined;
    const rawLex1 = topId ? (rawLexicalById.get(topId) ?? 0) : 0;
    const rawLex4 = fourthId ? (rawLexicalById.get(fourthId) ?? 0) : 0;
    const rawLexRatio = rawLex1 > 0 && rawLex4 > 0 ? rawLex1 / rawLex4 : Infinity;
    return topRatio >= 1.65 && rawLexRatio >= 1.35 ? "high" : "exploratory";
}

function promoteTopHitScopeMeta(scopeMeta, top, fileTopLock) {
    if (!fileTopLock || !top?.scope || !scopeMeta)
        return scopeMeta;
    return {
        federated: [...new Set([top.scope, ...scopeMeta.federated])],
        alsoMatched: scopeMeta.alsoMatched.filter((match) => match.scope !== top.scope),
    };
}

function lexical(query, corpus, limit, graphRank, inPrefix, fileFirst = true, fileComplement = false, fileTopLock = false, includeRankingMetadata = false) {
    const ctx = buildLexicalRankingContext(query, corpus, graphRank, inPrefix, fileFirst, fileComplement, fileTopLock, includeRankingMetadata);
    const { scopes, effQ, matchedOf, matchedStrongOf, selectionGroupOf, idOfHit, anchorInfoById, rawLexicalById, byId, graph } = ctx;
    let scopeMeta = scopes && scopes.length > 1 ? rankMultiScopeLexical(ctx, scopes) : undefined;
    if (!scopes || scopes.length <= 1)
        rankSingleScopeLexical(ctx);
    const scored = [...ctx.symbolHits].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const baselineScored = ctx.needsFileQueues
        ? [...ctx.baselineSymbolHits].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        : scored;
    const unlockedGroups = [...ctx.fileGroups].sort((a, b) => b.hits[0].score - a.hits[0].score || a.hits[0].title.localeCompare(b.hits[0].title));
    const projectedGroups = applyFileTopLockAndProjectGroups(ctx, unlockedGroups, baselineScored, limit);
    const selected = selectLexicalDisplayHits(scored, projectedGroups, selectionGroupOf, limit, fileFirst, fileTopLock);
    const top = selected[0] ?? scored[0];
    scopeMeta = promoteTopHitScopeMeta(scopeMeta, top, fileTopLock);
    const ranking = includeRankingMetadata && ctx.needsFileQueues
        ? buildLexicalRankingMetadata(unlockedGroups, baselineScored, selectionGroupOf, matchedOf, matchedStrongOf, limit)
        : undefined;
    const confidenceTier = computeLexicalConfidenceTier(scored, selected, idOfHit, anchorInfoById, rawLexicalById, matchedOf, matchedStrongOf, effQ);
    const candidateMap = buildDiverseCandidateMap(scored, projectedGroups, idOfHit, byId, graph, 8);
    const res = {
        query,
        mode: scored.length ? "lexical" : "empty",
        confidenceTier,
        hits: selected.slice(0, limit),
        candidateMap,
        scopes: scopeMeta,
        coverage: top && effQ.size > 0 ? matchedOf.get(top) ?? 0 : undefined,
        coverageStrong: top && effQ.size > 0 ? matchedStrongOf.get(top) ?? 0 : undefined,
        ...(ranking ? { ranking } : {}),
        note: scored.length
            ? undefined
            : `no matching nodes — try different words, or \`plexer build\` if plexer/ is empty${scopesHereClause(scopes ?? [])}`,
    };
    if (ctx.extraNodes.length > 0)
        Object.defineProperty(res, "_extraNodes", { value: ctx.extraNodes, enumerable: false, configurable: true });
    Object.defineProperty(res, "_qState", { value: ctx.qState, enumerable: false, configurable: true });
    return res;
}
export const sameHit = (a, b) => a.kind === b.kind && a.pointer === b.pointer && a.title === b.title;
/** Read the source lines [from, to] (1-indexed, inclusive) of `path` under `root`,
 * capped at `maxLines`. Returns null if the file can't be read. */
function sliceSpan(lines, path, from, to, maxLines = MAX_SPAN_LINES) {
    if (!lines)
        return null;
    const start = Math.max(1, from);
    const end = Math.min(lines.length, to);
    const slice = lines.slice(start - 1, end).map((line, idx) => `L${start + idx}: ${line}`);
    if (slice.length > maxLines) {
        const head = slice.slice(0, maxLines);
        head.push(`… (+${slice.length - maxLines} more lines; open ${path}:L${start + maxLines}-L${end})`);
        return head.join("\n");
    }
    return slice.join("\n");
}
/** Synthesize a deterministic ≤10-line query-aware crux from a symbol's span
 * when `--full` is off and no LLM crux was pre-seeded. Always keeps the
 * signature line(s), selects the highest-signal interior lines matching query
 * terms/stems, key calls, and control/return statements, and prefixes each
 * line with `L<n>:` when non-contiguous lines are excerpted. */
/** Synthesize a readable source excerpt from a symbol's span when `--full` is off:
 *  - If the symbol is `<= maxContiguous` lines (`35` for top hit, `24` for ranks 2-3),
 *    inline the entire contiguous definition with `L<n>:` line numbers so the agent
 *    can read and act on the function without a follow-up `view_file` call.
 *  - If the symbol exceeds `maxContiguous` lines, select `±1`-line contiguous context
 *    windows around the signature, query-matched lines, and final return (up to
 *    `MAX_CRUX_LINES` lines) and insert explicit `… (lines L<a>-L<b> omitted)` markers
 *    wherever lines are skipped so control flow is never silently spliced. */
function flushCruxLineCommentRun(lineCommentRun, blockCommentLines) {
    if (lineCommentRun.length >= 3) {
        for (const idx of lineCommentRun)
            blockCommentLines.add(idx);
    }
    lineCommentRun.length = 0;
}

function stepCruxCommentLine(i, t, state, blockCommentLines) {
    if (state.pyQuote) {
        flushCruxLineCommentRun(state.lineCommentRun, blockCommentLines);
        blockCommentLines.add(i);
        if (t.includes(state.pyQuote))
            state.pyQuote = null;
        return;
    }
    if (t.startsWith('"""') || t.startsWith("'''")) {
        flushCruxLineCommentRun(state.lineCommentRun, blockCommentLines);
        const q = t.slice(0, 3);
        blockCommentLines.add(i);
        if (!t.slice(3).includes(q))
            state.pyQuote = q;
        return;
    }
    if (t.startsWith("--[[") || t.startsWith("/*"))
        state.inBlockComment = true;
    if (state.inBlockComment) {
        flushCruxLineCommentRun(state.lineCommentRun, blockCommentLines);
        blockCommentLines.add(i);
        if (t.includes("]]") || t.includes("*/"))
            state.inBlockComment = false;
        return;
    }
    if (/^(?:\/\/|--|#)/.test(t))
        state.lineCommentRun.push(i);
    else
        flushCruxLineCommentRun(state.lineCommentRun, blockCommentLines);
}

function findCruxBlockCommentLines(slice) {
    const blockCommentLines = new Set();
    const state = { inBlockComment: false, pyQuote: null, lineCommentRun: [] };
    for (let i = 0; i < slice.length; i++)
        stepCruxCommentLine(i, slice[i].trim(), state, blockCommentLines);
    flushCruxLineCommentRun(state.lineCommentRun, blockCommentLines);
    return blockCommentLines;
}

function buildCruxTokLineFreq(lineTokSets) {
    const tokLineFreq = new Map();
    for (const sToks of lineTokSets) {
        for (const tok of sToks)
            tokLineFreq.set(tok, (tokLineFreq.get(tok) ?? 0) + 1);
    }
    return tokLineFreq;
}

function scoreCruxLineTokens(lineToks, sliceLen, tokLineFreq, qTerms, qStems, isComment) {
    let score = 0;
    let qLineMatches = 0;
    for (const tok of lineToks) {
        const lineFreq = tokLineFreq.get(tok) ?? 1;
        const rarity = sliceLen > 200 ? 0.4 + 3.2 / Math.pow(lineFreq, 0.75) : 1 + 1.5 / Math.sqrt(lineFreq);
        if (qTerms.has(tok) || qTerms.has(`${tok}s`) || (tok.endsWith("s") && qTerms.has(tok.slice(0, -1)))) {
            score += (isComment ? 3.2 : 3.5) * rarity;
            qLineMatches++;
            continue;
        }
        const st = stemToken(tok);
        if (st.length >= 4 && qStems.has(st)) {
            score += (isComment ? 2.7 : 3.0) * rarity;
            qLineMatches++;
        }
    }
    return { score, qLineMatches };
}

function parseStaticCruxLineSignals(raw) {
    const trimmed = raw.trim();
    if (!trimmed || /^[\s};,)\]]*$/.test(trimmed) || /^end[\s,)]*$/.test(trimmed))
        return { skip: true };
    const isComment = /^(\/\/|\/\*|\*|--|#)/.test(trimmed);
    const isReturnStmt = /\breturn\b/.test(trimmed);
    let staticBonus = 0;
    if (/\b(return|throw|yield|error|assert)\b/.test(trimmed))
        staticBonus += 1.5;
    if (/\b(?:[A-Z0-9_]*(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)[A-Z0-9_]*)\b/.test(trimmed))
        staticBonus += 2.5;
    if (/\b(?:[A-Za-z_]\w*\s*(?:==|~=|!=|===|!==)\s*(?:true|false|nil|null|0|[A-Za-z_]\w*)|\w+\s*=\s*(?:true|false|nil|null|0))\b/.test(trimmed))
        staticBonus += 1.5;
    if (/\b(if|else\s+if|switch|match|for|while|await)\b|[A-Za-z0-9_]+\s*\(/.test(trimmed))
        staticBonus += 1.0;
    return { skip: false, isComment, trimmed, lowerTrimmed: null, isReturnStmt, staticBonus };
}

function scoreCruxLineSignals(lineSig, lExact, qExactCode, qLiterals) {
    let bonus = lineSig.staticBonus;
    if (qLiterals?.size) {
        const lowerTrimmed = lineSig.lowerTrimmed ?? (lineSig.lowerTrimmed = lineSig.trimmed.toLowerCase());
        for (const lit of qLiterals) {
            if (lowerTrimmed.includes(lit)) {
                bonus += 10.0;
                break;
            }
        }
    }
    if (lExact && qExactCode) {
        for (const ex of qExactCode) {
            if (lExact.has(ex))
                bonus += 3.0;
        }
    }
    return bonus;
}

function resolveCruxStaticSignals(slice, start, lines) {
    if (!lines)
        return slice.map(parseStaticCruxLineSignals);
    let sigCache = lines._cruxSigByLine;
    if (!sigCache) {
        sigCache = new Array(lines.length);
        Object.defineProperty(lines, "_cruxSigByLine", { value: sigCache, enumerable: false, configurable: true, writable: true });
    }
    const baseOffset = start - 1;
    const out = new Array(slice.length);
    for (let i = 0; i < slice.length; i++) {
        const idx = baseOffset + i;
        out[i] = sigCache[idx] ?? (sigCache[idx] = parseStaticCruxLineSignals(slice[i]));
    }
    return out;
}

function resolveCruxLineTokenSets(slice, start, lines, needExact) {
    if (!lines) {
        return {
            lineTokSets: slice.map((raw) => new Set(tokenize(raw))),
            lineExactSets: needExact ? slice.map((raw) => new Set(tokenizeExact(raw))) : null,
        };
    }
    let tokCache = lines._tokByLine;
    if (!tokCache) {
        tokCache = new Array(lines.length);
        Object.defineProperty(lines, "_tokByLine", { value: tokCache, enumerable: false, configurable: true, writable: true });
    }
    let exactCache = needExact ? lines._exactByLine : null;
    if (needExact && !exactCache) {
        exactCache = new Array(lines.length);
        Object.defineProperty(lines, "_exactByLine", { value: exactCache, enumerable: false, configurable: true, writable: true });
    }
    const lineTokSets = new Array(slice.length);
    const lineExactSets = needExact ? new Array(slice.length) : null;
    const baseOffset = start - 1;
    for (let i = 0; i < slice.length; i++) {
        const lineIdx = baseOffset + i;
        lineTokSets[i] = tokCache[lineIdx] ?? (tokCache[lineIdx] = new Set(tokenize(slice[i])));
        if (lineExactSets)
            lineExactSets[i] = exactCache[lineIdx] ?? (exactCache[lineIdx] = new Set(tokenizeExact(slice[i])));
    }
    return { lineTokSets, lineExactSets };
}

function scoreCruxInteriorLines(slice, start, sigCount, blockCommentLines, qTerms, qStems, isExcluded, qExactCode = null, qLiterals = null, lines = null) {
    const { lineTokSets, lineExactSets } = resolveCruxLineTokenSets(slice, start, lines, Boolean(qExactCode?.size));
    const staticSigs = resolveCruxStaticSignals(slice, start, lines);
    const tokLineFreq = buildCruxTokLineFreq(lineTokSets);
    const scoredLines = [];
    let lastReturnIdx = -1;
    for (let i = sigCount; i < slice.length; i++) {
        if (isExcluded(start + i) || blockCommentLines.has(i))
            continue;
        const lineSig = staticSigs[i];
        if (lineSig.skip)
            continue;
        const tokRes = scoreCruxLineTokens(lineTokSets[i], slice.length, tokLineFreq, qTerms, qStems, lineSig.isComment);
        if (lineSig.isComment && tokRes.qLineMatches < 2)
            continue;
        const sigBonus = scoreCruxLineSignals(lineSig, lineExactSets?.[i], qExactCode, qLiterals);
        if (lineSig.isReturnStmt)
            lastReturnIdx = i;
        scoredLines.push({ idx: i, score: (1 - i / slice.length) * 0.2 + tokRes.score + sigBonus });
    }
    scoredLines.sort((a, b) => b.score - a.score || a.idx - b.idx);
    return { scoredLines, lastReturnIdx };
}

function addCruxBoundedRange(chosen, minIdx, maxIdx, maxSize, fromIdx, toIdx) {
    for (let idx = fromIdx; idx <= toIdx; idx++) {
        if (idx >= minIdx && idx < maxIdx && chosen.size < maxSize)
            chosen.add(idx);
    }
}

function expandCruxForwardBranch(p, slice, chosen, maxCruxLines, isBranch, opensTable) {
    if (p.idx + 1 < slice.length && chosen.size < maxCruxLines)
        chosen.add(p.idx + 1);
    if ((isBranch || opensTable) && p.idx + 2 < slice.length && chosen.size < maxCruxLines)
        chosen.add(p.idx + 2);
    if (opensTable && p.score >= 3.0) {
        for (let off = 3; off <= 6 && p.idx + off < slice.length && chosen.size < maxCruxLines + 3; off++) {
            chosen.add(p.idx + off);
            if ((slice[p.idx + off] ?? "").trim().startsWith("}"))
                break;
        }
    }
}

function expandCruxLineContext(p, slice, sigCount, chosen, maxCruxLines) {
    const lineText = (slice[p.idx] ?? "").trim();
    const isBranch = /\b(?:if|elseif|else\s+if)\b/.test(lineText);
    const opensTable = /\b(?:return|type|interface)\b/.test(lineText) && lineText.endsWith("{");
    if (slice.length > 200 && p.score >= 12.0) {
        addCruxBoundedRange(chosen, sigCount, slice.length, maxCruxLines, p.idx - 11, p.idx + 5);
        return;
    }
    if (p.score < 2.5 && !isBranch && !opensTable)
        return;
    expandCruxForwardBranch(p, slice, chosen, maxCruxLines, isBranch, opensTable);
    if (p.score >= 3.0 && p.idx - 1 >= sigCount && chosen.size < maxCruxLines) {
        chosen.add(p.idx - 1);
        if (p.idx - 2 >= sigCount && chosen.size < maxCruxLines && /\b(?:if|elseif|else\s+if)\b/.test(slice[p.idx - 2] ?? ""))
            chosen.add(p.idx - 2);
    }
    if (p.score >= 12.0)
        addCruxBoundedRange(chosen, sigCount, slice.length, maxCruxLines + 4, p.idx - 3, p.idx + 5);
}

function expandCruxTrailingReturn(slice, start, sigCount, chosen, lastReturnIdx, isExcluded) {
    if (lastReturnIdx < 0)
        return;
    chosen.add(lastReturnIdx);
    const retLine = (slice[lastReturnIdx] ?? "").trim();
    if (retLine.endsWith("{")) {
        for (let rOff = 1; rOff <= 14 && lastReturnIdx + rOff < slice.length; rOff++) {
            if (!isExcluded(start + lastReturnIdx + rOff))
                chosen.add(lastReturnIdx + rOff);
            if ((slice[lastReturnIdx + rOff] ?? "").trim().startsWith("}"))
                break;
        }
        return;
    }
    if (!/^return\s+[A-Za-z_]\w*$/.test(retLine))
        return;
    let addedProps = 0;
    for (let pIdx = lastReturnIdx - 1; pIdx >= Math.max(sigCount, lastReturnIdx - 30) && addedProps < 5; pIdx--) {
        if (/^\s*[A-Za-z_]\w*\.[A-Za-z_]\w*\s*=\s*[A-Za-z_]\w*\s*$/.test(slice[pIdx] ?? "")) {
            chosen.add(pIdx);
            addedProps++;
        }
    }
}

function expandCruxScoredWindows(slice, start, sigCount, chosen, scoredLines, lastReturnIdx, maxCruxLines, isExcluded) {
    for (const p of scoredLines) {
        if (chosen.size >= maxCruxLines)
            break;
        chosen.add(p.idx);
        expandCruxLineContext(p, slice, sigCount, chosen, maxCruxLines);
    }
    expandCruxTrailingReturn(slice, start, sigCount, chosen, lastReturnIdx, isExcluded);
}

function closeSmallCruxGapIfAllowed(start, prev, curr, chosen, isExcluded) {
    for (let gIdx = prev + 1; gIdx < curr; gIdx++) {
        if (isExcluded(start + gIdx))
            return;
    }
    for (let gIdx = prev + 1; gIdx < curr; gIdx++)
        chosen.add(gIdx);
}

function closeCruxSmallGapsAndTail(slice, start, end, chosen, maxContiguous, isExcluded) {
    const preSorted = [...chosen].sort((a, b) => a - b);
    const maxGapToClose = maxContiguous >= 50 ? 8 : (maxContiguous >= 40 ? 5 : 3);
    for (let k = 1; k < preSorted.length; k++) {
        const prev = preSorted[k - 1];
        const curr = preSorted[k];
        const gap = curr - prev - 1;
        if (gap >= 1 && (gap <= maxGapToClose || (prev === 0 && start === 1 && curr <= 8)))
            closeSmallCruxGapIfAllowed(start, prev, curr, chosen, isExcluded);
    }
    if (preSorted.length > 0 && preSorted[preSorted.length - 1] >= slice.length - 7 && !isExcluded(end)) {
        for (let gIdx = preSorted[preSorted.length - 1] + 1; gIdx < slice.length; gIdx++) {
            if (!isExcluded(start + gIdx))
                chosen.add(gIdx);
        }
    }
}

function formatCruxExcerptLines(slice, path, start, end, sorted) {
    const outLines = [];
    for (let k = 0; k < sorted.length; k++) {
        const idx = sorted[k];
        const prevIdx = k > 0 ? sorted[k - 1] : -1;
        if (k > 0 && idx > prevIdx + 1) {
            const gapStart = start + prevIdx + 1;
            const gapEnd = start + idx - 1;
            outLines.push(gapStart === gapEnd ? `  … (line L${gapStart} omitted)` : `  … (lines L${gapStart}-L${gapEnd} omitted)`);
        }
        outLines.push(`L${start + idx}: ${slice[idx]}`);
    }
    if (sorted[sorted.length - 1] < slice.length - 1) {
        const gapStart = start + sorted[sorted.length - 1] + 1;
        outLines.push(`  … (lines L${gapStart}-L${end} omitted)`);
    }
    return `${outLines.join("\n")}\n… (excerpt of ${path}:L${start}-L${end}, ${slice.length} lines — pass --full for whole span)`;
}

function closeCruxGapsAndFormat(slice, path, start, end, chosen, blockCommentLines, maxContiguous, maxCruxLines, isExcluded) {
    for (let i = 0; i < slice.length && chosen.size < Math.min(maxCruxLines, slice.length); i++) {
        if (!isExcluded(start + i) && !blockCommentLines.has(i))
            chosen.add(i);
    }
    closeCruxSmallGapsAndTail(slice, start, end, chosen, maxContiguous, isExcluded);
    const sorted = [...chosen].sort((a, b) => a - b);
    return formatCruxExcerptLines(slice, path, start, end, sorted);
}
function synthesizeCrux(lines, path, from, to, qTerms, qStems, maxContiguous = MAX_CONTIGUOUS_TOP_LINES, excludeRanges = null, maxCruxLines = MAX_CRUX_LINES, qExactCode = null, qLiterals = null) {
    if (!lines)
        return null;
    const start = Math.max(1, from);
    const end = Math.min(lines.length, to);
    const slice = lines.slice(start - 1, end);
    if (slice.length === 0)
        return null;
    const isExcluded = (lineNo) =>
        Boolean(excludeRanges && excludeRanges.some((r) => lineNo >= r.start && lineNo <= r.end));
    const blockCommentLines = findCruxBlockCommentLines(slice);
    if (slice.length <= maxContiguous && (!excludeRanges || excludeRanges.length === 0) && blockCommentLines.size <= 16) {
        return slice.map((line, idx) => `L${start + idx}: ${line}`).join("\n");
    }
    const chosen = new Set([0]);
    if (slice.length > 1) {
        let parenDepth = (slice[0].match(/\(/g)?.length ?? 0) - (slice[0].match(/\)/g)?.length ?? 0);
        let sigIdx = 0;
        while (sigIdx + 1 < Math.min(slice.length, 6) && (parenDepth > 0 || (/[,(]$/.test(slice[sigIdx].trim()) && !/[{;]$/.test(slice[sigIdx].trim())))) {
            sigIdx++;
            chosen.add(sigIdx);
            parenDepth += (slice[sigIdx].match(/\(/g)?.length ?? 0) - (slice[sigIdx].match(/\)/g)?.length ?? 0);
        }
        if (sigIdx + 1 < slice.length && /^\s*(?:\)|\{|->|=>|:)\s*/.test(slice[sigIdx + 1]))
            chosen.add(sigIdx + 1);
    }
    const sigCount = chosen.size;
    const { scoredLines, lastReturnIdx } = scoreCruxInteriorLines(
        slice, start, sigCount, blockCommentLines, qTerms, qStems, isExcluded, qExactCode, qLiterals, lines,
    );
    expandCruxScoredWindows(slice, start, sigCount, chosen, scoredLines, lastReturnIdx, maxCruxLines, isExcluded);
    return closeCruxGapsAndFormat(
        slice, path, start, end, chosen, blockCommentLines, maxContiguous, maxCruxLines, isExcluded,
    );
}
/** Attach inlined source to top hits whose pointer is a real `path:span`.
 * When `full` is off, inline contiguous source (or windowed excerpts with explicit
 * `…` gap markers on long symbols) for the top `SOURCE_TOP_HITS` hits while keeping
 * lower hits compact. */
const INLINE_INDEX_EDGE_RELS = new Set(["calls", "interface_dispatch", "reexports", "imports", "implements"]);
function indexGraphNodeForInlineSource(n, full, idx) {
    if (!idx.byId.has(n.id))
        idx.byId.set(n.id, n);
    const ptr = n.kind === "file" ? n.path : `${n.path}:${n.span}`;
    if (!idx.nodeByPointer.has(ptr) || n.kind !== "file")
        idx.nodeByPointer.set(ptr, n);
    if (!full && n.crux?.code)
        idx.cruxByPointer.set(`${n.path}:${n.span}`, n.crux.code);
    if (n.kind === "file" && n.span)
        idx.fileSpanByPath.set(n.path, n.span);
    if (n.kind !== "file" && n.path)
        pushMap(idx.nodesByPath, n.path, n);
}
function buildBaseInlineSourceIndex(graph, full) {
    const cruxByPointer = new Map();
    const fileSpanByPath = new Map();
    const nodeByPointer = new Map();
    const byId = graph?._byId ?? new Map();
    const outCallsById = new Map();
    const inCallsById = new Map();
    const nodesByPath = new Map();
    if (!graph)
        return { cruxByPointer, fileSpanByPath, nodeByPointer, byId, outCallsById, inCallsById, nodesByPath };
    const nodeIdx = { byId, nodeByPointer, cruxByPointer, fileSpanByPath, nodesByPath };
    for (const n of graph.nodes)
        indexGraphNodeForInlineSource(n, full, nodeIdx);
    for (const e of graph.edges) {
        if (!INLINE_INDEX_EDGE_RELS.has(e.relation))
            continue;
        pushMap(outCallsById, e.source, e.target);
        pushMap(inCallsById, e.target, e.source);
    }
    const baseIdx = { cruxByPointer, fileSpanByPath, nodeByPointer, byId, outCallsById, inCallsById, nodesByPath };
    if (!full) {
        Object.defineProperty(graph, "_inlineSourceIndex", {
            value: { nodeLen: graph.nodes.length, edgeLen: graph.edges.length, ...baseIdx },
            enumerable: false,
            configurable: true,
            writable: true,
        });
    }
    return baseIdx;
}
function getOrBuildInlineSourceIndex(graph, full, extraNodes = null) {
    const cached = graph && !full ? graph._inlineSourceIndex : null;
    const cacheValid = Boolean(cached && cached.nodeLen === graph.nodes.length && cached.edgeLen === graph.edges.length);
    const baseIdx = cacheValid ? cached : buildBaseInlineSourceIndex(graph, full);
    if (!extraNodes || extraNodes.length === 0)
        return baseIdx;
    const extraById = new Map();
    const extraNodeByPointer = new Map();
    for (const n of extraNodes) {
        if (!baseIdx.byId.has(n.id) && !extraById.has(n.id))
            extraById.set(n.id, n);
        const ptr = n.kind === "file" ? n.path : `${n.path}:${n.span}`;
        if (!baseIdx.nodeByPointer.has(ptr) && !extraNodeByPointer.has(ptr))
            extraNodeByPointer.set(ptr, n);
    }
    return {
        ...baseIdx,
        nodeByPointer: createLayeredMapView(baseIdx.nodeByPointer, extraNodeByPointer),
        byId: createLayeredMapView(baseIdx.byId, extraById),
    };
}
function getFileConstantsList(path, lines, constsByPath) {
    if (constsByPath.has(path))
        return constsByPath.get(path);
    const list = [];
    if (lines) {
        for (let idx = 0; idx < lines.length; idx++) {
            const raw = lines[idx];
            const m = /^\s*(?:export\s+)?(?:local|const|let|var|pub\s+const|static)\s+([A-Z][A-Z0-9_]{2,})\b.*=/.exec(raw);
            if (m)
                list.push({ name: m[1], lineNo: idx + 1, text: raw });
        }
    }
    constsByPath.set(path, list);
    return list;
}
function prependMatchingFileConstants(code, lines, path, effStart, effEnd, constsByPath, qTerms, qStems) {
    const fileConsts = getFileConstantsList(path, lines, constsByPath);
    const spanSliceText = lines.slice(Math.max(0, effStart - 1), Math.min(lines.length, effEnd)).join("\n");
    const prepended = [];
    for (const c of fileConsts) {
        if (code.includes(`L${c.lineNo}:`))
            continue;
        const re = new RegExp(`\\b${c.name}\\b`);
        const inExcerpt = re.test(code);
        const inSpanAndImportant = !inExcerpt &&
            re.test(spanSliceText) &&
            (/(?:LIMIT|MAX|MIN|PASS|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD|SYMBOL)/.test(c.name) ||
                tokenize(c.name).some((t) => qTerms.has(t) || qStems.has(stemToken(t))));
        if (inExcerpt || inSpanAndImportant)
            prepended.push(`L${c.lineNo}: ${c.text}`);
    }
    return prepended.length > 0 ? `${prepended.join("\n")}\n${code}` : code;
}
function collectCallersIntoQueue(callerIds, activeCallers, seenRel, byId, maxLen, viaNode, acceptCaller) {
    for (const sid of callerIds ?? []) {
        if (seenRel.has(sid) || activeCallers.length >= maxLen)
            continue;
        const sn = byId.get(sid);
        if (!sn || isTestPath(sn.path) || !acceptCaller(sn))
            continue;
        seenRel.add(sid);
        activeCallers.push({ caller: sn, via: viaNode });
    }
}

function expandTransitiveCallSiteCallers(node, activeCallers, seenRel, outCallsById, inCallsById, byId) {
    const outCallees = (outCallsById.get(node.id) ?? []).map((tid) => byId.get(tid)).filter((tn) => tn && tn.kind !== "file" && tn.name === node.name);
    for (const callee of outCallees)
        collectCallersIntoQueue(inCallsById.get(callee.id), activeCallers, seenRel, byId, 14, null, (sn) => sn.kind !== "file");
    for (const { caller } of [...activeCallers]) {
        if (caller.kind !== "file")
            collectCallersIntoQueue(inCallsById.get(caller.id), activeCallers, seenRel, byId, 16, caller, () => true);
    }
    for (const { caller, via } of [...activeCallers]) {
        const cr = via && caller.kind !== "file" ? spanRange(caller.span) : null;
        if (cr && cr.end - cr.start <= 20)
            collectCallersIntoQueue(inCallsById.get(caller.id), activeCallers, seenRel, byId, 22, caller, () => true);
    }
    for (const { caller, via } of [...activeCallers]) {
        const cr = via && caller.kind !== "file" && !caller.exported ? spanRange(caller.span) : null;
        if (cr && cr.end - cr.start <= 30)
            collectCallersIntoQueue(inCallsById.get(caller.id), activeCallers, seenRel, byId, 22, caller, (sn) => sn.path === caller.path);
    }
}

function collectCallerSpansByPath(activeCallers) {
    const callerSpansByPath = new Map();
    for (const { caller } of activeCallers) {
        if (caller.kind === "file")
            continue;
        const sr = spanRange(caller.span);
        if (sr)
            pushMap(callerSpansByPath, caller.path, sr);
    }
    return callerSpansByPath;
}

function buildCallSiteExcludeRanges(node, caller, via, targetSpan, callerSpansByPath) {
    const excludeRanges = [];
    if (caller.path === node.path && targetSpan && caller.id !== node.id)
        excludeRanges.push(targetSpan);
    if (via && caller.path === via.path && caller.id !== via.id) {
        const vr = spanRange(via.span);
        if (vr)
            excludeRanges.push(vr);
    }
    const cRange = spanRange(caller.span);
    const cLen = cRange ? cRange.end - cRange.start : 0;
    for (const sr of callerSpansByPath.get(caller.path) ?? []) {
        if (caller.kind === "file" || (cRange && sr.start >= cRange.start && sr.end <= cRange.end && sr.end - sr.start < cLen))
            excludeRanges.push(sr);
    }
    return { excludeRanges, cLen };
}

function appendCallerCallSiteQuotes(caller, via, needles, excludeRanges, cLen, readLines, callSites) {
    const quotes = referenceLines(caller.path, caller.span, needles, readLines, {
        excludeRanges,
        maxMatches: caller.kind === "file" ? 4 : cLen > 120 ? 6 : 2,
        includeHeaderContext: cLen > 120,
    }).filter((q) => {
        const trimmed = q.text.trim();
        return !trimmed.startsWith("--") && !trimmed.startsWith("//") && !trimmed.startsWith("*");
    });
    const viaTag = via ? ` [via ${via.name}]` : "";
    const callerLabel = caller.kind === "file" ? `${caller.path} (module)` : `${caller.name} (${caller.path}:${caller.span})`;
    if (quotes.length === 0) {
        if (caller.kind !== "file")
            callSites.push(`${callerLabel}${viaTag}`);
        return;
    }
    for (const q of quotes) {
        const txt = q.text.trim();
        const hdr = q.header && q.header.n !== q.n ? ` [in L${q.header.n}: ${q.header.text.trim().slice(0, 48)}]` : "";
        callSites.push(`${callerLabel}${viaTag}${hdr} → L${q.n}: ${txt.length > 110 ? `${txt.slice(0, 107)}…` : txt}`);
    }
}

function collectHitCallSiteQuotes(node, activeCallers, readLines, wantsCallSites, isMultiQuery) {
    const targetNeedles = needlesForName(node.name);
    const targetSpan = spanRange(node.span);
    const maxQuotesTotal = wantsCallSites ? 26 : (isMultiQuery ? 3 : 5);
    const callerSpansByPath = collectCallerSpansByPath(activeCallers);
    const callSites = [];
    for (const { caller, via } of activeCallers.slice(0, maxQuotesTotal)) {
        const needles = via ? [...needlesForName(via.name), ...targetNeedles] : targetNeedles;
        const { excludeRanges, cLen } = buildCallSiteExcludeRanges(node, caller, via, targetSpan, callerSpansByPath);
        appendCallerCallSiteQuotes(caller, via, needles, excludeRanges, cLen, readLines, callSites);
        if (callSites.length >= maxQuotesTotal)
            break;
    }
    return callSites;
}

function collectHitOutCalleeRelations(node, outCallsById, byId, seenRel, rel, maxOutRel) {
    for (const tid of outCallsById.get(node.id) ?? []) {
        if (rel.length >= maxOutRel || seenRel.has(tid))
            continue;
        const tn = byId.get(tid);
        if (!tn || tn.kind === "file")
            continue;
        seenRel.add(tid);
        rel.push(`→ ${tn.name} (${tn.path}:${tn.span})`);
    }
}

function collectHitInCallerRelations(node, inCallsById, byId, seenRel, rel, maxTotalRel) {
    const directCallerNodes = [];
    for (const sid of inCallsById.get(node.id) ?? []) {
        if (seenRel.has(sid))
            continue;
        const sn = byId.get(sid);
        if (!sn)
            continue;
        seenRel.add(sid);
        if (isTestPath(sn.path))
            continue;
        directCallerNodes.push({ caller: sn, via: null });
        if (sn.kind !== "file" && rel.length < maxTotalRel)
            rel.push(`← ${sn.name} (${sn.path}:${sn.span})`);
    }
    return directCallerNodes;
}

function populateHitRelationsAndCallSites(h, hitIdx, node, srcIdx, readLines, wantsCallSites, isMultiQuery) {
    const { outCallsById, inCallsById, byId } = srcIdx;
    const rel = [];
    const seenRel = new Set([node.id]);
    const maxOutRel = hitIdx === 0 ? 4 : 2;
    const maxTotalRel = hitIdx === 0 ? 8 : hitIdx === 1 ? 4 : 2;
    collectHitOutCalleeRelations(node, outCallsById, byId, seenRel, rel, maxOutRel);
    const directCallerNodes = collectHitInCallerRelations(node, inCallsById, byId, seenRel, rel, maxTotalRel);
    if (rel.length > 0)
        h.related = rel;
    const activeCallers = wantsCallSites ? directCallerNodes : directCallerNodes.filter((c) => c.caller.kind !== "file");
    if (hitIdx !== 0 || activeCallers.length === 0 || activeCallers.length > 20)
        return;
    if (wantsCallSites && activeCallers.length <= 12)
        expandTransitiveCallSiteCallers(node, activeCallers, seenRel, outCallsById, inCallsById, byId);
    const callSites = collectHitCallSiteQuotes(node, activeCallers, readLines, wantsCallSites, isMultiQuery);
    if (callSites.length > 0) {
        h.callSites = callSites;
        if (wantsCallSites)
            h.wantsCallSites = true;
    }
}

function expandToEnclosingShortFunction(h, node, s, nodesByPath, spanLen) {
    if (spanLen > 14 || node?.kind !== "function")
        return { s, spanLen };
    const enclosing = (nodesByPath.get(s.path) ?? []).find((pn) => {
        if (pn.id === node.id || (pn.kind !== "function" && pn.kind !== "method"))
            return false;
        const ps = parseSpan(`${pn.path}:${pn.span}`);
        const pLen = ps ? ps.end - ps.start + 1 : 0;
        return Boolean(ps && ps.start <= s.start && ps.end >= s.end && pLen > spanLen && pLen <= 60);
    });
    const ps = enclosing ? parseSpan(`${enclosing.path}:${enclosing.span}`) : null;
    if (!ps || !enclosing)
        return { s, spanLen };
    h.pointer = `${enclosing.path}:${enclosing.span}`;
    h.title = `${enclosing.name} · ${enclosing.kind}`;
    return { s: ps, spanLen: ps.end - ps.start + 1 };
}

function resolveEditEnvelopePrimarySpan(h, node, rawSpan, lines, nodesByPath, editEnvelope) {
    let s = rawSpan;
    let spanLen = s.end - s.start + 1;
    if (editEnvelope && lines)
        ({ s, spanLen } = expandToEnclosingShortFunction(h, node, s, nodesByPath, spanLen));
    const effStart = lines && spanLen <= 6 ? Math.max(1, s.start - 3) : (editEnvelope && s.start <= 25 && s.end <= 52 ? 1 : s.start);
    let effEnd = lines && spanLen <= 6 ? Math.min(lines.length, s.end + 3) : s.end;
    if (editEnvelope && lines && spanLen <= 48) {
        const nextTiny = (nodesByPath.get(s.path) ?? []).find((nn) => {
            if (nn.id === node?.id || nn.kind === "file")
                return false;
            const ns = parseSpan(`${nn.path}:${nn.span}`);
            return Boolean(ns && ns.start >= s.end + 1 && ns.start <= s.end + 3 && ns.end - ns.start + 1 <= 10 && ns.end - effStart + 1 <= 54);
        });
        const ns = nextTiny ? parseSpan(`${nextTiny.path}:${nextTiny.span}`) : null;
        if (ns)
            effEnd = ns.end;
    }
    return { s, spanLen, effStart, effEnd };
}
function recordInlinedCode(defaultPath, code, inlinedLinesByPath) {
    if (!code)
        return;
    let curPath = defaultPath;
    for (const line of code.split("\n")) {
        const hdr = /^\/\/ (?:same-file helper|cross-file callee|exported type): .+ \(([^():]+):L\d+/.exec(line) ??
            /^\/\/ module (?:context|return) \(([^():]+)(?::L\d+[^)]*)?\):/.exec(line);
        if (hdr?.[1]) {
            curPath = hdr[1];
            continue;
        }
        const lm = /^L(\d+):/.exec(line);
        if (lm && curPath) {
            let set = inlinedLinesByPath.get(curPath);
            if (!set) {
                set = new Set();
                inlinedLinesByPath.set(curPath, set);
            }
            set.add(Number(lm[1]));
        }
    }
}
function isSpanFullyInlined(path, start, end, inlinedLinesByPath) {
    if (!path || end <= start)
        return false;
    const set = inlinedLinesByPath.get(path);
    if (!set || set.size < end - start + 1)
        return false;
    for (let ln = start; ln <= end; ln++) {
        if (!set.has(ln))
            return false;
    }
    return true;
}
function dedupeSubsequentInlinedHits(hits, afterHitRef, inlinedLinesByPath, state) {
    const startIdx = hits.indexOf(afterHitRef);
    if (startIdx < 0)
        return;
    for (let j = startIdx + 1; j < hits.length; j++) {
        const hj = hits[j];
        if (!hj?.code)
            continue;
        const sp = parseSpan(hj.pointer);
        if (sp && isSpanFullyInlined(sp.path, sp.start, sp.end, inlinedLinesByPath)) {
            state.totalInlinedBytes = Math.max(0, state.totalInlinedBytes - Buffer.byteLength(hj.code, "utf8"));
            delete hj.code;
        }
    }
}
function tryCommitCruxHit(h, cruxByPointer, shownPointers, state) {
    const crux = cruxByPointer.get(h.pointer);
    if (!crux)
        return false;
    const cruxCode = `${crux}\n… (excerpt — full definition at ${h.pointer}; rerun with --full)`;
    const cBytes = Buffer.byteLength(cruxCode, "utf8");
    if (!state.full && state.inlinedHitCount > 0 && state.totalInlinedBytes + cBytes > state.maxTotalBytes)
        return true;
    h.code = cruxCode;
    state.totalInlinedBytes += cBytes;
    shownPointers.add(h.pointer);
    state.inlinedHitCount++;
    return true;
}

function shouldSkipPrimarySpanInlining(node, hitIdx, h, spanLen, qTerms, wantsCallSites, isMultiQuery, state) {
    const { maxHitsToInline, inlinedHitCount } = state;
    if (node?.kind === "type" && spanLen > 24 && !qTerms.has("type") && !qTerms.has((node.name ?? "").toLowerCase()))
        return true;
    if (isMultiQuery && wantsCallSites && spanLen > 300 && node?.kind !== "file")
        return true;
    if (isMultiQuery && hitIdx > 0 && (h.score ?? 0) < (wantsCallSites && maxHitsToInline >= 2 ? 0.45 : 0.86))
        return true;
    return inlinedHitCount > 0 && ((wantsCallSites && node?.kind === "file") || (spanLen > 500 && node?.kind !== "file") || (node?.kind === "type" && spanLen > 20));
}

function computePrimaryHitMaxContiguous(isTopOrAfterTiny, editEnvelope, effSpanLen, isSubQuerySecondary, isDominantTop, isMultiQuery) {
    if (!isTopOrAfterTiny)
        return editEnvelope ? (effSpanLen <= 42 ? 42 : 34) : MAX_CONTIGUOUS_SECONDARY_LINES;
    if (editEnvelope)
        return effSpanLen <= 56 ? 56 : (isMultiQuery ? 44 : 52);
    if (isSubQuerySecondary)
        return 30;
    if (isDominantTop)
        return 80;
    return isMultiQuery ? 60 : MAX_CONTIGUOUS_TOP_LINES;
}

function computePrimaryHitMaxCrux(node, spanLen, editEnvelope, isSubQuerySecondary, isMultiQuery, inlinedHitCount) {
    if (node?.kind === "file")
        return spanLen > 200 ? 22 : 16;
    if (inlinedHitCount !== 0)
        return 18;
    if (editEnvelope)
        return 26;
    if (isSubQuerySecondary)
        return 16;
    return isMultiQuery ? 28 : MAX_CRUX_LINES;
}

function buildPrimaryHitRenderParams(hits, node, spanLen, effSpanLen, state) {
    const { opts, isMultiQuery, editEnvelope, inlinedHitCount, totalInlinedBytes } = state;
    const isSubQuerySecondary = isMultiQuery && (opts.subQueryIndex ?? 0) > 0;
    const isDominantTop = !isSubQuerySecondary && inlinedHitCount === 0 &&
        (hits.length === 1 || (hits[0]?.score ?? 0) >= 1.15 * (hits[1]?.score ?? 0) || opts.maxHitsToInline === 1);
    const isTopOrAfterTiny = inlinedHitCount === 0 || (editEnvelope && totalInlinedBytes < 500);
    return {
        isTopOrAfterTiny,
        maxSpan: inlinedHitCount < 2 ? MAX_SPAN_LINES : 40,
        maxContiguous: computePrimaryHitMaxContiguous(isTopOrAfterTiny, editEnvelope, effSpanLen, isSubQuerySecondary, isDominantTop, isMultiQuery),
        maxCrux: computePrimaryHitMaxCrux(node, spanLen, editEnvelope, isSubQuerySecondary, isMultiQuery, inlinedHitCount),
    };
}

function fitPrimaryCodeWithinBudget(code, lines, s, effStart, effEnd, hitQTerms, isTopOrAfterTiny, state) {
    const { full, editEnvelope, isMultiQuery, maxHitsToInline, maxTotalBytes, qStems } = state;
    const effSpanLen = effEnd - effStart + 1;
    const helperReserve = state.inlinedHitCount > 0
        ? (editEnvelope && effSpanLen <= 42 ? 0 : (isMultiQuery && maxHitsToInline >= 2 && state.inlinedHitCount === 1 ? 250 : Math.min(950, Math.floor(maxTotalBytes * 0.28))))
        : 0;
    const effectiveBudget = isTopOrAfterTiny && editEnvelope && effSpanLen <= 52 ? Math.max(maxTotalBytes, 2550) : maxTotalBytes - helperReserve;
    if ((state.inlinedHitCount === 0 && !isMultiQuery) || state.totalInlinedBytes + Buffer.byteLength(code, "utf8") <= effectiveBudget)
        return code;
    let shrunk = code;
    if (state.inlinedHitCount === 0)
        shrunk = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, 34, null, 20, state.qExactCode, state.qLiterals);
    else if (!full)
        shrunk = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, editEnvelope ? 26 : 16, null, editEnvelope ? 18 : 12, state.qExactCode, state.qLiterals);
    if (!shrunk || (state.inlinedHitCount > 0 && state.totalInlinedBytes + Buffer.byteLength(shrunk, "utf8") > effectiveBudget))
        return null;
    return shrunk;
}

function collectPrimaryHitQTerms(hits, filePath, baseQTerms) {
    const hitQTerms = new Set(baseQTerms);
    for (const oh of hits.slice(0, 6)) {
        if (!oh.pointer.startsWith(`${filePath}:`))
            continue;
        for (const t of tokenize(oh.title.split(" · ")[0] ?? ""))
            hitQTerms.add(t);
    }
    return hitQTerms;
}

function inlinePrimaryHitSpan(h, hitIdx, hits, state) {
    const { srcIdx, readLines, shownPointers, constsByPath, qTerms, qStems, full, isMultiQuery, editEnvelope, wantsCallSites, maxHitsToInline, maxTotalBytes, primaryMeta, deferredFourthHits } = state;
    const { cruxByPointer, fileSpanByPath, nodeByPointer, nodesByPath } = srcIdx;
    const node = nodeByPointer.get(h.pointer);
    if (node && node.kind !== "file" && !h.related)
        populateHitRelationsAndCallSites(h, hitIdx, node, srcIdx, readLines, wantsCallSites, isMultiQuery);
    if (shownPointers.has(h.pointer)) {
        if (hitIdx === 0)
            state.inlinedHitCount++;
        return;
    }
    const effectiveMaxHits = node?.kind === "file" && !wantsCallSites ? maxHitsToInline + 1 : maxHitsToInline;
    if (state.inlinedHitCount >= effectiveMaxHits || state.totalInlinedBytes >= maxTotalBytes)
        return;
    const rawSpan = parseSpan(h.pointer) ?? (fileSpanByPath.has(h.pointer) ? parseSpan(`${h.pointer}:${fileSpanByPath.get(h.pointer)}`) : null);
    if (!rawSpan || tryCommitCruxHit(h, cruxByPointer, shownPointers, state))
        return;
    const lines = readLines(rawSpan.path);
    const { s, spanLen, effStart, effEnd } = resolveEditEnvelopePrimarySpan(h, node, rawSpan, lines, nodesByPath, editEnvelope);
    if (isSpanFullyInlined(s.path, s.start, s.end, state.inlinedLinesByPath) || shouldSkipPrimarySpanInlining(node, hitIdx, h, spanLen, qTerms, wantsCallSites, isMultiQuery, state))
        return;
    const params = buildPrimaryHitRenderParams(hits, node, spanLen, effEnd - effStart + 1, state);
    const hitQTerms = collectPrimaryHitQTerms(hits, s.path, qTerms);
    let code = full
        ? sliceSpan(lines, s.path, effStart, effEnd, params.maxSpan)
        : synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, params.maxContiguous, null, params.maxCrux, state.qExactCode, state.qLiterals);
    if (!code)
        return;
    if (!full && lines && spanLen <= 3 && lines.length > 15) {
        const fileCrux = synthesizeCrux(lines, s.path, 1, lines.length, hitQTerms, qStems, 18, null, MAX_CRUX_LINES, state.qExactCode, state.qLiterals);
        if (fileCrux && fileCrux !== code)
            code = `${code}\n// module context (${s.path}):\n${fileCrux}`;
    }
    if (lines)
        code = prependMatchingFileConstants(code, lines, s.path, effStart, effEnd, constsByPath, qTerms, qStems);
    if (state.inlinedHitCount >= 3) {
        deferredFourthHits.push({ h, code });
        state.inlinedHitCount++;
        return;
    }
    code = fitPrimaryCodeWithinBudget(code, lines, s, effStart, effEnd, hitQTerms, params.isTopOrAfterTiny, state);
    if (!code)
        return;
    h.code = code;
    recordInlinedCode(s.path, code, state.inlinedLinesByPath);
    shownPointers.add(h.pointer);
    state.totalInlinedBytes += Buffer.byteLength(code, "utf8");
    primaryMeta.set(state.inlinedHitCount, { h, node, s, lines, spanLen, effStart, effEnd, maxContiguous: params.maxContiguous, hitQTerms });
    state.inlinedHitCount++;
}
function addGraphHelperNeighbours(fromId, hop, allowCallers, viaTinyCallee, node, sPath, srcIdx, shownPointers, sameFileCands) {
    const { outCallsById, inCallsById, byId } = srcIdx;
    const outIds = outCallsById.get(fromId) ?? [];
    const inIds = allowCallers ? (inCallsById.get(fromId) ?? []) : [];
    for (const nid of [...outIds, ...inIds]) {
        if (nid === node.id || sameFileCands.has(nid))
            continue;
        const nn = byId.get(nid);
        if (!nn || nn.kind === "file")
            continue;
        const isSameFile = nn.path === sPath;
        if (!isSameFile && !outIds.includes(nid))
            continue;
        const ptr = `${nn.path}:${nn.span}`;
        if (shownPointers.has(ptr))
            continue;
        const isCallee = outIds.includes(nid);
        sameFileCands.set(nid, { node: nn, ptr, hop, isSameFile, isCallee, viaTinyCallee: viaTinyCallee && isCallee, fromGraph: true });
    }
}
function ensureNodeHelperMatcher(nn) {
    if (nn._helperMatcher !== undefined)
        return nn._helperMatcher;
    const rawName = nn.name ?? "";
    const escaped = rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let matcher = null;
    if (escaped) {
        const rawBare = rawName.split(/[.:]/).pop() ?? "";
        const bareEscaped = rawBare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const needle = rawBare.length > 0 ? rawBare : rawName;
        matcher = {
            needle,
            directRe: new RegExp(`\\b${escaped}\\s*\\(`),
            bareRe: bareEscaped && bareEscaped.length >= 4 && bareEscaped !== escaped
                ? new RegExp(`[:.]${bareEscaped}\\s*\\(`)
                : null,
            dottedRe: rawName.includes(".") ? new RegExp(`\\b${escaped}\\b`) : null,
        };
    }
    Object.defineProperty(nn, "_helperMatcher", {
        value: matcher,
        enumerable: false,
        configurable: true,
        writable: true,
    });
    return matcher;
}

function ensureNodeNameTokenPairs(nn) {
    if (nn._nameTokPairs !== undefined)
        return nn._nameTokPairs;
    const pairs = [];
    for (const t of new Set(tokenize(nn.name))) {
        const st = stemToken(t);
        pairs.push([t, st.length >= 4 ? st : ""]);
    }
    Object.defineProperty(nn, "_nameTokPairs", {
        value: pairs,
        enumerable: false,
        configurable: true,
        writable: true,
    });
    return pairs;
}

function countNodeNameTokenMatches(nn, qTerms, qStems) {
    let count = 0;
    for (const [t, st] of ensureNodeNameTokenPairs(nn)) {
        if (qTerms.has(t) || (st && qStems.has(st)))
            count++;
    }
    return count;
}

function scanTextHelperCalls(lines, sPath, nodeId, startLine, endLine, hop, viaTinyCallee, nodesByPath, shownPointers, sameFileCands) {
    const text = lines
        .slice(Math.max(0, startLine - 1), Math.min(lines.length, endLine))
        .map((l) => l.replace(/(?:--|\s\/\/|\/\/).*$/, ""))
        .join("\n");
    for (const nn of nodesByPath.get(sPath) ?? []) {
        if (nn.id === nodeId || nn.kind === "file")
            continue;
        const existing = sameFileCands.get(nn.id);
        if (existing?.fromGraph)
            continue;
        const matcher = ensureNodeHelperMatcher(nn);
        if (!matcher || !text.includes(matcher.needle))
            continue;
        const ptr = `${nn.path}:${nn.span}`;
        if (shownPointers.has(ptr))
            continue;
        const isDirectCall = matcher.directRe.test(text) || Boolean(matcher.bareRe && matcher.bareRe.test(text));
        const isDottedIdent = Boolean(matcher.dottedRe && matcher.dottedRe.test(text));
        if (isDirectCall || isDottedIdent) {
            sameFileCands.set(nn.id, {
                node: nn,
                ptr,
                hop: existing?.fromGraph ? Math.min(existing.hop, hop) : hop,
                isSameFile: true,
                isCallee: true,
                viaTinyCallee: Boolean(existing?.viaTinyCallee || viaTinyCallee),
                fromGraph: true,
            });
        }
    }
}
const GENERIC_HELPER_VERB_TOKENS = new Set(["format", "get", "set", "run", "read", "write"]);

function countHelperTokenMatches(text, qTerms, qStems) {
    let count = 0;
    for (const t of new Set(tokenize(text))) {
        if (qTerms.has(t) || (stemToken(t).length >= 4 && qStems.has(stemToken(t))))
            count++;
    }
    return count;
}

function detectTypeConstructedOrMemberHelper(nn, node, ptr, lines, typeBodyToks, structLitRe) {
    let constructsTypeLit = false;
    if (structLitRe && (nn.kind === "function" || nn.kind === "method")) {
        const ns = parseSpan(ptr);
        if (ns && ns.end - ns.start <= 36) {
            const fnBody = lines.slice(Math.max(0, ns.start - 1), Math.min(lines.length, ns.end)).join("\n");
            constructsTypeLit = structLitRe.test(fnBody);
        }
    }
    const isMemberName = Boolean(typeBodyToks && (typeBodyToks.has(nn.name.toLowerCase()) || /^(?:new|create)$/.test(nn.name)));
    const hasNodeSig = Boolean(node.name && nn.signature && nn.signature.includes(node.name));
    const isTypeMemberOrCtor = Boolean((nn.kind === "function" || nn.kind === "method") && (constructsTypeLit || isMemberName || hasNodeSig));
    return { constructsTypeLit, isTypeMemberOrCtor };
}

function addLexicalFallbackSameFileCands(meta, nodesByPath, shownPointers, qTerms, qStems, sameFileCands) {
    const { node, s, lines } = meta;
    const isTypeNode = node.kind === "type" || node.kind === "interface" || node.kind === "struct";
    const hadGraphCands = sameFileCands.size > 0;
    const typeBodyToks = isTypeNode ? new Set(tokenize(lines.slice(Math.max(0, s.start - 1), Math.min(lines.length, s.end)).join(" "))) : null;
    const structLitRe = isTypeNode && node.name && node.name.length >= 4
        ? new RegExp(`\\b${node.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{`)
        : null;
    for (const nn of nodesByPath.get(s.path) ?? []) {
        if (nn.id === node.id || sameFileCands.has(nn.id))
            continue;
        const ptr = `${nn.path}:${nn.span}`;
        if (shownPointers.has(ptr))
            continue;
        const nameMatch = countNodeNameTokenMatches(nn, qTerms, qStems);
        if (hadGraphCands && !isTypeNode && nameMatch === 0)
            continue;
        const m = !hadGraphCands || isTypeNode
            ? countHelperTokenMatches(`${nn.name} ${nn.signature ?? ""} ${nn.summary ?? ""}`, qTerms, qStems)
            : nameMatch;
        const { constructsTypeLit, isTypeMemberOrCtor } = isTypeNode
            ? detectTypeConstructedOrMemberHelper(nn, node, ptr, lines, typeBodyToks, structLitRe)
            : { constructsTypeLit: false, isTypeMemberOrCtor: false };
        if (m >= 1 || isTypeMemberOrCtor) {
            sameFileCands.set(nn.id, { node: nn, ptr, hop: 1, isSameFile: true, isCallee: !hadGraphCands || isTypeMemberOrCtor, viaTinyCallee: isTypeMemberOrCtor, constructsTypeLit, fromGraph: isTypeMemberOrCtor });
        }
    }
}

function expandSecondHopSameFileHelpers(meta, srcIdx, shownPointers, sameFileCands) {
    const { node, s, lines, spanLen } = meta;
    const { nodesByPath } = srcIdx;
    for (const [nid, cand] of [...sameFileCands]) {
        if (!cand.isSameFile)
            continue;
        const cs = parseSpan(`${cand.node.path}:${cand.node.span}`);
        const cLen = cs ? cs.end - cs.start + 1 : 999;
        const isNested = Boolean(cs && cs.start >= s.start && cs.end <= s.end);
        if (cand.hop !== 1 || (!isNested && (!cand.isCallee || !cand.fromGraph)))
            continue;
        const nextHop = isNested || (cLen <= 16 && spanLen <= 20) ? 1 : 2;
        const isViaTiny = isNested || cLen <= 16;
        addGraphHelperNeighbours(nid, nextHop, isNested || cLen <= 16, isViaTiny, node, s.path, srcIdx, shownPointers, sameFileCands);
        if (cs && cLen <= 90)
            scanTextHelperCalls(lines, s.path, node.id, cs.start, cs.end, nextHop, isViaTiny, nodesByPath, shownPointers, sameFileCands);
    }
}

function collectSameFileCandidatesForHit(meta, hitIdx, srcIdx, shownPointers, qTerms, qStems, wantsCallSites = false) {
    const { node, s, lines, spanLen } = meta;
    const { nodesByPath } = srcIdx;
    const sameFileCands = new Map();
    const allowCallers = wantsCallSites ? spanLen <= 35 : spanLen <= 55;
    addGraphHelperNeighbours(node.id, 1, allowCallers, false, node, s.path, srcIdx, shownPointers, sameFileCands);
    scanTextHelperCalls(lines, s.path, node.id, s.start, s.end, 1, false, nodesByPath, shownPointers, sameFileCands);
    if (sameFileCands.size === 0 || node.kind === "type" || node.kind === "interface" || node.kind === "struct" || hitIdx === 0)
        addLexicalFallbackSameFileCands(meta, nodesByPath, shownPointers, qTerms, qStems, sameFileCands);
    if (hitIdx <= 2)
        expandSecondHopSameFileHelpers(meta, srcIdx, shownPointers, sameFileCands);
    return sameFileCands;
}

function scoreSameFileHelperBonuses(cand, node, hSpanLen, spanLen) {
    let bonus = 2.0;
    if (cand.fromGraph) {
        bonus += cand.hop === 1 ? 8.5 : 4.5;
        if (cand.isCallee && cand.hop === 1)
            bonus += 4.5;
        if (!cand.isCallee && cand.hop === 1 && hSpanLen >= 18 && hSpanLen <= 90)
            bonus += 4.5;
        if (!cand.isCallee && cand.hop === 1 && cand.node.exported && !node.exported)
            bonus += 8.0;
        if (cand.viaTinyCallee && cand.isCallee && hSpanLen <= 32 && spanLen <= 20)
            bonus += 14.0;
    }
    if (cand.constructsTypeLit)
        bonus += 12.0;
    if (!cand.fromGraph && Boolean(cand.node.exported) && node.exported && hSpanLen >= 10 && hSpanLen <= 55) {
        const nodeToks = new Set(tokenize(node.name).filter((t) => !GENERIC_HELPER_VERB_TOKENS.has(t)));
        const sharesNameTok = nodeToks.size > 0 && tokenize(cand.node.name).some((t) => nodeToks.has(t));
        bonus += sharesNameTok ? 18.0 : -6.0;
    }
    else if (!cand.fromGraph && hSpanLen > 18) {
        bonus -= 12.0;
    }
    return bonus;
}

function scoreHelperNameAndSummaryBonuses(cand, node, sPath, hSpanLen, qTerms, qStems) {
    let bonus = 0;
    const eligibleNameBonus = (cand.isSameFile || cand.node.name.length >= 4 || (cand.isCallee && hSpanLen <= 12)) &&
        cand.fromGraph && cand.isCallee && cand.hop === 1;
    if (eligibleNameBonus) {
        const fileStem = basename(sPath).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
        for (const nTok of new Set(tokenize(`${cand.node.owner ?? ""} ${cand.node.name}`))) {
            if (cand.isSameFile && nTok === fileStem)
                continue;
            if (qTerms.has(nTok))
                bonus += 8;
            else if (stemToken(nTok).length >= 4 && qStems.has(stemToken(nTok)))
                bonus += 6;
        }
    }
    if (!cand.isSameFile && cand.isCallee && hSpanLen <= 12 && cand.node.summary) {
        for (const sTok of new Set(tokenize(cand.node.summary))) {
            if (qTerms.has(sTok) || (stemToken(sTok).length >= 4 && qStems.has(stemToken(sTok))))
                bonus += 2.5;
        }
    }
    return bonus;
}

function ensureHelperBodyTokenData(cand, candLines, cs) {
    let cache = candLines._helperTokBySpan;
    if (!cache) {
        cache = new Map();
        Object.defineProperty(candLines, "_helperTokBySpan", { value: cache, enumerable: false, configurable: true, writable: true });
    }
    const key = `${cand.node.id}:${cs.start}:${cs.end}`;
    let entry = cache.get(key);
    if (entry)
        return entry;
    const bodySlice = candLines.slice(Math.max(0, cs.start - 1), Math.min(candLines.length, cs.end)).join(" ");
    const hasGuardConst = /\b(?:[A-Z0-9_]*(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)[A-Z0-9_]*)\b/.test(bodySlice);
    const helperText = `${cand.node.owner ?? ""} ${cand.node.name} ${cand.node.summary ?? ""} ${bodySlice}`;
    const pairs = [];
    for (const tok of new Set(tokenize(helperText))) {
        const st = stemToken(tok);
        pairs.push([tok, st.length >= 4 ? st : ""]);
    }
    entry = { hasGuardConst, pairs };
    cache.set(key, entry);
    return entry;
}

function scoreHelperBodyTokens(cand, candLines, cs, hSpanLen, qTerms, qStems) {
    let score = 0;
    let qMatchCount = 0;
    const { hasGuardConst, pairs } = ensureHelperBodyTokenData(cand, candLines, cs);
    if (hasGuardConst)
        score += hSpanLen <= 14 ? 7.5 : 2.5;
    for (const [tok, st] of pairs) {
        if (qTerms.has(tok)) {
            score += 3;
            qMatchCount++;
            continue;
        }
        if (st && qStems.has(st)) {
            score += 2.5;
            qMatchCount++;
        }
    }
    return { score, qMatchCount };
}

function scoreSingleHelperCandidate(cand, meta, candLines, cs, hSpanLen, qTerms, qStems, wantsCallSites = false) {
    const { node, s, spanLen } = meta;
    if (wantsCallSites && !cand.isCallee && hSpanLen < 14 && spanLen > 10)
        return null;
    let hScore = (cand.hop === 1 ? 2 : 0) + (cand.fromGraph ? 3 : 0);
    if (hSpanLen <= 22 && (cand.isCallee || spanLen <= 10))
        hScore += hSpanLen <= 8 ? 5.5 : 2;
    if (cand.isSameFile)
        hScore += scoreSameFileHelperBonuses(cand, node, hSpanLen, spanLen);
    else if (cand.isCallee && cand.hop === 1 && (hSpanLen <= 20 || (cand.node.name === node.name && hSpanLen <= 28)))
        hScore += cand.node.name === node.name ? 11.5 : (hSpanLen <= 12 ? 6.5 : 5.0);
    hScore += scoreHelperNameAndSummaryBonuses(cand, node, s.path, hSpanLen, qTerms, qStems);
    const bodyRes = scoreHelperBodyTokens(cand, candLines, cs, hSpanLen, qTerms, qStems);
    hScore += bodyRes.score;
    const qMatchCount = bodyRes.qMatchCount;
    if (cand.isSameFile && hSpanLen > 52 && (cand.hop !== 1 || (qMatchCount < 2 && !cand.viaTinyCallee && !(cand.fromGraph && cand.isCallee && qMatchCount >= 1))))
        return null;
    if (qMatchCount === 0 && !(cand.fromGraph && cand.isSameFile) && !(cand.isSameFile && (hSpanLen <= 12 || (cand.viaTinyCallee && hSpanLen <= 90))))
        return null;
    return hScore;
}
function evaluateHelperCandidate(cand, meta, readLines, qTerms, qStems, wantsCallSites) {
    const { node, lines, spanLen, effStart, effEnd, maxContiguous } = meta;
    const cs = parseSpan(`${cand.node.path}:${cand.node.span}`);
    if (!cs)
        return null;
    const hSpanLen = cs.end - cs.start + 1;
    const isTypedFactory = (node.kind === "type" || node.kind === "interface") && /^(?:new|create)$/.test(cand.node.name);
    const maxSameFileHelperSpan = isTypedFactory ? 260 : 120;
    if (cand.isSameFile ? hSpanLen > maxSameFileHelperSpan : hSpanLen > 28)
        return null;
    const isNested = Boolean(cand.isSameFile && cs.start > effStart && cs.end <= effEnd);
    if (isNested && spanLen <= maxContiguous)
        return null;
    const candLines = cand.isSameFile ? lines : readLines(cand.node.path);
    if (!candLines)
        return null;
    const hScore = scoreSingleHelperCandidate(cand, meta, candLines, cs, hSpanLen, qTerms, qStems, wantsCallSites);
    return hScore === null ? null : { ...cand, cs, candLines, hSpanLen, hScore };
}
function scoreHelperCandidatesForHit(sameFileCands, meta, readLines, qTerms, qStems, wantsCallSites = false) {
    const scoredHelpers = [];
    for (const cand of sameFileCands.values()) {
        const evaluated = evaluateHelperCandidate(cand, meta, readLines, qTerms, qStems, wantsCallSites);
        if (evaluated)
            scoredHelpers.push(evaluated);
    }
    scoredHelpers.sort((a, b) => b.hScore - a.hScore || a.cs.start - b.cs.start);
    for (const hCand of scoredHelpers.slice(0, 3)) {
        for (const t of tokenize(hCand.node.name))
            meta.hitQTerms.add(t);
    }
    return scoredHelpers;
}
function computeAttachHelperLimits(scoredHelpers, node, hitIdx, spanLen, editEnvelope) {
    const isTinyTypeHit = (node.kind === "struct" || node.kind === "type" || node.kind === "interface") && spanLen <= 12;
    const second = scoredHelpers[1];
    const hasSecondTinySameFileCallee = Boolean(second && second.hSpanLen <= 12 && second.isSameFile && second.fromGraph && (second.hScore ?? 0) >= 16);
    const singleHelperBonus = (scoredHelpers[0]?.hSpanLen >= 40 || (scoredHelpers[0]?.node?.exported && !scoredHelpers[0]?.isCallee)) ? 250 : 0;
    if (!editEnvelope) {
        return {
            maxHelpers: hitIdx === 0 ? 3 : 1,
            maxHelperBytesForHit: hitIdx === 0 ? 2250 : 1150,
            singleHelperBonus,
        };
    }
    if (isTinyTypeHit && hitIdx <= 2)
        return { maxHelpers: 5, maxHelperBytesForHit: 1500, singleHelperBonus };
    const topQualifies = hitIdx <= 1 && spanLen <= 28 && (scoredHelpers[0]?.hScore ?? 0) >= 16 && (scoredHelpers[0]?.hSpanLen ?? 99) <= 28;
    const maxHelpers = topQualifies ? (hasSecondTinySameFileCallee ? 2 : 1) : 0;
    const maxHelperBytesForHit = hitIdx <= 1 ? (hasSecondTinySameFileCallee ? 850 : 600) : 0;
    return { maxHelpers, maxHelperBytesForHit, singleHelperBonus };
}

function canAttachAnotherHelper(hIdx, maxHelpers, editEnvelope, hCand) {
    if (hIdx < maxHelpers)
        return true;
    return hIdx === maxHelpers && !editEnvelope && Boolean(hCand && hCand.hSpanLen <= 12 && hCand.isSameFile && hCand.hScore >= 16);
}

function renderSingleHelperBlock(hCand, hIdx, sStart, hitQTerms, maxHelperBytesForHit, singleHelperBonus, hitHelperBytes, state) {
    const { full, editEnvelope, maxTotalBytes, qStems } = state;
    const hStart = hCand.hSpanLen <= 18 && hCand.isSameFile
        ? Math.max(1, hCand.cs.start - (hCand.node.summary ? Math.min(5, hCand.node.summary.split("\n").length + 1) : 2))
        : hCand.cs.start;
    const hEnd = hCand.isSameFile && sStart > hCand.cs.end && sStart - hCand.cs.end <= 15 ? sStart - 1 : hCand.cs.end;
    const hContig = hCand.constructsTypeLit && hCand.hSpanLen > 16 ? 12 : (hIdx === 0 && hCand.hSpanLen <= 48 ? 48 : 26);
    const hCrux = hCand.constructsTypeLit && hCand.hSpanLen > 16 ? 10 : 22;
    const hCode = full
        ? sliceSpan(hCand.candLines, hCand.node.path, hStart, hEnd, 48)
        : synthesizeCrux(hCand.candLines, hCand.node.path, hStart, hEnd, hitQTerms, qStems, hContig, null, hCrux, state.qExactCode, state.qLiterals);
    if (!hCode)
        return null;
    const label = hCand.isSameFile ? "same-file helper" : "cross-file callee";
    const dispName = hCand.node.owner && !hCand.node.name.includes(".") ? `${hCand.node.owner}.${hCand.node.name}` : hCand.node.name;
    let block = `// ${label}: ${dispName} (${hCand.ptr})\n${hCode}`;
    let bLen = Buffer.byteLength(block, "utf8");
    const effMaxTotal = (full || editEnvelope) && hIdx === 0 ? maxTotalBytes + singleHelperBonus : maxTotalBytes;
    const effMaxHit = hIdx === 0 ? maxHelperBytesForHit + singleHelperBonus : maxHelperBytesForHit;
    if (!full && (state.totalInlinedBytes + bLen > effMaxTotal || hitHelperBytes + bLen > effMaxHit)) {
        const compactH = synthesizeCrux(hCand.candLines, hCand.node.path, hStart, hCand.cs.end, hitQTerms, qStems, 16, null, 16, state.qExactCode, state.qLiterals);
        if (compactH) {
            block = `// ${label}: ${dispName} (${hCand.ptr})\n${compactH}`;
            bLen = Buffer.byteLength(block, "utf8");
        }
    }
    if (state.totalInlinedBytes + bLen > effMaxTotal || hitHelperBytes + bLen > effMaxHit)
        return null;
    return { block, bLen };
}

function combineCodeWithHelperBlocks(baseCode, helperBlocks, attachedSameFileSpans, lines, sPath, constsByPath) {
    const helperJoined = helperBlocks.join("\n\n");
    const helperCodeNoComments = helperJoined.split("\n").map((l) => l.replace(/(?:--|\s\/\/).*$/, "")).join("\n");
    const attachedFullHelperText = attachedSameFileSpans
        .map((sp) => lines.slice(Math.max(0, sp.start - 1), Math.min(lines.length, sp.end)).join("\n"))
        .join("\n");
    const combined = `${baseCode}\n\n${helperJoined}`;
    const fileConsts = getFileConstantsList(sPath, lines, constsByPath);
    const extraConsts = fileConsts
        .filter((c) => !combined.includes(`L${c.lineNo}:`) && (
            new RegExp(`\\b${c.name}\\b`).test(helperCodeNoComments) ||
            (/(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)/.test(c.name) &&
                new RegExp(`\\b${c.name}\\b`).test(attachedFullHelperText))
        ))
        .map((c) => `L${c.lineNo}: ${c.text}`);
    return extraConsts.length > 0 ? `${extraConsts.join("\n")}\n${combined}` : combined;
}

function attachScoredHelpersToHit(meta, hitIdx, scoredHelpers, state) {
    const { h, node, s, lines, spanLen, effStart, effEnd, maxContiguous, hitQTerms } = meta;
    const { full, wantsCallSites, shownPointers, constsByPath, qTerms, qStems } = state;
    const { maxHelpers, maxHelperBytesForHit, singleHelperBonus } = computeAttachHelperLimits(scoredHelpers, node, hitIdx, spanLen, state.editEnvelope);
    let hitHelperBytes = 0;
    const helperBlocks = [];
    const nestedRanges = [];
    const attachedSameFileSpans = [];
    let hIdx = 0;
    for (let sIdx = 0; sIdx < scoredHelpers.length && canAttachAnotherHelper(hIdx, maxHelpers, state.editEnvelope, scoredHelpers[sIdx]); sIdx++) {
        const hCand = scoredHelpers[sIdx];
        if (hCand.hScore < 3.5 || shownPointers.has(hCand.ptr) || isSpanFullyInlined(hCand.node.path, hCand.cs.start, hCand.cs.end, state.inlinedLinesByPath))
            continue;
        if (wantsCallSites && (h.callSites?.length ?? 0) >= 8 && hCand.hop > 1 && hIdx >= 2)
            continue;
        const rendered = renderSingleHelperBlock(hCand, hIdx, s.start, hitQTerms, maxHelperBytesForHit, singleHelperBonus, hitHelperBytes, state);
        if (!rendered)
            continue;
        helperBlocks.push(rendered.block);
        recordInlinedCode(hCand.node.path, rendered.block, state.inlinedLinesByPath);
        shownPointers.add(hCand.ptr);
        (h.helperPointers ??= []).push(hCand.ptr);
        state.totalInlinedBytes += rendered.bLen;
        hitHelperBytes += rendered.bLen;
        hIdx++;
        if (hCand.isSameFile) {
            attachedSameFileSpans.push({ start: hCand.cs.start, end: hCand.cs.end });
            if (hCand.cs.start > effStart && hCand.cs.end <= effEnd)
                nestedRanges.push({ start: hCand.cs.start, end: hCand.cs.end });
        }
    }
    meta.attachedSameFileSpans = attachedSameFileSpans;
    let baseCode = h.code;
    if (nestedRanges.length > 0 && !full) {
        const dedupedParent = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, maxContiguous, nestedRanges);
        if (dedupedParent)
            baseCode = prependMatchingFileConstants(dedupedParent, lines, s.path, effStart, effEnd, constsByPath, qTerms, qStems);
    }
    if (helperBlocks.length > 0)
        h.code = combineCodeWithHelperBlocks(baseCode, helperBlocks, attachedSameFileSpans, lines, s.path, constsByPath);
}

function scoreEnvelopeTypeCandidate(tn, ts, baseFileLower, qTerms, qStems) {
    const typeNameLower = (tn.name ?? "").toLowerCase();
    let tScore = qTerms.has(typeNameLower) ? 10 : 0;
    for (const tk of tokenize(tn.name ?? "")) {
        if (qTerms.has(tk))
            tScore += 4;
        else if (stemToken(tk).length >= 4 && qStems.has(stemToken(tk)))
            tScore += 3;
    }
    if (tScore === 0 && typeNameLower === baseFileLower && ts.end - ts.start + 1 <= 20)
        return 2;
    return tScore;
}
function findBestEnvelopeTypeMatch(fileNodes, node, sPath, shownPointers, qTerms, qStems) {
    let bestType = null;
    let bestTypeScore = 0;
    const baseFileLower = sPath.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "").toLowerCase() ?? "";
    for (const tn of fileNodes) {
        if ((tn.kind !== "type" && tn.kind !== "interface") || tn.id === node.id)
            continue;
        const tPtr = `${tn.path}:${tn.span}`;
        const ts = shownPointers.has(tPtr) ? null : parseSpan(tPtr);
        if (!ts || ts.end - ts.start + 1 > 32)
            continue;
        const tScore = scoreEnvelopeTypeCandidate(tn, ts, baseFileLower, qTerms, qStems);
        if (tScore > bestTypeScore) {
            bestTypeScore = tScore;
            bestType = { tn, tPtr, ts };
        }
    }
    return bestTypeScore >= 2 ? bestType : null;
}

function prependEditEnvelopeBestType(h, hitIdx, node, s, lines, fileNodes, state) {
    if (hitIdx > 1 || node.kind === "struct" || node.kind === "type" || node.kind === "interface")
        return;
    const bestType = findBestEnvelopeTypeMatch(fileNodes, node, s.path, state.shownPointers, state.qTerms, state.qStems);
    if (!bestType)
        return;
    const { tn, tPtr, ts } = bestType;
    const tSlice = sliceSpan(lines, s.path, ts.start, ts.end, 30);
    if (!tSlice || h.code.includes(`L${ts.start}:`))
        return;
    const tBlock = `// exported type: ${tn.name} (${tPtr})\n${tSlice}`;
    const tbLen = Buffer.byteLength(tBlock, "utf8");
    const limit = state.full ? state.maxTotalBytes + 350 : state.maxTotalBytes;
    if (state.totalInlinedBytes + tbLen <= limit) {
        state.shownPointers.add(tPtr);
        h.code = `${tBlock}\n\n${h.code}`;
        state.totalInlinedBytes += tbLen;
    }
}

function findModuleReturnLineIdx(lines, tailStart) {
    let retLineIdx = -1;
    for (let idx = lines.length - 1; idx >= tailStart - 1; idx--) {
        const rawLine = lines[idx] ?? "";
        const t = rawLine.trim();
        if (t === "return {" || (!/^\s/.test(rawLine) && /^(?:return\b|module\.exports\b|export\s+(?:default\b|\{))/.test(t))) {
            retLineIdx = idx + 1;
            if (t === "return {" || t.endsWith("{"))
                break;
        }
    }
    return retLineIdx;
}

function resolveModuleReturnEnvStart(lines, fileNodes, retLineIdx) {
    let envStart = retLineIdx > 0 ? retLineIdx : Math.max(1, lines.length - 18);
    const sortedEndFns = [...fileNodes]
        .map((fn) => (fn.kind !== "file" ? parseSpan(`${fn.path}:${fn.span}`) : null))
        .filter(Boolean)
        .sort((a, b) => b.end - a.end);
    const lastFn = sortedEndFns[0];
    if (lastFn && lastFn.end >= lines.length - 4 && lastFn.end - lastFn.start + 1 <= 36 && lastFn.start < envStart)
        return lastFn.start;
    if (retLineIdx > 0 && /^return\s+[A-Za-z_]\w*$/.test((lines[retLineIdx - 1] ?? "").trim())) {
        for (let p = retLineIdx - 2; p >= Math.max(0, retLineIdx - 26); p--) {
            const pt = (lines[p] ?? "").trim();
            if (/^(?:self|M|[A-Za-z_]\w*)\.[A-Za-z_]\w*\s*=/.test(pt) || pt === "return self")
                envStart = p + 1;
        }
    }
    return envStart;
}

function appendEditEnvelopeModuleReturn(h, hitIdx, s, lines, fileNodes, state) {
    const tailStart = Math.max(1, lines.length - 20);
    if (hitIdx > 2 || h.code.includes(`L${lines.length}:`))
        return;
    const retLineIdx = findModuleReturnLineIdx(lines, tailStart);
    const isCjsFactoryWrapper = retLineIdx <= 0 &&
        lines.slice(0, 30).some((l) => /^module\.exports\s*=\s*function\b/.test(l.trim())) &&
        lines.slice(-4).some((l) => l.trim() === "};");
    if (retLineIdx <= 0 && !isCjsFactoryWrapper)
        return;
    const envStart = resolveModuleReturnEnvStart(lines, fileNodes, retLineIdx);
    const tailSlice = sliceSpan(lines, s.path, envStart, lines.length, isCjsFactoryWrapper ? 45 : 28);
    if (!tailSlice || h.code.includes(`L${envStart}:`))
        return;
    const tailBlock = `// module return (${s.path}:L${envStart}-L${lines.length}):\n${tailSlice}`;
    const tbLen = Buffer.byteLength(tailBlock, "utf8");
    const bonus = isCjsFactoryWrapper ? 1100 : (envStart < retLineIdx ? 680 : 350);
    if (state.totalInlinedBytes + tbLen <= state.maxTotalBytes + bonus) {
        h.code = `${h.code}\n\n${tailBlock}`;
        state.totalInlinedBytes += tbLen;
    }
}
function collectOtherSymbolsInFile(fileNodes, excludeId, excludePointer, shownPointers, qTerms, qStems, qualifyDupOwners, maxItems, coveredRanges = []) {
    const otherSyms = [];
    const seenOtherNames = new Map();
    const candidates = fileNodes
        .filter((fn) => {
            if (!fn.span || (excludeId ? fn.id === excludeId : `${fn.path}:${fn.span}` === excludePointer) || shownPointers.has(`${fn.path}:${fn.span}`))
                return false;
            if (coveredRanges.length > 0) {
                const sp = parseSpan(`${fn.path}:${fn.span}`);
                if (sp && coveredRanges.some((r) => sp.start >= r.start && sp.end <= r.end))
                    return false;
            }
            return true;
        })
        .sort((a, b) => {
            const aFn = a.kind === "function" || a.kind === "method" ? 1 : 0;
            const bFn = b.kind === "function" || b.kind === "method" ? 1 : 0;
            if (aFn !== bFn)
                return bFn - aFn;
            const aMatch = tokenize(a.name ?? "").some((t) => qTerms.has(t) || qStems.has(stemToken(t))) ? 1 : 0;
            const bMatch = tokenize(b.name ?? "").some((t) => qTerms.has(t) || qStems.has(stemToken(t))) ? 1 : 0;
            if (aMatch !== bMatch)
                return bMatch - aMatch;
            return Number(Boolean(b.exported)) - Number(Boolean(a.exported));
        });
    for (const fn of candidates) {
        const dispName = qualifyDupOwners && fn.owner && fileNodes.filter((x) => x.name === fn.name).length > 1
            ? `${fn.owner}.${fn.name}`
            : fn.name;
        const cnt = seenOtherNames.get(dispName) ?? 0;
        if (cnt >= 1)
            continue;
        seenOtherNames.set(dispName, cnt + 1);
        otherSyms.push(`${dispName}(${fn.span})`);
        if (otherSyms.length >= maxItems)
            break;
    }
    return otherSyms;
}
const MAX_CACHED_SOURCE_FILES = 256;
const askSourceLinesCache = new Map();
registerGraphCacheClearer(() => {
    askSourceLinesCache.clear();
});

function createStatVerifiedFileReader(root) {
    const perCall = new Map();
    const absRoot = root !== undefined ? resolve(root) : null;
    let realRoot = absRoot;
    if (absRoot) {
        try { realRoot = realpathSync(absRoot); }
        catch { /* keep absRoot fallback */ }
    }
    let baseReader = null;
    return (relPath) => {
        if (!absRoot || !realRoot || typeof relPath !== "string" || !relPath)
            return null;
        if (perCall.has(relPath))
            return perCall.get(relPath);
        const safe = resolveSafeRepoFile(absRoot, realRoot, relPath);
        if (!safe) {
            perCall.set(relPath, null);
            return null;
        }
        const cached = askSourceLinesCache.get(safe.realFile);
        if (cached && cached.mtimeMs === safe.stat.mtimeMs && cached.size === safe.stat.size) {
            perCall.set(relPath, cached.lines);
            return cached.lines;
        }
        baseReader ??= fileReader(root);
        const lines = baseReader(relPath);
        if (lines) {
            if (askSourceLinesCache.size >= MAX_CACHED_SOURCE_FILES) {
                const oldest = askSourceLinesCache.keys().next().value;
                if (oldest !== undefined)
                    askSourceLinesCache.delete(oldest);
            }
            askSourceLinesCache.set(safe.realFile, { mtimeMs: safe.stat.mtimeMs, size: safe.stat.size, lines });
        }
        perCall.set(relPath, lines);
        return lines;
    };
}

function createInlineSourceState(root, graph, full, query, opts) {
    const srcIdx = getOrBuildInlineSourceIndex(graph, full, opts.extraNodes);
    const qTerms = new Set(tokenize(query));
    const qStems = new Set([...qTerms].map(stemToken).filter((s) => s.length >= 4));
    const qExactCode = opts.qExactCode instanceof Set ? opts.qExactCode : new Set(tokenizeExact(query));
    const qLiterals = opts.qLiterals instanceof Set ? opts.qLiterals : new Set(extractLiterals(query));
    const shownPointers = opts.seenPointers ?? new Set();
    const inlinedLinesByPath = opts.seenPointers
        ? (opts.seenPointers._inlinedLinesByPath ??= new Map())
        : new Map();
    const wantsCallSites = Boolean(opts.wantsCallSites) ||
        /\b(callers?|called|calls|invokes?|invoked|who\s+uses|used\s+by|blast\s+radius|refactor|references?|where\s+is\b.*\bused)\b/i.test(query);
    return {
        srcIdx, readLines: createStatVerifiedFileReader(root), shownPointers, inlinedLinesByPath,
        constsByPath: new Map(), qTerms, qStems, qExactCode, qLiterals, full, opts,
        isMultiQuery: Boolean(opts.maxHitsToInline && opts.maxHitsToInline <= 2),
        editEnvelope: Boolean(opts.editEnvelope),
        wantsCallSites,
        maxHitsToInline: opts.maxHitsToInline ?? SOURCE_TOP_HITS,
        maxTotalBytes: opts.maxSourceBytes ?? (full ? 5200 : 3800),
        primaryMeta: new Map(), deferredFourthHits: [],
        totalInlinedBytes: 0, inlinedHitCount: 0,
    };
}

function attachHelpersAndEnvelopeForPrimaryHit(meta, i, hits, state) {
    const { srcIdx, readLines, shownPointers, qTerms, qStems, wantsCallSites, editEnvelope, maxTotalBytes, full, inlinedLinesByPath } = state;
    const { h, node, s, lines } = meta;
    if (!node || node.kind === "file" || !lines || !h.code)
        return;
    const isTinyTypeHit = (node.kind === "struct" || node.kind === "type" || node.kind === "interface") && meta.spanLen <= 12;
    if (state.totalInlinedBytes < maxTotalBytes + (isTinyTypeHit ? 1400 : 0)) {
        const sameFileCands = collectSameFileCandidatesForHit(meta, i, srcIdx, shownPointers, qTerms, qStems, wantsCallSites);
        if (sameFileCands.size > 0) {
            const scoredHelpers = scoreHelperCandidatesForHit(sameFileCands, meta, readLines, qTerms, qStems, wantsCallSites);
            attachScoredHelpersToHit(meta, i, scoredHelpers, state);
        }
    }
    if (editEnvelope && lines && h.code) {
        const fileNodes = srcIdx.nodesByPath.get(s.path) ?? [];
        prependEditEnvelopeBestType(h, i, node, s, lines, fileNodes, state);
        appendEditEnvelopeModuleReturn(h, i, s, lines, fileNodes, state);
        const coveredRanges = [{ start: meta.effStart, end: meta.effEnd }, ...(meta.attachedSameFileSpans ?? [])];
        const otherSyms = collectOtherSymbolsInFile(fileNodes, node.id, null, shownPointers, qTerms, qStems, true, 10, coveredRanges);
        if (otherSyms.length > 0 && !h.code.includes(`// other symbols in ${s.path}:`)) {
            const footer = `\n// other symbols in ${s.path}: ${otherSyms.join(", ")}`;
            const fBytes = Buffer.byteLength(footer, "utf8");
            if (full || state.totalInlinedBytes + fBytes <= maxTotalBytes) {
                h.code += footer;
                state.totalInlinedBytes += fBytes;
            }
        }
    }
    recordInlinedCode(s.path, h.code, inlinedLinesByPath);
    dedupeSubsequentInlinedHits(hits, h, inlinedLinesByPath, state);
}

function populateEditEnvelopeFallbackOtherSymbols(hits, srcIdx, shownPointers, qTerms, qStems) {
    for (const h of hits.slice(0, 4)) {
        if (h.code || h.otherSymbols)
            continue;
        const s = parseSpan(h.pointer);
        const filePath = s?.path ?? (h.pointer || "").split(":")[0];
        if (!filePath)
            continue;
        const fileNodes = srcIdx.nodesByPath.get(filePath) ?? [];
        const otherSyms = collectOtherSymbolsInFile(fileNodes, null, h.pointer, shownPointers, qTerms, qStems, false, 8);
        if (otherSyms.length > 0)
            h.otherSymbols = otherSyms.join(", ");
    }
}

function commitDeferredFourthInlinedHits(state) {
    const { deferredFourthHits, inlinedLinesByPath, shownPointers, maxTotalBytes } = state;
    for (const { h, code } of deferredFourthHits) {
        const sp = parseSpan(h.pointer);
        if (sp && isSpanFullyInlined(sp.path, sp.start, sp.end, inlinedLinesByPath))
            continue;
        const cBytes = Buffer.byteLength(code, "utf8");
        if (state.totalInlinedBytes + cBytes <= maxTotalBytes) {
            h.code = code;
            if (sp)
                recordInlinedCode(sp.path, code, inlinedLinesByPath);
            shownPointers.add(h.pointer);
            state.totalInlinedBytes += cBytes;
        }
    }
}

function inlineSource(root, hits, graph, full, query = "", opts = {}) {
    const state = createInlineSourceState(root, graph, full, query, opts);
    for (let i = 0; i < hits.length; i++)
        inlinePrimaryHitSpan(hits[i], i, hits, state);
    for (const [i, meta] of state.primaryMeta) {
        if (i > 2)
            break;
        attachHelpersAndEnvelopeForPrimaryHit(meta, i, hits, state);
    }
    if (state.editEnvelope)
        populateEditEnvelopeFallbackOtherSymbols(hits, state.srcIdx, state.shownPointers, state.qTerms, state.qStems);
    commitDeferredFourthInlinedHits(state);
    return state.totalInlinedBytes;
}
function resolveAskSearchOutcome(query, corpus, fetchLimit, opts) {
    const graphRank = opts.graphRank ?? true;
    const fileFirst = opts.fileFirst ?? true;
    const fileTopLock = opts.fileTopLock ?? fileFirst;
    const fileComplement = (opts.fileComplement ?? false) || fileTopLock;
    const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
    if (inPrefix && corpus.graph)
        assertPrefixIndexed(corpus.graph, inPrefix);
    const outcome = corpus.graph ? structural(query, corpus.graph, fetchLimit, inPrefix) : null;
    if (outcome && "result" in outcome)
        return outcome.result;
    const result = lexical(query, corpus, fetchLimit, graphRank, inPrefix, fileFirst, fileComplement, fileTopLock, opts.includeRankingMetadata ?? false);
    if (outcome && "fallthroughNote" in outcome) {
        result.note = result.note ? `${outcome.fallthroughNote}\n${result.note}` : outcome.fallthroughNote;
    }
    return result;
}
function collectAskSourceHits(result) {
    if (!result.ranking)
        return result.hits;
    return [
        ...new Set([
            ...result.hits,
            ...result.ranking.groups.flatMap((group) => group.hits),
            ...result.ranking.groups.flatMap((group) => group.baselineHits ?? []),
            ...result.ranking.baseline.map((entry) => entry.hit),
        ]),
    ];
}
function inlineAskResultSource(root, result, graph, query, opts, topWasSeen) {
    if (opts.suppressExploratorySource && result.confidenceTier === "exploratory" && !opts.full)
        return 0;
    const qState = result._qState;
    const inlineOpts = {
        ...opts,
        extraNodes: result._extraNodes,
        qExactCode: qState?.codeAnchoredExact ?? new Set(tokenizeExact(query)),
        qLiterals: qState ? new Set(qState.qLiterals) : new Set(extractLiterals(query)),
    };
    const lowSeenTop = topWasSeen && (result.hits[0]?.score ?? 0) < 0.86;
    const effectiveOpts = lowSeenTop ? { ...inlineOpts, maxHitsToInline: 0 } : inlineOpts;
    return inlineSource(root, collectAskSourceHits(result), graph, opts.full ?? false, query, effectiveOpts);
}
export function ask(dir, query, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const limit = opts.limit ?? (opts.source ? 5 : 8);
    const fetchLimit = opts.seenPointers ? limit + opts.seenPointers.size : limit;
    const corpus = loadCorpus(outDir, root);
    if (!corpus.graph) {
        return {
            query,
            mode: "empty",
            confidenceTier: "exploratory",
            hits: [],
            note: "no wiring graph — run `plexer build` first",
            rawTopPointer: null,
            rawTopScore: 0,
        };
    }
    const result = resolveAskSearchOutcome(query, corpus, fetchLimit, opts);
    result.confidenceTier ??= result.hits.length > 0 && result.mode === "structural" ? "high" : "exploratory";
    result.rawTopPointer = result.hits[0]?.pointer ?? null;
    result.rawTopScore = result.hits[0]?.score ?? 0;
    const topWasSeen = Boolean(result.rawTopPointer && opts.seenPointers?.has(result.rawTopPointer));
    if (opts.seenPointers && result.hits.length > 0) {
        const filtered = result.hits.filter((h) => !opts.seenPointers.has(h.pointer));
        result.hits = (filtered.length > 0 ? filtered : result.hits).slice(0, limit);
    }
    if (opts.source) {
        result.usedSourceBytes = inlineAskResultSource(root, result, corpus.graph, query, opts, topWasSeen);
    }
    if (opts.seenPointers && !opts.source) {
        for (const h of result.hits)
            opts.seenPointers.add(h.pointer);
    }
    return result;
}
function toSkeletonEntry(n) {
    return {
        file: n.path,
        name: n.name,
        kind: n.kind,
        span: n.span,
        exported: Boolean(n.exported),
        signature: n.signature,
        summary: n.summary?.split("\n")[0].trim() || undefined,
    };
}
function ensureSkeletonByPathIndex(graph) {
    if (graph._skeletonByPath && graph._skeletonNodeLen === graph.nodes.length)
        return graph._skeletonByPath;
    const byPath = new Map();
    for (const n of graph.nodes) {
        if (!n.path)
            continue;
        let list = byPath.get(n.path);
        if (!list) {
            list = [];
            byPath.set(n.path, list);
        }
        if (n.kind !== "file")
            list.push(n);
    }
    for (const list of byPath.values()) {
        list.sort((a, b) => spanStart(a.span, 0) - spanStart(b.span, 0));
    }
    Object.defineProperty(graph, "_skeletonByPath", { value: byPath, enumerable: false, configurable: true, writable: true });
    Object.defineProperty(graph, "_skeletonNodeLen", { value: graph.nodes.length, enumerable: false, configurable: true, writable: true });
    return byPath;
}
function collectSkeletonSuffixDefs(nodes, file, normFile, suffix, caseInsensitive) {
    const exact = [];
    const bySuffix = new Map();
    const lowerNorm = caseInsensitive ? normFile.toLowerCase() : "";
    const lowerSuffix = caseInsensitive ? suffix.toLowerCase() : "";
    for (const n of nodes) {
        const matchedExact = caseInsensitive
            ? n.path.toLowerCase() === lowerNorm
            : (n.path === file || n.path === normFile);
        const matchedSuffix = !matchedExact && (caseInsensitive
            ? n.path.toLowerCase().endsWith(lowerSuffix)
            : n.path.endsWith(suffix));
        if (matchedExact) {
            if (n.kind !== "file")
                exact.push(n);
            bySuffix.set(n.path, exact);
        }
        else if (matchedSuffix) {
            let list = bySuffix.get(n.path);
            if (!list) {
                list = [];
                bySuffix.set(n.path, list);
            }
            if (n.kind !== "file")
                list.push(n);
        }
    }
    return { exact, bySuffix };
}
function resolveMultipleSkeletonSuffixMatches(file, bySuffix, allMatches) {
    const files = [...bySuffix.keys()].sort();
    if (allMatches) {
        const entries = [];
        for (const f of files) {
            const fileDefs = [...(bySuffix.get(f) ?? [])].sort(
                (a, b) => spanStart(a.span, 0) - spanStart(b.span, 0),
            );
            for (const n of fileDefs) {
                entries.push(toSkeletonEntry(n));
            }
        }
        return { files, entries };
    }
    return {
        file,
        entries: [],
        note: `ambiguous — matches: ${files.join(", ")}`,
        error: `ambiguous path "${file}" — matches: ${files.join(", ")}`,
    };
}
function boundedEditDistance(a, b, maxDist) {
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
function tokenOverlapScore(qToks, candText) {
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
function scoreNearCandidate(qFlat, qToks, candRaw) {
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
function buildNearQueryTokens(query) {
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
function suggestClosestSymbols(query, nodes, opts = {}) {
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
function stripFileExtension(p) {
    return String(p ?? "").replace(/\.[a-z0-9]+$/i, "");
}
function filterPathsByStem(paths, normStem, caseInsensitive) {
    const target = caseInsensitive ? normStem.toLowerCase() : normStem;
    const suffix = `/${target}`;
    return paths.filter((p) => {
        const stem = stripFileExtension(p);
        const cmp = caseInsensitive ? stem.toLowerCase() : stem;
        return cmp === target || cmp.endsWith(suffix);
    });
}
function resolveSkeletonStemFallback(file, normFile, byPath, allMatches) {
    const allPaths = [...byPath.keys()].sort();
    const normStem = stripFileExtension(normFile.replace(/^\.?\/+/, "").replace(/\/+$/, ""));
    if (normStem) {
        let stemPaths = filterPathsByStem(allPaths, normStem, false);
        if (!stemPaths.length)
            stemPaths = filterPathsByStem(allPaths, normStem, true);
        if (stemPaths.length === 1) {
            const onlyDefs = byPath.get(stemPaths[0]) ?? [];
            if (!onlyDefs.length)
                return { file: stemPaths[0], entries: [], note: "no definitions indexed for this file" };
            return { file: stemPaths[0], entries: onlyDefs.map(toSkeletonEntry) };
        }
        if (stemPaths.length > 1) {
            const stemMap = new Map(stemPaths.map((p) => [p, byPath.get(p) ?? []]));
            const multi = resolveMultipleSkeletonSuffixMatches(file, stemMap, allMatches);
            if (allMatches)
                return multi;
            return {
                file,
                entries: [],
                note: `ambiguous — matches: ${stemPaths.join(", ")}`,
                error: `ambiguous path "${file}" — did you mean: ${stemPaths.join(", ")}?`,
            };
        }
    }
    const normDir = normFile.replace(/^\.?\/+/, "").replace(/\/+$/, "");
    if (normDir) {
        const dirPrefix = `${normDir}/`;
        let dirPaths = allPaths.filter((p) => p.startsWith(dirPrefix));
        if (!dirPaths.length) {
            const lowerPrefix = dirPrefix.toLowerCase();
            dirPaths = allPaths.filter((p) => p.toLowerCase().startsWith(lowerPrefix));
        }
        if (dirPaths.length > 0) {
            const nonTest = dirPaths.filter((p) => !isTestPath(p));
            const chosen = (nonTest.length > 0 ? nonTest : dirPaths).slice(0, 12);
            const dirMap = new Map(chosen.map((p) => [p, byPath.get(p) ?? []]));
            return resolveMultipleSkeletonSuffixMatches(file, dirMap, true);
        }
    }
    const suggestions = suggestClosestFiles(normFile || file, allPaths, 3);
    if (suggestions.length > 0) {
        const hint = `did you mean: ${suggestions.join(", ")}?`;
        return { file, entries: [], note: `no definitions indexed for "${file}" — ${hint}`, error: `no file "${file}" in the graph — ${hint}` };
    }
    return { file, entries: [], note: "no definitions indexed for this file" };
}
/** Signatures-only view of one file, straight from the wiring graph — the
 * cheapest way to understand a file's API surface (~10× less than reading it).
 * `file` is matched as an exact repo-relative path, then as a basename. */
export function skeleton(dir, file, opts = {}) {
    const outDir = contextDirFor(resolve(dir), opts.contextDir);
    const graph = loadGraphCached(outDir);
    if (!graph)
        return { file, entries: [], note: "no wiring graph — run `plexer build` first" };
    const byPath = ensureSkeletonByPathIndex(graph);
    const rootPrefix = `${resolve(dir).replace(/\\/g, "/").replace(/^\/+/, "")}/`;
    const rawNormFile = String(file ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    const normFile = rawNormFile.startsWith(rootPrefix) ? rawNormFile.slice(rootPrefix.length) : rawNormFile;
    const exactMatch = byPath.get(file) ?? byPath.get(normFile);
    if (exactMatch) {
        if (!exactMatch.length)
            return { file: normFile, entries: [], note: "no definitions indexed for this file" };
        return {
            file: exactMatch[0].path,
            entries: exactMatch.map(toSkeletonEntry),
        };
    }
    const suffix = `/${normFile}`;
    let { exact, bySuffix } = collectSkeletonSuffixDefs(graph.nodes, file, normFile, suffix, false);
    if (!exact.length && bySuffix.size === 0) {
        ({ exact, bySuffix } = collectSkeletonSuffixDefs(graph.nodes, file, normFile, suffix, true));
    }
    let defs = exact;
    if (!defs.length) {
        if (bySuffix.size > 1)
            return resolveMultipleSkeletonSuffixMatches(file, bySuffix, opts.allMatches);
        const [only] = bySuffix.values();
        if (only)
            defs = only;
    }
    if (!defs.length)
        return resolveSkeletonStemFallback(file, normFile, byPath, opts.allMatches);
    defs.sort((a, b) => spanStart(a.span, 0) - spanStart(b.span, 0));
    return {
        file: defs[0].path,
        entries: defs.map(toSkeletonEntry),
    };
}
/** Render a {@link SkeletonResult} as compact markdown. */
export function formatSkeleton(r, opts = {}) {
    const renderLines = (entries, maxSigLen, maxSumLen, exportedSumOnly) =>
        entries.map((e) => {
            const showSum = maxSumLen > 0 && e.summary && (!exportedSumOnly || e.exported);
            const sum = showSum
                ? ` — ${e.summary.length > maxSumLen ? `${e.summary.slice(0, maxSumLen - 1)}…` : e.summary}`
                : "";
            const rawSig = e.signature
                ? (e.signature.length > maxSigLen ? `${e.signature.slice(0, maxSigLen - 1)}…` : e.signature)
                : "";
            const expPrefix = e.exported && !/^(?:export|pub)\b/.test(rawSig) ? "export " : "";
            if (!e.name.includes("#") && rawSig && rawSig.includes(e.name)) {
                const selfDescribing = /^(?:export\s+|local\s+|async\s+|pub\s+)*(?:function|type|class|interface|enum|struct|def|fn)\b/.test(rawSig);
                const kindTag = selfDescribing ? "" : `[${e.kind}] `;
                return `- ${e.span}  ${expPrefix}${kindTag}${rawSig}${sum}`;
            }
            const sig = rawSig ? `  ${rawSig}` : "";
            return `- ${e.span}  ${expPrefix}${e.kind} ${e.name}${sig}${sum}`;
        });
    if (Array.isArray(r.files)) {
        const sections = r.files.map((file) => {
            const fileEntries = (r.entries ?? []).filter((e) => e.file === file);
            const secHead = `${file} — skeleton (${fileEntries.length} symbols)`;
            const lines = opts.compact
                ? renderLines(fileEntries, 72, 0, true)
                : fileEntries.length > 30
                    ? renderLines(fileEntries, 90, 60, true)
                    : renderLines(fileEntries, 110, 90, false);
            return [secHead, ...lines].join("\n");
        });
        return `${sections.join("\n\n")}\n`;
    }
    const head = `plexer skeleton — ${r.file}`;
    if (!r.entries?.length)
        return `${head}\n\n${r.note ?? r.error ?? "no definitions."}\n`;
    if (opts.summaryOnly) {
        const preview = r.entries.slice(0, 8).map((e) => `${e.name}(${e.span})`).join(", ");
        const more = r.entries.length > 8 ? `, +${r.entries.length - 8} more` : "";
        return `${head} (${r.entries.length} symbols: ${preview}${more} — run \`plexer skeleton ${r.file}\` for full signatures)\n`;
    }
    const lines = opts.compact
        ? renderLines(r.entries, 72, 0, true)
        : r.entries.length > 30
            ? renderLines(r.entries, 90, 60, true)
            : renderLines(r.entries, 110, 90, false);
    let out = `${head}\n${lines.join("\n")}\n`;
    if (out.length > 6000 && !opts.compact) {
        out = `${head}\n${renderLines(r.entries, 72, 0, true).join("\n")}\n`;
    }
    return out;
}
export function isRedundantSnippet(snippet, code) {
    if (!snippet || !code)
        return false;
    const firstLine = code.split("\n")[0].replace(/^L\d+:\s*/, "").trim();
    const snip = snippet.trim();
    return Boolean(firstLine && (firstLine.startsWith(snip) || snip.startsWith(firstLine)));
}
function formatStructuralAskHits(hits, lines) {
    for (const h of hits) {
        const tail = h.snippet && !isRedundantSnippet(h.snippet, h.code) ? ` — ${h.snippet}` : "";
        lines.push(`- ${h.title}  ${h.pointer}  (${h.relation})${tail}`);
        if (h.code)
            lines.push("", "```", h.code, "```", "");
    }
}

function formatLexicalAskHit(h, i, r, lines) {
    const label = r.scopes && h.scope ? `[${h.scope}/] ` : "";
    lines.push(`${i + 1}. ${label}${h.title}  [${h.kind}]`);
    lines.push(`   ${h.pointer}`);
    if (h.snippet && !isRedundantSnippet(h.snippet, h.code)) {
        const maxSnip = h.code ? 140 : 96;
        const snip = h.snippet.length > maxSnip ? `${h.snippet.slice(0, maxSnip - 1)}…` : h.snippet;
        lines.push(`   ${snip}`);
    }
    if (h.related?.length && (h.code || i < 2))
        lines.push(`   related: ${h.related.join(", ")}`);
    if (h.callSites?.length) {
        lines.push(`   call sites (${h.callSites.length}):`);
        for (const cs of h.callSites)
            lines.push(`     ← ${cs}`);
    }
    if (h.code)
        lines.push("", "```", h.code, "```");
    lines.push("");
}

/** Render an {@link AskResult} as a compact markdown context pack. */
export function formatAsk(r) {
    const head = `plexer ask — "${r.query}"  (${r.mode})`;
    const noteBlock = r.note
        ? r.note
            .split("\n")
            .map((l) => (l.startsWith("structural index:") ? `⚠ ${l}` : l))
            .join("\n")
        : "";
    if (r.hits.length === 0)
        return `${head}\n\n${noteBlock || "no matches."}${escalationNudge(r)}\n`;
    const lines = noteBlock ? [head, "", noteBlock, ""] : [head, ""];
    if (r.mode === "structural") {
        formatStructuralAskHits(r.hits, lines);
    }
    else {
        r.hits.forEach((h, i) => formatLexicalAskHit(h, i, r, lines));
        lines.push(...scopeFooterLines(r));
    }
    const body = lines.join("\n").trimEnd();
    return body + escalationNudge(r) + "\n";
}
function parseReadSpanSpec(spec) {
    const trimmed = String(spec ?? "").trim();
    const mRange = /^(.*?):L?(\d+)(?:-L?(\d+))?$/.exec(trimmed);
    if (mRange && mRange[1]) {
        const rawPath = mRange[1].replace(/\\/g, "/").replace(/^\/+/, "");
        const rawStart = Math.max(1, Number(mRange[2]));
        const rawEnd = mRange[3] !== undefined ? Math.max(1, Number(mRange[3])) : rawStart + 30;
        const start = Math.min(rawStart, rawEnd);
        const end = Math.max(rawStart, rawEnd);
        return { raw: trimmed, file: rawPath, start, end, hasExplicitRange: true, symbol: null };
    }
    const mSym = /^(.*?):([A-Za-z_][A-Za-z0-9_.:#]*)$/.exec(trimmed);
    if (mSym && mSym[1] && mSym[2]) {
        const rawPath = mSym[1].replace(/\\/g, "/").replace(/^\/+/, "");
        return { raw: trimmed, file: rawPath, start: 1, end: 120, hasExplicitRange: false, symbol: mSym[2] };
    }
    if (!trimmed)
        return null;
    const rawPath = trimmed.replace(/\\/g, "/").replace(/^\/+/, "");
    return { raw: trimmed, file: rawPath, start: 1, end: 120, hasExplicitRange: false, symbol: null };
}
function lookupSpanTarget(fileNodes, targetName) {
    const symLower = targetName.toLowerCase();
    const symBare = symLower.split(/[.:#]/).pop() || symLower;
    return (fileNodes.find((n) => n.name.toLowerCase() === symLower) ??
        fileNodes.find((n) => n.name.toLowerCase() === symBare || n.name.toLowerCase().endsWith(`.${symBare}`) || n.name.toLowerCase().endsWith(`:${symBare}`)) ??
        fileNodes.find((n) => n.id.toLowerCase().endsWith(`#${symLower}`) || n.id.toLowerCase().endsWith(`.${symBare}`)));
}
function formatMissingReadFileError(resolvedFile, rawFile, indexedPaths) {
    if (resolvedFile.startsWith(".."))
        return `cannot read "${resolvedFile}"`;
    const suggestions = suggestClosestFiles(rawFile, indexedPaths, 3);
    return suggestions.length
        ? `cannot read "${resolvedFile}" — did you mean: ${suggestions.join(", ")}?`
        : `cannot read "${resolvedFile}"`;
}
function missingReadTargetError(targetName, resolvedFile, fileNodes) {
    const suggestions = suggestClosestSymbols(targetName, fileNodes, { max: 3, withSpan: true });
    return suggestions.length
        ? `no symbol "${targetName}" in "${resolvedFile}" — did you mean: ${suggestions.join(", ")}?`
        : `no symbol "${targetName}" in "${resolvedFile}"`;
}
function resolveIndexedReadPath(fileQuery, indexedPaths, rootPrefix, read) {
    const normalizedQuery = fileQuery.startsWith(rootPrefix)
        ? fileQuery.slice(rootPrefix.length)
        : fileQuery;
    const suffix = `/${normalizedQuery}`;
    const matches = indexedPaths.filter((p) => p === normalizedQuery || p.endsWith(suffix));
    if (matches.length === 1)
        return matches[0];
    const lower = normalizedQuery.toLowerCase();
    const lowerSuffix = suffix.toLowerCase();
    const ciMatches = indexedPaths.filter((p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(lowerSuffix));
    if (ciMatches.length === 1)
        return ciMatches[0];
    if (read(normalizedQuery))
        return normalizedQuery;
    return matches[0] ?? ciMatches[0] ?? normalizedQuery;
}
const DEFAULT_READ_BUDGET_BYTES = 9000;
const MAX_SINGLE_SPAN_LINES = 320;

function resolveSpanBlockRequest(rawSpec, resolvePath, read, graph, indexedPaths, opts = {}) {
    const parsed = parseReadSpanSpec(rawSpec);
    if (!parsed)
        return { spec: rawSpec, error: `invalid span "${rawSpec}"` };
    const resolvedFile = resolvePath(parsed.file);
    if (!resolvedFile.startsWith("..") && isSensitiveOrDotPath(resolvedFile))
        return { spec: rawSpec, file: resolvedFile, error: `cannot read sensitive or hidden path "${resolvedFile}"` };
    const lines = read(resolvedFile);
    if (!lines)
        return { spec: rawSpec, file: resolvedFile, error: formatMissingReadFileError(resolvedFile, parsed.file, indexedPaths) };
    let spanStartLine = parsed.start;
    let spanEndLine = parsed.end;
    let hasExplicit = parsed.hasExplicitRange;
    if (parsed.symbol && graph) {
        const pathNodes = graph._nodesByPath?.get(resolvedFile) ?? graph.nodes.filter((n) => n.path === resolvedFile);
        const fileNodes = pathNodes.filter((n) => n.kind !== "file" && n.span);
        const matchNode = lookupSpanTarget(fileNodes, parsed.symbol);
        if (!matchNode)
            return { spec: rawSpec, file: resolvedFile, error: missingReadTargetError(parsed.symbol, resolvedFile, fileNodes) };
        const sr = spanRange(matchNode.span);
        if (sr) {
            spanStartLine = sr.start;
            spanEndLine = sr.end;
            hasExplicit = true;
        }
    }
    const start = Math.max(1, Math.min(spanStartLine, lines.length));
    const defaultBareLines = opts.full ? 400 : 160;
    const rawTargetEnd = Math.max(start, Math.min(hasExplicit ? spanEndLine : Math.min(lines.length, defaultBareLines), lines.length));
    const unpooledMaxEnd = opts.full ? rawTargetEnd : Math.min(rawTargetEnd, start + MAX_SINGLE_SPAN_LINES - 1);
    return {
        spec: rawSpec,
        file: resolvedFile,
        start,
        targetEnd: rawTargetEnd,
        unpooledEnd: unpooledMaxEnd,
        totalLines: lines.length,
        lines,
    };
}

function coalesceResolvedSpanRequests(items) {
    const out = [];
    for (const item of items) {
        if (item.error) {
            out.push(item);
            continue;
        }
        const mergeTarget = out.find(
            (prev) =>
                !prev.error &&
                prev.file === item.file &&
                prev.targetEnd + 3 >= item.start &&
                item.targetEnd + 3 >= prev.start,
        );
        if (mergeTarget) {
            mergeTarget.start = Math.min(mergeTarget.start, item.start);
            mergeTarget.targetEnd = Math.max(mergeTarget.targetEnd, item.targetEnd);
            mergeTarget.unpooledEnd = Math.max(mergeTarget.unpooledEnd, item.unpooledEnd);
            if (mergeTarget.spec !== item.spec)
                mergeTarget.spec = `${mergeTarget.spec}, ${item.spec}`;
            continue;
        }
        out.push({ ...item });
    }
    return out;
}

function materializeSpanBlock(item, end) {
    const slice = [];
    for (let ln = item.start; ln <= end; ln++) {
        slice.push(`L${ln}: ${item.lines[ln - 1]}`);
    }
    if (end < item.targetEnd) {
        slice.push(`… (+${item.targetEnd - end} more lines in ${item.file}:L${end + 1}-L${item.targetEnd} — pass --full or use read_file)`);
    }
    const span = `L${item.start}-L${end}`;
    const code = slice.join("\n");
    const formatted = `${item.file}:${span} (of ${item.totalLines} lines)\n\`\`\`\n${code}\n\`\`\`\n\n`;
    return {
        block: {
            spec: item.spec,
            file: item.file,
            span,
            totalLines: item.totalLines,
            truncated: end < item.targetEnd,
            code,
        },
        bytes: Buffer.byteLength(formatted, "utf8"),
    };
}

function fitItemToByteShare(item, byteBudget, minLinesFloor) {
    const maxEnd = item.unpooledEnd;
    const minEnd = Math.min(maxEnd, item.start + minLinesFloor - 1);
    const frameOverhead = Buffer.byteLength(
        `${item.file}:L${item.start}-L${maxEnd} (of ${item.totalLines} lines)\n\`\`\`\n\n\`\`\`\n\n`,
        "utf8",
    ) + 96;
    let used = frameOverhead;
    let chosenEnd = item.start;
    for (let ln = item.start; ln <= maxEnd; ln++) {
        const lineBytes = Buffer.byteLength(`L${ln}: ${item.lines[ln - 1]}\n`, "utf8");
        if (ln > minEnd && used + lineBytes > byteBudget)
            break;
        used += lineBytes;
        chosenEnd = ln;
    }
    return materializeSpanBlock(item, chosenEnd);
}

/** Read one or more `<file>[:L<start>[-L<end>] | :<symbol>]` spans (matching exact repo-relative paths
 * or unique basenames from the graph) with `L<n>:` line prefixes. */
export function readSpans(dir, spanSpecs, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const graph = loadGraphCached(outDir);
    const read = fileReader(root);
    const specs = (Array.isArray(spanSpecs) ? spanSpecs : [spanSpecs])
        .flatMap((s) => String(s).split(","))
        .map((s) => s.trim())
        .filter(Boolean);
    const indexedPaths = graph
        ? (graph._nodesByPath
            ? [...graph._nodesByPath.keys()].sort()
            : [...new Set(graph.nodes.map((n) => n.path).filter(Boolean))].sort())
        : [];
    const rootPrefix = `${root.replace(/\\/g, "/").replace(/^\/+/, "")}/`;
    const resolvePath = (fileQuery) => resolveIndexedReadPath(fileQuery, indexedPaths, rootPrefix, read);
    const rawResolved = specs.map((rawSpec) => resolveSpanBlockRequest(rawSpec, resolvePath, read, graph, indexedPaths, opts));
    const items = coalesceResolvedSpanRequests(rawResolved);
    const fullResults = items.map((it) =>
        it.error
            ? { block: it, bytes: Buffer.byteLength(`✗ ${it.error}\n\n`, "utf8"), item: it }
            : { ...materializeSpanBlock(it, it.unpooledEnd), item: it },
    );
    const maxBytes = opts.full ? Infinity : (opts.maxBytes ?? DEFAULT_READ_BUDGET_BYTES);
    const totalBytes = fullResults.reduce((acc, r) => acc + r.bytes, 0);
    if (totalBytes <= maxBytes) {
        return { blocks: fullResults.map((r) => r.block) };
    }
    const validIndices = fullResults
        .map((r, idx) => (!r.item.error ? idx : -1))
        .filter((idx) => idx >= 0);
    const minLinesFloor = 5;
    let remainingPool = Math.max(1200, maxBytes - fullResults.filter((r) => r.item.error).reduce((a, r) => a + r.bytes, 0));
    const sortedValid = [...validIndices].sort((a, b) => fullResults[a].bytes - fullResults[b].bytes);
    const finalBlocks = fullResults.map((r) => r.block);
    for (let k = 0; k < sortedValid.length; k++) {
        const idx = sortedValid[k];
        const entry = fullResults[idx];
        const lineCount = entry.item.unpooledEnd - entry.item.start + 1;
        const fairShare = Math.floor(remainingPool / (sortedValid.length - k));
        if (entry.bytes <= fairShare || (lineCount <= 60 && entry.bytes <= 2200 && entry.bytes <= remainingPool)) {
            finalBlocks[idx] = entry.block;
            remainingPool = Math.max(0, remainingPool - entry.bytes);
            continue;
        }
        const fitted = fitItemToByteShare(entry.item, Math.max(400, fairShare), minLinesFloor);
        finalBlocks[idx] = fitted.block;
        remainingPool = Math.max(0, remainingPool - fitted.bytes);
    }
    return { blocks: finalBlocks };
}
export function formatReadSpans(result) {
    const out = [];
    for (const b of result.blocks ?? []) {
        if (b.error) {
            out.push(`✗ ${b.error}`);
            continue;
        }
        out.push(`${b.file}:${b.span} (of ${b.totalLines} lines)\n\`\`\`\n${b.code}\n\`\`\``);
    }
    return `${out.join("\n\n")}\n`;
}
function isStrongTopLexicalHit(r) {
    if (!r.hits.length)
        return false;
    if ((r.coverageStrong ?? 0) >= 0.3 || (r.coverage ?? 0) >= 0.65)
        return true;
    const rawSym = (r.hits[0].title ?? "").split(" · ")[0] ?? "";
    const symBare = (rawSym.split(/[.:#]/).pop() ?? rawSym).toLowerCase();
    const qNorm = String(r.query ?? "").trim().replace(/^`+|`+$/g, "").toLowerCase();
    if (!symBare || !qNorm)
        return false;
    if (qNorm === rawSym.toLowerCase() || qNorm === symBare)
        return true;
    if (symBare.length >= 3) {
        const escaped = symBare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`\\b${escaped}\\b`).test(qNorm);
    }
    return false;
}
function escalationNudge(r) {
    if ((r.mode !== "lexical" && r.mode !== "empty") || r.hits.length > 3)
        return "";
    if (r.hits.length >= 1 && isStrongTopLexicalHit(r))
        return "";
    const n = r.hits.length;
    return (`\n\n[plexer] ${n === 0 ? "no hits" : `only ${plural(n, "hit")}`} — don't re-ask with new wording; switch tool: ` +
        "`plexer grep \"<literal>\"` for every occurrence · `plexer skeleton <file>` for a file's full API · `plexer callers <symbol>` for who-uses.");
}
/** Multi-scope footer: answers a reviewer's two questions — "which
 * sub-projects did this pack come from?" (`matched in:`, displayed-hit counts,
 * biggest first) and "did anything else match that I should know about?"
 * (`also matched:` for scopes gated out of fusion, with the flag to narrow).
 * Empty (zero output) whenever the result isn't a federated multi-scope one. */
function scopeFooterLines(r) {
    if (!r.scopes)
        return [];
    const perScope = new Map();
    for (const h of r.hits)
        if (h.scope !== undefined)
            perScope.set(h.scope, (perScope.get(h.scope) ?? 0) + 1);
    const parts = [...perScope]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([s, c]) => `${scopeLabel(s)} (${c})`);
    const out = parts.length ? [`matched in: ${parts.join(" · ")}`] : [];
    for (const m of r.scopes.alsoMatched)
        out.push(`also matched: ${scopeLabel(m.scope)} — narrow with --in ${scopeLabel(m.scope)}`);
    return out;
}
