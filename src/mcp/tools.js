/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { ask, formatAsk, skeleton, formatSkeleton } from '../ask/ask.js';
import { checkGraph, formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../graph/load.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol, edgeWalk, parseWalkDepth } from '../graph/traverse.js';
import { headerOf, hitLine, looseNoteFor, quoteFor, renderMatchBlock } from '../graph/traverse-cli.js';
import { fileReader, wordRe } from '../blast/evidence.js';
import { grepGraph } from '../search/grep.js';
import { formatGrepResult, zeroHitNote } from '../search/grep-cli.js';
import { buildRepoMap, formatRepoMap } from '../graph/map.js';
import { federateAsk, federateCallers, federateCheck, federateGrep, federateMap, federateSkeleton, readWorkspace, } from '../graph/workspace.js';
const NO_GRAPH = 'no graph found — run `plexer build` first';
function unknownSymbolText(query) {
    return `no symbol "${query}" in the graph — check spelling or run \`plexer build\``;
}
export const TOOLS = [
    {
        name: 'plexer_find_code',
        description: 'Query the repo context graph in plain words. Returns ranked nodes with exact file:line spans and contiguous source (or windowed excerpts with … gap markers) inlined for top hits.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'what you want to locate or understand' },
                limit: { type: 'number', description: 'max results (default 5)' },
                full: {
                    type: 'boolean',
                    description: 'inline whole definition spans (up to 80 lines) across all returned hits',
                },
                in: {
                    type: 'string',
                    description: 'narrow to nodes under this repo-relative path prefix',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'plexer_file_api',
        description: "Signatures-only view of one file (~200 tokens): every definition's signature and line span.",
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: 'repo-relative path (or unique basename) of the file' },
            },
            required: ['file'],
        },
    },
    {
        name: 'plexer_check_freshness',
        description: 'Report whether the graph is in sync with the working tree.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'plexer_trace_calls',
        description: 'Precomputed call/reference/import/inheritance edges for a symbol or file. Defaults to direct callers (direction:"in"); set direction:"out" for callees, or depth:2 / depth:"all" for transitive blast radius before a rename or multi-file refactor.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'bare name, qualified (Mod.fn, Class:method, path:symbol), or file path (comma-separated for multiple)' },
                direction: {
                    type: 'string',
                    enum: ['in', 'out'],
                    description: '"in" (default) = callers/dependents; "out" = callees/dependencies',
                },
                depth: { description: 'transitive walk depth (default 1 = direct edges; 2 = blast radius; "all" = full connected closure)' },
                source: { type: 'boolean', description: 'inline target definition and call-site source excerpts' },
                in: { type: 'string', description: 'narrow matches to nodes under this repo-relative path prefix' },
            },
            required: ['symbol'],
        },
    },
    {
        name: 'plexer_find_all',
        description: 'Exhaustive regex or literal search over indexed files, grouped by enclosing symbol and ranked by incoming edge count.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'short symbol name, regex pattern, or literal string (with fixed: true)' },
                in: { type: 'string', description: 'narrow to files under this repo-relative path prefix' },
                ignore_case: { type: 'boolean', description: 'case-insensitive match' },
                fixed: { type: 'boolean', description: 'treat pattern as a literal string, not a regex' },
                context: { type: 'number', description: 'lines of surrounding context to show around each hit' },
                source: { type: 'boolean', description: 'show surrounding source context around each hit (default 3 lines)' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'plexer_repo_map',
        description: 'Token-budgeted repo orientation: directory clusters, per-directory hubs, and global hotspots.',
        inputSchema: {
            type: 'object',
            properties: {
                max_dirs: { type: 'number', description: 'max directory entries shown (default 16)' },
            },
        },
    },
];
function optIn(args) {
    return typeof args.in === 'string' && args.in ? args.in : undefined;
}
function resolveTraceDepth(raw) {
    const d = parseWalkDepth(raw, 1);
    if (Number.isNaN(d))
        return { error: `invalid depth "${raw}" — expected a positive integer or "all"` };
    return { depth: d };
}
function parseMaxDirs(args) {
    return typeof args.max_dirs === 'number' && Number.isFinite(args.max_dirs) && args.max_dirs > 0 ? args.max_dirs : undefined;
}
/** Render every resolved match's header + edge report (or the loud zero-edge
 * note), one block per match, joined with a blank line — the same grouping
 * `plexer callers` uses for multi-match symbols. `showDepth` tags each hit with
 * its BFS depth (for transitive `depth>1` walks). */
function renderMatches(root, direction, showDepth, matches, hitsFor, graph, withSource = false) {
    const read = fileReader(root);
    return matches
        .map((m) => renderMatchBlock(m, hitsFor(m), direction, showDepth, matches.length, read, { source: withSource }))
        .join('\n\n');
}
/** When the MCP server is rooted at a workspace parent, the ask/callers/grep/
 * map/check/file_api tools federate across the children — identical to the CLI. */
