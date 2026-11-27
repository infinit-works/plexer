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
    createBatchInserter,
    getAllSqliteMeta,
    getSqliteMeta,
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
import {
    counts,
    extractLiterals,
    isTokenDroppedByTokenize,
    stemCounts,
    stemToken,
    stripPluralSuffix,
    tokenize,
    tokenizeExact,
    tokenizeRegularAndExact,
} from "./tokenize.js";

export { counts, extractLiterals, stemCounts, stemToken, tokenize, tokenizeExact };

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
        if (fileLineCache.size >= 4) {
            const oldest = fileLineCache.keys().next().value;
            if (oldest !== undefined)
                fileLineCache.delete(oldest);
        }
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

function buildChannelPostings(doc, bodyText, pathCache = null, pool = null) {
    const docPath = doc.path ?? "";
    let pathMap;
    let pathExactMap;
    if (pathCache && pathCache.path === docPath && pathCache.pathMap) {
        pathMap = pathCache.pathMap;
        pathExactMap = pathCache.pathExactMap;
    }
    else {
        pathMap = new Map();
        pathExactMap = new Map();
        tokenizeRegularAndExact(docPath, pathMap, pathExactMap);
        if (pathCache) {
            pathCache.path = docPath;
            pathCache.pathMap = pathMap;
            pathCache.pathExactMap = pathExactMap;
            pathCache.pathVocabTokens = null;
        }
    }

    let exactMap;
    let nameMap;
    let sigMap;
    let summaryMap;
    let bodyMap;
    let literalsMap;
    let stemMap;
    if (pool) {
        exactMap = pool.exact_ident;
        exactMap.clear();
        for (const [k, v] of pathExactMap)
            exactMap.set(k, v);
        nameMap = pool.name;
        nameMap.clear();
        sigMap = pool.sig;
        sigMap.clear();
        summaryMap = pool.summary;
        summaryMap.clear();
        bodyMap = pool.body;
        bodyMap.clear();
        literalsMap = pool.literals;
        literalsMap.clear();
        stemMap = pool.stem;
        stemMap.clear();
    }
    else {
        exactMap = new Map(pathExactMap);
        nameMap = new Map();
        sigMap = new Map();
        summaryMap = new Map();
        bodyMap = new Map();
        literalsMap = null;
        stemMap = null;
    }

    tokenizeRegularAndExact(doc.name ?? "", nameMap, exactMap);
    tokenizeRegularAndExact(doc.signature ?? "", sigMap, exactMap);
    tokenizeRegularAndExact(doc.summary ?? "", summaryMap, exactMap);
    tokenizeRegularAndExact(bodyText ?? "", bodyMap, exactMap);

    const litText = `${doc.signature ?? ""} ${doc.summary ?? ""} ${bodyText ?? ""}`;
    literalsMap = counts(extractLiterals(litText), literalsMap);

    // Index ONLY `body` tokens in `stem` so path/name stems never leak into phantom body TF.
    stemMap = stemCounts(bodyMap, stemMap);

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
    const row = prepareStmt(
        store,
        `SELECT COUNT(*) AS cnt,
            COALESCE(SUM(len_name), 0) AS s_name,
            COALESCE(SUM(len_path), 0) AS s_path,
            COALESCE(SUM(len_sig), 0) AS s_sig,
            COALESCE(SUM(len_summary), 0) AS s_summary,
            COALESCE(SUM(len_literals), 0) AS s_literals,
            COALESCE(SUM(len_body), 0) AS s_body,
            COALESCE(SUM(len_exact), 0) AS s_exact
        FROM ask_docs`,
    ).get();
    const docCount = Number(row?.cnt ?? 0);
    const sums = {
        name: Number(row?.s_name ?? 0),
        path: Number(row?.s_path ?? 0),
        sig: Number(row?.s_sig ?? 0),
        summary: Number(row?.s_summary ?? 0),
        literals: Number(row?.s_literals ?? 0),
        body: Number(row?.s_body ?? 0),
        stem: Number(row?.s_body ?? 0),
        exact_ident: Number(row?.s_exact ?? 0),
    };
    const avgLens = emptyFieldLens();
    if (docCount > 0) {
        for (const ch of ASK_CHANNELS) {
            avgLens[ch] = sums[ch] / docCount;
        }
    }
    return { docCount, avgLens, sums };
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

function resolvePreloadedMarkdownDocs(markdownDocs, explicitDigest, prevDocsHash = undefined) {
    if (typeof explicitDigest === "string" && prevDocsHash !== undefined && prevDocsHash === explicitDigest) {
        return { mdNodes: [], docsDigest: explicitDigest };
    }
    const mdNodes = [];
    const mdHashItems = [];
    const rawEntries = [];
    for (const item of markdownDocs) {
        if (!item)
            continue;
        if (item.kind === "doc") {
            mdNodes.push(item);
            continue;
        }
        const relPath = item.relPath ?? item.path;
        if (!relPath)
            continue;
        let raw = typeof item.content === "string" ? item.content : typeof item.raw === "string" ? item.raw : null;
        if (raw === null && item.absPath && !(explicitDigest && prevDocsHash !== undefined) && !(item.hash && prevDocsHash !== undefined)) {
            try {
                raw = readFileSync(item.absPath, "utf8");
            }
            catch {
                raw = null;
            }
        }
        if (typeof item.hash === "string") {
            if (!explicitDigest)
                mdHashItems.push([relPath, item.hash]);
            if (raw !== null || item.absPath)
                rawEntries.push({ relPath, raw, absPath: item.absPath });
        }
        else if (raw !== null) {
            if (!explicitDigest)
                mdHashItems.push([relPath, contentHash(raw)]);
            rawEntries.push({ relPath, raw, absPath: null });
        }
    }
    const docsDigest = typeof explicitDigest === "string" ? explicitDigest : digestDocHashes(mdHashItems);
    if (prevDocsHash !== undefined && docsDigest === prevDocsHash) {
        return { mdNodes: [], docsDigest };
    }
    for (const entry of rawEntries) {
        let raw = entry.raw;
        if (raw === null && entry.absPath) {
            try {
                raw = readFileSync(entry.absPath, "utf8");
            }
            catch {
                raw = null;
            }
        }
        if (raw !== null)
            mdNodes.push(...parseMarkdownSections(entry.relPath, raw));
    }
    return { mdNodes, docsDigest };
}

function inferOwnerFromNodeId(nodeId) {
    const hash = String(nodeId ?? "").indexOf("#");
    if (hash === -1)
        return null;
    const frag = String(nodeId).slice(hash + 1);
    const dot = frag.lastIndexOf(".");
    if (dot > 0)
        return frag.slice(0, dot);
    const colon = frag.lastIndexOf(":");
    if (colon > 0)
        return frag.slice(0, colon);
    return null;
}

function collectNodeVocabDeltas(nodes, delta, sign) {
    const tmpCompounds = new Map();
    const bump = (kind, token) => {
        const k = `${kind}\0${token}`;
        delta.set(k, (delta.get(k) ?? 0) + sign);
    };
    for (const n of nodes) {
        if (!n || n.kind === "doc")
            continue;
        tmpCompounds.clear();
        recordNodeCompoundVocab(n, tmpCompounds);
        for (const [ck, cv] of tmpCompounds)
            bump("compound", `${ck}\0${cv}`);
        const seenPath = new Set();
        for (const t of tokenize(n.path ?? "")) {
            if (t.length >= 3 && !seenPath.has(t)) {
                seenPath.add(t);
                bump("path_tok", t);
            }
        }
        if (n.kind === "file")
            continue;
        const seenTok = new Set();
        const seenStem = new Set();
        for (const t of tokenize(n.name ?? "")) {
            if (t.length < 3)
                continue;
            if (!seenTok.has(t)) {
                seenTok.add(t);
                bump("name_tok", t);
            }
            const s = stemToken(t);
            if (!seenStem.has(s)) {
                seenStem.add(s);
                bump("name_stem", s);
            }
        }
    }
}

function writeFullAskVocabTx(store, codeNodes) {
    store.db.exec("DELETE FROM ask_vocab;");
    const countsMap = new Map();
    collectNodeVocabDeltas(codeNodes, countsMap, 1);
    const ins = prepareStmt(store, "INSERT INTO ask_vocab(kind, token, df) VALUES (?, ?, ?)");
    const keys = [...countsMap.keys()].sort();
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const df = countsMap.get(k);
        if (!df || df <= 0)
            continue;
        const nul = k.indexOf("\0");
        ins.run(k.slice(0, nul), k.slice(nul + 1), df);
    }
}

