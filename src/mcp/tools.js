/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { isWithinRoot, tryRealpath } from '../util/fs.js';
import { applySeenSpansFilter, invalidateEditedSpans, isSpanCovered, mergeSpan, parsePointerSpan, recordRetrievalSpans } from '../agy/spans.js';
import { resolveAgyWorkspaceDirs } from '../agy/multi-workspace.js';
import { loadGraphCached } from '../context/graph-store.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol } from '../context/symbol-query.js';
import { parseWalkDepth } from '../graph/traverse.js';
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from '../graph/root.js';
import { readWorkspaceMeta } from '../graph/workspace-path.js';
import { readAgyLastRepo } from '../agy/session.js';
import { isCanonicalMcpTool } from './tool-names.js';

let askModPromise;
let readSpansModPromise;
let skeletonModPromise;
let textHelpersModPromise;
let traverseModPromise;
let traverseCliModPromise;
let testLinksModPromise;
let spanModPromise;
let checkModPromise;
let blastModPromise;
let grepModPromise;
let grepCliModPromise;
let mapModPromise;
let historyModPromise;
let healthModPromise;
let healthRenderModPromise;
let workspaceModPromise;

const getAskMod = () => (askModPromise ??= import('../ask/ask.js'));
const getReadSpansMod = () => (readSpansModPromise ??= import('../ask/read-spans.js'));
const getSkeletonMod = () => (skeletonModPromise ??= import('../ask/skeleton.js'));
const getTextHelpersMod = () => (textHelpersModPromise ??= import('../ask/text-helpers.js'));
const getTraverseMod = () => (traverseModPromise ??= import('../graph/traverse.js'));
const getTraverseCliMod = () => (traverseCliModPromise ??= import('../graph/traverse-cli.js'));
const getTestLinksMod = () => (testLinksModPromise ??= import('../graph/test-links.js'));
const getSpanMod = () => (spanModPromise ??= import('../util/span.js'));
const getCheckMod = () => (checkModPromise ??= import('../graph/check.js'));
const getBlastMod = () => (blastModPromise ??= Promise.all([
    import('../blast/blast.js'),
    import('../blast/diff.js'),
    import('../blast/render.js'),
]));
const getGrepMods = () => (grepModPromise ??= Promise.all([
    import('../search/grep.js'),
    import('../search/grep-cli.js'),
]));
const getMapMod = () => (mapModPromise ??= import('../graph/map.js'));
const getHistoryMod = () => (historyModPromise ??= import('../blast/history.js'));
const getHealthMods = () => (healthModPromise ??= Promise.all([
    import('../health/health.js'),
    import('../health/render.js'),
]));
const getWorkspaceMod = () => (workspaceModPromise ??= import('../graph/workspace.js'));

const NO_GRAPH = 'no graph found — run `plexer build` first';
const DIR_PROP = { type: 'string' };
const MCP_HARD_MAX_BYTES = 8800;
const FRESHNESS_COALESCE_TTL_MS = 300;
const freshnessCheckCache = new Map();

export function invalidateMcpFreshnessCache(repoRoot = null) {
    if (!repoRoot) {
        freshnessCheckCache.clear();
        return;
    }
    const prefix = `${resolve(repoRoot)}::`;
    for (const k of freshnessCheckCache.keys()) {
        if (k.startsWith(prefix)) freshnessCheckCache.delete(k);
    }
}

async function ensureFreshGraphCoalesced(targetRoot, opts = {}) {
    const absRoot = resolve(targetRoot);
    const key = `${absRoot}::${opts.contextDir || ''}`;
    const now = Date.now();
    const cached = freshnessCheckCache.get(key);
    if (cached && now - cached.ts < FRESHNESS_COALESCE_TTL_MS) {
        return { refreshed: false, drift: null, cached: true };
    }
    const res = await ensureFreshGraph(targetRoot, opts);
    if (freshnessCheckCache.size >= 32) {
        freshnessCheckCache.delete(freshnessCheckCache.keys().next().value);
    }
    freshnessCheckCache.set(key, { ts: now });
    return res;
}

function capMcpText(text, maxBytes = MCP_HARD_MAX_BYTES) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    const suffix = '\n… (truncated to MCP 8.8 KB cap)\n';
    const limit = maxBytes - Buffer.byteLength(suffix, 'utf8');
    const kept = [];
    let bytes = 0;
    for (const line of text.split('\n')) {
        const lb = Buffer.byteLength(line, 'utf8') + 1;
        if (bytes + lb > limit)
            break;
        kept.push(line);
        bytes += lb;
    }
    let out = kept.join('\n');
    const fences = (out.match(/^```/gm) || []).length;
    if (fences % 2 === 1)
        out += '\n```';
    return `${out}${suffix}`;
}

export const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
export const HEALTH_ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
};

function unknownSymbolText(query, suggestions = []) {
    if (suggestions.length > 0)
        return `no symbol "${query}" in the graph — did you mean: ${suggestions.join(', ')}?`;
    return `no symbol "${query}" in the graph — check spelling or run \`plexer build\``;
}

async function collectWorkspacePaths(root, dirOverride) {
    const { loadWorkspaceGraphs } = await getWorkspaceMod();
    const paths = [];
    for (const { graph, child } of loadWorkspaceGraphs(root, dirOverride).loaded) {
        const seen = new Set();
        for (const n of graph.nodes) {
            if (n.path && !seen.has(n.path)) {
                seen.add(n.path);
                paths.push(`${child}/${n.path}`);
            }
        }
    }
    return paths.sort();
}

async function suggestWorkspaceSymbols(root, dirOverride, symbols) {
    const [{ loadWorkspaceGraphs }, { suggestNearTargets }] = await Promise.all([
        getWorkspaceMod(),
        getTextHelpersMod(),
    ]);
    const out = new Set();
    for (const { graph } of loadWorkspaceGraphs(root, dirOverride).loaded) {
        for (const sym of symbols) {
            for (const cand of suggestNearTargets(graph, sym, undefined, 3)) {
                out.add(cand);
                if (out.size >= 3)
                    return [...out];
            }
        }
    }
    return [...out];
}