async function callWorkspaceTool(root, dirOverride, name, args) {
    switch (name) {
        case 'plexer_find_code': {
            const query = String(args.query ?? '');
            if (!query)
                return { text: 'plexer_find_code requires a query', isError: true };
            const limit = typeof args.limit === 'number' ? args.limit : 5;
            const r = federateAsk(root, dirOverride, query, { limit, source: true, full: args.full === true, in: optIn(args) });
            return { text: formatAsk(r), isError: false };
        }
        case 'plexer_file_api': {
            const file = String(args.file ?? '');
            if (!file)
                return { text: 'plexer_file_api requires a file', isError: true };
            const r = federateSkeleton(root, dirOverride, file);
            return { text: formatSkeleton(r), isError: !r.entries.length && !!r.note };
        }
        case 'plexer_trace_calls': {
            const symbol = String(args.symbol ?? args.file ?? '');
            if (!symbol)
                return { text: 'plexer_trace_calls requires a symbol', isError: true };
            const parsedDepth = resolveTraceDepth(args.depth);
            if (parsedDepth.error)
                return { text: parsedDepth.error, isError: true };
            const { text, found } = federateCallers(root, dirOverride, symbol, {
                direction: args.direction === 'out' ? 'out' : 'in',
                depth: parsedDepth.depth,
                source: args.source !== false,
                in: optIn(args),
            });
            return { text, isError: !found };
        }
        case 'plexer_find_all': {
            const pattern = String(args.pattern ?? '');
            if (!pattern)
                return { text: 'plexer_find_all requires a pattern', isError: true };
            const contextLines = typeof args.context === 'number' ? args.context : args.source === false ? 0 : 2;
            const { result, coverage } = federateGrep(root, dirOverride, pattern, {
                ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
                fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
                context: contextLines,
                source: contextLines > 0,
                in: optIn(args),
            });
            const text = result.totalHits === 0 ? zeroHitNote(result) : formatGrepResult(result);
            return { text: coverage ? `${text}\n${coverage}` : text, isError: false };
        }
        case 'plexer_repo_map': {
            return { text: federateMap(root, dirOverride, { maxDirs: parseMaxDirs(args) }), isError: false };
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
export async function callTool(root, name, args, dirOverride) {
    try {
        const ws = readWorkspace(root, dirOverride);
        let note = null;
        if (!NO_REFRESH_TOOLS.has(name)) {
            const r = ws
                ? await ensureFreshChildren(root, ws.children, { contextDir: dirOverride })
                : await ensureFreshGraph(root, { contextDir: dirOverride });
            note = refreshNote(r);
        }
        const fed = ws ? await callWorkspaceTool(root, dirOverride, name, args) : null;
        const res = fed ?? (await callSingleTool(root, name, args, dirOverride));
        return note ? { ...res, text: `${note}\n${res.text}` } : res;
    }
    catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true };
    }
}
/** The single-graph path: every tool, answered from one repo's graph. */
async function callSingleTool(root, name, args, dirOverride) {
    switch (name) {
        case 'plexer_find_code': {
            const query = String(args.query ?? '');
            if (!query)
                return { text: 'plexer_find_code requires a query', isError: true };
            const limit = typeof args.limit === 'number' ? args.limit : 5;
            const r = ask(root, query, { contextDir: dirOverride, limit, source: true, full: args.full === true, in: optIn(args) });
            return { text: formatAsk(r), isError: false };
        }
        case 'plexer_file_api': {
            const file = String(args.file ?? '');
            if (!file)
                return { text: 'plexer_file_api requires a file', isError: true };
            const r = skeleton(root, file, { contextDir: dirOverride });
            return { text: formatSkeleton(r), isError: !r.entries.length && !!r.note };
        }
        case 'plexer_check_freshness': {
            const g = await checkGraph(root, { contextDir: dirOverride });
            return { text: formatGraphCheckReport(g), isError: false };
        }
        case 'plexer_trace_calls': {
            const symbol = String(args.symbol ?? args.file ?? '');
            if (!symbol)
                return { text: 'plexer_trace_calls requires a symbol', isError: true };
            const parsedDepth = resolveTraceDepth(args.depth);
            if (parsedDepth.error)
                return { text: parsedDepth.error, isError: true };
            const w = loadGraphCached(contextDirFor(root, dirOverride));
            if (!w)
                return { text: NO_GRAPH, isError: true };
            const inPrefix = optIn(args);
            const queries = symbol.split(',').map((s) => s.trim()).filter(Boolean);
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
                return { text: unknownSymbolText(symbol), isError: true };
            const direction = args.direction === 'out' ? 'out' : 'in';
            const { depth } = parsedDepth;
            const text = renderMatches(root, direction, depth > 1, matches, (m) => edgeWalk(w, m, direction, depth), w, args.source !== false);
            return { text, isError: false };
        }
        case 'plexer_find_all': {
            const pattern = String(args.pattern ?? '');
            if (!pattern)
                return { text: 'plexer_find_all requires a pattern', isError: true };
            const w = loadGraphCached(contextDirFor(root, dirOverride));
            if (!w)
                return { text: NO_GRAPH, isError: true };
            const contextLines = typeof args.context === 'number' ? args.context : args.source === false ? 0 : 2;
            const result = grepGraph(w, root, pattern, {
                ignoreCase: typeof args.ignore_case === 'boolean' ? args.ignore_case : undefined,
                fixed: typeof args.fixed === 'boolean' ? args.fixed : undefined,
                context: contextLines,
                source: contextLines > 0,
                in: optIn(args),
            });
            if (result.totalHits === 0)
                return { text: zeroHitNote(result), isError: false };
            return { text: formatGrepResult(result), isError: false };
        }
        case 'plexer_repo_map': {
            const w = loadGraphCached(contextDirFor(root, dirOverride));
            if (!w)
                return { text: NO_GRAPH, isError: true };
            const map = buildRepoMap(w, { maxDirs: parseMaxDirs(args) });
            return { text: formatRepoMap(map), isError: false };
        }
        default:
            return { text: `unknown tool: ${name}`, isError: true };
    }
}