function applyAskVocabDeltasTx(store, vocabDelta) {
    if (!vocabDelta || vocabDelta.size === 0)
        return;
    const sel = prepareStmt(store, "SELECT df FROM ask_vocab WHERE kind = ? AND token = ?");
    const upsert = prepareStmt(store, "INSERT OR REPLACE INTO ask_vocab(kind, token, df) VALUES (?, ?, ?)");
    const del = prepareStmt(store, "DELETE FROM ask_vocab WHERE kind = ? AND token = ?");
    for (const [k, d] of vocabDelta) {
        if (!d)
            continue;
        const nul = k.indexOf("\0");
        const kind = k.slice(0, nul);
        const token = k.slice(nul + 1);
        const cur = Number(sel.get(kind, token)?.df ?? 0);
        const next = cur + d;
        if (next <= 0)
            del.run(kind, token);
        else
            upsert.run(kind, token, next);
    }
}

function loadAskVocabFromSqlite(store, docCount) {
    const nameTokens = new Set();
    const nameStems = new Map();
    const pathTokens = new Set();
    const compoundSymbols = new Map();
    const sql = "SELECT kind, token, df FROM ask_vocab";
    const arrStmt = prepareArrayStmt(store, sql);
    if (arrStmt) {
        const rows = arrStmt.all();
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const kind = r[0];
            const tok = r[1];
            const df = Number(r[2]);
            if (kind === "path_tok")
                pathTokens.add(tok);
            else if (kind === "name_tok")
                nameTokens.add(tok);
            else if (kind === "name_stem")
                nameStems.set(tok, df);
            else if (kind === "compound") {
                const nul = tok.indexOf("\0");
                if (nul > 0) {
                    const key = tok.slice(0, nul);
                    if (!compoundSymbols.has(key))
                        compoundSymbols.set(key, tok.slice(nul + 1));
                }
            }
        }
    }
    else {
        for (const r of prepareStmt(store, sql).all()) {
            const kind = r.kind;
            const tok = r.token;
            const df = Number(r.df);
            if (kind === "path_tok")
                pathTokens.add(tok);
            else if (kind === "name_tok")
                nameTokens.add(tok);
            else if (kind === "name_stem")
                nameStems.set(tok, df);
            else if (kind === "compound") {
                const nul = tok.indexOf("\0");
                if (nul > 0) {
                    const key = tok.slice(0, nul);
                    if (!compoundSymbols.has(key))
                        compoundSymbols.set(key, tok.slice(nul + 1));
                }
            }
        }
    }
    return {
        nDocs: Number(docCount) || 100,
        nameTokens,
        nameStems,
        pathTokens,
        compoundSymbols,
    };
}

function insertSingleAskDoc(n, docId, pageranks, fallbackPrById, repoRoot, fileLineCache, insertDoc, insertPosting, onDfTerm) {
    const bodyText = n.kind === "doc" ? (n.body_text ?? "") : resolveBodyTextForNode(n, repoRoot, fileLineCache);
    const { channels, fieldLens } = buildChannelPostings(n, bodyText);
    if (n.kind !== "doc" && "body_text" in n)
        delete n.body_text;
    const pr = n.kind === "doc"
        ? 0
        : pageranks
            ? (pageranks.get(n.id) ?? 0)
            : (fallbackPrById?.get(n.id) ?? 0.05);
    insertDoc.run(
        docId, n.id, n.path ?? "", n.kind ?? "unknown", n.name ?? "", n.span ?? "L1-L1",
        n.signature ?? null, n.summary ?? null, n.exported ? 1 : 0,
        fieldLens.name, fieldLens.path, fieldLens.sig, fieldLens.summary,
        fieldLens.literals, fieldLens.body, fieldLens.exact_ident, pr, null,
    );
    for (const ch of ASK_CHANNELS) {
        for (const [term, tf] of channels[ch]) {
            insertPosting.run(ch, term, docId, tf);
            onDfTerm(ch, term);
        }
    }
    return fieldLens;
}