export const TOOLS = [
    {
        name: 'plexer_find_code',
        description: 'Rank repo symbols with <n>: source.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                query: { description: 'query, ";"-split, or string[]' },
                limit: { type: 'number' },
                full: { type: 'boolean', description: '80L/hit' },
                in: { type: 'string', description: 'path prefix' },
                dir: DIR_PROP,
            },
            required: ['query'],
        },
    },
    {
        name: 'plexer_read',
        description: 'Read file:Lx-Ly, file:symbol, or file spans (<n>: lines).',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                spans: { description: 'file:Lx-Ly|Lx|symbol|file (csv/array)' },
                full: { type: 'boolean', description: 'uncapped' },
                include_callers: { type: 'boolean', description: 'cross-file callers' },
                dir: DIR_PROP,
            },
            required: ['spans'],
        },
    },
    {
        name: 'plexer_file_api',
        description: 'Signatures + spans for file(s).',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                file: { description: 'path(s) or basename(s) (csv/array)' },
                all_matches: { type: 'boolean' },
                dir: DIR_PROP,
            },
            required: ['file'],
        },
    },
    {
        name: 'plexer_check_freshness',
        description: 'Check graph sync with working tree.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: { type: 'object', properties: { dir: DIR_PROP } },
    },
    {
        name: 'plexer_trace_calls',
        description: 'Call/ref/import edges (depth 2|"all" for renames).',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { description: 'name, Type.method, path:sym, or path (csv/array)' },
                direction: { type: 'string', enum: ['in', 'out'] },
                depth: { description: '1, N, or "all"' },
                source: { type: 'boolean' },
                full: { type: 'boolean' },
                in: { type: 'string' },
                dir: DIR_PROP,
            },
            required: ['symbol'],
        },
    },
    {
        name: 'plexer_find_all',
        description: 'Regex/literal grep grouped by symbol.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { description: 'pattern(s) or literal(s)' },
                in: { type: 'string' },
                ignore_case: { type: 'boolean' },
                fixed: { type: 'boolean', description: 'literal' },
                context: { type: 'number' },
                source: { type: 'boolean' },
                full: { type: 'boolean' },
                dir: DIR_PROP,
            },
            required: ['pattern'],
        },
    },
    {
        name: 'plexer_repo_map',
        description: 'Directory hubs and hotspots.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                max_dirs: { type: 'number' },
                churn: { type: 'boolean' },
                dir: DIR_PROP,
            },
        },
    },
    {
        name: 'plexer_blast',
        description: 'Git diff blast radius: callers and tests.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                base: { type: 'string', description: 'git ref' },
                depth: { description: 'hops or "all"' },
                format: { type: 'string', enum: ['text', 'markdown', 'mermaid'] },
                dir: DIR_PROP,
            },
        },
    },
    {
        name: 'plexer_health',
        description: 'Repo health audits and fix queue.',
        annotations: HEALTH_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'scan', 'next', 'backlog', 'show', 'tree', 'detect', 'prompt', 'resolve', 'skip', 'wontfix', 'reopen'],
                },
                target: { type: 'string' },
                in: { type: 'string' },
                diff: { type: 'boolean' },
                count: { type: 'number' },
                format: { type: 'string', enum: ['text', 'markdown', 'json'] },
                note: { type: 'string' },
                attest: { type: 'string' },
                dir: DIR_PROP,
                options: {
                    type: 'object',
                    description: 'Flags: cluster, group, status, chronic, confirm, permanent, detector, patterns, base, only, skip, max',
                },
            },
        },
    },
];

function optIn(args) {
    return typeof args.in === 'string' && args.in ? args.in : undefined;
}

function resolveTraceDepth(raw, defaultDepth = 1) {
    const d = parseWalkDepth(raw, defaultDepth);
    if (Number.isNaN(d))
        return { error: `invalid depth "${raw}" — expected a positive integer or "all"` };
    return { depth: d };
}

function parseMaxDirs(args) {
    return typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
}

function parsePositiveLimit(raw, fallback) {
    if (raw === undefined || raw === null)
        return { limit: fallback };
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1)
        return { error: 'limit must be a positive integer' };
    return { limit: Math.min(n, 100) };
}

function parseQueriesList(raw) {
    const list = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
    return list
        .flatMap((q) => {
            const str = String(q ?? '').trim();
            if (!str)
                return [];
            if (!str.includes(';'))
                return [str];
            const parts = str.split(';').map((s) => s.trim()).filter(Boolean);
            return parts.length >= 2 && parts.every((p) => p.split(/\s+/).length >= 2) ? parts : [str];
        })
        .filter(Boolean);
}

