/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { ask, formatAsk, skeleton, formatSkeleton, readSpans, formatReadSpans } from '../ask/ask.js';
import { checkGraph, formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../graph/load.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol, edgeWalk, parseWalkDepth } from '../graph/traverse.js';
import { headerOf, hitLine, looseNoteFor, quoteFor, renderMatchBlock } from '../graph/traverse-cli.js';
import { linkTestsForGraph } from '../graph/test-links.js';
import { fileReader, wordRe } from '../blast/evidence.js';
import { blastRadiusIn } from '../blast/blast.js';
import { changedFiles, refExists } from '../blast/diff.js';
import { analyzeGitHistory } from '../blast/history.js';
import { markdownReport, mermaidDiagram, textReport } from '../blast/render.js';
import { grepGraph } from '../search/grep.js';
import { formatGrepResult, zeroHitNote } from '../search/grep-cli.js';
import { buildRepoMap, formatRepoMap } from '../graph/map.js';
import { health } from '../health/health.js';
import { formatHealthMarkdown, formatHealthText } from '../health/render.js';
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from '../graph/root.js';
import {
    federateAsk,
    federateCallers,
    federateCheck,
    federateGrep,
    federateMap,
    federateRead,
    federateSkeleton,
    loadWorkspaceGraphs,
    readWorkspace,
} from '../graph/workspace.js';
import { readAgyLastRepo } from '../hosts/antigravity-hooks.js';
import { isCanonicalMcpTool } from './tool-names.js';

const NO_GRAPH = 'no graph found — run `plexer build` first';
const DIR_PROP = { type: 'string', description: 'optional repository root directory (defaults to current workspace)' };
export const READ_ONLY_ANNOTATIONS = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};

function unknownSymbolText(query) {
    return `no symbol "${query}" in the graph — check spelling or run \`plexer build\``;
}

