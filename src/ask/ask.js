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
import { basename, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { assertPrefixIndexed, normalizePathPrefix, pathUnderPrefix, pushMap, scopeLabel, scopeOf, scopesHereClause, scopesOfGraph, } from "../util/paths.js";
import { resolveSymbol } from "../util/id.js";
import { combineComparableScopes, rankScopesAndFuse, } from "./fuse.js";
import { rankFilesBounded, } from "./file-rank.js";
import { fileFirstRoundRobin, roundRobinQueues } from "./file-selection.js";
import { personalizedPageRank, personalizedPageRankPrepared, preparePageRankPartitions, } from "./graphrank.js";
import { fileReader, isSensitiveOrDotPath, needlesForName, parseSpan, plural, referenceLines, spanRange, spanStart, wordRe } from "../util/span.js";
import { bagLen, counts, loadAskIndexCached, loadGraphCached, stemCounts, stemToken, tokenize } from "./index-file.js";
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
    return /(?:^|\/)(?:__tests__|tests?|testdata|specs?|bench|benchmarks?|fixtures?|__mocks__|mocks?)\/|\.(?:test|spec|bench|mock)\.[a-z0-9]+$|_(?:test|spec|bench|mock)\.(?:go|py|rb|rs|luau|lua|ts|js|tsx|jsx|mjs|cjs)$|(?:^|\/)(?:test_[^/]+|mock_[^/]+|conftest)\.(?:py|go|rb|rs|luau|lua|ts|js)$/i.test(path || "");
}
export function isGeneratedPath(path) {
    return /\.pb\.(?:go|ts|js|cc|h)$|_pb2(?:_grpc)?\.py$|(?:^|\/|\.)(?:generated|__generated__|gen)\.[a-z0-9]+$|(?:\b|^)(?:generated|__generated__)\//i.test(path || "");
}
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
function structuralAdjacency(graph, outgoing) {
    const prop = outgoing ? "_structAdjOut" : "_structAdjIn";
    if (graph[prop])
        return graph[prop];
    const rels = new Set(outgoing ? OUTGOING_RELS : INCOMING_RELS);
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
    const wantsIn = INCOMING.test(query);
    const wantsOut = OUTGOING.test(query);
    if (!wantsIn && !wantsOut)
        return null;
    if (subjectWords(query).length > 2)
        return null;
    const { nodes: subjects, tried } = findSubjectNodes(query, graph, inPrefix);
    if (subjects.length === 0)
        return { fallthroughNote: fallthroughNoteFor(tried) };
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const outgoing = wantsOut && !wantsIn; // "what does X call / import" — else default to callers
    const adj = structuralAdjacency(graph, outgoing);
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
function buildSymbolDocRecord(n, hydratedById, rawDocById) {
    const slashIdx = n.path ? n.path.lastIndexOf("/") : -1;
    const baseNameLower = (slashIdx >= 0 ? n.path.slice(slashIdx + 1) : (n.path ?? "")).toLowerCase();
    const extDotIdx = baseNameLower.lastIndexOf(".");
    const fileStemLower = extDotIdx >= 0 ? baseNameLower.slice(0, extDotIdx) : baseNameLower;
    const ownerLower = n.owner ? n.owner.toLowerCase() : "";
    const singleWordMethod = Boolean(ownerLower && !n.name.includes("_") && !/[A-Z]/.test(n.name.slice(1)));
    let spanLines = 1;
    if (n.span) {
        const dash = n.span.indexOf("-");
        const a = Number(n.span.slice(n.span[0] === "L" ? 1 : 0, dash >= 0 ? dash : undefined));
        const b = dash >= 0 ? Number(n.span.slice(dash + (n.span[dash + 1] === "L" ? 2 : 1))) : a;
        if (b >= a && a > 0)
            spanLines = b - a + 1;
    }
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
            spanLines,
            baseNameLower,
            fileStemLower,
            ownerLower,
            singleWordMethod,
        };
    }
    const d = rawDocById?.get(n.id);
    const name = d ? new Map(d.name) : counts(tokenize(n.name));
    const path = d ? new Map(d.path) : counts(tokenize(n.path));
    const body = d ? new Map(d.body) : counts(tokenize(`${n.signature ?? ""} ${n.summary ?? ""} ${n.body_text ?? ""}`));
    return {
        n,
        name,
        path,
        body,
        nameStems: stemCounts(name),
        pathStems: stemCounts(path),
        bodyStems: stemCounts(body),
        bodyLen: bagLen(body),
        spanLines,
        baseNameLower,
        fileStemLower,
        ownerLower,
        singleWordMethod,
    };
}
function prepareLexicalSymbolDocs(corpus, graph, inPrefix) {
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
    let symbolDocs;
    if (!inPrefix && graph && hydratedById && graph._symbolDocsAskIndex === corpus.askIndex && graph._symbolDocsNodeLen === graphNodes.length) {
        symbolDocs = graph._symbolDocs;
    }
    else {
        symbolDocs = graphNodes.map((n) => buildSymbolDocRecord(n, hydratedById, rawDocById));
        if (!inPrefix && graph && hydratedById) {
            Object.defineProperty(graph, "_symbolDocs", { value: symbolDocs, enumerable: false, configurable: true, writable: true });
            Object.defineProperty(graph, "_symbolDocsAskIndex", { value: corpus.askIndex, enumerable: false, configurable: true, writable: true });
            Object.defineProperty(graph, "_symbolDocsNodeLen", { value: graphNodes.length, enumerable: false, configurable: true, writable: true });
        }
    }
    return { hydratedById, askIndex, symbolDocs };
}
function applyLexicalCompoundBoosts(n, nameScore, pathScore, matchedInName, matchedInPath, matchedCount, baseNameLower, ownerLower, qState) {
    let exactCompoundName = false;
    const { qLen, query, rawIdentifiers, identLikeWords, rawFileNames } = qState;
    if (nameScore > 0 && n.kind !== "file") {
        if (matchedInName >= 2) {
            const corroborated = qLen < 5 || matchedCount > matchedInName || matchedInPath > 0 || matchedInName >= 3;
            nameScore *= 1 + (corroborated ? 0.35 : 0.12) * Math.min(3, matchedInName - 1);
        }
        if (rawIdentifiers.size > 0) {
            const sepIdx = Math.max(n.name.lastIndexOf("#"), n.name.lastIndexOf("."));
            const bare = (sepIdx >= 0 ? n.name.slice(sepIdx + 1) : n.name).toLowerCase();
            const qual = ownerLower ? `${ownerLower}.${bare}` : "";
            if ((bare.length >= 4 && rawIdentifiers.has(bare)) || (qual && rawIdentifiers.has(qual))) {
                const isQualMatch = Boolean(qual && rawIdentifiers.has(qual));
                const isSingleTokenBare = tokenize(bare).length === 1;
                const isCodeIdent = !isSingleTokenBare || Boolean(identLikeWords?.has(bare));
                const isExactFullName = isQualMatch || matchedInName >= 2 || (isSingleTokenBare && isCodeIdent && (qLen <= 3 || matchedCount * 2 >= qLen));
                nameScore *= isQualMatch ? 1.85 : isExactFullName ? 1.65 : isCodeIdent ? 1.25 : 1.08;
                if (isExactFullName)
                    exactCompoundName = true;
                if (matchedInName >= 3 && bare.endsWith("error"))
                    nameScore *= 0.62;
            }
        }
    }
    if (pathScore > 0) {
        if (matchedInPath >= 2)
            pathScore *= 1 + 0.25 * Math.min(2, matchedInPath - 1);
        if (baseNameLower) {
            if (rawFileNames.has(baseNameLower)) {
                pathScore *= 4.0;
                exactCompoundName = true;
            }
            else if (rawIdentifiers.size > 0) {
                const dotIdx = baseNameLower.indexOf(".");
                const fileStem = dotIdx >= 0 ? baseNameLower.slice(0, dotIdx) : baseNameLower;
                const fileStemRoot = stemToken(fileStem);
                const hasFileStemInQuery = (fileStem.length >= 4 && rawIdentifiers.has(fileStem)) ||
                    (fileStem.length >= 3 && fileStemRoot.length >= 3 && qState.qStems?.includes(fileStemRoot));
                if (hasFileStemInQuery) {
                    const bareLower = n.name.toLowerCase();
                    const isPrimaryModule = (n.kind !== "file" && (bareLower === fileStem || (fileStemRoot.length >= 4 && stemToken(bareLower) === fileStemRoot))) ||
                        (n.kind === "file" && matchedInPath >= 1 && matchedCount >= 3 && !/[a-z][A-Z]|[._]/.test(query));
                    pathScore *= isPrimaryModule ? 2.1 : 1.25;
                    if (isPrimaryModule && n.kind === "file")
                        nameScore *= 1.5;
                    if (fileStem.length >= 4 && isPrimaryModule && matchedCount >= 3)
                        exactCompoundName = true;
                }
            }
        }
    }
    return { nameScore, pathScore, exactCompoundName };
}
function scoreLexicalSymbolDocs(docs, ctx) {
    const { qState, avgBodyLen, invAvgDl, testFactor, fileComplement, rawLexicalById, matchedTermsById, matchedStrongTermsById } = ctx;
    const { qTerms, qAlts, qStems, qIdfs, qLen, totalQueryIdf } = qState;
    const k1 = 1.2;
    const b = 0.75;
    const out = new Map();
    for (const { n, name, path, body, nameStems, pathStems, bodyStems, bodyLen: dBodyLen, spanLines, baseNameLower, fileStemLower, ownerLower, singleWordMethod } of docs) {
        const effBodyLen = n.kind === "file" ? Math.min(dBodyLen * 0.35, 420) : Math.max(dBodyLen, avgBodyLen * 0.65, (spanLines ?? 1) * 3.5);
        const norm = k1 * (1 - b + b * effBodyLen * invAvgDl);
        const isIndexFile = /^(?:init|index|mod)$/.test(fileStemLower);
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
            const rawNTf = fastTermCount(name, nameStems, t, alt, stem);
            const oTf = rawNTf === 0 && singleWordMethod && (ownerLower === t || ownerLower === alt || (stem && ownerLower === stem) || (t.length >= 4 && ownerLower.endsWith(t))) ? 0.85 : 0;
            const nTf = rawNTf || oTf;
            const pTf = fastTermCount(path, pathStems, t, alt, stem);
            const bTf = fastTermCount(body, bodyStems, t, alt, stem);
            if (nTf === 0 && pTf === 0 && bTf === 0)
                continue;
            const inFileStem = isIndexFile || fileStemLower.includes(t) || (stem && fileStemLower.includes(stem)) || (fileStemLower === "prop" && t.startsWith("prop"));
            const dirOnlyMatch = pTf > 0 && nTf === 0 && bTf === 0 && !inFileStem;
            matchedCount += dirOnlyMatch ? 0.45 : 1;
            matchedIdf += wIdf * (dirOnlyMatch ? 0.45 : 1);
            if (nTf > 0) {
                matchedInName++;
                nameScore += Math.min(1, nTf) * 3 * wIdf;
            }
            if (pTf > 0) {
                if (inFileStem)
                    matchedInPath++;
                pathScore += Math.min(1, pTf) * (dirOnlyMatch ? 0.55 : !inFileStem && nTf === 0 ? 0.85 : nTf > 0 ? 1.1 : 2) * wIdf;
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
        const boosted = applyLexicalCompoundBoosts(
            n, nameScore, pathScore, matchedInName, matchedInPath, matchedCount, baseNameLower, ownerLower, qState,
        );
        let raw = boosted.nameScore + boosted.pathScore + bodyScore;
        if (qLen >= 2) {
            const rawCov = 0.5 * (matchedCount / qLen) + 0.5 * (matchedIdf / totalQueryIdf);
            const cov = boosted.exactCompoundName ? Math.max(rawCov, 0.72) : rawCov;
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
function getOrBuildMultiScopeCache(corpus, graph, inPrefix, hydratedById, symbolDocs, scopes) {
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
function rankMultiScopeLexical(ctx, scopes) {
    const { corpus, graph, inPrefix, hydratedById, symbolDocs, q, qStemOf, graphRank, byId, testFactor, fileComplement, toFileCandidate, fileQueryWeights, needsFileQueues, symbolTitle, includeRankingMetadata, makeSymbolHit, baselineSymbolHits, baselineHitById, symbolHits } = ctx;
    let { byScope, scopeById, pageRankByScope } = getOrBuildMultiScopeCache(corpus, graph, inPrefix, hydratedById, symbolDocs, scopes);
    let collapsedComponents = [];
    let collapsedComponentById;
    let collapsedFileByRepresentative;
    const fusion = rankScopesAndFuse([...byScope.keys()].sort(), {
        lex: (s) => scoreLexicalSymbolDocs(byScope.get(s), ctx),
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
            return topology ? personalizedPageRankPrepared(topology, seeds) : new Map();
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
            : baselineTopRanked ? [baselineTopRanked] : [];
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
            appendLexicalFileQueueGroup(
                ctx,
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
    return fusion.federated.length > 1 || fusion.alsoMatched.length > 0
        ? { federated: fusion.federated, alsoMatched: fusion.alsoMatched }
        : undefined;
}
function rankSingleScopeLexical(ctx) {
    const { symbolDocs, graphRank, graph, inPrefix, byId, testFactor, fileComplement, toFileCandidate, fileQueryWeights, needsFileQueues, includeRankingMetadata, makeSymbolHit, baselineSymbolHits, baselineHitById, symbolHits } = ctx;
    const lex = scoreLexicalSymbolDocs(symbolDocs, ctx);
    let maxLex = 0;
    for (const total of lex.values())
        if (total > maxLex)
            maxLex = total;
    const pr = graphRank && graph && lex.size > 0
        ? personalizedPageRank(graph, lex, inPrefix ? { nodeFilter: (id) => pathUnderPrefix(byId.get(id)?.path ?? "", inPrefix) } : {})
        : new Map();
    const candidates = new Set(lex.keys());
    for (const [id, p] of pr)
        if (p >= RESCUE_FLOOR)
            candidates.add(id);
    const singleCandidates = [];
    for (const id of candidates) {
        const n = byId.get(id);
        if (!n)
            continue;
        const lexicalScore = maxLex > 0 ? (lex.get(id) ?? 0) / maxLex : 0;
        const graphScore = pr.get(id) ?? 0;
        const rankFactor = testFactor(n.path);
        const baseline = (lexicalScore + GRAPH_WEIGHT * graphScore) * rankFactor;
        if (baseline <= 0)
            continue;
        singleCandidates.push({ id, n, lexical: lexicalScore, graph: graphScore, rankFactor, baseline });
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
            : baselineTopCandidate ? [baselineTopCandidate] : [];
        for (const candidate of baselineCandidatesToBuild) {
            const hit = makeSymbolHit(candidate.id, candidate.baseline);
            if (hit) {
                baselineSymbolHits.push(hit);
                baselineHitById.set(candidate.id, hit);
            }
        }
        for (const file of rankedFiles) {
            appendLexicalFileQueueGroup(ctx, file, file.score, (member) => member.baselineScore);
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
function applyFileTopLockAndProjectGroups(ctx, unlockedGroups, baselineScored, limit) {
    const { fileTopLock, fileFirst, wantsTests, includeRankingMetadata, selectionGroupOf, matchedOf, matchedStrongOf, fileQueueHitsByGroup, baselineQueueHitsByGroup } = ctx;
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
            matchedOf.set(lockedLeader, locked.coverage);
            matchedStrongOf.set(lockedLeader, locked.coverageStrong);
            projectedGroups = [
                locked,
                ...unlockedGroups.filter((group) => group.key !== key),
            ];
        }
    }
    if (fileTopLock && fileFirst && !includeRankingMetadata) {
        const materializeAll = limit > projectedGroups.length;
        projectedGroups = projectedGroups.map((group, idx) => {
            if (group.key === lockedGroupKey || (!materializeAll && idx >= 3))
                return group;
            const materialize = fileQueueHitsByGroup.get(group.key);
            if (!materialize)
                return group;
            const hits = materialize().filter((h, hIdx) => hIdx === 0 || !h.title.endsWith(" · file"));
            return { ...group, hits };
        });
    }
    return projectedGroups;
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
function createLexicalSymbolHitMaker(byId, getDoc, q, idf, dfltIdf, qStemOf, matchedOf, matchedStrongOf, selectionGroupOf) {
    const hitCache = new Map();
    return (id, hitScore, scope) => {
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
}
function buildLexicalRankingContext(query, corpus, graphRank, inPrefix, fileFirst, fileComplement, fileTopLock, includeRankingMetadata) {
    const q = new Map([...counts(tokenize(query)).keys()].map((t) => [t, 1]));
    const qStemOf = new Map([...q.keys()].map((t) => [t, stemToken(t)]));
    const rawIdentifiers = new Set([
        ...(query.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter((w) => w.length >= 4),
        ...(query.toLowerCase().match(/[a-z0-9_]+(?:\.[a-z0-9_]+)+/g) ?? []),
    ]);
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
    const rawFileNames = new Set(query.toLowerCase().match(/\b[a-z0-9_-]+\.(?:py|go|js|ts|tsx|jsx|luau|rs)\b/g) ?? []);
    const graph = corpus.graph;
    const wantsTests = /\b(tests?|specs?|coverage|assert(?:ion)?s?|fixtures?|mocks?)\b/i.test(query);
    const testFactor = (path) => (!wantsTests && cachedTestPath(path) ? TEST_RANK_PENALTY : cachedGenPath(path) ? GENERATED_RANK_PENALTY : 1);
    const { hydratedById, askIndex, symbolDocs } = prepareLexicalSymbolDocs(corpus, graph, inPrefix);
    const qTerms = [...q.keys()];
    const idf = askIndex && !inPrefix
        ? computeIdfFromIndex(askIndex, q.keys())
        : computeIdf(symbolDocs.map((d) => new Set([...d.name.keys(), ...d.path.keys(), ...d.body.keys()])), q.keys());
    const nDocs = askIndex && !inPrefix ? askIndex.docCount : symbolDocs.length;
    const dfltIdf = Math.log(1 + nDocs);
    const matchedOf = new Map();
    const matchedStrongOf = new Map();
    const selectionGroupOf = new Map();
    const byId = graph?._byId ?? new Map((graph?.nodes ?? []).map((n) => [n.id, n]));
    let fallbackDocsById = null;
    const getDoc = (id) => hydratedById?.get(id) ?? (fallbackDocsById ??= new Map(symbolDocs.map((d) => [d.n.id, d]))).get(id);
    const makeSymbolHit = createLexicalSymbolHitMaker(byId, getDoc, q, idf, dfltIdf, qStemOf, matchedOf, matchedStrongOf, selectionGroupOf);
    const symbolTitle = (id) => {
        const n = byId.get(id);
        return n ? `${n.name} · ${n.kind}` : id;
    };
    const avgBodyLen = askIndex && !inPrefix
        ? askIndex.avgBodyLen
        : symbolDocs.length ? symbolDocs.reduce((a, d) => a + d.bodyLen, 0) / symbolDocs.length : 0;
    const rawLexicalById = new Map();
    const matchedTermsById = new Map();
    const matchedStrongTermsById = new Map();
    const qIdfs = qTerms.map((t) => idf.get(t) ?? dfltIdf);
    const qState = {
        query, qTerms, qLen: qTerms.length,
        qAlts: qTerms.map((t) => (t.endsWith("s") ? t.slice(0, -1) : `${t}s`)),
        qStems: qTerms.map((t) => {
            const s = qStemOf.get(t) ?? stemToken(t);
            return s.length >= 4 ? s : "";
        }),
        qIdfs, totalQueryIdf: qIdfs.reduce((a, w) => a + w, 0) || 1,
        rawIdentifiers, identLikeWords, rawFileNames,
    };
    const toFileCandidate = (id, n, lexicalScore, graphScore, rankFactor, baselineScore) => {
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
    };
    return {
        corpus, graph, inPrefix, hydratedById, symbolDocs, q, qStemOf, qState, avgBodyLen,
        invAvgDl: 1 / (avgBodyLen || 1), graphRank, byId, testFactor, wantsTests, fileFirst,
        fileComplement, fileTopLock, includeRankingMetadata,
        needsFileQueues: fileComplement && (fileTopLock || includeRankingMetadata),
        fileQueryWeights: fileComplement ? normalizedQueryWeights(q, idf, dfltIdf) : new Map(),
        rawLexicalById, matchedTermsById, matchedStrongTermsById,
        makeSymbolHit, symbolTitle, toFileCandidate,
        symbolHits: [], baselineSymbolHits: [], baselineHitById: new Map(),
        fileQueueHitsByGroup: new Map(), baselineQueueHitsByGroup: new Map(), fileGroups: [],
        matchedOf, matchedStrongOf, selectionGroupOf,
        scopes: graph ? scopesOfGraph(graph) : null,
    };
}
function lexical(query, corpus, limit, graphRank, inPrefix, fileFirst = true, fileComplement = false, fileTopLock = false, includeRankingMetadata = false) {
    const ctx = buildLexicalRankingContext(query, corpus, graphRank, inPrefix, fileFirst, fileComplement, fileTopLock, includeRankingMetadata);
    const { scopes, q, matchedOf, matchedStrongOf, selectionGroupOf } = ctx;
    let scopeMeta = scopes && scopes.length > 1 ? rankMultiScopeLexical(ctx, scopes) : undefined;
    if (!scopes || scopes.length <= 1)
        rankSingleScopeLexical(ctx);
    const scored = [...ctx.symbolHits].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    const baselineScored = ctx.needsFileQueues
        ? [...ctx.baselineSymbolHits].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
        : scored;
    const unlockedGroups = [...ctx.fileGroups].sort((a, b) => b.hits[0].score - a.hits[0].score ||
        a.hits[0].title.localeCompare(b.hits[0].title));
    const projectedGroups = applyFileTopLockAndProjectGroups(ctx, unlockedGroups, baselineScored, limit);
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
    const ranking = includeRankingMetadata && ctx.needsFileQueues
        ? buildLexicalRankingMetadata(unlockedGroups, baselineScored, selectionGroupOf, matchedOf, matchedStrongOf, limit)
        : undefined;
    return {
        query,
        mode: scored.length ? "lexical" : "empty",
        hits: selected.slice(0, limit),
        scopes: scopeMeta,
        coverage: top && q.size > 0 ? matchedOf.get(top) ?? 0 : undefined,
        coverageStrong: top && q.size > 0 ? matchedStrongOf.get(top) ?? 0 : undefined,
        ...(ranking ? { ranking } : {}),
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
function findCruxBlockCommentLines(slice) {
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
    return blockCommentLines;
}
function scoreCruxInteriorLines(slice, start, sigCount, blockCommentLines, qTerms, qStems, isExcluded) {
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
    return { scoredLines, lastReturnIdx };
}
function expandCruxScoredWindows(slice, start, sigCount, chosen, scoredLines, lastReturnIdx, maxCruxLines, isExcluded) {
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
                if (cIdx >= sigCount && cIdx < slice.length && chosen.size < maxCruxLines)
                    chosen.add(cIdx);
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
}
function closeCruxGapsAndFormat(slice, path, start, end, chosen, blockCommentLines, maxContiguous, maxCruxLines, isExcluded) {
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
                for (let gIdx = prev + 1; gIdx < curr; gIdx++)
                    chosen.add(gIdx);
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
    const blockCommentLines = findCruxBlockCommentLines(slice);
    if (slice.length <= maxContiguous && (!excludeRanges || excludeRanges.length === 0) && blockCommentLines.size <= 16) {
        return slice.map((line, idx) => `L${start + idx}: ${line}`).join("\n");
    }
    const chosen = new Set([0]);
    if (slice.length > 1 && slice[0].includes("(") && !slice[0].includes(")"))
        chosen.add(1);
    const sigCount = chosen.size;
    const { scoredLines, lastReturnIdx } = scoreCruxInteriorLines(
        slice, start, sigCount, blockCommentLines, qTerms, qStems, isExcluded,
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
function getOrBuildInlineSourceIndex(graph, full) {
    if (graph && !full && graph._inlineSourceIndex && graph._inlineSourceIndex.nodeLen === graph.nodes.length && graph._inlineSourceIndex.edgeLen === graph.edges.length) {
        return graph._inlineSourceIndex;
    }
    const cruxByPointer = new Map();
    const fileSpanByPath = new Map();
    const nodeByPointer = new Map();
    const byId = graph?._byId ?? new Map();
    const outCallsById = new Map();
    const inCallsById = new Map();
    const nodesByPath = new Map();
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
            if (n.kind !== "file" && n.path)
                pushMap(nodesByPath, n.path, n);
        }
        for (const e of graph.edges) {
            if (e.relation !== "calls" && e.relation !== "imports")
                continue;
            pushMap(outCallsById, e.source, e.target);
            pushMap(inCallsById, e.target, e.source);
        }
        if (!full) {
            Object.defineProperty(graph, "_inlineSourceIndex", {
                value: {
                    nodeLen: graph.nodes.length,
                    edgeLen: graph.edges.length,
                    cruxByPointer,
                    fileSpanByPath,
                    nodeByPointer,
                    byId,
                    outCallsById,
                    inCallsById,
                    nodesByPath,
                },
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
    }
    return { cruxByPointer, fileSpanByPath, nodeByPointer, byId, outCallsById, inCallsById, nodesByPath };
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
function expandTransitiveCallSiteCallers(node, activeCallers, seenRel, outCallsById, inCallsById, byId) {
    const outCallees = (outCallsById.get(node.id) ?? []).map((tid) => byId.get(tid)).filter((tn) => tn && tn.kind !== "file" && tn.name === node.name);
    for (const callee of outCallees) {
        for (const sid of inCallsById.get(callee.id) ?? []) {
            if (seenRel.has(sid) || activeCallers.length >= 14)
                continue;
            const sn = byId.get(sid);
            if (!sn || sn.kind === "file" || isTestPath(sn.path))
                continue;
            seenRel.add(sid);
            activeCallers.push({ caller: sn, via: null });
        }
    }
    for (const { caller } of [...activeCallers]) {
        if (caller.kind === "file")
            continue;
        for (const sid2 of inCallsById.get(caller.id) ?? []) {
            if (seenRel.has(sid2) || activeCallers.length >= 16)
                continue;
            const sn2 = byId.get(sid2);
            if (!sn2 || isTestPath(sn2.path))
                continue;
            seenRel.add(sid2);
            activeCallers.push({ caller: sn2, via: caller });
        }
    }
    for (const { caller, via } of [...activeCallers]) {
        if (!via || caller.kind === "file")
            continue;
        const cr = spanRange(caller.span);
        if (!cr || cr.end - cr.start > 20)
            continue;
        for (const sid3 of inCallsById.get(caller.id) ?? []) {
            if (seenRel.has(sid3) || activeCallers.length >= 22)
                continue;
            const sn3 = byId.get(sid3);
            if (!sn3 || isTestPath(sn3.path))
                continue;
            seenRel.add(sid3);
            activeCallers.push({ caller: sn3, via: caller });
        }
    }
    for (const { caller, via } of [...activeCallers]) {
        if (!via || caller.kind === "file" || caller.exported)
            continue;
        const cr = spanRange(caller.span);
        if (!cr || cr.end - cr.start > 30)
            continue;
        for (const sid4 of inCallsById.get(caller.id) ?? []) {
            if (seenRel.has(sid4) || activeCallers.length >= 22)
                continue;
            const sn4 = byId.get(sid4);
            if (!sn4 || sn4.path !== caller.path || isTestPath(sn4.path))
                continue;
            seenRel.add(sid4);
            activeCallers.push({ caller: sn4, via: caller });
        }
    }
}
function collectHitCallSiteQuotes(node, activeCallers, readLines, wantsCallSites, isMultiQuery) {
    const targetNeedles = needlesForName(node.name);
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
        const needles = via ? [...needlesForName(via.name), ...targetNeedles] : targetNeedles;
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
    return callSites;
}
function populateHitRelationsAndCallSites(h, hitIdx, node, srcIdx, readLines, wantsCallSites, isMultiQuery) {
    const { outCallsById, inCallsById, byId } = srcIdx;
    const rel = [];
    const seenRel = new Set([node.id]);
    const maxOutRel = hitIdx === 0 ? 4 : 2;
    const maxTotalRel = hitIdx === 0 ? 8 : hitIdx === 1 ? 4 : 2;
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
        if (!isTestPath(sn.path))
            directCallerNodes.push({ caller: sn, via: null });
        if (sn.kind !== "file" && !isTestPath(sn.path) && rel.length < maxTotalRel)
            rel.push(`← ${sn.name} (${sn.path}:${sn.span})`);
    }
    if (rel.length > 0)
        h.related = rel;
    const namedCallersOnly = directCallerNodes.filter((c) => c.caller.kind !== "file");
    const activeCallers = wantsCallSites ? directCallerNodes : namedCallersOnly;
    if (hitIdx === 0 && activeCallers.length > 0 && activeCallers.length <= 20) {
        if (wantsCallSites && activeCallers.length <= 6) {
            expandTransitiveCallSiteCallers(node, activeCallers, seenRel, outCallsById, inCallsById, byId);
        }
        const callSites = collectHitCallSiteQuotes(node, activeCallers, readLines, wantsCallSites, isMultiQuery);
        if (callSites.length > 0) {
            h.callSites = callSites;
            if (wantsCallSites)
                h.wantsCallSites = true;
        }
    }
}
function resolveEditEnvelopePrimarySpan(h, node, s, lines, nodesByPath, editEnvelope) {
    let spanLen = s.end - s.start + 1;
    if (editEnvelope && lines && spanLen <= 14 && node?.kind === "function") {
        const enclosing = (nodesByPath.get(s.path) ?? []).find((pn) => {
            if (pn.id === node.id || (pn.kind !== "function" && pn.kind !== "method"))
                return false;
            const ps = parseSpan(`${pn.path}:${pn.span}`);
            if (!ps)
                return false;
            const pLen = ps.end - ps.start + 1;
            return ps.start <= s.start && ps.end >= s.end && pLen > spanLen && pLen <= 60;
        });
        if (enclosing) {
            const ps = parseSpan(`${enclosing.path}:${enclosing.span}`);
            if (ps) {
                s = ps;
                spanLen = ps.end - ps.start + 1;
                h.pointer = `${enclosing.path}:${enclosing.span}`;
                h.title = `${enclosing.name} · ${enclosing.kind}`;
            }
        }
    }
    const effStart = lines && spanLen <= 6 ? Math.max(1, s.start - 3) : (editEnvelope && s.start <= 10 ? 1 : s.start);
    let effEnd = lines && spanLen <= 6 ? Math.min(lines.length, s.end + 3) : s.end;
    if (editEnvelope && lines && spanLen <= 45) {
        const nextTiny = (nodesByPath.get(s.path) ?? []).find((nn) => {
            if (nn.id === node?.id || nn.kind === "file")
                return false;
            const ns = parseSpan(`${nn.path}:${nn.span}`);
            return ns && ns.start >= s.end + 1 && ns.start <= s.end + 3 && ns.end - ns.start + 1 <= 10;
        });
        if (nextTiny) {
            const ns = parseSpan(`${nextTiny.path}:${nextTiny.span}`);
            if (ns)
                effEnd = ns.end;
        }
    }
    return { s, spanLen, effStart, effEnd };
}
function inlinePrimaryHitSpan(h, hitIdx, hits, state) {
    const { srcIdx, readLines, shownPointers, constsByPath, qTerms, qStems, full, opts, isMultiQuery, editEnvelope, wantsCallSites, maxHitsToInline, maxTotalBytes, primaryMeta, deferredFourthHits } = state;
    const { cruxByPointer, fileSpanByPath, nodeByPointer, nodesByPath } = srcIdx;
    const node = nodeByPointer.get(h.pointer);
    if (node && node.kind !== "file" && !h.related) {
        populateHitRelationsAndCallSites(h, hitIdx, node, srcIdx, readLines, wantsCallSites, isMultiQuery);
    }
    if (shownPointers.has(h.pointer)) {
        if (hitIdx === 0)
            state.inlinedHitCount++;
        return;
    }
    const effectiveMaxHits = node?.kind === "file" && !wantsCallSites ? maxHitsToInline + 1 : maxHitsToInline;
    if (state.inlinedHitCount >= effectiveMaxHits || state.totalInlinedBytes >= maxTotalBytes)
        return;
    let rawSpan = parseSpan(h.pointer);
    if (!rawSpan && fileSpanByPath.has(h.pointer))
        rawSpan = parseSpan(`${h.pointer}:${fileSpanByPath.get(h.pointer)}`);
    if (!rawSpan)
        return;
    const crux = cruxByPointer.get(h.pointer);
    if (crux) {
        h.code = `${crux}\n… (excerpt — full definition at ${h.pointer}; rerun with --full)`;
        state.totalInlinedBytes += Buffer.byteLength(h.code, "utf8");
        shownPointers.add(h.pointer);
        state.inlinedHitCount++;
        return;
    }
    const lines = readLines(rawSpan.path);
    const { s, spanLen, effStart, effEnd } = resolveEditEnvelopePrimarySpan(h, node, rawSpan, lines, nodesByPath, editEnvelope);
    const isUnrequestedLargeType = node?.kind === "type" && spanLen > 24 && !qTerms.has("type") && !qTerms.has((node.name ?? "").toLowerCase());
    if (
        isUnrequestedLargeType ||
        (isMultiQuery && wantsCallSites && spanLen > 250 && node?.kind !== "file") ||
        (isMultiQuery && hitIdx > 0 && (h.score ?? 0) < 0.86) ||
        (state.inlinedHitCount > 0 && ((wantsCallSites && node?.kind === "file") || (spanLen > 500 && node?.kind !== "file") || (node?.kind === "type" && spanLen > 20)))
    )
        return;
    const maxSpan = state.inlinedHitCount < 2 ? MAX_SPAN_LINES : 40;
    const isDominantTop = state.inlinedHitCount === 0 && (hits.length === 1 || (hits[0]?.score ?? 0) >= 1.15 * (hits[1]?.score ?? 0) || opts.maxHitsToInline === 1);
    const maxContiguous = state.inlinedHitCount === 0
        ? (editEnvelope ? (!isMultiQuery && spanLen <= 42 ? 42 : 22) : isDominantTop ? 80 : isMultiQuery ? 60 : MAX_CONTIGUOUS_TOP_LINES)
        : (editEnvelope ? 14 : MAX_CONTIGUOUS_SECONDARY_LINES);
    const maxCrux = node?.kind === "file" ? (spanLen > 200 ? 22 : 16) : state.inlinedHitCount === 0 ? (editEnvelope ? 15 : isMultiQuery ? 28 : MAX_CRUX_LINES) : (editEnvelope ? 10 : 18);
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
        return;
    if (!full && lines && spanLen <= 3 && lines.length > 15) {
        const fileCrux = synthesizeCrux(lines, s.path, 1, lines.length, hitQTerms, qStems, 18);
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
    const helperReserve = state.inlinedHitCount > 0
        ? (isMultiQuery && maxHitsToInline >= 2 && state.inlinedHitCount === 1 ? 250 : Math.min(950, Math.floor(maxTotalBytes * 0.28)))
        : 0;
    const effectiveBudget = maxTotalBytes - helperReserve;
    if ((state.inlinedHitCount > 0 || isMultiQuery) && state.totalInlinedBytes + Buffer.byteLength(code, "utf8") > effectiveBudget) {
        if (isMultiQuery && state.inlinedHitCount === 0)
            code = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, 34, null, 20);
        else if (state.inlinedHitCount > 0 && !full)
            code = synthesizeCrux(lines, s.path, effStart, effEnd, hitQTerms, qStems, 16, null, 12);
        if (!code || (state.inlinedHitCount > 0 && state.totalInlinedBytes + Buffer.byteLength(code, "utf8") > effectiveBudget))
            return;
    }
    h.code = code;
    shownPointers.add(h.pointer);
    state.totalInlinedBytes += Buffer.byteLength(code, "utf8");
    primaryMeta.set(state.inlinedHitCount, { h, node, s, lines, spanLen, effStart, effEnd, maxContiguous, hitQTerms });
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
        const ptr = `${nn.path}:${nn.span}`;
        if (shownPointers.has(ptr))
            continue;
        const escaped = (nn.name ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (!escaped)
            continue;
        const bareSuffix = (nn.name ?? "").split(/[.:]/).pop()?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const isDirectCall = new RegExp(`\\b${escaped}\\s*\\(`).test(text) ||
            Boolean(bareSuffix && bareSuffix.length >= 4 && bareSuffix !== escaped && new RegExp(`[:.]${bareSuffix}\\s*\\(`).test(text));
        const isDottedIdent = nn.name.includes(".") && new RegExp(`\\b${escaped}\\b`).test(text);
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
function collectSameFileCandidatesForHit(meta, hitIdx, srcIdx, shownPointers, qTerms, qStems, wantsCallSites = false) {
    const { node, s, lines, spanLen } = meta;
    const { nodesByPath } = srcIdx;
    const sameFileCands = new Map();
    const allowCallers = wantsCallSites ? spanLen <= 35 : spanLen <= 55;
    addGraphHelperNeighbours(node.id, 1, allowCallers, false, node, s.path, srcIdx, shownPointers, sameFileCands);
    scanTextHelperCalls(lines, s.path, node.id, s.start, s.end, 1, false, nodesByPath, shownPointers, sameFileCands);
    if (sameFileCands.size === 0 || node.kind === "type" || node.kind === "interface" || node.kind === "struct" || hitIdx === 0) {
        const isTypeNode = node.kind === "type" || node.kind === "interface" || node.kind === "struct";
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
            let m = nameMatch;
            if (!hadGraphCands || isTypeNode) {
                m = 0;
                for (const t of new Set(tokenize(`${nn.name} ${nn.signature ?? ""} ${nn.summary ?? ""}`))) {
                    if (qTerms.has(t) || (stemToken(t).length >= 4 && qStems.has(stemToken(t))))
                        m++;
                }
            }
            const isTypeMemberOrCtor = Boolean(
                isTypeNode &&
                (nn.kind === "function" || nn.kind === "method") &&
                ((typeBodyToks && (typeBodyToks.has(nn.name.toLowerCase()) || /^(?:new|create)$/.test(nn.name))) ||
                    (node.name && nn.signature && nn.signature.includes(node.name)))
            );
            if (m >= 1 || isTypeMemberOrCtor) {
                sameFileCands.set(nn.id, { node: nn, ptr, hop: 1, isSameFile: true, isCallee: !hadGraphCands || isTypeMemberOrCtor, viaTinyCallee: isTypeMemberOrCtor, fromGraph: isTypeMemberOrCtor });
            }
        }
    }
    if (hitIdx <= 2) {
        for (const [nid, cand] of [...sameFileCands]) {
            if (!cand.isSameFile)
                continue;
            const cs = parseSpan(`${cand.node.path}:${cand.node.span}`);
            const cLen = cs ? cs.end - cs.start + 1 : 999;
            const isNested = Boolean(cs && cs.start >= s.start && cs.end <= s.end);
            if (cand.hop === 1 && (isNested || (cand.isCallee && cand.fromGraph))) {
                const nextHop = isNested || (cLen <= 16 && spanLen <= 20) ? 1 : 2;
                const isViaTiny = isNested || cLen <= 16;
                addGraphHelperNeighbours(nid, nextHop, isNested || cLen <= 16, isViaTiny, node, s.path, srcIdx, shownPointers, sameFileCands);
                if (cs && cLen <= 90)
                    scanTextHelperCalls(lines, s.path, node.id, cs.start, cs.end, nextHop, isViaTiny, nodesByPath, shownPointers, sameFileCands);
            }
        }
    }
    return sameFileCands;
}
function scoreSingleHelperCandidate(cand, meta, candLines, cs, hSpanLen, qTerms, qStems, wantsCallSites = false) {
    const { node, s, spanLen } = meta;
    if (wantsCallSites && !cand.isCallee && hSpanLen < 14 && spanLen > 10)
        return null;
    let qMatchCount = 0;
    let hScore = (cand.hop === 1 ? 2 : 0) + (cand.fromGraph ? 3 : 0);
    if (hSpanLen <= 22 && (cand.isCallee || spanLen <= 10))
        hScore += hSpanLen <= 8 ? 5.5 : 2;
    if (cand.isSameFile) {
        hScore += 2.0;
        if (cand.fromGraph)
            hScore += cand.hop === 1 ? 8.5 : 4.5;
        if (cand.isCallee && cand.hop === 1 && cand.fromGraph)
            hScore += 4.5;
        if (cand.fromGraph && !cand.isCallee && cand.hop === 1 && hSpanLen >= 18 && hSpanLen <= 90)
            hScore += 4.5;
        if (cand.fromGraph && !cand.isCallee && cand.hop === 1 && cand.node.exported && !node.exported)
            hScore += 8.0;
        if (cand.viaTinyCallee && cand.fromGraph && cand.isCallee && hSpanLen <= 22 && spanLen <= 20)
            hScore += 14.0;
        if (!cand.fromGraph && Boolean(cand.node.exported) && node.exported && hSpanLen >= 10 && hSpanLen <= 55) {
            const nodeToks = new Set(tokenize(node.name).filter((t) => t !== "format" && t !== "get" && t !== "set" && t !== "run" && t !== "read" && t !== "write"));
            const sharesNameTok = nodeToks.size > 0 && tokenize(cand.node.name).some((t) => nodeToks.has(t));
            hScore += sharesNameTok ? 18.0 : -6.0;
        }
        else if (!cand.fromGraph && hSpanLen > 18)
            hScore -= 12.0;
    }
    else if (cand.isCallee && cand.hop === 1 && (hSpanLen <= 12 || (cand.node.name === node.name && hSpanLen <= 28))) {
        hScore += cand.node.name === node.name ? 11.5 : 6.5;
    }
    if ((cand.isSameFile || cand.node.name.length >= 4 || (cand.isCallee && hSpanLen <= 12)) && cand.fromGraph && cand.isCallee && cand.hop === 1) {
        const fileStem = basename(s.path).replace(/\.[a-z0-9]+$/i, "").toLowerCase();
        for (const nTok of new Set(tokenize(cand.node.name))) {
            if (cand.isSameFile && nTok === fileStem)
                continue;
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
    if (/\b(?:[A-Z0-9_]*(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)[A-Z0-9_]*)\b/.test(bodySlice))
        hScore += hSpanLen <= 14 ? 7.5 : 2.5;
    const helperText = `${cand.node.owner ?? ""} ${cand.node.name} ${cand.node.summary ?? ""} ${bodySlice}`;
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
        return null;
    if (qMatchCount === 0 && !(cand.fromGraph && cand.isSameFile) && !(cand.isSameFile && (hSpanLen <= 12 || (cand.viaTinyCallee && hSpanLen <= 90))))
        return null;
    return hScore;
}
function scoreHelperCandidatesForHit(sameFileCands, meta, readLines, qTerms, qStems, wantsCallSites = false) {
    const { node, lines, spanLen, effStart, effEnd, maxContiguous, hitQTerms } = meta;
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
        const hScore = scoreSingleHelperCandidate(cand, meta, candLines, cs, hSpanLen, qTerms, qStems, wantsCallSites);
        if (hScore !== null)
            scoredHelpers.push({ ...cand, cs, candLines, hSpanLen, hScore });
    }
    scoredHelpers.sort((a, b) => b.hScore - a.hScore || a.cs.start - b.cs.start);
    for (const hCand of scoredHelpers.slice(0, 3)) {
        for (const t of tokenize(hCand.node.name))
            hitQTerms.add(t);
    }
    return scoredHelpers;
}
function attachScoredHelpersToHit(meta, hitIdx, scoredHelpers, state) {
    const { h, node, s, lines, spanLen, effStart, effEnd, maxContiguous, hitQTerms } = meta;
    const { full, editEnvelope, wantsCallSites, maxTotalBytes, shownPointers, constsByPath, qTerms, qStems } = state;
    const isTinyTypeHit = (node.kind === "struct" || node.kind === "type" || node.kind === "interface") && spanLen <= 12;
    const maxHelpers = editEnvelope
        ? (hitIdx === 0 ? (isTinyTypeHit ? 4 : (spanLen <= 28 && (scoredHelpers[0]?.hScore ?? 0) >= 16 && (scoredHelpers[0]?.hSpanLen ?? 99) <= 28 ? 1 : 0)) : 0)
        : (hitIdx === 0 ? 3 : 1);
    const maxHelperBytesForHit = editEnvelope ? (hitIdx === 0 ? (isTinyTypeHit ? 1100 : 600) : 0) : (hitIdx === 0 ? 2250 : 1150);
    const singleHelperBonus = (scoredHelpers[0]?.hSpanLen >= 40 || (scoredHelpers[0]?.node?.exported && !scoredHelpers[0]?.isCallee)) ? 250 : 0;
    let hitHelperBytes = 0;
    const helperBlocks = [];
    const nestedRanges = [];
    const attachedSameFileSpans = [];
    let hIdx = 0;
    for (
        let sIdx = 0;
        sIdx < scoredHelpers.length &&
        (hIdx < maxHelpers || (hIdx === maxHelpers && !editEnvelope && scoredHelpers[sIdx]?.hSpanLen <= 12 && scoredHelpers[sIdx]?.isSameFile && scoredHelpers[sIdx]?.hScore >= 16));
        sIdx++
    ) {
        const hCand = scoredHelpers[sIdx];
        if (hCand.hScore < 3.5 || shownPointers.has(hCand.ptr))
            continue;
        if (wantsCallSites && (h.callSites?.length ?? 0) >= 8 && hCand.hop > 1 && hIdx >= 2)
            continue;
        const hStart = hCand.hSpanLen <= 18 && hCand.isSameFile
            ? Math.max(1, hCand.cs.start - (hCand.node.summary ? Math.min(5, hCand.node.summary.split("\n").length + 1) : 2))
            : hCand.cs.start;
        const hEnd = hCand.isSameFile && s.start > hCand.cs.end && s.start - hCand.cs.end <= 15
            ? s.start - 1
            : hCand.cs.end;
        const hContig = hIdx === 0 && hCand.hSpanLen <= 48 ? 48 : 26;
        const hCode = full
            ? sliceSpan(hCand.candLines, hCand.node.path, hStart, hEnd, 48)
            : synthesizeCrux(hCand.candLines, hCand.node.path, hStart, hEnd, hitQTerms, qStems, hContig, null, 22);
        if (!hCode)
            continue;
        const label = hCand.isSameFile ? "same-file helper" : "cross-file callee";
        let block = `// ${label}: ${hCand.node.name} (${hCand.ptr})\n${hCode}`;
        let bLen = Buffer.byteLength(block, "utf8");
        const effMaxTotal = hIdx === 0 ? maxTotalBytes + singleHelperBonus : maxTotalBytes;
        const effMaxHit = hIdx === 0 ? maxHelperBytesForHit + singleHelperBonus : maxHelperBytesForHit;
        if (!full && (state.totalInlinedBytes + bLen > effMaxTotal || hitHelperBytes + bLen > effMaxHit)) {
            const compactH = synthesizeCrux(hCand.candLines, hCand.node.path, hStart, hCand.cs.end, hitQTerms, qStems, 16, null, 16);
            if (compactH) {
                block = `// ${label}: ${hCand.node.name} (${hCand.ptr})\n${compactH}`;
                bLen = Buffer.byteLength(block, "utf8");
            }
        }
        if (state.totalInlinedBytes + bLen > effMaxTotal || hitHelperBytes + bLen > effMaxHit)
            continue;
        helperBlocks.push(block);
        shownPointers.add(hCand.ptr);
        (h.helperPointers ??= []).push(hCand.ptr);
        state.totalInlinedBytes += bLen;
        hitHelperBytes += bLen;
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
    if (helperBlocks.length > 0) {
        const helperJoined = helperBlocks.join("\n\n");
        const helperCodeNoComments = helperJoined.split("\n").map((l) => l.replace(/(?:--|\s\/\/).*$/, "")).join("\n");
        const attachedFullHelperText = attachedSameFileSpans
            .map((sp) => lines.slice(Math.max(0, sp.start - 1), Math.min(lines.length, sp.end)).join("\n"))
            .join("\n");
        let combined = `${baseCode}\n\n${helperJoined}`;
        const fileConsts = getFileConstantsList(s.path, lines, constsByPath);
        const extraConsts = fileConsts
            .filter((c) => !combined.includes(`L${c.lineNo}:`) && (
                new RegExp(`\\b${c.name}\\b`).test(helperCodeNoComments) ||
                (/(?:LIMIT|MAX|MIN|PASS|PASSES|GUARD|BOUND|SIZE|TIMEOUT|RETRY|COUNT|CAP|THRESHOLD)/.test(c.name) &&
                    new RegExp(`\\b${c.name}\\b`).test(attachedFullHelperText))
            ))
            .map((c) => `L${c.lineNo}: ${c.text}`);
        if (extraConsts.length > 0)
            combined = `${extraConsts.join("\n")}\n${combined}`;
        h.code = combined;
    }
}
function prependEditEnvelopeBestType(h, hitIdx, node, s, lines, fileNodes, state) {
    const { shownPointers, maxTotalBytes, qTerms, qStems } = state;
    if (hitIdx > 1 || node.kind === "struct" || node.kind === "type" || node.kind === "interface")
        return;
    let bestType = null;
    let bestTypeScore = 0;
    const baseFileLower = s.path.split("/").pop()?.replace(/\.[a-z0-9]+$/i, "").toLowerCase() ?? "";
    for (const tn of fileNodes) {
        if ((tn.kind !== "type" && tn.kind !== "interface") || tn.id === node.id)
            continue;
        const tPtr = `${tn.path}:${tn.span}`;
        if (shownPointers.has(tPtr))
            continue;
        const ts = parseSpan(tPtr);
        if (!ts || ts.end - ts.start + 1 > 32)
            continue;
        const typeNameLower = (tn.name ?? "").toLowerCase();
        let tScore = 0;
        if (qTerms.has(typeNameLower))
            tScore += 10;
        for (const tk of tokenize(tn.name ?? "")) {
            if (qTerms.has(tk))
                tScore += 4;
            else if (stemToken(tk).length >= 4 && qStems.has(stemToken(tk)))
                tScore += 3;
        }
        if (typeNameLower === "store" && qTerms.has("store"))
            tScore += 6;
        if (tScore === 0 && typeNameLower === baseFileLower && ts.end - ts.start + 1 <= 20)
            tScore = 2;
        if (tScore > bestTypeScore) {
            bestTypeScore = tScore;
            bestType = { tn, tPtr, ts };
        }
    }
    if (bestType && bestTypeScore >= 2) {
        const { tn, tPtr, ts } = bestType;
        const tSlice = sliceSpan(lines, s.path, ts.start, ts.end, 30);
        if (tSlice && !h.code.includes(`L${ts.start}:`)) {
            const tBlock = `// exported type: ${tn.name} (${tPtr})\n${tSlice}`;
            const tbLen = Buffer.byteLength(tBlock, "utf8");
            if (state.totalInlinedBytes + tbLen <= maxTotalBytes + 350) {
                shownPointers.add(tPtr);
                h.code = `${tBlock}\n\n${h.code}`;
                state.totalInlinedBytes += tbLen;
            }
        }
    }
}
function appendEditEnvelopeModuleReturn(h, hitIdx, s, lines, fileNodes, state) {
    const { maxTotalBytes } = state;
    const tailStart = Math.max(1, lines.length - 20);
    if (hitIdx > 1 || h.code.includes(`L${lines.length}:`))
        return;
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
    if (retLineIdx <= 0)
        return;
    let envStart = retLineIdx;
    const lastFn = [...fileNodes]
        .map((fn) => (fn.kind !== "file" ? parseSpan(`${fn.path}:${fn.span}`) : null))
        .filter(Boolean)
        .sort((a, b) => b.end - a.end)[0];
    if (lastFn && lastFn.end >= lines.length - 3 && lastFn.end - lastFn.start + 1 <= 28 && lastFn.start < envStart) {
        envStart = lastFn.start;
    }
    else if (/^return\s+[A-Za-z_]\w*$/.test((lines[retLineIdx - 1] ?? "").trim())) {
        for (let p = retLineIdx - 2; p >= Math.max(0, retLineIdx - 26); p--) {
            const pt = (lines[p] ?? "").trim();
            if (/^(?:self|M|[A-Za-z_]\w*)\.[A-Za-z_]\w*\s*=/.test(pt) || pt === "return self")
                envStart = p + 1;
        }
    }
    const tailSlice = sliceSpan(lines, s.path, envStart, lines.length, 28);
    if (tailSlice && !h.code.includes(`L${envStart}:`)) {
        const tailBlock = `// module return (${s.path}:L${envStart}-L${lines.length}):\n${tailSlice}`;
        const tbLen = Buffer.byteLength(tailBlock, "utf8");
        if (state.totalInlinedBytes + tbLen <= maxTotalBytes + (envStart < retLineIdx ? 680 : 350)) {
            h.code = `${h.code}\n\n${tailBlock}`;
            state.totalInlinedBytes += tbLen;
        }
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
function inlineSource(root, hits, graph, full, query = "", opts = {}) {
    const srcIdx = getOrBuildInlineSourceIndex(graph, full);
    const qTerms = new Set(tokenize(query));
    const qStems = new Set([...qTerms].map(stemToken).filter((s) => s.length >= 4));
    const readLines = fileReader(root);
    const maxHitsToInline = opts.maxHitsToInline ?? SOURCE_TOP_HITS;
    const maxTotalBytes = opts.maxSourceBytes ?? (full ? 5200 : 3850);
    const shownPointers = opts.seenPointers ?? new Set();
    const constsByPath = new Map();
    const primaryMeta = new Map();
    const deferredFourthHits = [];
    const isMultiQuery = Boolean(opts.maxHitsToInline && opts.maxHitsToInline <= 2);
    const wantsCallSites = Boolean(opts.wantsCallSites) || /\b(callers?|called|calls|invokes?|invoked|who\s+uses|used\s+by|blast\s+radius|refactor|references?|where\s+is\b.*\bused)\b/i.test(query);
    const editEnvelope = Boolean(opts.editEnvelope);
    const state = {
        srcIdx, readLines, shownPointers, constsByPath, qTerms, qStems, full, opts,
        isMultiQuery, editEnvelope, wantsCallSites, maxHitsToInline, maxTotalBytes,
        primaryMeta, deferredFourthHits, totalInlinedBytes: 0, inlinedHitCount: 0,
    };
    for (let i = 0; i < hits.length; i++) {
        inlinePrimaryHitSpan(hits[i], i, hits, state);
    }
    for (const [i, meta] of primaryMeta) {
        if (i > 2 || state.totalInlinedBytes >= maxTotalBytes)
            break;
        const { h, node, s, lines } = meta;
        if (!node || node.kind === "file" || !lines || !h.code)
            continue;
        const sameFileCands = collectSameFileCandidatesForHit(meta, i, srcIdx, shownPointers, qTerms, qStems, wantsCallSites);
        if (sameFileCands.size > 0) {
            const scoredHelpers = scoreHelperCandidatesForHit(sameFileCands, meta, readLines, qTerms, qStems, wantsCallSites);
            attachScoredHelpersToHit(meta, i, scoredHelpers, state);
        }
        if (editEnvelope && lines && h.code) {
            const fileNodes = srcIdx.nodesByPath.get(s.path) ?? [];
            prependEditEnvelopeBestType(h, i, node, s, lines, fileNodes, state);
            appendEditEnvelopeModuleReturn(h, i, s, lines, fileNodes, state);
            const coveredRanges = [{ start: meta.effStart, end: meta.effEnd }, ...(meta.attachedSameFileSpans ?? [])];
            const otherSyms = collectOtherSymbolsInFile(fileNodes, node.id, null, shownPointers, qTerms, qStems, true, 10, coveredRanges);
            if (otherSyms.length > 0 && !h.code.includes(`// other symbols in ${s.path}:`)) {
                const footer = `\n// other symbols in ${s.path}: ${otherSyms.join(", ")}`;
                h.code += footer;
                state.totalInlinedBytes += Buffer.byteLength(footer, "utf8");
            }
        }
    }
    if (editEnvelope) {
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
    for (const { h, code } of deferredFourthHits) {
        if (state.totalInlinedBytes + Buffer.byteLength(code, "utf8") <= maxTotalBytes) {
            h.code = code;
            shownPointers.add(h.pointer);
            state.totalInlinedBytes += Buffer.byteLength(code, "utf8");
        }
    }
    return state.totalInlinedBytes;
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
    result.rawTopPointer = result.hits[0]?.pointer ?? null;
    result.rawTopScore = result.hits[0]?.score ?? 0;
    const topWasSeen = Boolean(result.rawTopPointer && opts.seenPointers?.has(result.rawTopPointer));
    if (opts.seenPointers && result.hits.length > 0) {
        const filtered = result.hits.filter((h) => !opts.seenPointers.has(h.pointer));
        result.hits = (filtered.length > 0 ? filtered : result.hits).slice(0, limit);
    }
    if (opts.source) {
        const effectiveOpts = topWasSeen && (result.hits[0]?.score ?? 0) < 0.86
            ? { ...opts, maxHitsToInline: 0 }
            : opts;
        const allHits = result.ranking
            ? [
                ...result.hits,
                ...result.ranking.groups.flatMap((group) => group.hits),
                ...result.ranking.groups.flatMap((group) => group.baselineHits ?? []),
                ...result.ranking.baseline.map((entry) => entry.hit),
            ]
            : result.hits;
        result.usedSourceBytes = inlineSource(root, [...new Set(allHits)], corpus.graph, opts.full ?? false, query, effectiveOpts);
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
        ? [...new Set(graph.nodes.map((n) => n.path).filter(Boolean))].sort()
        : [];
    const rootPrefix = `${root.replace(/\\/g, "/").replace(/^\/+/, "")}/`;
    const resolvePath = (fileQuery) => {
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
    };
    const blocks = [];
    for (const rawSpec of specs) {
        const parsed = parseReadSpanSpec(rawSpec);
        if (!parsed) {
            blocks.push({ spec: rawSpec, error: `invalid span "${rawSpec}"` });
            continue;
        }
        const resolvedFile = resolvePath(parsed.file);
        if (!resolvedFile.startsWith("..") && isSensitiveOrDotPath(resolvedFile)) {
            blocks.push({ spec: rawSpec, file: resolvedFile, error: `cannot read sensitive or hidden path "${resolvedFile}"` });
            continue;
        }
        const lines = read(resolvedFile);
        if (!lines) {
            blocks.push({ spec: rawSpec, file: resolvedFile, error: `cannot read "${resolvedFile}"` });
            continue;
        }
        let spanStartLine = parsed.start;
        let spanEndLine = parsed.end;
        let hasExplicit = parsed.hasExplicitRange;
        if (parsed.symbol && graph) {
            const symLower = parsed.symbol.toLowerCase();
            const symBare = symLower.split(/[.:#]/).pop() || symLower;
            const fileNodes = graph.nodes.filter((n) => n.kind !== "file" && n.path === resolvedFile && n.span);
            const matchNode =
                fileNodes.find((n) => n.name.toLowerCase() === symLower) ??
                fileNodes.find((n) => n.name.toLowerCase() === symBare || n.name.toLowerCase().endsWith(`.${symBare}`) || n.name.toLowerCase().endsWith(`:${symBare}`)) ??
                fileNodes.find((n) => n.id.toLowerCase().endsWith(`#${symLower}`) || n.id.toLowerCase().endsWith(`.${symBare}`));
            if (!matchNode) {
                blocks.push({ spec: rawSpec, file: resolvedFile, error: `no symbol "${parsed.symbol}" in "${resolvedFile}"` });
                continue;
            }
            const sr = spanRange(matchNode.span);
            if (sr) {
                spanStartLine = sr.start;
                spanEndLine = sr.end;
                hasExplicit = true;
            }
        }
        const start = Math.max(1, Math.min(spanStartLine, lines.length));
        const requestedEnd = Math.max(start, Math.min(hasExplicit ? spanEndLine : Math.min(lines.length, 120), lines.length));
        const maxLinesForSpec = specs.length >= 2 ? Math.max(45, Math.floor(160 / specs.length)) : 170;
        const end = Math.min(requestedEnd, start + maxLinesForSpec - 1);
        const slice = [];
        for (let ln = start; ln <= end; ln++) {
            slice.push(`L${ln}: ${lines[ln - 1]}`);
        }
        if (end < requestedEnd) {
            slice.push(`… (+${requestedEnd - end} more lines in ${resolvedFile}:L${end + 1}-L${requestedEnd})`);
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
