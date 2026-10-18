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
import { resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached, loadAskIndexCached } from "../graph/load.js";
import { assertPrefixIndexed, pathUnderPrefix, scopeLabel, scopeOf, scopesHereClause, scopesOfGraph, } from "../graph/scopes.js";
import { normalizePathPrefix, pushMap } from "../util/paths.js";
import { resolveSymbol } from "../graph/traverse.js";
import { combineComparableScopes, rankScopesAndFuse, } from "./fuse.js";
import { rankFilesBounded, } from "./file-rank.js";
import { fileFirstRoundRobin, roundRobinQueues } from "./file-selection.js";
import { personalizedPageRank, personalizedPageRankPrepared, preparePageRankPartitions, } from "./graphrank.js";
import { fileReader, parseSpan, plural, referenceLines, spanRange, spanStart, wordRe } from "../blast/evidence.js";
import { bagLen, counts, stemCounts, stemToken, tokenize } from "./index-file.js";
/** Max source lines to inline per hit when `--full` is enabled. */
const MAX_SPAN_LINES = 80;
/** Max lines to inline contiguously for the top hit (and rank 2) before switching to windowed excerpts. */
const MAX_CONTIGUOUS_TOP_LINES = 65;
const MAX_CONTIGUOUS_SECONDARY_LINES = 24;
/** Max source lines across contiguous windows when excerpting a long (>65 line) symbol. */
const MAX_CRUX_LINES = 30;
/** Number of top hits that receive inlined source when `--source` is used. */
const SOURCE_TOP_HITS = 2;
function loadCorpus(outDir) {
    return { graph: loadGraphCached(outDir), askIndex: loadAskIndexCached(outDir) };
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
export function isTestPath(path) {
    return /(?:^|\/)(?:__tests__|tests?|specs?|bench|benchmarks?|fixtures?|__mocks__)\/|\.(?:test|spec|bench)\.[a-z0-9]+$|_test\.(?:go|py|rb)$|(^|\/)(?:test_[^/]+|conftest)\.py$/i.test(path || "");
}
const TEST_RANK_PENALTY = 0.35;
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
function computeIdf(docBags, queryTerms) {
    const df = new Map();
    if (queryTerms) {
        for (const t of queryTerms) {
            let count = 0;
            for (const bag of docBags) {
                if (bag.has(t))
                    count++;
            }
            if (count > 0)
                df.set(t, count);
        }
        return idfFromDf(df, docBags.length);
    }
    for (const bag of docBags)
        for (const t of bag)
            df.set(t, (df.get(t) ?? 0) + 1);
    return idfFromDf(df, docBags.length);
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
const INCOMING = /\b(caller|callers|calls?\s+into|who\s+calls|what\s+calls|called\s+by|used\s+by)\b/i;
const OUTGOING = /\b(callee|callees|what\s+does\s+[\w.:]+\s+call|calls\s+what|imports?|depends\s+on)\b/i;
const INCOMING_RELS = ["calls", "references", "implements", "extends"];
const OUTGOING_RELS = ["calls", "references", "imports", "implements", "extends"];
const STRUCTURAL_STOPWORDS = new Set([
    "caller", "callers", "callee", "callees", "call", "calls", "called", "calling",
    "into", "from", "what", "who", "where", "which", "how", "when", "does", "used",
    "uses", "using", "import", "imports", "depends", "reference", "references",
    "direct", "all", "every", "across", "function", "functions", "method", "methods",
    "helper", "helpers", "module", "modules", "class", "type", "types", "table",
    "tables", "file", "files", "value", "values", "state", "data", "info", "list",
    "item", "items", "result", "results", "error", "errors", "check", "checks",
    "checking", "target", "source", "client", "server", "shared", "by", "of", "for",
    "to", "in", "on", "the", "a", "an", "and", "or",
]);
/** Split a prose query into word-like tokens, keeping dots so a qualified name
 * ("Cache.get") or package-qualified name ("pkg.Fn") survives as one token —
 * `resolveSymbol`'s own suffix/last-segment matching handles the rest. */
function subjectWords(query) {
    return [...new Set(query.split(/[^A-Za-z0-9_.:]+/).filter((w) => {
        if (!w)
            return false;
        if (w.includes(".") || w.includes(":"))
            return true;
        return !STRUCTURAL_STOPWORDS.has(w.toLowerCase());
    }))];
}
/** Resolve the query's structural subject via {@link resolveSymbol}, trying
 * each word longest-first — the intended subject of a structural query is
 * usually the most specific (longest) identifier-shaped word, never a short
 * verb like "calls" — until one resolves. `tried` is the word that was tried
 * last regardless of outcome, so a caller can name *something* in a fallthrough
 * note even when nothing resolved (e.g. `subjects.length === 0`). This is what
 * makes a qualified/dotted subject like `Cache.get` resolve, where the old
 * plain name-equality lookup (`findSubject`) never matched it.
 *
 * `inPrefix`, when given, filters each word's `resolveSymbol` matches down to
 * nodes under that path prefix BEFORE checking whether any survived — same
 * "narrow the subject resolution" semantics `callers`/`callees`/`impact --in`
 * already have (segment-aware here, via `pathUnderPrefix`). A word that
 * resolves globally but has nothing under the prefix does NOT count as a
 * match; the next (shorter) word is tried instead, same as an unresolved word
 * today — and if nothing survives for ANY word, `subjects.length === 0`
 * naturally falls through to the existing loud fallthrough note. */
function findSubjectNodes(query, graph, inPrefix) {
    const words = subjectWords(query).sort((a, b) => b.length - a.length);
    for (const w of words) {
        let nodes = resolveSymbol(graph, w);
        if (inPrefix)
            nodes = nodes.filter((n) => pathUnderPrefix(n.path, inPrefix));
        if (nodes.length > 0)
            return { nodes, tried: w };
    }
    return { nodes: [], tried: words[0] ?? query };
}
function fallthroughNoteFor(subject) {
    return (`structural index: no entries for '${subject}' — showing lexical matches; ` +
        `for precise edges try plexer callers '${subject}', or plexer grep '${subject}' for every reference (loosen the pattern if it returns nothing)`);
}
function structural(query, graph, limit, inPrefix) {
    const wantsIn = INCOMING.test(query);
    const wantsOut = OUTGOING.test(query);
    if (!wantsIn && !wantsOut)
        return null;
    if (subjectWords(query).length > 2)
        return null;
    const { nodes: subjects, tried } = findSubjectNodes(query, graph, inPrefix);
    if (subjects.length === 0)
        return { fallthroughNote: fallthroughNoteFor(tried) };
    const ids = new Set(subjects.map((n) => n.id));
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const outgoing = wantsOut && !wantsIn; // "what does X call / import" — else default to callers
    const rels = new Set(outgoing ? OUTGOING_RELS : INCOMING_RELS);
    const hits = [];
    const seen = new Set();
    for (const e of graph.edges) {
        if (!rels.has(e.relation))
            continue;
        const anchor = outgoing ? e.source : e.target;
        const other = outgoing ? e.target : e.source;
        if (!ids.has(anchor) || seen.has(other + e.relation))
            continue;
        seen.add(other + e.relation);
        const node = byId.get(other);
        hits.push({
            kind: outgoing ? "callee" : "caller",
            title: node ? node.name : other, // unresolved import target → raw module string
            pointer: node ? `${node.path}:${node.span}` : other,
            snippet: node?.summary?.split("\n")[0].trim() || node?.signature || "",
            relation: e.relation,
            score: 1,
        });
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
function hasTerm(f, t, fStems, qStemOf) {
    if (f.has(t) || f.has(`${t}s`) || (t.endsWith("s") && f.has(t.slice(0, -1))))
        return true;
    if (fStems) {
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
export function strongShare(q, node, doc, idf, dfltIdf, qStemOf) {
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
        if (fields.some((f, i) => hasTerm(f, t, fieldStems?.[i], qStemOf)))
            matched += w;
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
function lexical(query, corpus, limit, graphRank, inPrefix, fileFirst = true, fileComplement = false, fileTopLock = false, includeRankingMetadata = false) {
    // Binary query terms: a word repeated in a pasted issue body counts once, so a
    // ranty description can't linearly amplify an incidental word.
    const q = new Map([...counts(tokenize(query)).keys()].map((t) => [t, 1]));
    const qStemOf = new Map([...q.keys()].map((t) => [t, stemToken(t)]));
    const rawIdentifiers = new Set((query.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length >= 4));
    const graph = corpus.graph;
    // Test-file de-ranking is query-aware: a query that ASKS about tests wants test
    // files on top, so it gets no penalty; every other query wants the real
    // definition first. This stops a test that merely contains the query's literals
    // (e.g. `TestDownloadStall` matching "download stall") from outranking the
    // source it exercises — the "tests ranked above the actual code" trap.
    const wantsTests = /\b(tests?|specs?|coverage|assert(?:ion)?s?|fixtures?|mocks?)\b/i.test(query);
    const testFactor = (path) => (!wantsTests && isTestPath(path) ? TEST_RANK_PENALTY : 1);
    // ── Pass 1: tokenize every scored field once, and collect per-document token
    // bags so IDF can down-weight words that occur across the whole corpus. ──
    let hydratedById = null;
    let rawDocById = null;
    if (corpus.askIndex && graph && corpus.askIndex.docs.length === graph.nodes.length) {
        const hydrated = corpus.askIndex._hydrated;
        if (hydrated) {
            if (graph._askIndexIdCheck !== corpus.askIndex) {
                Object.defineProperty(graph, "_askIndexIdCheckOk", {
                    value: graph.nodes.every((n) => hydrated.byId.has(n.id)),
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
                Object.defineProperty(graph, "_askIndexIdCheck", {
                    value: corpus.askIndex,
                    enumerable: false,
                    configurable: true,
                    writable: true,
                });
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
    const askIndex = hydratedById || rawDocById ? corpus.askIndex : null;
    const graphNodes = inPrefix ? (graph?.nodes ?? []).filter((n) => pathUnderPrefix(n.path, inPrefix)) : (graph?.nodes ?? []);
    const symbolDocs = graphNodes.map((n) => {
        const hd = hydratedById?.get(n.id);
        if (hd) {
            return {
                n,
                name: hd.name,
                path: hd.path,
                body: hd.body,
                nameStems: hd.nameStems,
                pathStems: hd.pathStems,
                bodyStems: hd.bodyStems,
                bodyLen: hd.bodyLen,
            };
        }
        const d = rawDocById?.get(n.id);
        if (d) {
            const name = new Map(d.name);
            const path = new Map(d.path);
            const body = new Map(d.body);
            return {
                n,
                name,
                path,
                body,
                nameStems: stemCounts(name),
                pathStems: stemCounts(path),
                bodyStems: stemCounts(body),
                bodyLen: bagLen(body),
            };
        }
        const name = counts(tokenize(n.name));
        const path = counts(tokenize(n.path));
        const body = counts(tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`));
        return {
            n,
            name,
            path,
            body,
            nameStems: stemCounts(name),
            pathStems: stemCounts(path),
            bodyStems: stemCounts(body),
            bodyLen: bagLen(body),
        };
    });
    const qTerms = [...q.keys()];
    const qLen = qTerms.length;
    const idf = askIndex && !inPrefix
        ? computeIdfFromIndex(askIndex, q.keys())
        : computeIdf(symbolDocs.map((d) => new Set([...d.name.keys(), ...d.path.keys(), ...d.body.keys()])), q.keys());
    const nDocs = askIndex && !inPrefix
        ? askIndex.docCount
        : symbolDocs.length;
    const dfltIdf = Math.log(1 + nDocs);
    const matchedOf = new Map();
    const matchedStrongOf = new Map();
    const selectionGroupOf = new Map();
    // ── Symbols (wiring graph): lexical score per node, keyed by id ──
    const byId = graph?._byId ?? new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    let fallbackDocsById = null;
    const getDoc = (id) => hydratedById?.get(id) ?? (fallbackDocsById ??= new Map(symbolDocs.map((d) => [d.n.id, d]))).get(id);
    const hitCache = new Map();
    const symbolHits = [];
    const baselineSymbolHits = [];
    const baselineHitById = new Map();
    const fileQueueHitsByGroup = new Map();
    const baselineQueueHitsByGroup = new Map();
    const fileGroups = [];
    const needsFileQueues = fileComplement && (fileTopLock || includeRankingMetadata);
    const makeSymbolHit = (id, hitScore, scope) => {
        let base = hitCache.get(id);
        if (!base) {
            const n = byId.get(id);
            if (!n)
                return null;
            const d = getDoc(id);
            base = {
                title: `${n.name} · ${n.kind}`,
                pointer: n.kind === "file" ? n.path : `${n.path}:${n.span}`,
                snippet: n.summary?.split("\n")[0].trim() || n.signature || "",
                matched: d ? matchedIdfShare(q, [d.name, d.path, d.body], idf, dfltIdf, [d.nameStems, d.pathStems, d.bodyStems], qStemOf) : 0,
                matchedStrong: d ? strongShare(q, n, d, idf, dfltIdf, qStemOf) : 0,
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
        matchedOf.set(hit, base.matched);
        matchedStrongOf.set(hit, base.matchedStrong);
        selectionGroupOf.set(hit, base.group);
        return hit;
    };
    const symbolTitle = (id) => {
        const n = byId.get(id);
        return n ? `${n.name} · ${n.kind}` : id;
    };
    const scopes = graph ? scopesOfGraph(graph) : null;
    let scopeMeta;
    const avgBodyLen = askIndex && !inPrefix
        ? askIndex.avgBodyLen
        : symbolDocs.length
            ? symbolDocs.reduce((a, d) => a + d.bodyLen, 0) / symbolDocs.length
            : 0;
    const rawLexicalById = new Map();
    const matchedTermsById = new Map();
    const matchedStrongTermsById = new Map();
    const fileQueryWeights = fileComplement
        ? normalizedQueryWeights(q, idf, dfltIdf)
        : new Map();
    const qAlts = qTerms.map((t) => (t.endsWith("s") ? t.slice(0, -1) : `${t}s`));
    const qStems = qTerms.map((t) => {
        const s = qStemOf.get(t) ?? stemToken(t);
        return s.length >= 4 ? s : "";
    });
    const qIdfs = qTerms.map((t) => idf.get(t) ?? dfltIdf);
    const totalQueryIdf = qIdfs.reduce((a, w) => a + w, 0) || 1;
    const k1 = 1.2;
    const b = 0.75;
    const invAvgDl = 1 / (avgBodyLen || 1);
    const scoreSymbolDocs = (docs) => {
        const out = new Map();
        for (const { n, name, path, body, nameStems, pathStems, bodyStems, bodyLen: dBodyLen } of docs) {
            const effBodyLen = n.kind === "file" ? dBodyLen * 0.35 : Math.max(dBodyLen, avgBodyLen * 0.65);
            const norm = k1 * (1 - b + b * effBodyLen * invAvgDl);
            const slashIdx = n.path ? n.path.lastIndexOf("/") : -1;
            const baseNameLower = (slashIdx >= 0 ? n.path.slice(slashIdx + 1) : (n.path ?? "")).toLowerCase();
            let nameScore = 0;
            let pathScore = 0;
            let bodyScore = 0;
            let matchedCount = 0;
            let matchedIdf = 0;
            let matchedInName = 0;
            let matchedInPath = 0;
            let matched = null;
            let strong = null;
            for (let i = 0; i < qLen; i++) {
                const t = qTerms[i];
                const alt = qAlts[i];
                const stem = qStems[i];
                const wIdf = qIdfs[i];
                const nTf = fastTermCount(name, nameStems, t, alt, stem);
                const pTf = fastTermCount(path, pathStems, t, alt, stem);
                const bTf = fastTermCount(body, bodyStems, t, alt, stem);
                if (nTf === 0 && pTf === 0 && bTf === 0)
                    continue;
                const dirOnlyMatch = pTf > 0 && nTf === 0 && bTf === 0 && !baseNameLower.includes(t) && (!stem || !baseNameLower.includes(stem));
                matchedCount += dirOnlyMatch ? 0.45 : 1;
                matchedIdf += wIdf * (dirOnlyMatch ? 0.45 : 1);
                if (nTf > 0) {
                    matchedInName++;
                    nameScore += Math.min(1, nTf) * 3 * wIdf;
                }
                if (pTf > 0) {
                    if (!dirOnlyMatch)
                        matchedInPath++;
                    pathScore += Math.min(1, pTf) * (dirOnlyMatch ? 0.55 : nTf > 0 ? 1.1 : 2) * wIdf;
                }
                if (bTf > 0)
                    bodyScore += wIdf * ((bTf * (k1 + 1)) / (bTf + norm));
                if (fileComplement) {
                    matched ??= new Set();
                    matched.add(t);
                    if (nTf > 0 && n.kind !== "file") {
                        strong ??= new Set();
                        strong.add(t);
                    }
                }
            }
            if (matchedCount === 0)
                continue;
            let exactCompoundName = false;
            if (nameScore > 0 && n.kind !== "file") {
                if (matchedInName >= 2)
                    nameScore *= 1 + 0.35 * Math.min(3, matchedInName - 1);
                if (rawIdentifiers.size > 0) {
                    const sepIdx = Math.max(n.name.lastIndexOf("#"), n.name.lastIndexOf("."));
                    const bare = (sepIdx >= 0 ? n.name.slice(sepIdx + 1) : n.name).toLowerCase();
                    if (bare.length >= 4 && rawIdentifiers.has(bare)) {
                        nameScore *= matchedInName >= 2 ? 1.65 : 1.25;
                        if (matchedInName >= 2)
                            exactCompoundName = true;
                    }
                }
            }
            if (pathScore > 0) {
                if (matchedInPath >= 2)
                    pathScore *= 1 + 0.25 * Math.min(2, matchedInPath - 1);
                if (rawIdentifiers.size > 0 && baseNameLower) {
                    const dotIdx = baseNameLower.indexOf(".");
                    const fileStem = dotIdx >= 0 ? baseNameLower.slice(0, dotIdx) : baseNameLower;
                    if (fileStem.length >= 4 && rawIdentifiers.has(fileStem))
                        pathScore *= 1.25;
                }
            }
            let raw = nameScore + pathScore + bodyScore;
            if (qLen >= 2) {
                const rawCov = 0.5 * (matchedCount / qLen) + 0.5 * (matchedIdf / totalQueryIdf);
                const cov = exactCompoundName ? Math.max(rawCov, 0.72) : rawCov;
                raw *= 0.2 + 0.8 * Math.pow(cov, 1.35);
            }
            const total = raw * testFactor(n.path);
            out.set(n.id, total);
            if (fileComplement) {
                rawLexicalById.set(n.id, total);
                if (matched)
                    matchedTermsById.set(n.id, matched);
                if (strong)
                    matchedStrongTermsById.set(n.id, strong);
            }
        }
        return out;
    };
    const toFileCandidate = (id, n, lexicalScore, graphScore, rankFactor, baselineScore) => {
        const rawLexical = rawLexicalById.get(id) ?? 0;
        return {
            id,
            file: n?.path ?? "",
            kind: n?.kind === "file" ? "file" : "symbol",
            rawLexical,
            lexical: lexicalScore,
            graph: graphScore,
            rankFactor,
            baselineScore,
            baselineTieKey: symbolTitle(id),
            matchedTerms: matchedTermsById.get(id) ?? new Set(),
            matchedStrongTerms: matchedStrongTermsById.get(id) ?? new Set(),
            eligible: Boolean(n && n.kind !== "file" && rawLexical > 0),
            spanStart: n ? spanStart(n.span, Number.POSITIVE_INFINITY) : undefined,
        };
    };
    const appendFileQueueGroup = (file, leaderScore, scoreFor, scopeFor) => {
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
    };
    if (scopes && scopes.length > 1) {
        const byScope = new Map();
        const scopeById = new Map();
        for (const d of symbolDocs) {
            const s = scopeOf(d.n.path, scopes).prefix;
            scopeById.set(d.n.id, s);
            pushMap(byScope, s, d);
        }
        let pageRankByScope;
        let collapsedComponents = [];
        let collapsedComponentById;
        let collapsedFileByRepresentative;
        const fusion = rankScopesAndFuse([...byScope.keys()].sort(), {
            lex: (s) => scoreSymbolDocs(byScope.get(s)),
            hasIdentifierMatch: (s) => (byScope.get(s) ?? []).some(({ name, path, nameStems, pathStems }) => {
                for (const t of q.keys())
                    if (hasTerm(name, t, nameStems, qStemOf) || hasTerm(path, t, pathStems, qStemOf))
                        return true;
                return false;
            }),
            walk: (s, seeds) => {
                if (!graphRank)
                    return new Map();
                pageRankByScope ??= preparePageRankPartitions(graph, (id) => scopeById.get(id));
                const topology = pageRankByScope?.get(s);
                return topology
                    ? personalizedPageRankPrepared(topology, seeds)
                    : new Map();
            },
            rankFactor: (_s, id) => testFactor(byId.get(id)?.path ?? ""),
            collapseCandidates: fileComplement
                ? (candidates) => {
                    collapsedComponents = [...candidates];
                    collapsedComponentById = new Map(candidates.map((c) => [c.id, c]));
                    const fileCandidates = candidates.map((c) => toFileCandidate(c.id, byId.get(c.id), c.lexical, c.graph, c.rankFactor, c.score));
                    const rankedFiles = rankFilesBounded(fileCandidates, fileQueryWeights);
                    collapsedFileByRepresentative = new Map(rankedFiles.map((file) => [file.representative.id, file]));
                    return rankedFiles.map((file) => ({
                        id: file.representative.id,
                        scope: collapsedComponentById.get(file.representative.id).scope,
                        score: file.score,
                    }));
                }
                : undefined,
        }, GRAPH_WEIGHT, RESCUE_FLOOR);
        if (needsFileQueues) {
            const baselineFusion = combineComparableScopes(collapsedComponents.map(({ id, scope, score }) => ({ id, scope, score })));
            const baselineScoreById = new Map(baselineFusion.ranked.map((ranked) => [ranked.id, ranked.score]));
            const baselineDisplayOrder = (a, b) => b.score - a.score || symbolTitle(a.id).localeCompare(symbolTitle(b.id));
            let baselineTopRanked = baselineFusion.ranked[0];
            for (const ranked of baselineFusion.ranked.slice(1))
                if (baselineTopRanked && baselineDisplayOrder(ranked, baselineTopRanked) < 0)
                    baselineTopRanked = ranked;
            const baselineHitsToBuild = includeRankingMetadata
                ? [...baselineFusion.ranked].sort(baselineDisplayOrder)
                : baselineTopRanked
                    ? [baselineTopRanked]
                    : [];
            for (const ranked of baselineHitsToBuild) {
                const hit = makeSymbolHit(ranked.id, ranked.score, ranked.scope);
                if (hit) {
                    baselineSymbolHits.push(hit);
                    baselineHitById.set(ranked.id, hit);
                }
            }
            for (const ranked of fusion.ranked) {
                const file = collapsedFileByRepresentative?.get(ranked.id);
                if (!file)
                    continue;
                appendFileQueueGroup(
                    file,
                    ranked.score,
                    (member) => baselineScoreById.get(member.id) ?? member.baselineScore,
                    (id) => collapsedComponentById?.get(id)?.scope ?? ranked.scope,
                );
            }
        }
        else {
            for (const ranked of fusion.ranked) {
                const hit = makeSymbolHit(ranked.id, ranked.score, ranked.scope);
                if (hit)
                    symbolHits.push(hit);
            }
        }
        // Label + footer only when federation actually happened (or a scope was
        // gated out and is worth mentioning) — a query matching one scope of a
        // multi-scope repo reads exactly like today.
        if (fusion.federated.length > 1 || fusion.alsoMatched.length > 0)
            scopeMeta = { federated: fusion.federated, alsoMatched: fusion.alsoMatched };
    }
    else {
        // Single-scope: the pre-scopes ranking path, byte-identical output when
        // `--in` is absent (Task 3's regression guarantee: `askIndex && !inPrefix`
        // reduces to plain `askIndex` when `inPrefix` is undefined). `avgBodyLen` is
        // now defined once above and shared with the multi-scope branch.
        const lex = scoreSymbolDocs(symbolDocs);
        let maxLex = 0;
        for (const total of lex.values())
            if (total > maxLex)
                maxLex = total;
        // ── Graph-rank: let connectivity to the matched set reorder and rescue ──
        // `--in` restricts the walk itself, not just the seeds: without a nodeFilter
        // here, a RESCUE_FLOOR-qualifying neighbour OUTSIDE the prefix could still
        // surface, defeating the "filters before scoring" contract.
        const pr = graphRank && graph && lex.size > 0
            ? personalizedPageRank(graph, lex, inPrefix ? { nodeFilter: (id) => pathUnderPrefix(byId.get(id)?.path ?? "", inPrefix) } : {})
            : new Map();
        // Candidate symbols = everything the query word-matched, plus nodes the walk
        // found strongly central even without a word match (RESCUE_FLOOR).
        const candidates = new Set(lex.keys());
        for (const [id, p] of pr)
            if (p >= RESCUE_FLOOR)
                candidates.add(id);
        const singleCandidates = [];
        for (const id of candidates) {
            const n = byId.get(id);
            if (!n)
                continue;
            const lexical = maxLex > 0 ? (lex.get(id) ?? 0) / maxLex : 0;
            const graphScore = pr.get(id) ?? 0;
            const rankFactor = testFactor(n.path);
            // Apply the test penalty after normalization too. Applying it only to the
            // raw lexical score is not enough: if a test is still the strongest raw
            // match, dividing by maxLex restores it to 1.0 and erases the de-rank.
            const baseline = (lexical + GRAPH_WEIGHT * graphScore) * rankFactor;
            if (baseline <= 0)
                continue;
            singleCandidates.push({ id, n, lexical, graph: graphScore, rankFactor, baseline });
        }
        const candidateById = fileComplement
            ? new Map(singleCandidates.map((candidate) => [candidate.id, candidate]))
            : undefined;
        const rankedFiles = fileComplement
            ? rankFilesBounded(singleCandidates.map((c) => toFileCandidate(c.id, c.n, c.lexical, c.graph, c.rankFactor, c.baseline)), fileQueryWeights)
            : undefined;
        if (needsFileQueues && rankedFiles) {
            const baselineCandidateOrder = (a, b) => b.baseline - a.baseline ||
                `${a.n.name} · ${a.n.kind}`.localeCompare(`${b.n.name} · ${b.n.kind}`);
            let baselineTopCandidate = singleCandidates[0];
            for (const candidate of singleCandidates.slice(1))
                if (baselineTopCandidate && baselineCandidateOrder(candidate, baselineTopCandidate) < 0)
                    baselineTopCandidate = candidate;
            const baselineCandidatesToBuild = includeRankingMetadata
                ? [...singleCandidates].sort(baselineCandidateOrder)
                : baselineTopCandidate
                    ? [baselineTopCandidate]
                    : [];
            for (const candidate of baselineCandidatesToBuild) {
                const hit = makeSymbolHit(candidate.id, candidate.baseline);
                if (hit) {
                    baselineSymbolHits.push(hit);
                    baselineHitById.set(candidate.id, hit);
                }
            }
            for (const file of rankedFiles) {
                appendFileQueueGroup(file, file.score, (member) => member.baselineScore);
            }
        }
        else if (rankedFiles) {
            for (const file of rankedFiles) {
                const candidate = candidateById?.get(file.representative.id);
                const hit = candidate ? makeSymbolHit(candidate.id, file.score) : null;
                if (hit)
                    symbolHits.push(hit);
            }
        }
        else {
            for (const candidate of singleCandidates) {
                const hit = makeSymbolHit(candidate.id, candidate.baseline);
                if (hit)
                    symbolHits.push(hit);
            }
        }
    }
    const scored = [...symbolHits];
    scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const baselineScored = needsFileQueues
        ? [...baselineSymbolHits].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        : scored;
    const unlockedGroups = [...fileGroups].sort((a, b) => b.hits[0].score - a.hits[0].score ||
        a.hits[0].title.localeCompare(b.hits[0].title));
    let projectedGroups = unlockedGroups;
    let lockedGroupKey;
    if (fileTopLock && fileFirst && baselineScored[0]) {
        const baselineTop = baselineScored[0];
        const key = selectionGroupOf.get(baselineTop) ?? "locked:top";
        const existing = unlockedGroups.find((group) => group.key === key);
        const topUnlocked = unlockedGroups[0];
        const baselineCov = existing?.coverage ?? matchedOf.get(baselineTop) ?? 0;
        const unlockedCov = topUnlocked?.coverage ?? 0;
        const baselineGroupScore = existing?.hits[0]?.score ?? baselineTop.score;
        const unlockedTopScore = topUnlocked?.hits[0]?.score ?? 0;
        if ((wantsTests || !isTestPath(baselineTop.pointer)) && baselineCov >= unlockedCov && baselineGroupScore >= unlockedTopScore) {
            lockedGroupKey = key;
            const fileQueue = !includeRankingMetadata ? (fileQueueHitsByGroup.get(key)?.() ?? []) : [];
            const baselineQueue = includeRankingMetadata || limit > unlockedGroups.length
                ? baselineQueueHitsByGroup.get(key)?.() ?? baselineScored.filter((hit) => (selectionGroupOf.get(hit) ?? "") === key)
                : fileQueue;
            let lockedLeader = baselineTop;
            if (!includeRankingMetadata && baselineTop.title.endsWith(" · file") && fileQueue[0] && !fileQueue[0].title.endsWith(" · file")) {
                lockedLeader = { ...fileQueue[0], score: baselineTop.score };
                matchedOf.set(lockedLeader, matchedOf.get(fileQueue[0]) ?? matchedOf.get(baselineTop) ?? 0);
                matchedStrongOf.set(lockedLeader, matchedStrongOf.get(fileQueue[0]) ?? matchedStrongOf.get(baselineTop) ?? 0);
                selectionGroupOf.set(lockedLeader, selectionGroupOf.get(fileQueue[0]) ?? key);
            }
            const locked = existing
                ? {
                    ...existing,
                    hits: [
                        lockedLeader,
                        ...baselineQueue.filter((hit) => !sameHit(hit, lockedLeader) && (includeRankingMetadata || !hit.title.endsWith(" · file"))),
                    ],
                }
                : {
                    key,
                    hits: baselineQueue.length ? baselineQueue : [lockedLeader],
                    coverage: matchedOf.get(baselineTop) ?? 0,
                    coverageStrong: matchedStrongOf.get(baselineTop) ?? 0,
                };
            projectedGroups = [
                locked,
                ...unlockedGroups.filter((group) => group.key !== key),
            ];
        }
    }
    // Materialize secondary span queues for the top 3 files (and all files when
    // limit exceeds projectedGroups.length) so strong secondary symbols in the
    // highest-ranked files can surface via score-aware roundRobinQueues.
    if (fileTopLock &&
        fileFirst &&
        !includeRankingMetadata) {
        const materializeAll = limit > projectedGroups.length;
        projectedGroups = projectedGroups.map((group, idx) => {
            if (group.key === lockedGroupKey)
                return group;
            if (!materializeAll && idx >= 3)
                return group;
            const materialize = fileQueueHitsByGroup.get(group.key);
            if (!materialize)
                return group;
            const hits = materialize().filter((h, hIdx) => hIdx === 0 || !h.title.endsWith(" · file"));
            return { ...group, hits };
        });
    }
    // File-aware ranking feeds latent groups to the existing file-first frontier.
    // Leaders are listed first so every file/concept emits once before any
    // secondary span; each group's remaining queue retains baseline order.
    const selected = fileTopLock && fileFirst
        ? roundRobinQueues(projectedGroups.map((group) => group.hits), limit)
        : fileFirst
            ? fileFirstRoundRobin(scored.map((hit, index) => ({
                group: selectionGroupOf.get(hit) ?? `ungrouped:${index}`,
                value: hit,
            })), limit)
            : scored;
    const top = selected[0] ?? scored[0];
    if (fileTopLock && top?.scope && scopeMeta) {
        scopeMeta = {
            federated: [...new Set([top.scope, ...scopeMeta.federated])],
            alsoMatched: scopeMeta.alsoMatched.filter((match) => match.scope !== top.scope),
        };
    }
    const ranking = includeRankingMetadata && needsFileQueues
        ? {
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
            baselineCoverage: baselineScored[0]
                ? matchedOf.get(baselineScored[0]) ?? 0
                : undefined,
            baselineCoverageStrong: baselineScored[0]
                ? matchedStrongOf.get(baselineScored[0]) ?? 0
                : undefined,
        }
        : undefined;
    return {
        query,
        mode: scored.length ? "lexical" : "empty",
        hits: selected.slice(0, limit),
        scopes: scopeMeta,
        coverage: top && q.size > 0 ? matchedOf.get(top) ?? 0 : undefined,
        coverageStrong: top && q.size > 0 ? matchedStrongOf.get(top) ?? 0 : undefined,
        ...(ranking ? { ranking } : {}),
        // Zero hits on a genuinely multi-scope graph names the scopes that exist,
        // so a query that missed everywhere still tells the caller where to look.
        note: scored.length
            ? undefined
            : `no matching nodes — try different words, or \`plexer build\` if plexer/ is empty${scopesHereClause(scopes ?? [])}`,
    };
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
function synthesizeCrux(lines, path, from, to, qTerms, qStems, maxContiguous = MAX_CONTIGUOUS_TOP_LINES, excludeRanges = null, maxCruxLines = MAX_CRUX_LINES) {
    if (!lines)
        return null;
    const start = Math.max(1, from);
    const end = Math.min(lines.length, to);
    const slice = lines.slice(start - 1, end);
    if (slice.length === 0)
        return null;
    const isExcluded = (lineNo) =>
        Boolean(excludeRanges && excludeRanges.some((r) => lineNo >= r.start && lineNo <= r.end));
    const blockCommentLines = new Set();
    let inBlockComment = false;
    for (let i = 0; i < slice.length; i++) {
        const t = slice[i].trim();
        if (t.startsWith("--[[") || t.startsWith("/*"))
            inBlockComment = true;
        if (inBlockComment)
            blockCommentLines.add(i);
        if (inBlockComment && (t.includes("]]") || t.includes("*/")))
            inBlockComment = false;
    }
    if (slice.length <= maxContiguous && (!excludeRanges || excludeRanges.length === 0) && blockCommentLines.size <= 16) {
        return slice.map((line, idx) => `L${start + idx}: ${line}`).join("\n");
    }
    const chosen = new Set([0]);
    if (slice.length > 1 && slice[0].includes("(") && !slice[0].includes(")"))
        chosen.add(1);
    const sigCount = chosen.size;
    const lineTokSets = slice.map((raw) => new Set(tokenize(raw)));
    const tokLineFreq = new Map();
    for (const sToks of lineTokSets) {
        for (const tok of sToks) {
            tokLineFreq.set(tok, (tokLineFreq.get(tok) ?? 0) + 1);
        }
    }
    const scoredLines = [];
    let lastReturnIdx = -1;
    for (let i = sigCount; i < slice.length; i++) {
        if (isExcluded(start + i))
            continue;
        const raw = slice[i];
        const trimmed = raw.trim();
        if (!trimmed || /^[\s};,)\]]*$/.test(trimmed) || /^end[\s,)]*$/.test(trimmed))
            continue;
        const isComment = blockCommentLines.has(i) || /^(\/\/|\/\*|\*|--|#)/.test(trimmed);
        let s = (1 - i / slice.length) * 0.2;
        const lineToks = lineTokSets[i];
        let qLineMatches = 0;
        for (const tok of lineToks) {
            const lineFreq = tokLineFreq.get(tok) ?? 1;
            const rarity = slice.length > 200
                ? 0.4 + 3.2 / Math.pow(lineFreq, 0.75)
                : 1 + 1.5 / Math.sqrt(lineFreq);
            if (qTerms.has(tok) || qTerms.has(`${tok}s`) || (tok.endsWith("s") && qTerms.has(tok.slice(0, -1)))) {
                s += (isComment ? 3.2 : 3.5) * rarity;
                qLineMatches++;
            }
            else {
                const st = stemToken(tok);
                if (st.length >= 4 && qStems.has(st)) {
                    s += (isComment ? 2.7 : 3.0) * rarity;
                    qLineMatches++;
                }
            }
        }
        if (isComment && qLineMatches < 2)
            continue;
        if (/\b(return|throw|yield|error|assert)\b/.test(trimmed)) {
            s += 1.5;
            if (/\breturn\b/.test(trimmed))
                lastReturnIdx = i;
        }
        if (/\b(?:[A-Z0-9_]*(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)[A-Z0-9_]*)\b/.test(trimmed))
            s += 2.5;
        if (/\b(?:[A-Za-z_]\w*\s*(?:==|~=|!=|===|!==)\s*(?:true|false|nil|null|0|[A-Za-z_]\w*)|\w+\s*=\s*(?:true|false|nil|null|0))\b/.test(trimmed))
            s += 1.5;
        if (/\b(if|else\s+if|switch|match|for|while|await)\b|[A-Za-z0-9_]+\s*\(/.test(trimmed))
            s += 1.0;
        scoredLines.push({ idx: i, score: s });
    }
    scoredLines.sort((a, b) => b.score - a.score || a.idx - b.idx);
    for (const p of scoredLines) {
        if (chosen.size >= maxCruxLines)
            break;
        chosen.add(p.idx);
        const lineText = (slice[p.idx] ?? "").trim();
        const isBranch = /\b(?:if|elseif|else\s+if)\b/.test(lineText);
        const opensTable = /\b(?:return|type|interface)\b/.test(lineText) && lineText.endsWith("{");
        const isChainBlock = slice.length > 200 && p.score >= 12.0;
        if (isChainBlock) {
            for (let off = -11; off <= 5; off++) {
                const cIdx = p.idx + off;
                if (cIdx >= sigCount && cIdx < slice.length && chosen.size < maxCruxLines) {
                    chosen.add(cIdx);
                }
            }
        }
        else if (p.score >= 2.5 || isBranch || opensTable) {
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
            if (p.score >= 3.0 && p.idx - 1 >= sigCount && chosen.size < maxCruxLines) {
                chosen.add(p.idx - 1);
                if (p.idx - 2 >= sigCount && chosen.size < maxCruxLines && /\b(?:if|elseif|else\s+if)\b/.test(slice[p.idx - 2] ?? ""))
                    chosen.add(p.idx - 2);
            }
        }
    }
    if (lastReturnIdx >= 0) {
        chosen.add(lastReturnIdx);
        const retLine = (slice[lastReturnIdx] ?? "").trim();
        if (retLine.endsWith("{")) {
            for (let rOff = 1; rOff <= 14 && lastReturnIdx + rOff < slice.length; rOff++) {
                if (!isExcluded(start + lastReturnIdx + rOff))
                    chosen.add(lastReturnIdx + rOff);
                if ((slice[lastReturnIdx + rOff] ?? "").trim().startsWith("}"))
                    break;
            }
        }
        else if (/^return\s+[A-Za-z_]\w*$/.test(retLine)) {
            let addedProps = 0;
            for (let pIdx = lastReturnIdx - 1; pIdx >= Math.max(sigCount, lastReturnIdx - 30) && addedProps < 5; pIdx--) {
                if (/^\s*[A-Za-z_]\w*\.[A-Za-z_]\w*\s*=\s*[A-Za-z_]\w*\s*$/.test(slice[pIdx] ?? "")) {
                    chosen.add(pIdx);
                    addedProps++;
                }
            }
        }
    }
    for (let i = 0; i < slice.length && chosen.size < Math.min(maxCruxLines, slice.length); i++) {
        if (!isExcluded(start + i) && !blockCommentLines.has(i))
            chosen.add(i);
    }
    const preSorted = [...chosen].sort((a, b) => a - b);
    const maxGapToClose = maxContiguous >= 50 ? 8 : 3;
    for (let k = 1; k < preSorted.length; k++) {
        const prev = preSorted[k - 1];
        const curr = preSorted[k];
        const gap = curr - prev - 1;
        if (gap >= 1 && gap <= maxGapToClose) {
            let canClose = true;
            for (let gIdx = prev + 1; gIdx < curr; gIdx++) {
                if (isExcluded(start + gIdx)) {
                    canClose = false;
                    break;
                }
            }
            if (canClose) {
                for (let gIdx = prev + 1; gIdx < curr; gIdx++) {
                    chosen.add(gIdx);
                }
            }
        }
    }
    if (preSorted.length > 0 && preSorted[preSorted.length - 1] >= slice.length - 4 && !isExcluded(end)) {
        for (let gIdx = preSorted[preSorted.length - 1] + 1; gIdx < slice.length; gIdx++) {
            if (!isExcluded(start + gIdx))
                chosen.add(gIdx);
        }
    }
    const sorted = [...chosen].sort((a, b) => a - b);
    const outLines = [];
    for (let k = 0; k < sorted.length; k++) {
        const idx = sorted[k];
        const prevIdx = k > 0 ? sorted[k - 1] : -1;
        if (k > 0 && idx > prevIdx + 1) {
            const gapStart = start + prevIdx + 1;
            const gapEnd = start + idx - 1;
            outLines.push(
                gapStart === gapEnd
                    ? `  … (line L${gapStart} omitted)`
                    : `  … (lines L${gapStart}-L${gapEnd} omitted)`,
            );
        }
        outLines.push(`L${start + idx}: ${slice[idx]}`);
    }
    if (sorted[sorted.length - 1] < slice.length - 1) {
        const gapStart = start + sorted[sorted.length - 1] + 1;
        outLines.push(`  … (lines L${gapStart}-L${end} omitted)`);
    }
    return `${outLines.join("\n")}\n… (excerpt of ${path}:L${start}-L${end}, ${slice.length} lines — pass --full for whole span)`;
}
/** Attach inlined source to top hits whose pointer is a real `path:span`.
 * When `full` is off, inline contiguous source (or windowed excerpts with explicit
 * `…` gap markers on long symbols) for the top `SOURCE_TOP_HITS` hits while keeping
 * lower hits compact. */
function inlineSource(root, hits, graph, full, query = "", opts = {}) {
    const cruxByPointer = new Map();
    const fileSpanByPath = new Map();
    const nodeByPointer = new Map();
    const byId = graph?._byId ?? new Map();
    const outCallsById = new Map();
    const inCallsById = new Map();
    if (graph) {
        for (const n of graph.nodes) {
            if (!byId.has(n.id))
                byId.set(n.id, n);
            const ptr = n.kind === "file" ? n.path : `${n.path}:${n.span}`;
            if (!nodeByPointer.has(ptr) || n.kind !== "file")
                nodeByPointer.set(ptr, n);
            if (!full && n.crux?.code)
                cruxByPointer.set(`${n.path}:${n.span}`, n.crux.code);
            if (n.kind === "file" && n.span)
                fileSpanByPath.set(n.path, n.span);
        }
        for (const e of graph.edges) {
            if (e.relation !== "calls")
                continue;
            pushMap(outCallsById, e.source, e.target);
            pushMap(inCallsById, e.target, e.source);
        }
    }
    const qTerms = new Set(tokenize(query));
    const qStems = new Set([...qTerms].map(stemToken).filter((s) => s.length >= 4));
    const readLines = fileReader(root);
    const maxHitsToInline = opts.maxHitsToInline ?? SOURCE_TOP_HITS;
    const maxTotalBytes = opts.maxSourceBytes ?? (full ? 5200 : 3850);
    let totalInlinedBytes = 0;
    let inlinedHitCount = 0;
    const shownPointers = opts.seenPointers ?? new Set();
    const constsByPath = new Map();
    const nodesByPath = new Map();
    if (graph) {
        for (const n of graph.nodes) {
            if (n.kind !== "file" && n.path)
                pushMap(nodesByPath, n.path, n);
        }
    }
    const getFileConsts = (path, lines) => {
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
    };
    const primaryMeta = new Map();
    const deferredFourthHits = [];
    const buildNeedlesFor = (name) => {
        if (!name)
            return [];
        const out = [wordRe(name)];
        const sep = Math.max(name.lastIndexOf("."), name.lastIndexOf(":"), name.lastIndexOf("#"));
        if (sep >= 0 && sep + 1 < name.length) {
            const bare = name.slice(sep + 1);
            if (bare.length >= 2)
                out.push(wordRe(bare));
        }
        return out;
    };
    const isMultiQuery = Boolean(opts.maxHitsToInline && opts.maxHitsToInline <= 2);
    const wantsCallSites = /\b(callers?|called|calls|invokes?|invoked|who\s+uses|used\s+by|blast\s+radius|refactor|references?|where\s+is\b.*\bused)\b/i.test(query);
    for (let i = 0; i < hits.length; i++) {
        const h = hits[i];
        const node = nodeByPointer.get(h.pointer);
        if (node && node.kind !== "file" && !h.related) {
            const rel = [];
            const seenRel = new Set([node.id]);
            const maxOutRel = i === 0 ? 4 : 2;
            const maxTotalRel = i === 0 ? 8 : i === 1 ? 4 : 2;
            for (const tid of outCallsById.get(node.id) ?? []) {
                if (rel.length >= maxOutRel || seenRel.has(tid))
                    continue;
                const tn = byId.get(tid);
                if (!tn || tn.kind === "file")
                    continue;
                seenRel.add(tid);
                rel.push(`→ ${tn.name} (${tn.path}:${tn.span})`);
            }
            const directCallerNodes = [];
            for (const sid of inCallsById.get(node.id) ?? []) {
                if (seenRel.has(sid))
                    continue;
                const sn = byId.get(sid);
                if (!sn)
                    continue;
                seenRel.add(sid);
                if (!isTestPath(sn.path)) {
                    directCallerNodes.push({ caller: sn, via: null });
                }
                if (sn.kind !== "file" && rel.length < maxTotalRel) {
                    rel.push(`← ${sn.name} (${sn.path}:${sn.span})`);
                }
            }
            if (rel.length > 0)
                h.related = rel;
            const namedCallersOnly = directCallerNodes.filter((c) => c.caller.kind !== "file");
            const activeCallers = wantsCallSites ? directCallerNodes : namedCallersOnly;
            if (i === 0 && activeCallers.length > 0 && activeCallers.length <= 20) {
                if (wantsCallSites && activeCallers.length <= 3) {
                    for (const { caller } of [...activeCallers]) {
                        if (caller.kind === "file")
                            continue;
                        for (const sid2 of inCallsById.get(caller.id) ?? []) {
                            if (seenRel.has(sid2) || activeCallers.length >= 12)
                                continue;
                            const sn2 = byId.get(sid2);
                            if (!sn2 || isTestPath(sn2.path))
                                continue;
                            seenRel.add(sid2);
                            activeCallers.push({ caller: sn2, via: caller });
                        }
                    }
                }
                const targetNeedles = buildNeedlesFor(node.name);
                const targetSpan = spanRange(node.span);
                const maxQuotesTotal = wantsCallSites ? 26 : (isMultiQuery ? 3 : 5);
                const callerSpansByPath = new Map();
                for (const { caller } of activeCallers) {
                    if (caller.kind === "file")
                        continue;
                    const sr = spanRange(caller.span);
                    if (sr)
                        pushMap(callerSpansByPath, caller.path, sr);
                }
                const callSites = [];
                for (const { caller, via } of activeCallers.slice(0, maxQuotesTotal)) {
                    const needles = via ? [...buildNeedlesFor(via.name), ...targetNeedles] : targetNeedles;
                    const excludeRanges = [];
                    if (caller.path === node.path && targetSpan && caller.id !== node.id) {
                        excludeRanges.push(targetSpan);
                    }
                    if (via && caller.path === via.path && caller.id !== via.id) {
                        const vr = spanRange(via.span);
                        if (vr)
                            excludeRanges.push(vr);
                    }
                    const cRange = spanRange(caller.span);
                    const cLen = cRange ? cRange.end - cRange.start : 0;
                    for (const sr of callerSpansByPath.get(caller.path) ?? []) {
                        if (caller.kind === "file" || (cRange && sr.start >= cRange.start && sr.end <= cRange.end && sr.end - sr.start < cLen)) {
                            excludeRanges.push(sr);
                        }
                    }
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
                    if (quotes.length > 0) {
                        for (const q of quotes) {
                            const txt = q.text.trim();
                            const hdr = q.header && q.header.n !== q.n ? ` [in L${q.header.n}: ${q.header.text.trim().slice(0, 48)}]` : "";
                            callSites.push(`${callerLabel}${viaTag}${hdr} → L${q.n}: ${txt.length > 110 ? `${txt.slice(0, 107)}…` : txt}`);
                        }
                    }
                    else if (caller.kind !== "file") {
                        callSites.push(`${callerLabel}${viaTag}`);
                    }
                    if (callSites.length >= maxQuotesTotal)
                        break;
                }
                if (callSites.length > 0) {
                    h.callSites = callSites;
                }
            }
        }
        if (shownPointers.has(h.pointer)) {
            if (i === 0)
                inlinedHitCount++;
            continue;
        }
        const effectiveMaxHits = node?.kind === "file" ? maxHitsToInline + 1 : maxHitsToInline;
        if (inlinedHitCount >= effectiveMaxHits || totalInlinedBytes >= maxTotalBytes)
            continue;
        let s = parseSpan(h.pointer);
        if (!s && fileSpanByPath.has(h.pointer)) {
            s = parseSpan(`${h.pointer}:${fileSpanByPath.get(h.pointer)}`);
        }
        if (!s)
            continue;
        const crux = cruxByPointer.get(h.pointer);
        if (crux) {
            h.code = `${crux}\n… (excerpt — full definition at ${h.pointer}; rerun with --full)`;
            totalInlinedBytes += Buffer.byteLength(h.code, "utf8");
            shownPointers.add(h.pointer);
            inlinedHitCount++;
            continue;
        }
        const lines = readLines(s.path);
        const spanLen = s.end - s.start + 1;
        const isUnrequestedLargeType = node?.kind === "type" && spanLen > 24 && !qTerms.has("type") && !qTerms.has((node.name ?? "").toLowerCase());
        if (isUnrequestedLargeType || (inlinedHitCount > 0 && ((spanLen > 500 && node?.kind !== "file") || (node?.kind === "type" && spanLen > 20))))
            continue;
        const effStart = lines && spanLen <= 6 ? Math.max(1, s.start - 3) : s.start;
        const effEnd = lines && spanLen <= 6 ? Math.min(lines.length, s.end + 3) : s.end;
        const maxSpan = inlinedHitCount < 2 ? MAX_SPAN_LINES : 40;
        const isDominantTop = inlinedHitCount === 0 && (hits.length === 1 || (hits[0]?.score ?? 0) >= 1.15 * (hits[1]?.score ?? 0) || opts.maxHitsToInline === 1);
        const maxContiguous = inlinedHitCount === 0
            ? (isDominantTop ? 80 : isMultiQuery ? 60 : MAX_CONTIGUOUS_TOP_LINES)
            : MAX_CONTIGUOUS_SECONDARY_LINES;
        const maxCrux = node?.kind === "file" ? (spanLen > 200 ? 22 : 16) : inlinedHitCount === 0 ? (isMultiQuery ? 28 : MAX_CRUX_LINES) : 18;
        const hitQTerms = new Set(qTerms);
        for (const oh of hits.slice(0, 6)) {
            if (oh.pointer.startsWith(`${s.path}:`)) {
                for (const t of tokenize(oh.title.split(" · ")[0] ?? ""))
                    hitQTerms.add(t);
            }
        }
        let code = full
            ? sliceSpan(lines, s.path, effStart, effEnd, maxSpan)
            : synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, maxContiguous, null, maxCrux);
        if (!code)
            continue;
        if (!full && lines && spanLen <= 3 && lines.length > 15) {
            const fileCrux = synthesizeCrux(lines, s.path, 1, lines.length, hitQTerms, qStems, 18);
            if (fileCrux && fileCrux !== code) {
                code = `${code}\n// module context (${s.path}):\n${fileCrux}`;
            }
        }
        if (lines) {
            const fileConsts = getFileConsts(s.path, lines);
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
                if (inExcerpt || inSpanAndImportant) {
                    prepended.push(`L${c.lineNo}: ${c.text}`);
                }
            }
            if (prepended.length > 0) {
                code = `${prepended.join("\n")}\n${code}`;
            }
        }
        if (inlinedHitCount >= 3) {
            deferredFourthHits.push({ h, code });
            inlinedHitCount++;
            continue;
        }
        const helperReserve = inlinedHitCount > 0 ? Math.min(950, Math.floor(maxTotalBytes * 0.28)) : 0;
        const effectiveBudget = maxTotalBytes - helperReserve;
        if ((inlinedHitCount > 0 || isMultiQuery) && totalInlinedBytes + Buffer.byteLength(code, "utf8") > effectiveBudget) {
            if (isMultiQuery && inlinedHitCount === 0) {
                code = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, 34, null, 20);
            }
            else if (inlinedHitCount > 0 && !full) {
                code = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, 16, null, 12);
            }
            if (!code || (inlinedHitCount > 0 && totalInlinedBytes + Buffer.byteLength(code, "utf8") > effectiveBudget))
                continue;
        }
        h.code = code;
        shownPointers.add(h.pointer);
        totalInlinedBytes += Buffer.byteLength(code, "utf8");
        primaryMeta.set(inlinedHitCount, { h, node, s, lines, spanLen, effStart, effEnd, maxContiguous, hitQTerms });
        inlinedHitCount++;
    }
    for (const [i, meta] of primaryMeta) {
        if (i > 2 || totalInlinedBytes >= maxTotalBytes)
            break;
        const { h, node, s, lines, spanLen, effStart, effEnd, maxContiguous, hitQTerms } = meta;
        if (node && node.kind !== "file" && lines && h.code) {
            const sameFileCands = new Map();
            const addNeighbours = (fromId, hop, allowCallers, viaTinyCallee = false) => {
                const outIds = outCallsById.get(fromId) ?? [];
                const inIds = allowCallers ? (inCallsById.get(fromId) ?? []) : [];
                for (const nid of [...outIds, ...inIds]) {
                    if (nid === node.id || sameFileCands.has(nid))
                        continue;
                    const nn = byId.get(nid);
                    if (!nn || nn.kind === "file")
                        continue;
                    const isSameFile = nn.path === s.path;
                    if (!isSameFile && !outIds.includes(nid))
                        continue;
                    const ptr = `${nn.path}:${nn.span}`;
                    if (shownPointers.has(ptr))
                        continue;
                    const isCallee = outIds.includes(nid);
                    sameFileCands.set(nid, { node: nn, ptr, hop, isSameFile, isCallee, viaTinyCallee: viaTinyCallee && isCallee, fromGraph: true });
                }
            };
            addNeighbours(node.id, 1, spanLen <= 55, false);
            if (sameFileCands.size === 0 || node.kind === "type" || node.kind === "interface" || i === 0) {
                const isTypeNode = node.kind === "type" || node.kind === "interface";
                const hadGraphCands = sameFileCands.size > 0;
                const typeBodyToks = isTypeNode ? new Set(tokenize(lines.slice(Math.max(0, s.start - 1), Math.min(lines.length, s.end)).join(" "))) : null;
                for (const nn of nodesByPath.get(s.path) ?? []) {
                    if (nn.id === node.id || sameFileCands.has(nn.id))
                        continue;
                    const ptr = `${nn.path}:${nn.span}`;
                    if (shownPointers.has(ptr))
                        continue;
                    let nameMatch = 0;
                    for (const t of new Set(tokenize(nn.name))) {
                        if (qTerms.has(t) || (stemToken(t).length >= 4 && qStems.has(stemToken(t))))
                            nameMatch++;
                    }
                    if (hadGraphCands && !isTypeNode && nameMatch === 0)
                        continue;
                    const nameToks = tokenize(`${nn.name} ${nn.signature ?? ""} ${nn.summary ?? ""}`);
                    let m = nameMatch;
                    if (!hadGraphCands || isTypeNode) {
                        m = 0;
                        for (const t of new Set(nameToks)) {
                            if (qTerms.has(t) || (stemToken(t).length >= 4 && qStems.has(stemToken(t))))
                                m++;
                        }
                    }
                    const isTypeMemberOrCtor = Boolean(typeBodyToks && nn.kind === "function" && (typeBodyToks.has(nn.name.toLowerCase()) || /^(?:new|create)$/.test(nn.name)));
                    if (m >= 1 || isTypeMemberOrCtor) {
                        sameFileCands.set(nn.id, { node: nn, ptr, hop: 1, isSameFile: true, isCallee: !hadGraphCands || isTypeMemberOrCtor, viaTinyCallee: isTypeMemberOrCtor, fromGraph: isTypeMemberOrCtor });
                    }
                }
            }
            if (i <= 2) {
                for (const [nid, cand] of [...sameFileCands]) {
                    if (cand.isSameFile) {
                        const cs = parseSpan(`${cand.node.path}:${cand.node.span}`);
                        const cLen = cs ? cs.end - cs.start + 1 : 999;
                        const isNested = Boolean(cs && cs.start >= s.start && cs.end <= s.end);
                        if (cand.isSameFile && cand.hop === 1 && (isNested || cand.isCallee)) {
                            addNeighbours(nid, isNested || cLen <= 16 ? 1 : 2, isNested || cLen <= 16, isNested || cLen <= 8 || (cand.isCallee && cLen <= 90));
                        }
                    }
                }
            }
            if (sameFileCands.size > 0) {
                const scoredHelpers = [];
                for (const cand of sameFileCands.values()) {
                    const cs = parseSpan(`${cand.node.path}:${cand.node.span}`);
                    if (!cs)
                        continue;
                    const hSpanLen = cs.end - cs.start + 1;
                    const maxSameFileHelperSpan = (node.kind === "type" || node.kind === "interface") && /^(?:new|create)$/.test(cand.node.name) ? 260 : 120;
                    if (cand.isSameFile ? hSpanLen > maxSameFileHelperSpan : hSpanLen > 28)
                        continue;
                    const isNested = Boolean(cand.isSameFile && cs.start > effStart && cs.end <= effEnd);
                    if (isNested && spanLen <= maxContiguous)
                        continue;
                    const candLines = cand.isSameFile ? lines : readLines(cand.node.path);
                    if (!candLines)
                        continue;
                    let qMatchCount = 0;
                    let hScore = (cand.hop === 1 ? 2 : 0) + (cand.fromGraph ? 3 : 0);
                    if (hSpanLen <= 22)
                        hScore += hSpanLen <= 8 ? 5.5 : 2;
                    if (cand.isSameFile) {
                        hScore += 2.0;
                        if (cand.fromGraph)
                            hScore += 3.5;
                        if (cand.isCallee && cand.hop === 1 && cand.fromGraph)
                            hScore += 4.5;
                    }
                    else if (cand.isCallee && cand.hop === 1 && hSpanLen <= 12) {
                        hScore += 6.5;
                    }
                    if (cand.isSameFile || cand.node.name.length >= 4 || (cand.isCallee && hSpanLen <= 12)) {
                        for (const nTok of new Set(tokenize(cand.node.name))) {
                            if (qTerms.has(nTok))
                                hScore += 8;
                            else if (stemToken(nTok).length >= 4 && qStems.has(stemToken(nTok)))
                                hScore += 6;
                        }
                    }
                    if (!cand.isSameFile && cand.isCallee && hSpanLen <= 12 && cand.node.summary) {
                        for (const sTok of new Set(tokenize(cand.node.summary))) {
                            if (qTerms.has(sTok) || (stemToken(sTok).length >= 4 && qStems.has(stemToken(sTok))))
                                hScore += 2.5;
                        }
                    }
                    const bodySlice = candLines.slice(Math.max(0, cs.start - 1), Math.min(candLines.length, cs.end)).join(" ");
                    if (/\b(?:[A-Z0-9_]*(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)[A-Z0-9_]*)\b/.test(bodySlice)) {
                        hScore += 2.5;
                    }
                    const helperText = `${cand.node.name} ${cand.node.summary ?? ""} ${bodySlice}`;
                    for (const tok of new Set(tokenize(helperText))) {
                        if (qTerms.has(tok)) {
                            hScore += 3;
                            qMatchCount++;
                        }
                        else {
                            const st = stemToken(tok);
                            if (st.length >= 4 && qStems.has(st)) {
                                hScore += 2.5;
                                qMatchCount++;
                            }
                        }
                    }
                    if (cand.isSameFile && hSpanLen > 52 && (cand.hop !== 1 || (qMatchCount < 2 && !cand.viaTinyCallee && !(cand.fromGraph && cand.isCallee && qMatchCount >= 1))))
                        continue;
                    if (qMatchCount === 0 && !(cand.fromGraph && cand.isSameFile) && !(cand.isSameFile && (hSpanLen <= 12 || (cand.viaTinyCallee && hSpanLen <= 90))))
                        continue;
                    scoredHelpers.push({ ...cand, cs, candLines, hSpanLen, hScore });
                }
                scoredHelpers.sort((a, b) => b.hScore - a.hScore || a.cs.start - b.cs.start);
                for (const hCand of scoredHelpers.slice(0, 3)) {
                    for (const t of tokenize(hCand.node.name))
                        hitQTerms.add(t);
                }
                const maxHelpers = opts.maxHitsToInline ? (i === 0 ? 2 : 1) : i === 0 ? 2 : 1;
                const maxHelperBytesForHit = opts.maxHitsToInline ? (i === 0 ? 1300 : 800) : i === 0 ? 1500 : 800;
                let hitHelperBytes = 0;
                const helperBlocks = [];
                const nestedRanges = [];
                for (let hIdx = 0; hIdx < Math.min(scoredHelpers.length, maxHelpers); hIdx++) {
                    const hCand = scoredHelpers[hIdx];
                    if (hCand.hScore < 3.5)
                        continue;
                    const hStart = hCand.hSpanLen <= 18
                        ? Math.max(1, hCand.cs.start - (hCand.node.summary ? Math.min(5, hCand.node.summary.split("\n").length + 1) : 2))
                        : hCand.cs.start;
                    const hContig = hIdx === 0 && hCand.hSpanLen <= 38 ? 38 : 26;
                    let hCode = full
                        ? sliceSpan(hCand.candLines, hCand.node.path, hStart, hCand.cs.end, 45)
                        : synthesizeCrux(hCand.candLines, hCand.node.path, hStart, hCand.cs.end, hitQTerms, qStems, hContig);
                    if (hCode) {
                        const label = hCand.isSameFile ? "same-file helper" : "cross-file callee";
                        let block = `// ${label}: ${hCand.node.name} (${hCand.ptr})\n${hCode}`;
                        let bLen = Buffer.byteLength(block, "utf8");
                        if (!full && (totalInlinedBytes + bLen > maxTotalBytes || hitHelperBytes + bLen > maxHelperBytesForHit)) {
                            const compactH = synthesizeCrux(hCand.candLines, hCand.node.path, hStart, hCand.cs.end, hitQTerms, qStems, 14, null, 11);
                            if (compactH) {
                                block = `// ${label}: ${hCand.node.name} (${hCand.ptr})\n${compactH}`;
                                bLen = Buffer.byteLength(block, "utf8");
                            }
                        }
                        if (totalInlinedBytes + bLen > maxTotalBytes || hitHelperBytes + bLen > maxHelperBytesForHit)
                            continue;
                        shownPointers.add(hCand.ptr);
                        helperBlocks.push(block);
                        totalInlinedBytes += bLen;
                        hitHelperBytes += bLen;
                        if (hCand.isSameFile && hCand.cs.start > effStart && hCand.cs.end <= effEnd) {
                            nestedRanges.push({ start: hCand.cs.start, end: hCand.cs.end });
                        }
                    }
                }
                let baseCode = h.code;
                if (nestedRanges.length > 0 && !full) {
                    const dedupedParent = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, maxContiguous, nestedRanges);
                    if (dedupedParent) {
                        const fileConsts = getFileConsts(s.path, lines);
                        const spanSliceText = lines.slice(Math.max(0, effStart - 1), Math.min(lines.length, effEnd)).join("\n");
                        const prepended = [];
                        for (const c of fileConsts) {
                            if (dedupedParent.includes(`L${c.lineNo}:`))
                                continue;
                            const re = new RegExp(`\\b${c.name}\\b`);
                            const inExcerpt = re.test(dedupedParent);
                            const inSpanAndImportant = !inExcerpt &&
                                re.test(spanSliceText) &&
                                (/(?:LIMIT|MAX|MIN|PASS|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD|SYMBOL)/.test(c.name) ||
                                    tokenize(c.name).some((t) => qTerms.has(t) || qStems.has(stemToken(t))));
                            if (inExcerpt || inSpanAndImportant) {
                                prepended.push(`L${c.lineNo}: ${c.text}`);
                            }
                        }
                        baseCode = prepended.length > 0 ? `${prepended.join("\n")}\n${dedupedParent}` : dedupedParent;
                    }
                }
                if (helperBlocks.length > 0) {
                    const helperJoined = helperBlocks.join("\n\n");
                    const helperCodeNoComments = helperJoined
                        .split("\n")
                        .map((l) => l.replace(/(?:--|\s\/\/).*$/, ""))
                        .join("\n");
                    let combined = `${baseCode}\n\n${helperJoined}`;
                    const fileConsts = getFileConsts(s.path, lines);
                    const extraConsts = [];
                    for (const c of fileConsts) {
                        if (combined.includes(`L${c.lineNo}:`))
                            continue;
                        if (new RegExp(`\\b${c.name}\\b`).test(helperCodeNoComments)) {
                            extraConsts.push(`L${c.lineNo}: ${c.text}`);
                        }
                    }
                    if (extraConsts.length > 0) {
                        combined = `${extraConsts.join("\n")}\n${combined}`;
                    }
                    h.code = combined;
                }
            }
        }
    }
    for (const { h, code } of deferredFourthHits) {
        if (totalInlinedBytes + Buffer.byteLength(code, "utf8") <= maxTotalBytes) {
            h.code = code;
            shownPointers.add(h.pointer);
            totalInlinedBytes += Buffer.byteLength(code, "utf8");
        }
    }
    return totalInlinedBytes;
}
export function ask(dir, query, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const limit = opts.limit ?? (opts.source ? 5 : 8);
    const fetchLimit = opts.seenPointers ? limit + opts.seenPointers.size : limit;
    const corpus = loadCorpus(outDir);
    const graphRank = opts.graphRank ?? true;
    const fileFirst = opts.fileFirst ?? true;
    const fileTopLock = opts.fileTopLock ?? fileFirst;
    const fileComplement = (opts.fileComplement ?? false) || fileTopLock;
    const inPrefix = opts.in ? normalizePathPrefix(opts.in) : undefined;
    if (inPrefix && corpus.graph)
        assertPrefixIndexed(corpus.graph, inPrefix);
    const outcome = corpus.graph ? structural(query, corpus.graph, fetchLimit, inPrefix) : null;
    let result;
    if (outcome && "result" in outcome) {
        result = outcome.result;
    }
    else {
        result = lexical(query, corpus, fetchLimit, graphRank, inPrefix, fileFirst, fileComplement, fileTopLock, opts.includeRankingMetadata ?? false);
        if (outcome && "fallthroughNote" in outcome) {
            result.note = result.note ? `${outcome.fallthroughNote}\n${result.note}` : outcome.fallthroughNote;
        }
    }
    if (opts.seenPointers && result.hits.length > 0) {
        const filtered = result.hits.filter((h) => !opts.seenPointers.has(h.pointer));
        result.hits = (filtered.length > 0 ? filtered : result.hits).slice(0, limit);
    }
    if (opts.source) {
        const allHits = result.ranking
            ? [
                ...result.hits,
                ...result.ranking.groups.flatMap((group) => group.hits),
                ...result.ranking.groups.flatMap((group) => group.baselineHits ?? []),
                ...result.ranking.baseline.map((entry) => entry.hit),
            ]
            : result.hits;
        result.usedSourceBytes = inlineSource(root, [...new Set(allHits)], corpus.graph, opts.full ?? false, query, opts);
    }
    if (opts.seenPointers) {
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
/** Signatures-only view of one file, straight from the wiring graph — the
 * cheapest way to understand a file's API surface (~10× less than reading it).
 * `file` is matched as an exact repo-relative path, then as a basename. */
export function skeleton(dir, file, opts = {}) {
    const outDir = contextDirFor(resolve(dir), opts.contextDir);
    const graph = loadGraphCached(outDir);
    if (!graph)
        return { file, entries: [], note: "no wiring graph — run `plexer build` first" };
    const normFile = String(file ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
    const suffix = `/${normFile}`;
    const exact = [];
    const bySuffix = new Map();
    for (const n of graph.nodes) {
        if (n.path === file || n.path === normFile) {
            if (n.kind !== "file")
                exact.push(n);
            bySuffix.set(n.path, exact);
        }
        else if (n.path.endsWith(suffix)) {
            let list = bySuffix.get(n.path);
            if (!list) {
                list = [];
                bySuffix.set(n.path, list);
            }
            if (n.kind !== "file")
                list.push(n);
        }
    }
    if (!exact.length && bySuffix.size === 0) {
        const lowerNorm = normFile.toLowerCase();
        const lowerSuffix = suffix.toLowerCase();
        for (const n of graph.nodes) {
            const lp = n.path.toLowerCase();
            if (lp === lowerNorm) {
                if (n.kind !== "file")
                    exact.push(n);
                bySuffix.set(n.path, exact);
            }
            else if (lp.endsWith(lowerSuffix)) {
                let list = bySuffix.get(n.path);
                if (!list) {
                    list = [];
                    bySuffix.set(n.path, list);
                }
                if (n.kind !== "file")
                    list.push(n);
            }
        }
    }
    let defs = exact;
    if (!defs.length) {
        if (bySuffix.size > 1) {
            const files = [...bySuffix.keys()].sort();
            if (opts.allMatches) {
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
        const [only] = bySuffix.values();
        if (only)
            defs = only;
    }
    if (!defs.length)
        return { file, entries: [], note: "no definitions indexed for this file" };
    defs.sort((a, b) => spanStart(a.span, 0) - spanStart(b.span, 0));
    return {
        file: defs[0].path,
        entries: defs.map(toSkeletonEntry),
    };
}
/** Render a {@link SkeletonResult} as compact markdown. */
export function formatSkeleton(r) {
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
            const lines = fileEntries.length > 30
                ? renderLines(fileEntries, 90, 60, true)
                : renderLines(fileEntries, 110, 90, false);
            return [secHead, ...lines].join("\n");
        });
        return `${sections.join("\n\n")}\n`;
    }
    const head = `plexer skeleton — ${r.file}`;
    if (!r.entries?.length)
        return `${head}\n\n${r.note ?? r.error ?? "no definitions."}\n`;
    let lines = r.entries.length > 30 ? renderLines(r.entries, 90, 60, true) : renderLines(r.entries, 110, 90, false);
    let out = `${head}\n${lines.join("\n")}\n`;
    if (out.length > 6000) {
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
/** Render an {@link AskResult} as a compact markdown context pack. */
export function formatAsk(r) {
    const head = `plexer ask — "${r.query}"  (${r.mode})`;
    const noteBlock = r.note
        ? r.note
            .split("\n")
            .map((l) => (l.startsWith("structural index:") ? `⚠ ${l}` : l))
            .join("\n")
        : "";
    if (r.hits.length === 0) {
        return `${head}\n\n${noteBlock || "no matches."}${escalationNudge(r)}\n`;
    }
    const lines = noteBlock ? [head, "", noteBlock, ""] : [head, ""];
    if (r.mode === "structural") {
        for (const h of r.hits) {
            const tail = h.snippet && !isRedundantSnippet(h.snippet, h.code) ? ` — ${h.snippet}` : "";
            lines.push(`- ${h.title}  ${h.pointer}  (${h.relation})${tail}`);
            if (h.code)
                lines.push("", "```", h.code, "```", "");
        }
    }
    else {
        r.hits.forEach((h, i) => {
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
                for (const cs of h.callSites) {
                    lines.push(`     ← ${cs}`);
                }
            }
            if (h.code)
                lines.push("", "```", h.code, "```");
            lines.push("");
        });
        lines.push(...scopeFooterLines(r));
    }
    const body = lines.join("\n").trimEnd();
    return body + escalationNudge(r) + "\n";
}
function parseReadSpanSpec(spec) {
    const trimmed = String(spec ?? "").trim();
    const m = /^(.*?)(?::L?(\d+)(?:-L?(\d+))?)?$/.exec(trimmed);
    if (!m || !m[1])
        return null;
    const rawPath = m[1].replace(/\\/g, "/").replace(/^\/+/, "");
    const start = m[2] !== undefined ? Math.max(1, Number(m[2])) : 1;
    const end = m[3] !== undefined ? Math.max(start, Number(m[3])) : m[2] !== undefined ? start + 30 : 120;
    return { raw: trimmed, file: rawPath, start, end, hasExplicitRange: m[2] !== undefined };
}
/** Read one or more `<file>[:L<start>[-L<end>]]` spans (matching exact repo-relative paths
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
        ? [...new Set(graph.nodes.map((n) => n.path).filter(Boolean))].sort()
        : [];
    const resolvePath = (fileQuery) => {
        if (read(fileQuery))
            return fileQuery;
        const suffix = `/${fileQuery}`;
        const matches = indexedPaths.filter((p) => p === fileQuery || p.endsWith(suffix));
        if (matches.length === 1)
            return matches[0];
        const lower = fileQuery.toLowerCase();
        const lowerSuffix = suffix.toLowerCase();
        const ciMatches = indexedPaths.filter((p) => p.toLowerCase() === lower || p.toLowerCase().endsWith(lowerSuffix));
        if (ciMatches.length === 1)
            return ciMatches[0];
        return matches[0] ?? ciMatches[0] ?? fileQuery;
    };
    const blocks = [];
    for (const rawSpec of specs) {
        const parsed = parseReadSpanSpec(rawSpec);
        if (!parsed) {
            blocks.push({ spec: rawSpec, error: `invalid span "${rawSpec}"` });
            continue;
        }
        const resolvedFile = resolvePath(parsed.file);
        const lines = read(resolvedFile);
        if (!lines) {
            blocks.push({ spec: rawSpec, file: resolvedFile, error: `cannot read "${resolvedFile}"` });
            continue;
        }
        const start = Math.max(1, Math.min(parsed.start, lines.length));
        const end = Math.max(start, Math.min(parsed.hasExplicitRange ? parsed.end : Math.min(lines.length, 120), lines.length));
        const slice = [];
        for (let ln = start; ln <= end; ln++) {
            slice.push(`L${ln}: ${lines[ln - 1]}`);
        }
        blocks.push({
            spec: rawSpec,
            file: resolvedFile,
            span: `L${start}-L${end}`,
            totalLines: lines.length,
            code: slice.join("\n"),
        });
    }
    return { blocks };
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
function escalationNudge(r) {
    if ((r.mode !== "lexical" && r.mode !== "empty") || r.hits.length > 3)
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