export const TOOLS = [
    {
        name: 'plexer_find_code',
        description: 'Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and contiguous source (or windowed excerpts with … gap markers) inlined for top hits.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    description: 'one or more plain-word queries (string, ";"-separated sub-queries, or array of strings)',
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                },
                limit: { type: 'number', description: 'max results (default 5)' },
                full: {
                    type: 'boolean',
                    description: 'inline whole definition spans (up to 80 lines) across all returned hits',
                },
                in: {
                    type: 'string',
                    description: 'narrow to nodes under this repo-relative path prefix',
                },
                dir: DIR_PROP,
            },
            required: ['query'],
        },
    },
    {
        name: 'plexer_read',
        description: 'Read one or more exact file:Lx-Ly line spans or file:symbol definitions (or unique basenames) with L<n>: line numbers.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                spans: {
                    description: 'one or more file:Lx-Ly, file:Lx, file:symbol, or file spans (comma-separated string or array of strings)',
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                },
                dir: DIR_PROP,
            },
            required: ['spans'],
        },
    },
    {
        name: 'plexer_file_api',
        description: "Signatures-only view of one or more files (~200 tokens): every definition's signature and line span.",
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                file: {
                    description: 'one or more repo-relative paths (or unique basenames) of files (comma-separated string or array)',
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                },
                all_matches: {
                    type: 'boolean',
                    description: 'return skeletons for all matching files when a basename is ambiguous',
                },
                dir: DIR_PROP,
            },
            required: ['file'],
        },
    },
    {
        name: 'plexer_check_freshness',
        description: 'Report whether the graph is in sync with the working tree.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: { type: 'object', properties: { dir: DIR_PROP } },
    },
    {
        name: 'plexer_trace_calls',
        description: 'Precomputed call/reference/import/inheritance edges for one or more symbols or files. Defaults to direct callers (direction:"in"); set direction:"out" for callees, or depth:2 / depth:"all" for transitive blast radius before a rename or multi-file refactor.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                symbol: {
                    description: 'bare name, qualified (Mod.fn, Class:method, path:symbol), or file path (comma-separated string or array for multiple)',
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                },
                direction: {
                    type: 'string',
                    enum: ['in', 'out'],
                    description: '"in" (default) = callers/dependents; "out" = callees/dependencies',
                },
                depth: { description: 'transitive walk depth (default 1 = direct edges; 2 = blast radius; "all" = full connected closure)' },
                source: { type: 'boolean', description: 'inline target definition and call-site source excerpts (default true)' },
                full: { type: 'boolean', description: 'inline extended source excerpts across callers' },
                in: { type: 'string', description: 'narrow matches to nodes under this repo-relative path prefix' },
                dir: DIR_PROP,
            },
            required: ['symbol'],
        },
    },
    {
        name: 'plexer_find_all',
        description: 'Exhaustive regex or literal search over indexed files, grouped by enclosing symbol and ranked by incoming edge count.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                pattern: {
                    description: 'one or more short symbol names, regex patterns, or literal strings (with fixed: true)',
                    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                },
                in: { type: 'string', description: 'narrow to files under this repo-relative path prefix' },
                ignore_case: { type: 'boolean', description: 'case-insensitive match' },
                fixed: { type: 'boolean', description: 'treat pattern as a literal string, not a regex' },
                context: { type: 'number', description: 'lines of surrounding context to show around each hit' },
                source: { type: 'boolean', description: 'show surrounding source context around each hit (default true)' },
                full: { type: 'boolean', description: 'show extended surrounding source context (4 lines) around each hit' },
                dir: DIR_PROP,
            },
            required: ['pattern'],
        },
    },
    {
        name: 'plexer_repo_map',
        description: 'Token-budgeted repo orientation: directory clusters, per-directory hubs, and global hotspots.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                max_dirs: { type: 'number', description: 'max directory entries shown (default 16)' },
                churn: { type: 'boolean', description: 'Include git churn hotspots when true.' },
                dir: DIR_PROP,
            },
        },
    },
    {
        name: 'plexer_blast',
        description: 'Git diff blast radius: what symbols, modules, and tests depend on the lines changed in the working tree or since a base ref.',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                base: { type: 'string', description: 'diff against this git ref merge-base with HEAD (default: working tree vs HEAD)' },
                depth: { description: 'transitive hops over incoming edges, or "all" (default 2)' },
                format: {
                    type: 'string',
                    enum: ['text', 'markdown', 'mermaid'],
                    description: 'output format: "text" (default), "markdown" (PR-ready), or "mermaid" (diagram)',
                },
                dir: DIR_PROP,
            },
        },
    },
    {
        name: 'plexer_health',
        description: 'Codebase health engine and execution queue: run mechanical & Luau/Roblox detectors (`scan`), inspect the next prioritized fix item (`next`), check strict/overall/objective/verified scores (`status`), or run diff-scoped health checks (`diff: true`).',
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['scan', 'next', 'backlog', 'status', 'show', 'tree', 'detect', 'prompt'],
                    description: 'health command action (default "scan")',
                },
                detector: {
                    type: 'string',
                    description: 'specific detector name for action="detect" (e.g. "signature_variance", "roblox_security")',
                },
                diff: {
                    type: 'boolean',
                    description: 'when true, restrict findings to files touched in the working tree or since `base`',
                },
                base: {
                    type: 'string',
                    description: 'optional git ref for diff comparison',
                },
                in: {
                    type: 'string',
                    description: 'optional directory prefix filter (e.g. "src/graph")',
                },
                only: {
                    type: 'string',
                    description: 'comma-separated categories to run (duplicates,dead,coupling,cohesion,tests,catches,types,traps,slop,security)',
                },
                skip: {
                    type: 'string',
                    description: 'comma-separated categories to skip',
                },
                max: {
                    type: 'number',
                    description: 'maximum findings to return (default 10)',
                },
                format: {
                    type: 'string',
                    enum: ['text', 'markdown', 'json'],
                    description: 'output format (default "text")',
                },
                dir: DIR_PROP,
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
function renderMatches(root, direction, showDepth, matches, hitsFor, graph, withSource = false, full = false) {
    const read = fileReader(root);
    const testLinks = graph ? linkTestsForGraph(graph) : null;
    const seenSourceIds = new Set();
    const maxCap = full ? 8800 : 5800;
    const singleCap = full ? 8000 : 5400;
    const maxBytesPerSymbol = matches.length > 1 ? Math.max(1200, Math.floor(maxCap / matches.length)) : singleCap;
    let totalBytes = 0;
    return matches
        .map((m) => {
            const remaining = matches.length > 1 ? Math.max(0, maxCap - totalBytes) : maxBytesPerSymbol;
            const sourceBudget = { bytes: 0, maxBytes: Math.min(maxBytesPerSymbol, remaining) };
            const block = renderMatchBlock(m, hitsFor(m), direction, showDepth, matches.length, read, {
                source: withSource && remaining > 0,
                seenSourceIds,
                sourceBudget,
                graph,
                testLinks,
            });
            totalBytes += sourceBudget.bytes;
            return block;
        })
        .join('\n\n');
}