function parseCommaOrArrayList(raw) {
    const list = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
    return list
        .flatMap((item) => String(item ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

function parsePatternList(raw) {
    const list = Array.isArray(raw) ? raw : raw !== undefined && raw !== null ? [raw] : [];
    return list.map((p) => String(p ?? '')).filter(Boolean);
}

/** Render every resolved match's header + edge report (or the loud zero-edge
 * note), one block per match, joined with a blank line — the same grouping
 * `plexer callers` uses for multi-match symbols. `showDepth` tags each hit with
 * its BFS depth (for transitive `depth>1` walks). */
async function renderMatches(root, direction, showDepth, matches, hitsFor, graph, withSource = false, full = false, seenSpans = null) {
    const [{ fileReader }, { linkTestsForGraph }, { renderMatchBlock }] = await Promise.all([
        getSpanMod(),
        getTestLinksMod(),
        getTraverseCliMod(),
    ]);
    const read = fileReader(root);
    const testLinks = graph ? linkTestsForGraph(graph) : null;
    const seenSourceIds = new Set();
    const shownTargetSpans = seenSpans ? [] : null;
    const maxCap = MCP_HARD_MAX_BYTES;
    const singleCap = full ? 8000 : 5400;
    const maxBytesPerSymbol = matches.length > 1 ? Math.max(1200, Math.floor(maxCap / matches.length)) : singleCap;
    let totalBytes = 0;
    const rendered = matches
        .map((m) => {
            const remaining = matches.length > 1 ? Math.max(0, maxCap - totalBytes) : maxBytesPerSymbol;
            const sourceBudget = { bytes: 0, maxBytes: Math.min(maxBytesPerSymbol, remaining) };
            const block = renderMatchBlock(m, hitsFor(m), direction, showDepth, matches.length, read, {
                source: withSource && remaining > 0,
                full,
                seenSourceIds,
                seenSpans: !full ? seenSpans : null,
                shownTargetSpans,
                sourceBudget,
                graph,
                testLinks,
            });
            totalBytes += sourceBudget.bytes;
            return block;
        })
        .join('\n\n');
    const finalText = capMcpText(rendered, MCP_HARD_MAX_BYTES);
    if (seenSpans && shownTargetSpans && Buffer.byteLength(finalText, 'utf8') <= MCP_HARD_MAX_BYTES) {
        for (const sp of shownTargetSpans) {
            mergeSpan(seenSpans, sp.file, sp.start, sp.end);
        }
    }
    return finalText;
}

async function runBlastOnRepo(root, dirOverride, args) {
    const contextDir = contextDirFor(root, dirOverride);
    const w = loadGraphCached(contextDir);
    if (!w)
        return { text: NO_GRAPH, isError: true };
    const parsedDepth = resolveTraceDepth(args.depth, 2);
    if (parsedDepth.error)
        return { text: parsedDepth.error, isError: true };
    const [{ blastRadiusIn }, { changedFiles, refExists }, { markdownReport, mermaidDiagram, textReport }] = await getBlastMod();
    const base = typeof args.base === 'string' && args.base.trim() ? args.base.trim() : undefined;
    if (base !== undefined && !refExists(root, base)) {
        return {
            text: `base ref "${base}" is not in this checkout — fetch enough history for the merge base`,
            isError: true,
        };
    }
    const diff = changedFiles(root, base);
    if (!diff) {
        return { text: `could not read a diff in ${root} — is this a git repository?`, isError: true };
    }
    const report = blastRadiusIn(w, contextDir, diff.files, diff.basis, parsedDepth.depth, { rootDir: root });
    const fmt = args.format === 'markdown' || args.format === 'mermaid' ? args.format : 'text';
    if (fmt === 'mermaid') {
        return { text: capMcpText(mermaidDiagram(report) ?? '%% no dependents to draw'), isError: false };
    }
    const text = fmt === 'markdown' ? markdownReport(report, { root }) : textReport(report);
    return { text: capMcpText(text), isError: false };
}

async function workspaceFindAll(root, dirOverride, args) {
    const patterns = parsePatternList(args.pattern);
    if (patterns.length === 0)
        return { text: 'plexer_find_all requires a pattern', isError: true };
    const [{ federateGrep }, [, { formatGrepResult, zeroHitNote }]] = await Promise.all([
        getWorkspaceMod(),
        getGrepMods(),
    ]);
    const contextLines = typeof args.context === 'number' && Number.isFinite(args.context)
        ? Math.max(0, Math.min(50, Math.trunc(args.context)))
        : args.source === false
            ? 0
            : args.full === true
                ? 4
                : 2;
    const perPatternBudget = patterns.length >= 2 ? Math.max(950, Math.floor(8600 / patterns.length)) : 4800;
    const chunks = patterns.map((pat) => {
        const { result, coverage } = federateGrep(root, dirOverride, pat, {
            ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
            fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
            context: contextLines,
            source: contextLines > 0,
            in: optIn(args),
        });
        const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result, { maxBytes: perPatternBudget });
        return coverage ? `${text}\n${coverage}` : text;
    });
    return { text: capMcpText(chunks.join('\n\n')), isError: false };
}

async function workspaceBlast(root, dirOverride, args) {
    const { loadWorkspaceGraphs } = await getWorkspaceMod();
    const wg = loadWorkspaceGraphs(root, dirOverride);
    if (wg.loaded.length === 0)
        return { text: NO_GRAPH, isError: true };
    const chunks = [];
    for (const { child } of wg.loaded) {
        const res = await runBlastOnRepo(join(root, child), undefined, args);
        if (!res.isError) {
            chunks.push(`## ${child}/\n${res.text.trimEnd()}`);
        }
    }
    if (chunks.length === 0)
        return { text: 'could not read a diff in any workspace repository', isError: true };
    return { text: capMcpText(`${chunks.join('\n\n')}\n`), isError: false };
}

async function workspaceHealth(root, dirOverride, args) {
    const { loadWorkspaceGraphs } = await getWorkspaceMod();
    const ws = readWorkspaceMeta(root, dirOverride);
    const children = ws?.children?.length
        ? ws.children
        : loadWorkspaceGraphs(root, dirOverride).loaded.map((l) => l.child);
    if (children.length === 0)
        return { text: NO_GRAPH, isError: true };
    const isJson = args.format === 'json';
    const repos = {};
    const chunks = [];
    for (const child of children) {
        const childPath = typeof child === 'string' ? child : child.path;
        const childName = typeof child === 'string' ? child : (child.name ?? child.path);
        const res = await singleHealth(join(root, childPath), args, undefined);
        if (res.isError && res.text !== NO_GRAPH)
            return res;
        if (!res.isError) {
            if (isJson) {
                repos[childName] = JSON.parse(res.text);
            }
            else {
                chunks.push(`=== ${childName} ===\n${res.text.trimEnd()}`);
            }
        }
    }
    if (isJson ? Object.keys(repos).length === 0 : chunks.length === 0)
        return { text: NO_GRAPH, isError: true };
    if (isJson) {
        return { text: `${JSON.stringify({ workspace: true, repos }, null, 2)}\n`, isError: false };
    }
    return { text: `${chunks.join('\n\n')}\n`, isError: false };
}

async function workspaceRead(root, dirOverride, args, seenSpans = null) {
    const specs = parseCommaOrArrayList(args.spans ?? args.file);
    if (specs.length === 0)
        return { text: 'plexer_read requires spans', isError: true };
    const [{ federateRead }, { formatReadSpans }, { suggestClosestFiles }] = await Promise.all([
        getWorkspaceMod(),
        getReadSpansMod(),
        getTextHelpersMod(),
    ]);
    const r = federateRead(root, dirOverride, specs, { full: args.full === true, callers: args.include_callers === true });
    if (r.blocks.some((b) => b.error && !b.error.includes('did you mean:'))) {
        const wsPaths = await collectWorkspacePaths(root, dirOverride);
        for (const b of r.blocks) {
            if (b.error && !b.error.includes('did you mean:') && !b.error.includes('sensitive')) {
                const rawPath = String(b.spec ?? '').split(':')[0];
                const hints = suggestClosestFiles(rawPath, wsPaths, 3);
                if (hints.length)
                    b.error = `${b.error} — did you mean: ${hints.join(', ')}?`;
            }
        }
    }
    applyReadSeenSpans(r, seenSpans, args.full === true);
    return {
        text: formatReadSpans(r),
        isError: r.blocks.length > 0 && r.blocks.every((b) => Boolean(b.error)),
    };
}

async function workspaceFileApi(root, dirOverride, args) {
    const files = parseCommaOrArrayList(args.file);
    if (files.length === 0)
        return { text: 'plexer_file_api requires a file', isError: true };
    const [{ federateSkeleton }, { formatSkeleton }, { suggestClosestFiles }] = await Promise.all([
        getWorkspaceMod(),
        getSkeletonMod(),
        getTextHelpersMod(),
    ]);
    const skelOpts = { allMatches: Boolean(args.all_matches) };
    const results = files.map((f) => federateSkeleton(root, dirOverride, f, skelOpts));
    if (results.some((r) => !r.entries?.length && r.note && !r.note.includes('ambiguous') && !r.note.includes('did you mean:'))) {
        const wsPaths = await collectWorkspacePaths(root, dirOverride);
        for (const r of results) {
            if (!r.entries?.length && r.note && !r.note.includes('ambiguous') && !r.note.includes('did you mean:')) {
                const hints = suggestClosestFiles(r.file, wsPaths, 3);
                if (hints.length)
                    r.note = `${r.note} — did you mean: ${hints.join(', ')}?`;
            }
        }
    }
    const text = results.length === 1
        ? formatSkeleton(results[0])
        : `${results.map((r) => formatSkeleton(r).trimEnd()).join('\n\n')}\n`;
    const isError = results.every((r) => !r.entries?.length && Boolean(r.note || r.error));
    return { text: capMcpText(text), isError };
}

async function workspaceTraceCalls(root, dirOverride, args, seenSpans = null) {
    const symbols = parseCommaOrArrayList(args.symbol ?? args.file);
    if (symbols.length === 0)
        return { text: 'plexer_trace_calls requires a symbol', isError: true };
    const parsedDepth = resolveTraceDepth(args.depth, 1);
    if (parsedDepth.error)
        return { text: parsedDepth.error, isError: true };
    const { federateCallers } = await getWorkspaceMod();
    const shownTargetSpans = seenSpans ? [] : null;
    const { text, found } = federateCallers(root, dirOverride, symbols.length === 1 ? symbols[0] : symbols, {
        direction: args.direction === 'out' ? 'out' : 'in',
        depth: parsedDepth.depth,
        source: args.full === true ? true : args.source !== false,
        full: args.full === true,
        in: optIn(args),
        seenSpans: args.full === true ? null : seenSpans,
        shownTargetSpans,
    });
    if (seenSpans && shownTargetSpans && Buffer.byteLength(text, 'utf8') <= MCP_HARD_MAX_BYTES) {
        for (const sp of shownTargetSpans)
            mergeSpan(seenSpans, sp.file, sp.start, sp.end);
    }
    if (!found && !text.includes('did you mean:')) {
        const hints = await suggestWorkspaceSymbols(root, dirOverride, symbols);
        if (hints.length)
            return { text: `${text.trimEnd()} — did you mean: ${hints.join(', ')}?\n`, isError: true };
    }
    return { text: capMcpText(text), isError: !found };
}

/** When the MCP server is rooted at a workspace parent, the ask/read/callers/grep/
 * map/check/file_api/blast tools federate across the children — identical to the CLI. */
async function callWorkspaceTool(root, dirOverride, name, args, seenSpans = null) {
    switch (name) {
        case 'plexer_find_code': {
            const queries = parseQueriesList(args.query ?? args.queries);
            if (queries.length === 0)
                return { text: 'plexer_find_code requires a query', isError: true };
            const parsedLimit = parsePositiveLimit(args.limit, queries.length > 1 ? 3 : 5);
            if (parsedLimit.error)
                return { text: parsedLimit.error, isError: true };
            const { limit } = parsedLimit;
            const [{ federateAsk }, { formatAsk }] = await Promise.all([getWorkspaceMod(), getAskMod()]);
            const blocks = queries.map((q) => {
                const r = federateAsk(root, dirOverride, q, { limit, source: true, full: args.full === true, in: optIn(args) });
                return formatAskWithSeenSpans(r, seenSpans, args.full === true, formatAsk);
            });
            return { text: capMcpText(`${blocks.join('\n\n')}\n`), isError: false };
        }
        case 'plexer_read':
            return workspaceRead(root, dirOverride, args, seenSpans);
        case 'plexer_file_api':
            return workspaceFileApi(root, dirOverride, args);
        case 'plexer_trace_calls':
            return workspaceTraceCalls(root, dirOverride, args, seenSpans);
        case 'plexer_find_all':
            return workspaceFindAll(root, dirOverride, args);
        case 'plexer_repo_map': {
            const [{ federateMap }, { analyzeGitHistory }] = await Promise.all([getWorkspaceMod(), getHistoryMod()]);
            return {
                text: federateMap(root, dirOverride, {
                    maxDirs: parseMaxDirs(args),
                    churn: args.churn === true,
                    analyzeGitHistory,
                }),
                isError: false,
            };
        }
        case 'plexer_blast':
            return workspaceBlast(root, dirOverride, args);
        case 'plexer_health':
            return workspaceHealth(root, dirOverride, args);
        case 'plexer_check_freshness': {
            const { federateCheck } = await getWorkspaceMod();
            const { text } = await federateCheck(root, dirOverride);
            return { text, isError: false };
        }
        default:
            return null;
    }
}

/** Tools whose whole job is to REPORT drift. Rebuilding first would make
 * `plexer_check_freshness` answer about a graph it just fixed, i.e. always "OK". */
const NO_REFRESH_TOOLS = new Set(['plexer_check_freshness']);

function extractCandidateAbsPath(args) {
    const raw = args?.file ?? args?.spans;
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (typeof first !== 'string' || !first.trim())
        return null;
    const item = first.split(',')[0].trim();
    const colonMatch = item.match(/^((?:[A-Za-z]:)?[^:]+):/);
    const fileCandidate = colonMatch ? colonMatch[1] : item;
    if (!isAbsolute(fileCandidate))
        return null;
    const resolved = resolve(fileCandidate);
    if (existsSync(resolved))
        return dirname(resolved);
    const parent = dirname(resolved);
    return existsSync(parent) ? parent : null;
}

function sessionSeenSpansFor(sessionState, targetRoot) {
    if (!sessionState || typeof sessionState !== 'object') return null;
    const key = tryRealpath(targetRoot);
    sessionState.seenSpansByRepo ??= {};
    if (sessionState.seenSpansByRepo[key]) return sessionState.seenSpansByRepo[key];
    if (Object.keys(sessionState.seenSpansByRepo).length === 0) {
        sessionState.seenSpans ??= {};
        sessionState.seenSpansByRepo[key] = sessionState.seenSpans;
        return sessionState.seenSpans;
    }
    sessionState.seenSpansByRepo[key] = {};
    return sessionState.seenSpansByRepo[key];
}

function formatAskWithSeenSpans(askResult, seenSpans, forceFull, formatAsk) {
    let cur = askResult;
    if (seenSpans && !forceFull) {
        cur = applySeenSpansFilter(askResult, seenSpans)?.ask ?? askResult;
    }
    if (seenSpans) recordRetrievalSpans(seenSpans, cur);
    return formatAsk(cur).trimEnd();
}

function applyReadSeenSpans(readResult, seenSpans, forceFull = false) {
    if (!seenSpans || !Array.isArray(readResult?.blocks)) return;
    for (const b of readResult.blocks) {
        if (!b || b.error || !b.file || !b.span) continue;
        const parsed = parsePointerSpan(`${b.file}:${b.span}`);
        if (!parsed) continue;
        if (!forceFull && isSpanCovered(seenSpans, parsed.file, parsed.start, parsed.end)) {
            b.code = `// [seen: ${parsed.file}:L${parsed.start}-L${parsed.end}; full:true]`;
        } else {
            mergeSpan(seenSpans, parsed.file, parsed.start, parsed.end);
        }
    }
}

function isFilesystemRoot(p) {
    if (!p || typeof p !== 'string') return false;
    const c = tryRealpath(p);
    return c === parse(c).root;
}

function resolveMcpRoot(root, args, dirOverride, sessionState = null, getAgyRoots = null) {
    if (typeof args?.dir === 'string' && args.dir.trim()) {
        return nearestPlexerRoot(args.dir.trim(), dirOverride).root;
    }
    if (dirOverride === undefined) {
        const absDir = extractCandidateAbsPath(args);
        if (absDir) {
            const fromAbs = nearestPlexerRoot(absDir, dirOverride).root;
            if (!isFilesystemRoot(fromAbs) && (hasPlexerIndex(fromAbs) || isAutoBuildableRepo(fromAbs))) {
                return fromAbs;
            }
        }
    }
    if (root && !isFilesystemRoot(root)) {
        const candidate = nearestPlexerRoot(root, dirOverride).root;
        if (!isFilesystemRoot(candidate) && (dirOverride !== undefined || hasPlexerIndex(candidate) || isAutoBuildableRepo(candidate))) {
            return candidate;
        }
    }
    const mcpRoots = Array.isArray(sessionState?.roots) ? sessionState.roots : [];
    for (const mr of mcpRoots) {
        if (!mr || isFilesystemRoot(mr)) continue;
        const rc = nearestPlexerRoot(mr, dirOverride).root;
        if (!isFilesystemRoot(rc) && (hasPlexerIndex(rc) || isAutoBuildableRepo(rc))) return rc;
    }
    for (const mr of mcpRoots) {
        if (mr && !isFilesystemRoot(mr)) return nearestPlexerRoot(mr, dirOverride).root;
    }
    const agyCandidates = getAgyRoots
        ? getAgyRoots()
        : [readAgyLastRepo(), ...resolveAgyWorkspaceDirs({})].filter(Boolean);
    for (const ac of agyCandidates) {
        if (isFilesystemRoot(ac)) continue;
        const ra = nearestPlexerRoot(ac, dirOverride).root;
        if (!isFilesystemRoot(ra)) return ra;
    }
    return root ? nearestPlexerRoot(root, dirOverride).root : process.cwd();
}

function isInsideRoot(base, target) {
    if (!base || !target || isFilesystemRoot(base))
        return false;
    return isWithinRoot(target, base);
}

export async function callTool(root, name, args, dirOverride, sessionState = null) {
    if (!isCanonicalMcpTool(name)) {
        return { text: `unknown tool: ${name}`, isError: true };
    }
    try {
        if (sessionState?.pendingRoots) await sessionState.pendingRoots;
        let cachedAgyRoots = null;
        const getAgyRoots = () => (cachedAgyRoots ??= [readAgyLastRepo(), ...resolveAgyWorkspaceDirs({})].filter(Boolean));
        const targetRoot = resolveMcpRoot(root, args, dirOverride, sessionState, getAgyRoots);
        if (isFilesystemRoot(targetRoot)) {
            return { text: NO_GRAPH, isError: true };
        }
        const startupRoot = root ? resolve(root) : '';
        const mcpRoots = Array.isArray(sessionState?.roots) ? sessionState.roots : [];
        const hasStartupRoot = Boolean(startupRoot && !isFilesystemRoot(startupRoot));
        const isTmpStartupWithMcpRoots = mcpRoots.length > 0 && startupRoot === resolve(tmpdir());
        const trustedViaStartup = hasStartupRoot && !isTmpStartupWithMcpRoots && isInsideRoot(startupRoot, targetRoot);
        const trustedViaMcp = mcpRoots.some((r) => isInsideRoot(r, targetRoot));
        const isTrustedRoot = (hasStartupRoot || mcpRoots.length > 0)
            ? (trustedViaStartup || trustedViaMcp)
            : (hasPlexerIndex(targetRoot) || getAgyRoots().some((d) => isInsideRoot(d, targetRoot)));
        if (!isTrustedRoot) {
            return { text: NO_GRAPH, isError: true };
        }
        const ws = readWorkspaceMeta(targetRoot, dirOverride);
        let note = null;
        const seenSpans = sessionSeenSpansFor(sessionState, targetRoot);
        if (!NO_REFRESH_TOOLS.has(name)) {
            const r = ws
                ? await ensureFreshChildren(targetRoot, ws.children, { contextDir: dirOverride, autoBuild: isTrustedRoot })
                : await ensureFreshGraphCoalesced(targetRoot, { contextDir: dirOverride, autoBuild: isTrustedRoot });
            if (r?.refreshed) {
                const changedFiles = [
                    ...(Array.isArray(r.drift?.changed) ? r.drift.changed : []),
                    ...(Array.isArray(r.drift?.removed) ? r.drift.removed : []),
                ];
                if (seenSpans && changedFiles.length > 0) {
                    for (const rel of changedFiles) {
                        invalidateEditedSpans(seenSpans, rel, 1);
                    }
                }
                if (seenSpans && Array.isArray(r.children)) {
                    for (const ch of r.children) {
                        const childPrefix = ch?.child ? `${ch.child}/` : '';
                        for (const rel of [...(ch?.drift?.changed ?? []), ...(ch?.drift?.removed ?? [])]) {
                            invalidateEditedSpans(seenSpans, `${childPrefix}${rel}`, 1);
                            invalidateEditedSpans(seenSpans, rel, 1);
                        }
                    }
                }
            }
            note = refreshNote(r);
        }
        const fed = ws ? await callWorkspaceTool(targetRoot, dirOverride, name, args, seenSpans) : null;
        const res = fed ?? (await callSingleTool(targetRoot, name, args, dirOverride, seenSpans));
        return note ? { ...res, text: `${note}\n${res.text}` } : res;
    }
    catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
}

async function singleFindCode(root, args, dirOverride, seenSpans = null) {
    const queries = parseQueriesList(args.query ?? args.queries);
    if (queries.length === 0)
        return { text: 'plexer_find_code requires a query', isError: true };
    const parsedLimit = parsePositiveLimit(args.limit, queries.length > 1 ? 3 : 5);
    if (parsedLimit.error)
        return { text: parsedLimit.error, isError: true };
    const { limit } = parsedLimit;
    const { ask, formatAsk } = await getAskMod();
    const seenPointers = queries.length > 1 ? new Set() : undefined;
    const blocks = queries.map((q) => {
        const maxHitsToInline = queries.length > 1 ? 1 : undefined;
        const maxSourceBytes = queries.length > 1
            ? (args.full === true ? 2800 : queries.length >= 3 ? 1700 : 2100)
            : undefined;
        const r = ask(root, q, {
            contextDir: dirOverride,
            limit,
            source: true,
            full: args.full === true,
            in: optIn(args),
            seenPointers,
            maxSourceBytes,
            maxHitsToInline,
        });
        return formatAskWithSeenSpans(r, seenSpans, args.full === true, formatAsk);
    });
    return { text: capMcpText(`${blocks.join('\n\n')}\n`), isError: false };
}

async function singleTraceCalls(root, args, dirOverride, seenSpans = null) {
    const queries = parseCommaOrArrayList(args.symbol ?? args.file);
    if (queries.length === 0)
        return { text: 'plexer_trace_calls requires a symbol', isError: true };
    const parsedDepth = resolveTraceDepth(args.depth, 1);
    if (parsedDepth.error)
        return { text: parsedDepth.error, isError: true };
    const w = loadGraphCached(contextDirFor(root, dirOverride));
    if (!w)
        return { text: NO_GRAPH, isError: true };
    const inPrefix = optIn(args);
    const matches = [];
    const seenIds = new Set();
    for (const q of queries) {
        for (const m of resolveSymbol(w, q, inPrefix ? { in: inPrefix } : {})) {
            if (!seenIds.has(m.id)) {
                seenIds.add(m.id);
                matches.push(m);
            }
        }
    }
    if (matches.length === 0) {
        const { suggestNearTargets } = await getTextHelpersMod();
        const suggestions = [...new Set(queries.flatMap((q) => suggestNearTargets(w, q, inPrefix, 3)))].slice(0, 3);
        return { text: unknownSymbolText(queries.join(', '), suggestions), isError: true };
    }
    const { edgeWalk } = await getTraverseMod();
    const direction = args.direction === 'out' ? 'out' : 'in';
    const { depth } = parsedDepth;
    const useSource = args.full === true ? true : args.source !== false;
    const text = await renderMatches(root, direction, depth > 1, matches, (m) => edgeWalk(w, m, direction, depth), w, useSource, args.full === true, seenSpans);
    return { text, isError: false };
}

async function singleFindAll(root, args, dirOverride) {
    const patterns = parsePatternList(args.pattern);
    if (patterns.length === 0)
        return { text: 'plexer_find_all requires a pattern', isError: true };
    const w = loadGraphCached(contextDirFor(root, dirOverride));
    if (!w)
        return { text: NO_GRAPH, isError: true };
    const [{ grepGraph }, { formatGrepResult, zeroHitNote }] = await getGrepMods();
    const contextLines = typeof args.context === 'number' && Number.isFinite(args.context)
        ? Math.max(0, Math.min(50, Math.trunc(args.context)))
        : args.source === false
            ? 0
            : args.full === true
                ? 4
                : 2;
    const perPatternBudget = patterns.length >= 2 ? Math.max(950, Math.floor(8600 / patterns.length)) : 4800;
    const chunks = patterns.map((pat) => {
        const result = grepGraph(w, root, pat, {
            ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
            fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
            context: contextLines,
            source: contextLines > 0,
            in: optIn(args),
        });
        return result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result, { maxBytes: perPatternBudget });
    });
    return { text: capMcpText(chunks.join('\n\n')), isError: false };
}

const ALLOWED_MCP_HEALTH_ACTIONS = new Set([
    'status',
    'scan',
    'next',
    'backlog',
    'show',
    'tree',
    'detect',
    'prompt',
    'resolve',
    'skip',
    'wontfix',
    'reopen',
]);

function formatShowHealthText(res) {
    if (res.view === 'concerns') {
        const lines = [`concerns (${res.count ?? 0}):`];
        for (const c of res.concerns ?? []) {
            lines.push(`- [${c.type ?? 'concern'}] ${c.file ?? ''} — ${c.summary ?? ''}`);
        }
        return `${lines.join('\n')}\n`;
    }
    if (res.view === 'dimension') {
        const d = res.dimension ?? {};
        const scoreStr = d.score !== null && d.score !== undefined ? `${d.score}%` : 'unassessed';
        const lines = [`plexer health show ${d.id ?? d.name ?? ''} (${scoreStr}, ${res.count ?? 0} issues):`];
        for (const iss of res.items ?? []) {
            lines.push(`- [${iss.tier}/${iss.severity}] ${iss.id} — ${iss.summary}`);
        }
        return `${lines.join('\n')}\n`;
    }
    const lines = [`plexer health show — ${res.count ?? 0} of ${res.total_matching ?? res.count ?? 0} issues:`];
    for (const iss of res.items ?? []) {
        lines.push(`- [${iss.tier}/${iss.severity}] ${iss.id} — ${iss.summary}`);
        if (iss.code_excerpt) {
            for (const line of String(iss.code_excerpt).split('\n')) {
                lines.push(`    ${line}`);
            }
        }
    }
    return `${lines.join('\n')}\n`;
}

function formatDetectHealthText(res) {
    const lines = [`plexer health detect (${res.detector ?? 'all'}) — ${res.count ?? 0} finding(s):`];
    for (const it of res.items ?? []) {
        lines.push(`- [${it.tier}/${it.severity}/${it.detector}] ${it.file}:${it.span} — ${it.summary}`);
    }
    return `${lines.join('\n')}\n`;
}

function formatMcpHealthMutationResult(rawAction, res, fmt) {
    const failed =
        res.status === 'scan_gate_blocked' ||
        res.status === 'attestation_invalid' ||
        res.status === 'not_found' ||
        res.status === 'confirm_required';
    if (failed) {
        return { text: res.message || res.error || JSON.stringify(res), isError: true };
    }
    if (fmt === 'json') {
        return { text: JSON.stringify(res, null, 2), isError: false };
    }
    if (rawAction === 'resolve') {
        return {
            text: `✓ Resolved ${(res.resolved_ids || []).length} finding(s): ${(res.resolved_ids || []).join(', ')} (Strict: ${res.scores?.strict}%)\n`,
            isError: false,
        };
    }
    if (rawAction === 'reopen') {
        return {
            text: `✓ Reopened ${(res.reopened_ids || []).length} finding(s): ${(res.reopened_ids || []).join(', ')} (Strict: ${res.scores?.strict}%)\n`,
            isError: false,
        };
    }
    return {
        text: `✓ Marked ${(res.skipped_ids || []).length} finding(s) as ${res.status}: ${(res.skipped_ids || []).join(', ')} (Strict: ${res.scores?.strict}%)\n`,
        isError: false,
    };
}

async function singleHealth(root, rawArgs, dirOverride) {
    const args = {
        ...(rawArgs?.options && typeof rawArgs.options === 'object' ? rawArgs.options : {}),
        ...(rawArgs ?? {}),
    };
    const rawAction = typeof args.action === 'string' ? args.action.toLowerCase() : 'status';
    if (!ALLOWED_MCP_HEALTH_ACTIONS.has(rawAction)) {
        return {
            text: `invalid health action "${rawAction}" — allowed: ${[...ALLOWED_MCP_HEALTH_ACTIONS].join(', ')}`,
            isError: true,
        };
    }
    const w = loadGraphCached(contextDirFor(root, dirOverride));
    if (!w)
        return { text: NO_GRAPH, isError: true };
    const patterns = args.pattern
        ? [String(args.pattern)]
        : Array.isArray(args.patterns)
            ? args.patterns.map(String)
            : typeof args.patterns === 'string'
                ? [args.patterns]
                : (typeof args.target === 'string' && args.target.trim() ? [args.target.trim()] : undefined);

    let engineAction = rawAction;
    let subAction;
    let permanent = Boolean(args.permanent);
    const falsePositive = Boolean(args.false_positive);
    if (rawAction === 'skip') {
        engineAction = 'plan';
        subAction = 'skip';
    } else if (rawAction === 'wontfix') {
        engineAction = 'plan';
        subAction = 'skip';
        permanent = true;
    } else if (rawAction === 'reopen') {
        engineAction = 'plan';
        subAction = 'reopen';
    }

    const [{ health }, { formatHealthMarkdown, formatHealthText }] = await getHealthMods();
    const res = health(root, {
        contextDir: dirOverride,
        action: engineAction,
        subAction,
        patterns,
        count: typeof args.count === 'number' ? args.count : undefined,
        cluster: typeof args.cluster === 'string' ? args.cluster : undefined,
        group: typeof args.group === 'string' ? args.group : undefined,
        explain: args.explain === true,
        lanes: args.lanes === true,
        status: typeof args.status === 'string' ? args.status : undefined,
        chronic: args.chronic === true,
        code: args.code === true,
        note: typeof args.note === 'string' ? args.note : undefined,
        attest: typeof args.attest === 'string' ? args.attest : undefined,
        confirm: args.confirm === true,
        permanent,
        falsePositive,
        detector: typeof args.detector === 'string' ? args.detector : (rawAction === 'detect' && typeof args.target === 'string' ? args.target : undefined),
        diff: args.diff === true ? (typeof args.base === 'string' ? args.base : true) : undefined,
        base: typeof args.base === 'string' ? args.base : undefined,
        in: optIn(args),
        only: typeof args.only === 'string' ? args.only : undefined,
        skip: typeof args.skip === 'string' ? args.skip : undefined,
        max: typeof args.max === 'number' ? args.max : 10,
    });
    if (rawAction === 'resolve' || rawAction === 'skip' || rawAction === 'wontfix' || rawAction === 'reopen' || rawAction === 'scan') {
        invalidateMcpFreshnessCache(root);
    }
    if (rawAction === 'prompt') return { text: res.prompt, isError: false };
    if (rawAction === 'tree') return { text: res.tree_text, isError: false };
    const fmt = args.format === 'json' ? 'json' : args.format === 'markdown' ? 'markdown' : 'text';
    if (rawAction === 'detect') {
        return {
            text: fmt === 'json' ? JSON.stringify(res, null, 2) : formatDetectHealthText(res),
            isError: false,
        };
    }
    if (rawAction === 'resolve' || rawAction === 'skip' || rawAction === 'wontfix' || rawAction === 'reopen') {
        return formatMcpHealthMutationResult(rawAction, res, fmt);
    }
    if (rawAction === 'show' && fmt !== 'json') {
        return { text: formatShowHealthText(res), isError: false };
    }
    const text = fmt === 'json'
        ? JSON.stringify(res, null, 2)
        : fmt === 'markdown'
            ? formatHealthMarkdown(res)
            : formatHealthText(res);
    return { text, isError: false };
}

/** The single-graph path: every tool, answered from one repo's graph. */
async function callSingleTool(root, name, args, dirOverride, seenSpans = null) {
    switch (name) {
        case 'plexer_find_code':
            return singleFindCode(root, args, dirOverride, seenSpans);
        case 'plexer_read': {
            const specs = parseCommaOrArrayList(args.spans ?? args.file);
            if (specs.length === 0)
                return { text: 'plexer_read requires spans', isError: true };
            const { readSpans, formatReadSpans } = await getReadSpansMod();
            const r = readSpans(root, specs, { contextDir: dirOverride, full: args.full === true, callers: args.include_callers === true });
            applyReadSeenSpans(r, seenSpans, args.full === true);
            return {
                text: formatReadSpans(r),
                isError: r.blocks.length > 0 && r.blocks.every((b) => Boolean(b.error)),
            };
        }
        case 'plexer_file_api': {
            const files = parseCommaOrArrayList(args.file);
            if (files.length === 0)
                return { text: 'plexer_file_api requires a file', isError: true };
            const { skeleton, formatSkeleton } = await getSkeletonMod();
            const skelOpts = { contextDir: dirOverride, allMatches: Boolean(args.all_matches) };
            const results = files.map((f) => skeleton(root, f, skelOpts));
            const text = results.length === 1
                ? formatSkeleton(results[0])
                : `${results.map((r) => formatSkeleton(r).trimEnd()).join('\n\n')}\n`;
            const isError = results.every((r) => !r.entries?.length && Boolean(r.note || r.error));
            return { text: capMcpText(text), isError };
        }
        case 'plexer_check_freshness': {
            const { checkGraph, formatGraphCheckReport } = await getCheckMod();
            const g = await checkGraph(root, { contextDir: dirOverride });
            return { text: formatGraphCheckReport(g), isError: false };
        }
        case 'plexer_trace_calls':
            return singleTraceCalls(root, args, dirOverride, seenSpans);
        case 'plexer_find_all':
            return singleFindAll(root, args, dirOverride);
        case 'plexer_repo_map': {
            const w = loadGraphCached(contextDirFor(root, dirOverride));
            if (!w)
                return { text: NO_GRAPH, isError: true };
            const [{ buildRepoMap, formatRepoMap }, { analyzeGitHistory }] = await Promise.all([
                getMapMod(),
                args.churn === true ? getHistoryMod() : Promise.resolve({}),
            ]);
            const map = buildRepoMap(w, {
                maxDirs: parseMaxDirs(args),
                gitHistory: args.churn === true ? analyzeGitHistory(root, contextDirFor(root, dirOverride)) : undefined,
            });
            return { text: formatRepoMap(map), isError: false };
        }
        case 'plexer_blast':
            return runBlastOnRepo(root, dirOverride, args);
        case 'plexer_health':
            return singleHealth(root, args, dirOverride);
        default:
            return { text: `unknown tool: ${name}`, isError: true };
    }
}