const ASK_DOC_INSERT_SQL = `INSERT INTO ask_docs(
    doc_id, node_id, path, kind, name, span, signature, summary, exported,
    len_name, len_path, len_sig, len_summary, len_literals, len_body, len_exact, pagerank, terms_blob
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function recordNodeVocabFromChannels(n, pathMap, nameMap, pathCache, tmpCompounds, vocabCounts) {
    if (!n || n.kind === "doc")
        return;
    const bump = (k) => vocabCounts.set(k, (vocabCounts.get(k) ?? 0) + 1);
    tmpCompounds.clear();
    recordNodeCompoundVocab(n, tmpCompounds);
    for (const [ck, cv] of tmpCompounds)
        bump(`compound\0${ck}\0${cv}`);
    let pathToks = pathCache.path === (n.path ?? "") ? pathCache.pathVocabTokens : null;
    if (!pathToks) {
        pathToks = [];
        for (const t of pathMap.keys()) {
            if (t.length >= 3)
                pathToks.push(t);
        }
        if (pathCache.path === (n.path ?? ""))
            pathCache.pathVocabTokens = pathToks;
    }
    for (let i = 0; i < pathToks.length; i++)
        bump(`path_tok\0${pathToks[i]}`);
    if (n.kind === "file")
        return;
    const seenStem = new Set();
    for (const t of nameMap.keys()) {
        if (t.length < 3)
            continue;
        bump(`name_tok\0${t}`);
        const s = stemToken(t);
        if (!seenStem.has(s)) {
            seenStem.add(s);
            bump(`name_stem\0${s}`);
        }
    }
}

const DOC_TERMS_SCRATCH = Buffer.allocUnsafe(65536);

function encodeDocTermsBlob(channels) {
    let pos = 0;
    let buf = DOC_TERMS_SCRATCH;
    for (let ci = 0; ci < ASK_CHANNELS.length; ci++) {
        const map = channels[ASK_CHANNELS[ci]];
        if (!map || map.size === 0)
            continue;
        for (const term of map.keys()) {
            const byteLen = Buffer.byteLength(term, "utf8");
            if (byteLen > 65535)
                continue;
            const need = pos + 3 + byteLen;
            if (need > buf.length) {
                const grown = Buffer.allocUnsafe(Math.max(buf.length * 2, need));
                buf.copy(grown, 0, 0, pos);
                buf = grown;
            }
            buf[pos++] = ci;
            buf[pos++] = (byteLen >>> 8) & 0xff;
            buf[pos++] = byteLen & 0xff;
            pos += buf.write(term, pos, byteLen, "utf8");
        }
    }
    return buf.subarray(0, pos);
}

function decodeDocTermsBlob(blob) {
    const out = [];
    if (!blob || blob.byteLength < 3)
        return out;
    const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
    let pos = 0;
    while (pos + 3 <= buf.length) {
        const ci = buf[pos++];
        const len = (buf[pos++] << 8) | buf[pos++];
        if (pos + len > buf.length)
            break;
        const ch = ASK_CHANNELS[ci];
        if (ch)
            out.push([ch, buf.toString("utf8", pos, pos + len)]);
        pos += len;
    }
    return out;
}

function packPostingsBlob(list) {
    const i32 = Int32Array.from(list);
    return new Uint8Array(i32.buffer, i32.byteOffset, i32.byteLength);
}

function decodePostingsBlob(blob) {
    if (!blob || blob.byteLength < 8)
        return EMPTY_PACKED_POSTINGS;
    const count = blob.byteLength >>> 2;
    if ((blob.byteOffset & 3) === 0)
        return new Int32Array(blob.buffer, blob.byteOffset, count);
    const copy = new Uint8Array(count << 2);
    copy.set(blob.subarray(0, count << 2));
    return new Int32Array(copy.buffer);
}

function writeFullAskIndexTx(store, codeNodes, mdNodes, pageranks, repoRoot, fileLineCache, docsDigest) {
    store.db.exec(`
        DELETE FROM ask_df;
        DELETE FROM ask_postings;
        DELETE FROM ask_term_postings;
        DELETE FROM ask_docs;
        DELETE FROM ask_vocab;
        DROP INDEX IF EXISTS idx_ask_postings_doc;
        DROP INDEX IF EXISTS idx_ask_docs_path;
    `);
    const allDocs = [...codeNodes, ...mdNodes];
    const insertDoc = prepareStmt(store, ASK_DOC_INSERT_SQL);
    const SLAB_SHIFT = 17;
    const SLAB_SIZE = 1 << SLAB_SHIFT;
    const SLAB_MASK = SLAB_SIZE - 1;
    const slabDoc = [new Int32Array(SLAB_SIZE)];
    const slabTf = [new Int32Array(SLAB_SIZE)];
    const slabPrev = [new Int32Array(SLAB_SIZE)];
    let nextPosting = 0;
    let termCount = 0;
    let termCap = 16384;
    let head = new Int32Array(termCap);
    head.fill(-1);
    let dfArr = new Int32Array(termCap);
    const termToTid = ASK_CHANNELS.map(() => new Map());
    const lensSums = emptyFieldLens();
    const pathCache = { path: null, pathMap: null, pathExactMap: null, pathVocabTokens: null };
    const channelPool = {
        name: new Map(), sig: new Map(), summary: new Map(), body: new Map(),
        literals: new Map(), stem: new Map(), exact_ident: new Map(),
    };
    const vocabCounts = new Map();
    const tmpCompounds = new Map();

    for (let i = 0; i < allDocs.length; i++) {
        const docId = i + 1;
        const n = allDocs[i];
        const bodyText = n.kind === "doc" ? (n.body_text ?? "") : resolveBodyTextForNode(n, repoRoot, fileLineCache);
        const { channels, fieldLens } = buildChannelPostings(n, bodyText, pathCache, channelPool);
        if (n.kind !== "doc" && "body_text" in n)
            delete n.body_text;
        recordNodeVocabFromChannels(n, channels.path, channels.name, pathCache, tmpCompounds, vocabCounts);
        const pr = n.kind === "doc" ? 0 : (pageranks?.get(n.id) ?? 0);
        insertDoc.run(
            docId, n.id, n.path ?? "", n.kind ?? "unknown", n.name ?? "", n.span ?? "L1-L1",
            n.signature ?? null, n.summary ?? null, n.exported ? 1 : 0,
            fieldLens.name, fieldLens.path, fieldLens.sig, fieldLens.summary,
            fieldLens.literals, fieldLens.body, fieldLens.exact_ident, pr,
            encodeDocTermsBlob(channels),
        );
        for (let ci = 0; ci < ASK_CHANNELS.length; ci++) {
            const ch = ASK_CHANNELS[ci];
            lensSums[ch] += fieldLens[ch];
            const tMap = termToTid[ci];
            for (const [term, tf] of channels[ch]) {
                let tid = tMap.get(term);
                if (tid === undefined) {
                    tid = termCount++;
                    if (tid >= termCap) {
                        termCap <<= 1;
                        const nextHead = new Int32Array(termCap);
                        nextHead.fill(-1);
                        nextHead.set(head);
                        head = nextHead;
                        const nextDf = new Int32Array(termCap);
                        nextDf.set(dfArr);
                        dfArr = nextDf;
                    }
                    tMap.set(term, tid);
                }
                const pIdx = nextPosting++;
                const sIdx = pIdx >>> SLAB_SHIFT;
                if (sIdx >= slabDoc.length) {
                    slabDoc.push(new Int32Array(SLAB_SIZE));
                    slabTf.push(new Int32Array(SLAB_SIZE));
                    slabPrev.push(new Int32Array(SLAB_SIZE));
                }
                const off = pIdx & SLAB_MASK;
                slabDoc[sIdx][off] = docId;
                slabTf[sIdx][off] = tf;
                slabPrev[sIdx][off] = head[tid];
                head[tid] = pIdx;
                dfArr[tid]++;
            }
        }
    }

    const insertTermPosting = prepareStmt(store, "INSERT INTO ask_term_postings(channel, term, df, postings) VALUES (?, ?, ?, ?)");
    let packBuf = new Int32Array(4096);
    for (let ci = 0; ci < ASK_CHANNELS.length; ci++) {
        const ch = ASK_CHANNELS[ci];
        const tMap = termToTid[ci];
        const sortedTerms = [...tMap.keys()].sort();
        for (let ti = 0; ti < sortedTerms.length; ti++) {
            const term = sortedTerms[ti];
            const tid = tMap.get(term);
            const df = dfArr[tid];
            const needI32 = df << 1;
            if (needI32 > packBuf.length) {
                let cap = packBuf.length;
                while (cap < needI32)
                    cap <<= 1;
                packBuf = new Int32Array(cap);
            }
            let w = needI32 - 2;
            let p = head[tid];
            while (p >= 0) {
                const sIdx = p >>> SLAB_SHIFT;
                const off = p & SLAB_MASK;
                packBuf[w] = slabDoc[sIdx][off];
                packBuf[w + 1] = slabTf[sIdx][off];
                w -= 2;
                p = slabPrev[sIdx][off];
            }
            insertTermPosting.run(ch, term, df, new Uint8Array(packBuf.buffer, 0, df << 3));
        }
        termToTid[ci] = null;
    }
    slabDoc.length = 0;
    slabTf.length = 0;
    slabPrev.length = 0;
    head = null;
    dfArr = null;

    const insertVocab = prepareStmt(store, "INSERT INTO ask_vocab(kind, token, df) VALUES (?, ?, ?)");
    const vocabKeys = [...vocabCounts.keys()].sort();
    for (let i = 0; i < vocabKeys.length; i++) {
        const k = vocabKeys[i];
        const df = vocabCounts.get(k);
        if (!df || df <= 0)
            continue;
        const nul = k.indexOf("\0");
        insertVocab.run(k.slice(0, nul), k.slice(nul + 1), df);
    }

    store.db.exec("CREATE INDEX IF NOT EXISTS idx_ask_docs_path ON ask_docs(path);");
    const docCount = allDocs.length;
    const avgLens = emptyFieldLens();
    if (docCount > 0) {
        for (const ch of ASK_CHANNELS)
            avgLens[ch] = lensSums[ch] / docCount;
    }
    setSqliteMetaMany(store, {
        doc_count: String(docCount),
        avg_lens_json: JSON.stringify(avgLens),
        lens_sums_json: JSON.stringify(lensSums),
        vocab_ready: "1",
        postings_packed: "1",
        docs_hash: docsDigest,
    });
}

function queryAskDocsByPaths(store, pathSet) {
    const out = [];
    const list = [...pathSet];
    const sqlPrefix =
        "SELECT doc_id, node_id, path, kind, name, pagerank, len_name, len_path, len_sig, len_summary, len_literals, len_body, len_exact FROM ask_docs WHERE path IN (";
    for (let off = 0; off < list.length; off += 256) {
        const sub = list.slice(off, off + 256);
        const bucket = pickPow2InBucket(sub.length);
        const placeholders = IN_PLACEHOLDERS_BY_SIZE.get(bucket);
        const rows = prepareStmt(store, `${sqlPrefix}${placeholders})`).all(...padBucketArgs(sub, bucket));
        for (const r of rows)
            out.push(r);
    }
    return out;
}

function collectIncrementalAskStaleDocs(store, codeNodes, touchedPaths, explicitDeletedPaths, docsUnchanged) {
    const maxDocId = Number(prepareStmt(store, "SELECT MAX(doc_id) AS m FROM ask_docs").get()?.m ?? 0);
    const staleRows = [];
    const oldPrByNodeId = new Map();
    const seenStaleId = new Set();

    if (explicitDeletedPaths !== null) {
        if (touchedPaths.size > 0) {
            for (const r of queryAskDocsByPaths(store, touchedPaths)) {
                if (r.kind === "doc")
                    continue;
                seenStaleId.add(r.doc_id);
                staleRows.push(r);
                oldPrByNodeId.set(r.node_id, Number(r.pagerank ?? 0));
            }
        }
        if (!docsUnchanged) {
            const docRows = prepareStmt(
                store,
                "SELECT doc_id, node_id, path, kind, name, pagerank, len_name, len_path, len_sig, len_summary, len_literals, len_body, len_exact FROM ask_docs WHERE kind = 'doc'",
            ).all();
            for (const r of docRows) {
                if (!seenStaleId.has(r.doc_id)) {
                    seenStaleId.add(r.doc_id);
                    staleRows.push(r);
                }
            }
        }
        return { existingDocRows: null, maxDocId, staleRows, oldPrByNodeId };
    }

    // Legacy caller fallback (dirtyPaths passed without deletedPaths): inspect all ask_docs rows cleanly.
    const existingDocRows = prepareStmt(
        store,
        "SELECT doc_id, node_id, path, kind, name, pagerank, len_name, len_path, len_sig, len_summary, len_literals, len_body, len_exact FROM ask_docs",
    ).all();
    const existingNodeIds = new Set();
    const codePathSet = new Set();
    const codeNodeIdSet = new Set();
    for (const n of codeNodes) {
        if (n.path)
            codePathSet.add(n.path);
        if (n.id)
            codeNodeIdSet.add(n.id);
    }
    const rowsByPath = new Map();
    const flushPathToStale = (p) => {
        const list = rowsByPath.get(p);
        if (list) {
            for (const r of list) {
                if (!seenStaleId.has(r.doc_id)) {
                    seenStaleId.add(r.doc_id);
                    staleRows.push(r);
                    oldPrByNodeId.set(r.node_id, Number(r.pagerank ?? 0));
                }
            }
            rowsByPath.delete(p);
        }
    };
    for (const r of existingDocRows) {
        existingNodeIds.add(r.node_id);
        if (r.kind === "doc") {
            if (!docsUnchanged) {
                seenStaleId.add(r.doc_id);
                staleRows.push(r);
            }
            continue;
        }
        const pathVanished = !codePathSet.has(r.path);
        const nodeVanished = !codeNodeIdSet.has(r.node_id);
        if (touchedPaths.has(r.path) || pathVanished || nodeVanished) {
            seenStaleId.add(r.doc_id);
            staleRows.push(r);
            oldPrByNodeId.set(r.node_id, Number(r.pagerank ?? 0));
            if (!pathVanished && !touchedPaths.has(r.path)) {
                touchedPaths.add(r.path);
                flushPathToStale(r.path);
            }
        }
        else {
            const arr = rowsByPath.get(r.path) ?? [];
            arr.push(r);
            rowsByPath.set(r.path, arr);
        }
    }
    for (const n of codeNodes) {
        if (touchedPaths.has(n.path) || existingNodeIds.has(n.id))
            continue;
        touchedPaths.add(n.path);
        flushPathToStale(n.path);
    }
    return { existingDocRows, maxDocId, staleRows, oldPrByNodeId };
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

function parseStoredLensSums(rawJson) {
    if (!rawJson)
        return null;
    try {
        const parsed = JSON.parse(rawJson);
        if (!parsed || typeof parsed !== "object")
            return null;
        const out = emptyFieldLens();
        for (const ch of ASK_CHANNELS) {
            const v = Number(parsed[ch]);
            if (!Number.isFinite(v))
                return null;
            out[ch] = v;
        }
        return out;
    }
    catch {
        return null;
    }
}

function updateIncrementalPackedPostingsTx(
    store, staleRows, nodesToInsert, maxDocId, pageranks, oldPrByNodeId, repoRoot, fileLineCache, lensSums, docCount,
) {
    const staleDocIds = new Set();
    const touchedByChan = new Map(ASK_CHANNELS.map((ch) => [ch, new Map()]));
    const selectDocTerms = prepareStmt(store, "SELECT terms_blob FROM ask_docs WHERE doc_id = ?");
    const deleteDocById = prepareStmt(store, "DELETE FROM ask_docs WHERE doc_id = ?");

    for (const row of staleRows) {
        const oldDocId = Number(row.doc_id);
        staleDocIds.add(oldDocId);
        if (lensSums) {
            lensSums.name = Math.max(0, lensSums.name - Number(row.len_name ?? 0));
            lensSums.path = Math.max(0, lensSums.path - Number(row.len_path ?? 0));
            lensSums.sig = Math.max(0, lensSums.sig - Number(row.len_sig ?? 0));
            lensSums.summary = Math.max(0, lensSums.summary - Number(row.len_summary ?? 0));
            lensSums.literals = Math.max(0, lensSums.literals - Number(row.len_literals ?? 0));
            lensSums.body = Math.max(0, lensSums.body - Number(row.len_body ?? 0));
            lensSums.stem = Math.max(0, lensSums.stem - Number(row.len_body ?? 0));
            lensSums.exact_ident = Math.max(0, lensSums.exact_ident - Number(row.len_exact ?? 0));
            docCount = Math.max(0, docCount - 1);
        }
        const dtRow = selectDocTerms.get(oldDocId);
        if (dtRow?.terms_blob) {
            for (const [ch, term] of decodeDocTermsBlob(dtRow.terms_blob)) {
                const tm = touchedByChan.get(ch);
                if (tm && !tm.has(term))
                    tm.set(term, null);
            }
        }
        deleteDocById.run(oldDocId);
    }

    const insertDoc = prepareStmt(store, ASK_DOC_INSERT_SQL);
    const pathCache = { path: null, pathMap: null, pathExactMap: null, pathVocabTokens: null };
    let nextDocId = maxDocId + 1;
    for (const n of nodesToInsert) {
        const docId = nextDocId++;
        const isDoc = n.kind === "doc";
        const bodyText = isDoc ? (n.body_text ?? "") : resolveBodyTextForNode(n, repoRoot, fileLineCache);
        const { channels, fieldLens } = buildChannelPostings(n, bodyText, pathCache);
        if (!isDoc && "body_text" in n)
            delete n.body_text;
        const pr = isDoc ? 0 : (pageranks ? (pageranks.get(n.id) ?? 0) : (oldPrByNodeId?.get(n.id) ?? 0.05));
        insertDoc.run(
            docId, n.id, n.path ?? "", n.kind ?? "unknown", n.name ?? "", n.span ?? "L1-L1",
            n.signature ?? null, n.summary ?? null, n.exported ? 1 : 0,
            fieldLens.name, fieldLens.path, fieldLens.sig, fieldLens.summary,
            fieldLens.literals, fieldLens.body, fieldLens.exact_ident, pr,
            encodeDocTermsBlob(channels),
        );
        for (const ch of ASK_CHANNELS) {
            const tm = touchedByChan.get(ch);
            for (const [term, tf] of channels[ch]) {
                let added = tm.get(term);
                if (!added) {
                    added = [];
                    tm.set(term, added);
                }
                added.push(docId, tf);
            }
        }
        if (lensSums) {
            for (const ch of ASK_CHANNELS)
                lensSums[ch] += fieldLens[ch];
            docCount++;
        }
    }

    const staleSorted = [...staleDocIds].sort((a, b) => a - b);
    let mergeScratch = new Int32Array(4096);
    const upsertTerm = prepareStmt(store, "INSERT OR REPLACE INTO ask_term_postings(channel, term, df, postings) VALUES (?, ?, ?, ?)");
    const delTerm = prepareStmt(store, "DELETE FROM ask_term_postings WHERE channel = ? AND term = ?");
    for (const [ch, tm] of touchedByChan) {
        if (tm.size === 0)
            continue;
        const terms = [...tm.keys()];
        const existingByTerm = new Map();
        for (let off = 0; off < terms.length; off += 256) {
            const sub = terms.slice(off, off + 256);
            const bucket = pickPow2InBucket(sub.length);
            const placeholders = IN_PLACEHOLDERS_BY_SIZE.get(bucket);
            const rows = prepareStmt(
                store,
                `SELECT term, postings FROM ask_term_postings WHERE channel = ? AND term IN (${placeholders})`,
            ).all(ch, ...padBucketArgs(sub, bucket));
            for (const r of rows)
                existingByTerm.set(r.term, decodePostingsBlob(r.postings));
        }
        for (let i = 0; i < terms.length; i++) {
            const term = terms[i];
            const prevArr = existingByTerm.get(term);
            const added = tm.get(term);
            const maxNeeded = (prevArr ? prevArr.length : 0) + (added ? added.length : 0);
            if (maxNeeded > mergeScratch.length) {
                let nextCap = mergeScratch.length;
                while (nextCap < maxNeeded)
                    nextCap <<= 1;
                mergeScratch = new Int32Array(nextCap);
            }
            let outLen = 0;
            if (prevArr && prevArr.length > 0) {
                if (staleSorted.length === 0) {
                    mergeScratch.set(prevArr, 0);
                    outLen = prevArr.length;
                }
                else if (staleSorted.length <= 32 && prevArr.length >= 64) {
                    const prevPairs = prevArr.length >>> 1;
                    let srcPair = 0;
                    for (let si = 0; si < staleSorted.length; si++) {
                        const sd = staleSorted[si];
                        let lo = srcPair;
                        let hi = prevPairs;
                        while (lo < hi) {
                            const mid = (lo + hi) >>> 1;
                            if (prevArr[mid << 1] < sd)
                                lo = mid + 1;
                            else
                                hi = mid;
                        }
                        if (lo > srcPair) {
                            const copyStart = srcPair << 1;
                            const copyEnd = lo << 1;
                            mergeScratch.set(prevArr.subarray(copyStart, copyEnd), outLen);
                            outLen += copyEnd - copyStart;
                        }
                        srcPair = (lo < prevPairs && prevArr[lo << 1] === sd) ? lo + 1 : lo;
                    }
                    if (srcPair < prevPairs) {
                        const tail = prevArr.subarray(srcPair << 1);
                        mergeScratch.set(tail, outLen);
                        outLen += tail.length;
                    }
                }
                else {
                    for (let j = 0; j < prevArr.length; j += 2) {
                        const d = prevArr[j];
                        if (!staleDocIds.has(d)) {
                            mergeScratch[outLen++] = d;
                            mergeScratch[outLen++] = prevArr[j + 1];
                        }
                    }
                }
            }
            if (added) {
                for (let j = 0; j < added.length; j++)
                    mergeScratch[outLen++] = added[j];
            }
            const nextDf = outLen >>> 1;
            if (nextDf === 0)
                delTerm.run(ch, term);
            else
                upsertTerm.run(ch, term, nextDf, new Uint8Array(mergeScratch.buffer, 0, outLen << 2));
        }
    }
    return docCount;
}

function writeIncrementalAskIndexTx(
    store, codeNodes, mdNodes, dirtyPaths, deletedPaths, pageranks, repoRoot, fileLineCache, docsDigest, prevMeta, docsUnchanged, existingDocCount, prevTouchedNodes, dirtyNodes,
) {
    const touchedPaths = new Set([...(dirtyPaths ?? []), ...(deletedPaths ?? [])]);
    const { existingDocRows, maxDocId, staleRows, oldPrByNodeId } = collectIncrementalAskStaleDocs(
        store, codeNodes, touchedPaths, deletedPaths, docsUnchanged,
    );
    const lensSums = parseStoredLensSums(prevMeta?.lens_sums_json);
    let docCount = Number(prevMeta?.doc_count ?? existingDocCount);
    if (!Number.isFinite(docCount) || docCount < 0)
        docCount = existingDocCount;
    const packedMode = prevMeta?.postings_packed === "1";
    const vocabDelta = new Map();
    if (prevMeta?.vocab_ready === "1") {
        const oldVocabNodes = Array.isArray(prevTouchedNodes)
            ? prevTouchedNodes
            : staleRows
                .filter((r) => r.kind !== "doc")
                .map((r) => ({ id: r.node_id, path: r.path, kind: r.kind, name: r.name, owner: inferOwnerFromNodeId(r.node_id) }));
        collectNodeVocabDeltas(oldVocabNodes, vocabDelta, -1);
    }

    const deletedSet = deletedPaths ?? new Set();
    const dirtyCodeNodes = Array.isArray(dirtyNodes)
        ? (deletedSet.size === 0 ? dirtyNodes : dirtyNodes.filter((n) => !deletedSet.has(n.path)))
        : codeNodes.filter((n) => touchedPaths.has(n.path) && !deletedSet.has(n.path));
    const nodesToInsert = [
        ...dirtyCodeNodes,
        ...(docsUnchanged ? [] : mdNodes),
    ];
    if (prevMeta?.vocab_ready === "1") {
        collectNodeVocabDeltas(dirtyCodeNodes, vocabDelta, 1);
        applyAskVocabDeltasTx(store, vocabDelta);
    }
    else {
        writeFullAskVocabTx(store, codeNodes);
    }

    let dfDelta = null;
    if (packedMode) {
        docCount = updateIncrementalPackedPostingsTx(
            store, staleRows, nodesToInsert, maxDocId, pageranks, oldPrByNodeId, repoRoot, fileLineCache, lensSums, docCount,
        );
    }
    else {
        dfDelta = new Map();
        const bumpDf = (ch, term, delta) => {
            const k = `${ch}\0${term}`;
            dfDelta.set(k, (dfDelta.get(k) ?? 0) + delta);
        };
        const selectDocPostings = prepareStmt(store, "SELECT channel, term FROM ask_postings WHERE doc_id = ?");
        const deletePostingsByDoc = prepareStmt(store, "DELETE FROM ask_postings WHERE doc_id = ?");
        const deleteDocById = prepareStmt(store, "DELETE FROM ask_docs WHERE doc_id = ?");
        for (const row of staleRows) {
            const oldDocId = row.doc_id;
            if (lensSums) {
                lensSums.name = Math.max(0, lensSums.name - Number(row.len_name ?? 0));
                lensSums.path = Math.max(0, lensSums.path - Number(row.len_path ?? 0));
                lensSums.sig = Math.max(0, lensSums.sig - Number(row.len_sig ?? 0));
                lensSums.summary = Math.max(0, lensSums.summary - Number(row.len_summary ?? 0));
                lensSums.literals = Math.max(0, lensSums.literals - Number(row.len_literals ?? 0));
                lensSums.body = Math.max(0, lensSums.body - Number(row.len_body ?? 0));
                lensSums.stem = Math.max(0, lensSums.stem - Number(row.len_body ?? 0));
                lensSums.exact_ident = Math.max(0, lensSums.exact_ident - Number(row.len_exact ?? 0));
                docCount = Math.max(0, docCount - 1);
            }
            for (const prRow of selectDocPostings.all(oldDocId))
                bumpDf(prRow.channel, prRow.term, -1);
            deletePostingsByDoc.run(oldDocId);
            deleteDocById.run(oldDocId);
        }

        const insertDoc = prepareStmt(store, ASK_DOC_INSERT_SQL);
        const insertPosting = prepareStmt(store, "INSERT INTO ask_postings(channel, term, doc_id, tf) VALUES (?, ?, ?, ?)");
        let nextDocId = maxDocId + 1;
        for (const n of nodesToInsert) {
            const fl = insertSingleAskDoc(
                n, nextDocId++, pageranks, oldPrByNodeId, repoRoot, fileLineCache, insertDoc, insertPosting,
                (ch, term) => bumpDf(ch, term, 1),
            );
            if (lensSums) {
                for (const ch of ASK_CHANNELS)
                    lensSums[ch] += fl[ch];
                docCount++;
            }
        }
    }

    if (pageranks && pageranks.size > 0) {
        const updatePr = prepareStmt(store, "UPDATE ask_docs SET pagerank = ? WHERE doc_id = ?");
        const allCodeRows = existingDocRows ?? prepareStmt(store, "SELECT doc_id, node_id, path, kind, pagerank FROM ask_docs WHERE kind != 'doc'").all();
        for (const r of allCodeRows) {
            if (r.kind === "doc" || touchedPaths.has(r.path))
                continue;
            const nextPr = pageranks.get(r.node_id) ?? 0;
            if (Math.abs((r.pagerank ?? 0) - nextPr) > 1e-6)
                updatePr.run(nextPr, r.doc_id);
        }
    }

    if (dfDelta)
        applyAskDfDeltaStatements(store, dfDelta);
    let finalSums = lensSums;
    let avgLens;
    if (finalSums) {
        avgLens = emptyFieldLens();
        if (docCount > 0) {
            for (const ch of ASK_CHANNELS)
                avgLens[ch] = finalSums[ch] / docCount;
        }
    }
    else {
        const computed = computeAvgLensAndDfSql(store);
        docCount = computed.docCount;
        avgLens = computed.avgLens;
        finalSums = computed.sums;
    }
    setSqliteMetaMany(store, {
        doc_count: String(docCount),
        avg_lens_json: JSON.stringify(avgLens),
        lens_sums_json: JSON.stringify(finalSums),
        vocab_ready: "1",
        ...(packedMode ? { postings_packed: "1" } : {}),
        docs_hash: docsDigest,
    });
}

export function writeAskIndex(outDir, graph, optsOrPrior) {
    const opts = normalizeWriteOpts(optsOrPrior);
    const store = openSqliteStore(outDir, { create: true });
    const repoRoot = inferRepoRoot(outDir, opts);
    const rawNodes = graph?.nodes ?? [];
    const codeNodes = opts.alreadySorted
        ? rawNodes
        : [...rawNodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const dirtyPaths = opts.dirtyPaths ? new Set(opts.dirtyPaths) : null;
    const deletedPaths = opts.deletedPaths ? new Set(opts.deletedPaths) : null;
    const forceFull = opts.fullRebuild === true || (!dirtyPaths && !deletedPaths);
    const existingDocCount = Number(prepareStmt(store, "SELECT COUNT(*) AS cnt FROM ask_docs").get()?.cnt ?? 0);
    const canIncremental = !forceFull && existingDocCount > 0;
    const prevMeta = canIncremental ? getAllSqliteMeta(store) : null;
    const touchedCount = (dirtyPaths?.size ?? 0) + (deletedPaths?.size ?? 0);
    const pageranks = opts.pageranks ?? (
        !canIncremental || touchedCount > 32
            ? computeStaticPageranks(codeNodes, graph?.edges ?? [])
            : null
    );

    let mdNodes = [];
    let docsDigest;
    let docsUnchanged = false;
    if (opts.includeDocs === false) {
        docsDigest = "disabled";
        docsUnchanged = Boolean(canIncremental && prevMeta?.docs_hash === "disabled");
    }
    else if (Array.isArray(opts.markdownDocs)) {
        const resolved = resolvePreloadedMarkdownDocs(
            opts.markdownDocs,
            opts.docsDigest,
            canIncremental ? prevMeta?.docs_hash : undefined,
        );
        mdNodes = resolved.mdNodes;
        docsDigest = resolved.docsDigest;
        docsUnchanged = Boolean(canIncremental && prevMeta?.docs_hash !== undefined && prevMeta.docs_hash === docsDigest);
    }
    else if (canIncremental && typeof opts.docsDigest === "string" && prevMeta?.docs_hash === opts.docsDigest) {
        docsDigest = opts.docsDigest;
        docsUnchanged = true;
    }
    else {
        const loaded = loadAskMarkdownDocs(repoRoot, opts.includeDocs);
        mdNodes = loaded.mdNodes;
        docsDigest = typeof opts.docsDigest === "string" ? opts.docsDigest : loaded.docsDigest;
        docsUnchanged = Boolean(canIncremental && prevMeta?.docs_hash !== undefined && prevMeta.docs_hash === docsDigest);
    }

    const legacyAlreadyCleaned = prevMeta
        ? prevMeta.legacy_cleaned === "1"
        : getSqliteMeta(store, "legacy_cleaned") === "1";

    withSqliteTransaction(store, () => {
        const fileLineCache = new Map();
        if (!canIncremental) {
            writeFullAskIndexTx(store, codeNodes, mdNodes, pageranks, repoRoot, fileLineCache, docsDigest);
            return;
        }
        writeIncrementalAskIndexTx(
            store, codeNodes, mdNodes, dirtyPaths, deletedPaths, pageranks, repoRoot, fileLineCache,
            docsDigest, prevMeta, docsUnchanged, existingDocCount, opts.prevTouchedNodes, opts.dirtyNodes,
        );
    });

    if (!legacyAlreadyCleaned) {
        cleanupLegacyCacheFiles(outDir);
        withSqliteTransaction(store, () => setSqliteMetaMany(store, { legacy_cleaned: "1" }));
    }
    if (store.txDepth === 0)
        checkpointSqliteStore(outDir, "PASSIVE");
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
    const vocabReady = meta.vocab_ready === "1";
    const postingsPacked = meta.postings_packed === "1";
    const rawVocabJson = meta.vocab_json ?? null;
    let parsedVocab = null;
    return {
        docCount,
        avgLens,
        postingsPacked,
        get vocab() {
            if (parsedVocab !== null)
                return parsedVocab;
            if (vocabReady) {
                parsedVocab = loadAskVocabFromSqlite(store, docCount);
                return parsedVocab;
            }
            if (rawVocabJson) {
                try {
                    parsedVocab = deserializeVocab(JSON.parse(rawVocabJson), docCount);
                    return parsedVocab;
                }
                catch { /* fallback empty vocab */ }
            }
            parsedVocab = deserializeVocab(null, docCount);
            return parsedVocab;
        },
    };
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
const EMPTY_PACKED_POSTINGS = new Int32Array(0);

function setBoundedChannelPosting(chanCache, term, value) {
    if (!chanCache.has(term) && chanCache.size >= MAX_CACHED_POSTING_TERMS_PER_CHAN) {
        const oldest = chanCache.keys().next().value;
        if (oldest !== undefined)
            chanCache.delete(oldest);
    }
    chanCache.set(term, value);
}

function collectMissingCachedPostings(terms, chanCache, dfMap, packedMap, hitDocIds) {
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
        const packed = cached.packed;
        if (packed.length > 0) {
            packedMap.set(term, packed);
            if (hitDocIds) {
                for (let i = 0; i < packed.length; i += 2)
                    hitDocIds.add(packed[i]);
            }
        }
    }
    return missing;
}

const MAX_ASK_SNAPSHOT_CACHE = 12;
const IN_BUCKET_SIZES = [4, 16, 64, 256];
const IN_PLACEHOLDERS_BY_SIZE = new Map(
    IN_BUCKET_SIZES.map((sz) => [sz, Array.from({ length: sz }, () => "?").join(",")]),
);

function pickPow2InBucket(n) {
    if (n <= 4) return 4;
    if (n <= 16) return 16;
    if (n <= 64) return 64;
    return 256;
}

function padBucketArgs(slice, bucketSize) {
    if (slice.length === bucketSize)
        return slice;
    const padVal = slice[slice.length - 1];
    const out = new Array(bucketSize);
    for (let i = 0; i < slice.length; i++)
        out[i] = slice[i];
    for (let i = slice.length; i < bucketSize; i++)
        out[i] = padVal;
    return out;
}

function queryChannelPostingsPacked(store, ch, terms, dfMap, packedMap, hitDocIds, chanCache = null, postingsPacked = false) {
    const targetTerms = collectMissingCachedPostings(terms, chanCache, dfMap, packedMap, hitDocIds);
    if (targetTerms.length === 0)
        return;
    if (postingsPacked) {
        for (let off = 0; off < targetTerms.length; off += 256) {
            const sub = targetTerms.slice(off, off + 256);
            const bucket = pickPow2InBucket(sub.length);
            const placeholders = IN_PLACEHOLDERS_BY_SIZE.get(bucket);
            const sql = `SELECT term, df, postings FROM ask_term_postings WHERE channel = ? AND term IN (${placeholders})`;
            const args = [ch, ...padBucketArgs(sub, bucket)];
            const seenHit = new Set();
            const arrayStmt = prepareArrayStmt(store, sql);
            if (arrayStmt) {
                const rows = arrayStmt.all(...args);
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    const term = r[0];
                    if (seenHit.has(term))
                        continue;
                    seenHit.add(term);
                    const packed = decodePostingsBlob(r[2]);
                    const df = Number(r[1] ?? (packed.length >>> 1));
                    dfMap.set(term, df);
                    packedMap.set(term, packed);
                    if (hitDocIds) {
                        for (let j = 0; j < packed.length; j += 2)
                            hitDocIds.add(packed[j]);
                    }
                    if (chanCache)
                        setBoundedChannelPosting(chanCache, term, { df, packed });
                }
            }
            else {
                const rows = prepareStmt(store, sql).all(...args);
                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    const term = r.term;
                    if (seenHit.has(term))
                        continue;
                    seenHit.add(term);
                    const packed = decodePostingsBlob(r.postings);
                    const df = Number(r.df ?? (packed.length >>> 1));
                    dfMap.set(term, df);
                    packedMap.set(term, packed);
                    if (hitDocIds) {
                        for (let j = 0; j < packed.length; j += 2)
                            hitDocIds.add(packed[j]);
                    }
                    if (chanCache)
                        setBoundedChannelPosting(chanCache, term, { df, packed });
                }
            }
            if (chanCache) {
                for (let i = 0; i < sub.length; i++) {
                    if (!seenHit.has(sub[i]))
                        setBoundedChannelPosting(chanCache, sub[i], { df: 0, packed: EMPTY_PACKED_POSTINGS });
                }
            }
        }
        return;
    }
    for (let off = 0; off < targetTerms.length; off += 256) {
        const sub = targetTerms.slice(off, off + 256);
        const bucket = pickPow2InBucket(sub.length);
        const placeholders = IN_PLACEHOLDERS_BY_SIZE.get(bucket);
        const sql = `SELECT term, doc_id, tf FROM ask_postings WHERE channel = ? AND term IN (${placeholders})`;
        const args = [ch, ...padBucketArgs(sub, bucket)];
        const grouped = new Map();
        for (let i = 0; i < sub.length; i++)
            grouped.set(sub[i], []);
        const arrayStmt = prepareArrayStmt(store, sql);
        if (arrayStmt) {
            const rows = arrayStmt.all(...args);
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const docId = Number(r[1]);
                if (hitDocIds)
                    hitDocIds.add(docId);
                grouped.get(r[0])?.push(docId, Number(r[2]));
            }
        }
        else {
            const rows = prepareStmt(store, sql).all(...args);
            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const docId = Number(r.doc_id);
                if (hitDocIds)
                    hitDocIds.add(docId);
                grouped.get(r.term)?.push(docId, Number(r.tf));
            }
        }
        for (let i = 0; i < sub.length; i++) {
            const t = sub[i];
            const raw = grouped.get(t);
            if (raw.length > 0) {
                const packed = Int32Array.from(raw);
                const df = packed.length >>> 1;
                dfMap.set(t, df);
                packedMap.set(t, packed);
                if (chanCache)
                    setBoundedChannelPosting(chanCache, t, { df, packed });
            }
            else if (chanCache) {
                setBoundedChannelPosting(chanCache, t, { df: 0, packed: EMPTY_PACKED_POSTINGS });
            }
        }
    }
}

const ASK_DOCS_SELECT_SQL =
    "SELECT doc_id, node_id, path, kind, name, span, signature, summary, exported, len_name, len_path, len_sig, len_summary, len_literals, len_body, len_exact, pagerank FROM ask_docs";

class AskHydratedDoc {
    constructor(r, isArray = false) {
        const a = isArray ? r : [
            r.doc_id, r.node_id, r.path, r.kind, r.name, r.span,
            r.signature, r.summary, r.exported,
            r.len_name, r.len_path, r.len_sig, r.len_summary, r.len_literals, r.len_body, r.len_exact,
            r.pagerank,
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
        this.pagerank = Number(a[16] ?? 0);
        const bodyLen = Number(a[14] ?? 0);
        this.fieldLens = {
            name: Number(a[9] ?? 0),
            path: Number(a[10] ?? 0),
            sig: Number(a[11] ?? 0),
            summary: Number(a[12] ?? 0),
            literals: Number(a[13] ?? 0),
            body: bodyLen,
            stem: bodyLen,
            exact_ident: Number(a[15] ?? 0),
        };
        this._normSpan = undefined;
        this._lexStatic = null;
    }
}

function fetchAskDocRows(store, sql, args) {
    const arrStmt = prepareArrayStmt(store, sql);
    if (arrStmt)
        return { rows: args ? arrStmt.all(...args) : arrStmt.all(), isArray: true };
    const objStmt = prepareStmt(store, sql);
    return { rows: args ? objStmt.all(...args) : objStmt.all(), isArray: false };
}

function hydrateMissingAskDocs(store, missingIds, docsById) {
    for (let off = 0; off < missingIds.length; off += 256) {
        const slice = missingIds.slice(off, off + 256);
        const bucket = pickPow2InBucket(slice.length);
        const placeholders = IN_PLACEHOLDERS_BY_SIZE.get(bucket);
        const { rows, isArray } = fetchAskDocRows(
            store,
            `${ASK_DOCS_SELECT_SQL} WHERE doc_id IN (${placeholders})`,
            padBucketArgs(slice, bucket),
        );
        for (let i = 0; i < rows.length; i++) {
            const doc = new AskHydratedDoc(rows[i], isArray);
            docsById.set(doc.docId, doc);
        }
    }
}

function loadSnapshotDocTables(store, snapshot) {
    if (snapshot.docTables)
        return snapshot.docTables;
    const maxDocId = Number(prepareStmt(store, "SELECT MAX(doc_id) AS m FROM ask_docs").get()?.m ?? 0);
    const cap = Math.max(1, maxDocId + 1);
    const lenName = new Uint16Array(cap);
    const lenPath = new Uint16Array(cap);
    const lenSig = new Uint16Array(cap);
    const lenSummary = new Uint16Array(cap);
    const lenLiterals = new Uint16Array(cap);
    const lenBody = new Uint16Array(cap);
    const lenExact = new Uint16Array(cap);
    const pagerank = new Float32Array(cap);
    const isDoc = new Uint8Array(cap);
    const valid = new Uint8Array(cap);
    const clamp16 = (v) => (v > 65535 ? 65535 : v < 0 ? 0 : v);
    const { rows, isArray } = fetchAskDocRows(
        store,
        "SELECT doc_id, kind, len_name, len_path, len_sig, len_summary, len_literals, len_body, len_exact, pagerank FROM ask_docs",
        null,
    );
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const id = Number(isArray ? r[0] : r.doc_id);
        if (id <= 0 || id >= cap)
            continue;
        valid[id] = 1;
        isDoc[id] = (isArray ? r[1] : r.kind) === "doc" ? 1 : 0;
        lenName[id] = clamp16(Number(isArray ? r[2] : r.len_name));
        lenPath[id] = clamp16(Number(isArray ? r[3] : r.len_path));
        lenSig[id] = clamp16(Number(isArray ? r[4] : r.len_sig));
        lenSummary[id] = clamp16(Number(isArray ? r[5] : r.len_summary));
        lenLiterals[id] = clamp16(Number(isArray ? r[6] : r.len_literals));
        lenBody[id] = clamp16(Number(isArray ? r[7] : r.len_body));
        lenExact[id] = clamp16(Number(isArray ? r[8] : r.len_exact));
        pagerank[id] = Number((isArray ? r[9] : r.pagerank) ?? 0);
    }
    snapshot.docTables = {
        cap,
        lenName,
        lenPath,
        lenSig,
        lenSummary,
        lenLiterals,
        lenBody,
        lenExact,
        pagerank,
        isDoc,
        valid,
    };
    return snapshot.docTables;
}

function loadAskHitDocsByIds(store, hitDocIds, snapshot) {
    const docs = new Map();
    if (hitDocIds.size === 0)
        return docs;
    const docsById = snapshot ? snapshot.docsById : new Map();
    const missingIds = [];
    for (const id of hitDocIds) {
        if (!docsById.has(id))
            missingIds.push(id);
    }
    if (missingIds.length > 0)
        hydrateMissingAskDocs(store, missingIds, docsById);
    for (const id of hitDocIds) {
        const doc = docsById.get(id);
        if (doc)
            docs.set(id, doc);
    }
    return docs;
}

function getOrLoadAskQuerySnapshot(outDir, store) {
    const key = resolve(outDir);
    const rev = sqliteWalRevision(key);
    const dataVersion = Number(prepareStmt(store, "PRAGMA data_version").get()?.data_version ?? 0);
    const cached = askQuerySnapshotCache.get(key);
    if (rev && cached && sameWalRevision(cached.rev, rev) && cached.dataVersion === dataVersion) {
        askQuerySnapshotCache.delete(key);
        askQuerySnapshotCache.set(key, cached);
        return cached;
    }
    const metaInfo = readAskSqliteIndexMeta(store);
    if (!metaInfo) return null;
    const entry = { rev, dataVersion, metaInfo, docsById: new Map(), postingsByChan: new Map(), docTables: null };
    if (askQuerySnapshotCache.has(key))
        askQuerySnapshotCache.delete(key);
    else if (askQuerySnapshotCache.size >= MAX_ASK_SNAPSHOT_CACHE) {
        const oldest = askQuerySnapshotCache.keys().next().value;
        if (oldest !== undefined)
            askQuerySnapshotCache.delete(oldest);
    }
    askQuerySnapshotCache.set(key, entry);
    return entry;
}

/**
 * Packed `Int32Array` posting lookup for `ask`: defers full `ask_docs` row hydration
 * until after phase-1 BM25F scoring over typed numeric doc-length arrays.
 */
export function queryAskPostingsFast(outDir, termsByChannel = {}) {
    const store = openSqliteStore(outDir, { create: false, readOnly: true });
    if (!store)
        return null;
    const snapshot = getOrLoadAskQuerySnapshot(outDir, store);
    if (!snapshot)
        return null;
    const docTables = loadSnapshotDocTables(store, snapshot);
    const df = {};
    const packedPostings = {};
    for (const ch of ASK_CHANNELS) {
        df[ch] = new Map();
        packedPostings[ch] = new Map();
        const rawTerms = termsByChannel?.[ch];
        if (!rawTerms)
            continue;
        const terms = collectNormalizedChannelTerms(rawTerms);
        if (terms.length > 0) {
            let chanCache = snapshot.postingsByChan.get(ch);
            if (!chanCache)
                snapshot.postingsByChan.set(ch, (chanCache = new Map()));
            queryChannelPostingsPacked(store, ch, terms, df[ch], packedPostings[ch], null, chanCache, snapshot.metaInfo.postingsPacked);
        }
    }
    return {
        docCount: snapshot.metaInfo.docCount,
        avgLens: snapshot.metaInfo.avgLens,
        df,
        packedPostings,
        docTables,
        vocab: snapshot.metaInfo.vocab,
        hydrateDocs(docIds) {
            const activeStore = store.closed ? openSqliteStore(outDir, { create: false, readOnly: true }) : store;
            if (!activeStore)
                return new Map();
            const idSet = docIds instanceof Set ? docIds : new Set(docIds);
            return loadAskHitDocsByIds(activeStore, idSet, snapshot);
        },
    };
}

export function queryAskPostings(outDir, termsByChannel = {}) {
    const store = openSqliteStore(outDir, { create: false, readOnly: true });
    if (!store) return null;
    const snapshot = getOrLoadAskQuerySnapshot(outDir, store);
    if (!snapshot) return null;

    const df = {};
    const postings = {};
    const packedByChan = {};
    const hitDocIds = new Set();
    for (const ch of ASK_CHANNELS) {
        df[ch] = new Map();
        packedByChan[ch] = new Map();
        const rawTerms = termsByChannel?.[ch];
        if (!rawTerms) continue;
        const terms = collectNormalizedChannelTerms(rawTerms);
        if (terms.length > 0) {
            let chanCache = snapshot.postingsByChan.get(ch);
            if (!chanCache)
                snapshot.postingsByChan.set(ch, (chanCache = new Map()));
            queryChannelPostingsPacked(store, ch, terms, df[ch], packedByChan[ch], hitDocIds, chanCache, snapshot.metaInfo.postingsPacked);
        }
    }
    for (const ch of ASK_CHANNELS) {
        const pMap = new Map();
        for (const [term, packed] of packedByChan[ch]) {
            const pairsList = new Array(packed.length >>> 1);
            for (let i = 0, j = 0; i < packed.length; i += 2, j++)
                pairsList[j] = [packed[i], packed[i + 1]];
            pMap.set(term, pairsList);
        }
        postings[ch] = pMap;
    }

    return {
        docCount: snapshot.metaInfo.docCount,
        avgLens: snapshot.metaInfo.avgLens,
        df,
        docs: loadAskHitDocsByIds(store, hitDocIds, snapshot),
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

function attachLazySqliteVocabDfMaps(value, key, initialStore, docKindIds, postingsPacked = false) {
    let cachedStore = initialStore;
    const getStore = () => {
        if (!cachedStore || cachedStore.closed)
            cachedStore = openSqliteStore(key, { create: false, readOnly: true });
        return cachedStore;
    };
    const seenDocIds = new Set();
    if (postingsPacked) {
        const packedDfSql = "SELECT postings FROM ask_term_postings WHERE channel IN ('name', 'path', 'sig', 'summary', 'body') AND term = ?";
        const packedStemBlobSql = "SELECT postings FROM ask_term_postings WHERE channel = 'stem' AND term = ?";
        const packedStemDfSql = "SELECT df FROM ask_term_postings WHERE channel = 'stem' AND term = ?";
        value.dfMap = new LazySqliteDfMap((term) => {
            const activeStore = getStore();
            if (!activeStore)
                return 0;
            const { rows, isArray } = queryVocabDocIds(activeStore, packedDfSql, term);
            seenDocIds.clear();
            for (let i = 0; i < rows.length; i++) {
                const arr = decodePostingsBlob(isArray ? rows[i][0] : rows[i].postings);
                for (let j = 0; j < arr.length; j += 2) {
                    const id = arr[j];
                    if (!docKindIds.has(id))
                        seenDocIds.add(id);
                }
            }
            return seenDocIds.size;
        });
        value.stemDf = new LazySqliteDfMap((stem) => {
            const activeStore = getStore();
            if (!activeStore)
                return 0;
            if (docKindIds.size === 0)
                return Number(prepareStmt(activeStore, packedStemDfSql).get(String(stem))?.df ?? 0);
            const { rows, isArray } = queryVocabDocIds(activeStore, packedStemBlobSql, stem);
            let cnt = 0;
            for (let i = 0; i < rows.length; i++) {
                const arr = decodePostingsBlob(isArray ? rows[i][0] : rows[i].postings);
                for (let j = 0; j < arr.length; j += 2) {
                    if (!docKindIds.has(arr[j]))
                        cnt++;
                }
            }
            return cnt;
        });
        return;
    }
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
    const store = openSqliteStore(key, { create: false, readOnly: true });
    if (!store)
        return null;
    const meta = getAllSqliteMeta(store);
    const codeDocCount = Number(prepareStmt(store, "SELECT COUNT(*) AS c FROM ask_docs WHERE kind != 'doc'").get()?.c ?? 0);
    const snapEntry = askQuerySnapshotCache.get(key);
    let value = snapEntry && sameWalRevision(snapEntry.rev, rev) ? snapEntry.value?.metaInfo?.vocab ?? null : null;
    if (!value && meta.vocab_ready === "1") {
        value = loadAskVocabFromSqlite(store, codeDocCount || 100);
    }
    else if (!value && meta.vocab_json) {
        let parsedVocab = null;
        try {
            parsedVocab = JSON.parse(meta.vocab_json);
        }
        catch {
            return null;
        }
        value = deserializeVocab(parsedVocab, codeDocCount || 100);
    }
    else if (!value) {
        const postRev = sqliteWalRevision(key) ?? rev;
        askVocabCache.set(key, { rev: postRev, value: null });
        return null;
    }
    if (!value.dfMap || !value.stemDf) {
        const docKindIds = new Set(prepareStmt(store, "SELECT doc_id FROM ask_docs WHERE kind = 'doc'").all().map((r) => Number(r.doc_id)));
        attachLazySqliteVocabDfMaps(value, key, store, docKindIds, meta.postings_packed === "1");
    }
    const postRev = sqliteWalRevision(key) ?? rev;
    askVocabCache.set(key, { rev: postRev, value });
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
    const store = openSqliteStore(outDir, { create: false, readOnly: true });
    if (!store)
        return null;
    let meta;
    try {
        meta = getAllSqliteMeta(store);
    }
    catch {
        return null;
    }
    let rawVocab;
    if (meta.vocab_ready === "1") {
        const loaded = loadAskVocabFromSqlite(store, 0);
        rawVocab = {
            compoundSymbols: pairs(loaded.compoundSymbols),
            nameToks: [...loaded.nameTokens].sort(),
            nameStemCounts: pairs(loaded.nameStems),
            pathToks: [...loaded.pathTokens].sort(),
        };
    }
    else if (meta.vocab_json) {
        try {
            rawVocab = JSON.parse(meta.vocab_json);
        }
        catch {
            return null;
        }
    }
    else {
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

    if (meta.postings_packed === "1") {
        const packedSql = "SELECT channel, term, postings FROM ask_term_postings WHERE channel IN ('name', 'path', 'sig', 'summary', 'body')";
        const { rows: packedRows, isArray } = fetchAskDocRows(store, packedSql, null);
        for (let i = 0; i < packedRows.length; i++) {
            const r = packedRows[i];
            const ch = isArray ? r[0] : r.channel;
            const term = isArray ? r[1] : r.term;
            const arr = decodePostingsBlob(isArray ? r[2] : r.postings);
            for (let j = 0; j < arr.length; j += 2) {
                const idx = docIdToIdx.get(arr[j]);
                if (idx === undefined)
                    continue;
                const d = docs[idx];
                const tf = arr[j + 1];
                if (ch === "name")
                    d.name.set(term, tf);
                else if (ch === "path")
                    d.path.set(term, tf);
                else
                    d.body.set(term, (d.body.get(term) ?? 0) + tf);
            }
        }
    }
    else {
        const postingSql = "SELECT channel, term, doc_id, tf FROM ask_postings WHERE channel IN ('name', 'path', 'sig', 'summary', 'body')";
        const arrStmt = prepareArrayStmt(store, postingSql);
        if (arrStmt) {
            const postingRows = arrStmt.all();
            for (let i = 0; i < postingRows.length; i++) {
                const r = postingRows[i];
                const idx = docIdToIdx.get(Number(r[2]));
                if (idx === undefined)
                    continue;
                const d = docs[idx];
                const ch = r[0];
                const term = r[1];
                const tf = Number(r[3]);
                if (ch === "name") d.name.set(term, tf);
                else if (ch === "path") d.path.set(term, tf);
                else d.body.set(term, (d.body.get(term) ?? 0) + tf);
            }
        } else {
            const postingRows = prepareStmt(store, postingSql).all();
            for (let i = 0; i < postingRows.length; i++) {
                const r = postingRows[i];
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