function runBlastOnRepo(root, dirOverride, args) {
    const contextDir = contextDirFor(root, dirOverride);
    const w = loadGraphCached(contextDir);
    if (!w)
        return { text: NO_GRAPH, isError: true };
    const parsedDepth = resolveTraceDepth(args.depth, 2);
    if (parsedDepth.error)
        return { text: parsedDepth.error, isError: true };
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
    const report = blastRadiusIn(w, contextDir, diff.files, diff.basis, parsedDepth.depth);
    const fmt = args.format === 'markdown' || args.format === 'mermaid' ? args.format : 'text';
    if (fmt === 'mermaid') {
        return { text: mermaidDiagram(report) ?? '%% no dependents to draw', isError: false };
    }
    const text = fmt === 'markdown' ? markdownReport(report, { root }) : textReport(report);
    return { text, isError: false };
}

function workspaceFindAll(root, dirOverride, args) {
    const patterns = parsePatternList(args.pattern);
    if (patterns.length === 0)
        return { text: 'plexer_find_all requires a pattern', isError: true };
    const contextLines = typeof args.context === 'number'
        ? args.context
        : args.source === false
            ? 0
            : args.full === true
                ? 4
                : 2;
    const chunks = patterns.map((pat) => {
        const { result, coverage } = federateGrep(root, dirOverride, pat, {
            ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
            fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
            context: contextLines,
            source: contextLines > 0,
            in: optIn(args),
        });
        const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
        return coverage ? `${text}\n${coverage}` : text;
    });
    return { text: chunks.join('\n\n'), isError: false };
}

function workspaceBlast(root, dirOverride, args) {
    const wg = loadWorkspaceGraphs(root, dirOverride);
    if (wg.loaded.length === 0)
        return { text: NO_GRAPH, isError: true };
    const chunks = [];
    for (const { child } of wg.loaded) {
        const res = runBlastOnRepo(join(root, child), undefined, args);
        if (!res.isError) {
            chunks.push(`## ${child}/\n${res.text.trimEnd()}`);
        }
    }
    if (chunks.length === 0)
        return { text: 'could not read a diff in any workspace repository', isError: true };
    return { text: `${chunks.join('\n\n')}\n`, isError: false };
}

/** When the MCP server is rooted at a workspace parent, the ask/read/callers/grep/
 * map/check/file_api/blast tools federate across the children — identical to the CLI. */
async function callWorkspaceTool(root, dirOverride, name, args) {
    switch (name) {
        case 'plexer_find_code': {
            const queries = parseQueriesList(args.query ?? args.queries);
            if (queries.length === 0)
                return { text: 'plexer_find_code requires a query', isError: true };
            const limit = typeof args.limit === 'number' ? args.limit : queries.length > 1 ? 3 : 5;
            const blocks = queries.map((q) => {
                const r = federateAsk(root, dirOverride, q, { limit, source: true, full: args.full === true, in: optIn(args) });
                return formatAsk(r).trimEnd();
            });
            return { text: `${blocks.join('\n\n')}\n`, isError: false };
        }
        case 'plexer_read': {
            const specs = parseCommaOrArrayList(args.spans ?? args.file);
            if (specs.length === 0)
                return { text: 'plexer_read requires spans', isError: true };
            const r = federateRead(root, dirOverride, specs);
            return {
                text: formatReadSpans(r),
                isError: r.blocks.length > 0 && r.blocks.every((b) => Boolean(b.error)),
            };
        }
        case 'plexer_file_api': {
            const files = parseCommaOrArrayList(args.file);
            if (files.length === 0)
                return { text: 'plexer_file_api requires a file', isError: true };
            const skelOpts = { allMatches: Boolean(args.all_matches) };
            const results = files.map((f) => federateSkeleton(root, dirOverride, f, skelOpts));
            const text = results.length === 1
                ? formatSkeleton(results[0])
                : `${results.map((r) => formatSkeleton(r).trimEnd()).join('\n\n')}\n`;
            const isError = results.every((r) => !r.entries?.length && Boolean(r.note || r.error));
            return { text, isError };
        }
        case 'plexer_trace_calls': {
            const symbols = parseCommaOrArrayList(args.symbol ?? args.file);
            if (symbols.length === 0)
                return { text: 'plexer_trace_calls requires a symbol', isError: true };
            const parsedDepth = resolveTraceDepth(args.depth, 1);
            if (parsedDepth.error)
                return { text: parsedDepth.error, isError: true };
            const { text, found } = federateCallers(root, dirOverride, symbols.length === 1 ? symbols[0] : symbols, {
                direction: args.direction === 'out' ? 'out' : 'in',
                depth: parsedDepth.depth,
                source: args.full === true ? true : args.source !== false,
                full: args.full === true,
                in: optIn(args),
            });
            return { text, isError: !found };
        }
        case 'plexer_find_all':
            return workspaceFindAll(root, dirOverride, args);
        case 'plexer_repo_map':
            return { text: federateMap(root, dirOverride, { maxDirs: parseMaxDirs(args) }), isError: false };
        case 'plexer_blast':
            return workspaceBlast(root, dirOverride, args);
        case 'plexer_health': {
            const ws = readWorkspace(root, dirOverride);
            const children = ws?.children?.length
                ? ws.children
                : loadWorkspaceGraphs(root, dirOverride).loaded.map((l) => l.child);
            if (children.length === 0)
                return { text: NO_GRAPH, isError: true };
            const chunks = [];
            for (const child of children) {
                const childPath = typeof child === 'string' ? child : child.path;
                const childName = typeof child === 'string' ? child : (child.name ?? child.path);
                const res = singleHealth(join(root, childPath), args, dirOverride);
                if (res.isError && res.text !== NO_GRAPH)
                    return res;
                if (!res.isError) {
                    chunks.push(`=== ${childName} ===\n${res.text.trimEnd()}`);
                }
            }
            if (chunks.length === 0)
                return { text: NO_GRAPH, isError: true };
            return { text: `${chunks.join('\n\n')}\n`, isError: false };
        }
        case 'plexer_check_freshness': {
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

function resolveMcpRoot(root, args, dirOverride) {
    if (typeof args?.dir === 'string' && args.dir.trim()) {
        return nearestPlexerRoot(args.dir.trim(), dirOverride).root;
    }
    if (dirOverride === undefined) {
        const absDir = extractCandidateAbsPath(args);
        if (absDir) {
            const fromAbs = nearestPlexerRoot(absDir, dirOverride).root;
            if (hasPlexerIndex(fromAbs) || isAutoBuildableRepo(fromAbs)) {
                return fromAbs;
            }
        }
    }
    const candidate = nearestPlexerRoot(root, dirOverride).root;
    if (dirOverride !== undefined || hasPlexerIndex(candidate) || isAutoBuildableRepo(candidate)) {
        return candidate;
    }
    const lastAgy = readAgyLastRepo();
    if (lastAgy) {
        return nearestPlexerRoot(lastAgy, dirOverride).root;
    }
    return candidate;
}

export async function callTool(root, name, args, dirOverride) {
    if (!isCanonicalMcpTool(name)) {
        return { text: `unknown tool: ${name}`, isError: true };
    }
    try {
        const targetRoot = resolveMcpRoot(root, args, dirOverride);
        const ws = readWorkspace(targetRoot, dirOverride);
        let note = null;
        if (!NO_REFRESH_TOOLS.has(name)) {
            const r = ws
                ? await ensureFreshChildren(targetRoot, ws.children, { contextDir: dirOverride })
                : await ensureFreshGraph(targetRoot, { contextDir: dirOverride });
            note = refreshNote(r);
        }
        const fed = ws ? await callWorkspaceTool(targetRoot, dirOverride, name, args) : null;
        const res = fed ?? (await callSingleTool(targetRoot, name, args, dirOverride));
        return note ? { ...res, text: `${note}\n${res.text}` } : res;
    }
    catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
}

function singleFindCode(root, args, dirOverride) {
    const queries = parseQueriesList(args.query ?? args.queries);
    if (queries.length === 0)
        return { text: 'plexer_find_code requires a query', isError: true };
    const limit = typeof args.limit === 'number' ? args.limit : queries.length > 1 ? 3 : 5;
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
        return formatAsk(r).trimEnd();
    });
    return { text: `${blocks.join('\n\n')}\n`, isError: false };
}

function singleTraceCalls(root, args, dirOverride) {
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
    if (matches.length === 0)
        return { text: unknownSymbolText(queries.join(', ')), isError: true };
    const direction = args.direction === 'out' ? 'out' : 'in';
    const { depth } = parsedDepth;
    const useSource = args.full === true ? true : args.source !== false;
    const text = renderMatches(root, direction, depth > 1, matches, (m) => edgeWalk(w, m, direction, depth), w, useSource, args.full === true);
    return { text, isError: false };
}

function singleFindAll(root, args, dirOverride) {
    const patterns = parsePatternList(args.pattern);
    if (patterns.length === 0)
        return { text: 'plexer_find_all requires a pattern', isError: true };
    const w = loadGraphCached(contextDirFor(root, dirOverride));
    if (!w)
        return { text: NO_GRAPH, isError: true };
    const contextLines = typeof args.context === 'number'
        ? args.context
        : args.source === false
            ? 0
            : args.full === true
                ? 4
                : 2;
    const chunks = patterns.map((pat) => {
        const result = grepGraph(w, root, pat, {
            ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
            fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
            context: contextLines,
            source: contextLines > 0,
            in: optIn(args),
        });
        return result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
    });
    return { text: chunks.join('\n\n'), isError: false };
}

const ALLOWED_MCP_HEALTH_ACTIONS = new Set(['scan', 'next', 'backlog', 'status', 'show', 'tree', 'detect', 'prompt']);

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
    }
    return `${lines.join('\n')}\n`;
}

function singleHealth(root, args, dirOverride) {
    const action = typeof args.action === 'string' ? args.action.toLowerCase() : 'scan';
    if (!ALLOWED_MCP_HEALTH_ACTIONS.has(action)) {
        return {
            text: `invalid health action "${action}" — allowed: ${[...ALLOWED_MCP_HEALTH_ACTIONS].join(', ')}`,
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
            : undefined;
    const res = health(root, {
        contextDir: dirOverride,
        action,
        patterns,
        detector: typeof args.detector === 'string' ? args.detector : undefined,
        diff: args.diff === true ? (typeof args.base === 'string' ? args.base : true) : undefined,
        base: typeof args.base === 'string' ? args.base : undefined,
        in: optIn(args),
        only: typeof args.only === 'string' ? args.only : undefined,
        skip: typeof args.skip === 'string' ? args.skip : undefined,
        max: typeof args.max === 'number' ? args.max : 10,
    });
    if (action === 'prompt') {
        return { text: res.prompt, isError: false };
    }
    if (action === 'tree') {
        return { text: res.tree_text, isError: false };
    }
    if (action === 'detect') {
        return { text: JSON.stringify(res, null, 2), isError: false };
    }
    const fmt = args.format === 'json' ? 'json' : args.format === 'markdown' ? 'markdown' : 'text';
    if (action === 'show' && fmt !== 'json') {
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
async function callSingleTool(root, name, args, dirOverride) {
    switch (name) {
        case 'plexer_find_code':
            return singleFindCode(root, args, dirOverride);
        case 'plexer_read': {
            const specs = parseCommaOrArrayList(args.spans ?? args.file);
            if (specs.length === 0)
                return { text: 'plexer_read requires spans', isError: true };
            const r = readSpans(root, specs, { contextDir: dirOverride });
            return {
                text: formatReadSpans(r),
                isError: r.blocks.length > 0 && r.blocks.every((b) => Boolean(b.error)),
            };
        }
        case 'plexer_file_api': {
            const files = parseCommaOrArrayList(args.file);
            if (files.length === 0)
                return { text: 'plexer_file_api requires a file', isError: true };
            const skelOpts = { contextDir: dirOverride, allMatches: Boolean(args.all_matches) };
            const results = files.map((f) => skeleton(root, f, skelOpts));
            const text = results.length === 1
                ? formatSkeleton(results[0])
                : `${results.map((r) => formatSkeleton(r).trimEnd()).join('\n\n')}\n`;
            const isError = results.every((r) => !r.entries?.length && Boolean(r.note || r.error));
            return { text, isError };
        }
        case 'plexer_check_freshness': {
            const g = await checkGraph(root, { contextDir: dirOverride });
            return { text: formatGraphCheckReport(g), isError: false };
        }
        case 'plexer_trace_calls':
            return singleTraceCalls(root, args, dirOverride);
        case 'plexer_find_all':
            return singleFindAll(root, args, dirOverride);
        case 'plexer_repo_map': {
            const w = loadGraphCached(contextDirFor(root, dirOverride));
            if (!w)
                return { text: NO_GRAPH, isError: true };
            const map = buildRepoMap(w, {
                maxDirs: parseMaxDirs(args),
                gitHistory: args.churn === true ? analyzeGitHistory(root) : undefined,
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
