/**
 * The MCP tools, as pure functions over the existing engine.
 * `callTool` never throws — hosts get soft errors as isError content.
 */
import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ask, formatAsk, skeleton, formatSkeleton, readSpans, formatReadSpans, suggestClosestFiles, suggestNearTargets } from '../ask/ask.js';
import { checkGraph, formatGraphCheckReport } from '../graph/check.js';
import { loadGraphCached } from '../context/graph-store.js';
import { ensureFreshChildren, ensureFreshGraph, refreshNote } from '../graph/refresh.js';
import { contextDirFor } from '../context/node-file.js';
import { resolveSymbol } from '../context/symbol-query.js';
import { edgeWalk, parseWalkDepth } from '../graph/traverse.js';
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

function unknownSymbolText(query, suggestions = []) {
    if (suggestions.length > 0)
        return `no symbol "${query}" in the graph — did you mean: ${suggestions.join(', ')}?`;
    return `no symbol "${query}" in the graph — check spelling or run \`plexer build\``;
}

function collectWorkspacePaths(root, dirOverride) {
    const paths = [];
    for (const { child, graph } of loadWorkspaceGraphs(root, dirOverride).loaded) {
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

function suggestWorkspaceSymbols(root, dirOverride, symbols) {
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
        description: 'Codebase health engine and execution queue: check strict/overall/objective/verified scores (`status`), run mechanical & Luau/Roblox detectors (`scan`), inspect the next prioritized fix items or parallel subagent work lanes (`next`), resolve or skip findings (`resolve`, `skip`, `wontfix`, `reopen`), or run diff-scoped health checks (`diff: true`).',
        // Source-mutating actions (`autofix`, `move`) are intentionally excluded from MCP so `plexer_health`
        // never modifies repository source files (only `plexer/.health/` local cache metadata) and preserves
        // zero-prompt MCP auto-approval across Claude Code, Codex, and Cursor.
        annotations: READ_ONLY_ANNOTATIONS,
        inputSchema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['status', 'scan', 'next', 'backlog', 'show', 'tree', 'detect', 'prompt', 'resolve', 'skip', 'wontfix', 'reopen'],
                    description: 'health command action (default "status")',
                },
                detector: {
                    type: 'string',
                    description: 'specific detector name for action="detect" or "scan" (e.g. "signature_variance", "package_census", "roblox_security")',
                },
                patterns: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'issue ID, file, or detector patterns for show/resolve/skip/wontfix/reopen',
                },
                count: {
                    type: 'number',
                    description: 'number of queue items for action="next" or "backlog" (default 1 for next, 20 for backlog)',
                },
                cluster: {
                    type: 'string',
                    description: 'filter action="next" to a specific cluster',
                },
                group: {
                    type: 'string',
                    enum: ['item', 'file', 'detector'],
                    description: 'group action="next" items by item (default), file, or detector',
                },
                explain: {
                    type: 'boolean',
                    description: 'include ranking and score-impact rationale in action="next"',
                },
                lanes: {
                    type: 'boolean',
                    description: 'compute graph-disjoint parallel subagent workstream lanes in action="next"',
                },
                status: {
                    type: 'string',
                    enum: ['open', 'fixed', 'wontfix', 'deferred', 'false_positive'],
                    description: 'filter action="show" by issue status',
                },
                chronic: {
                    type: 'boolean',
                    description: 'filter action="show" to recurring or reopened issues across multiple scans',
                },
                code: {
                    type: 'boolean',
                    description: 'inline source code excerpts in action="show"',
                },
                note: {
                    type: 'string',
                    description: 'resolution or skip note',
                },
                attest: {
                    type: 'string',
                    description: 'explicit attestation for resolve, permanent skip (wontfix), or false_positive',
                },
                confirm: {
                    type: 'boolean',
                    description: 'confirm issue resolution or skip',
                },
                permanent: {
                    type: 'boolean',
                    description: 'mark skipped issue as permanent wontfix (requires attest)',
                },
                false_positive: {
                    type: 'boolean',
                    description: 'mark skipped issue as permanent false_positive (requires attest)',
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
    const report = blastRadiusIn(w, contextDir, diff.files, diff.basis, parsedDepth.depth, { rootDir: root });
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
    const contextLines = typeof args.context === 'number' && Number.isFinite(args.context)
        ? Math.max(0, Math.min(50, Math.trunc(args.context)))
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

function workspaceHealth(root, dirOverride, args) {
    const ws = readWorkspace(root, dirOverride);
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
        const res = singleHealth(join(root, childPath), args, undefined);
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

function workspaceRead(root, dirOverride, args) {
    const specs = parseCommaOrArrayList(args.spans ?? args.file);
    if (specs.length === 0)
        return { text: 'plexer_read requires spans', isError: true };
    const r = federateRead(root, dirOverride, specs);
    if (r.blocks.some((b) => b.error && !b.error.includes('did you mean:'))) {
        const wsPaths = collectWorkspacePaths(root, dirOverride);
        for (const b of r.blocks) {
            if (b.error && !b.error.includes('did you mean:') && !b.error.includes('sensitive')) {
                const rawPath = String(b.spec ?? '').split(':')[0];
                const hints = suggestClosestFiles(rawPath, wsPaths, 3);
                if (hints.length)
                    b.error = `${b.error} — did you mean: ${hints.join(', ')}?`;
            }
        }
    }
    return {
        text: formatReadSpans(r),
        isError: r.blocks.length > 0 && r.blocks.every((b) => Boolean(b.error)),
    };
}

function workspaceFileApi(root, dirOverride, args) {
    const files = parseCommaOrArrayList(args.file);
    if (files.length === 0)
        return { text: 'plexer_file_api requires a file', isError: true };
    const skelOpts = { allMatches: Boolean(args.all_matches) };
    const results = files.map((f) => federateSkeleton(root, dirOverride, f, skelOpts));
    if (results.some((r) => !r.entries?.length && r.note && !r.note.includes('ambiguous') && !r.note.includes('did you mean:'))) {
        const wsPaths = collectWorkspacePaths(root, dirOverride);
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
    return { text, isError };
}

function workspaceTraceCalls(root, dirOverride, args) {
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
    if (!found && !text.includes('did you mean:')) {
        const hints = suggestWorkspaceSymbols(root, dirOverride, symbols);
        if (hints.length)
            return { text: `${text.trimEnd()} — did you mean: ${hints.join(', ')}?\n`, isError: true };
    }
    return { text, isError: !found };
}

/** When the MCP server is rooted at a workspace parent, the ask/read/callers/grep/
 * map/check/file_api/blast tools federate across the children — identical to the CLI. */
async function callWorkspaceTool(root, dirOverride, name, args) {
    switch (name) {
        case 'plexer_find_code': {
            const queries = parseQueriesList(args.query ?? args.queries);
            if (queries.length === 0)
                return { text: 'plexer_find_code requires a query', isError: true };
            const parsedLimit = parsePositiveLimit(args.limit, queries.length > 1 ? 3 : 5);
            if (parsedLimit.error)
                return { text: parsedLimit.error, isError: true };
            const { limit } = parsedLimit;
            const blocks = queries.map((q) => {
                const r = federateAsk(root, dirOverride, q, { limit, source: true, full: args.full === true, in: optIn(args) });
                return formatAsk(r).trimEnd();
            });
            return { text: `${blocks.join('\n\n')}\n`, isError: false };
        }
        case 'plexer_read':
            return workspaceRead(root, dirOverride, args);
        case 'plexer_file_api':
            return workspaceFileApi(root, dirOverride, args);
        case 'plexer_trace_calls':
            return workspaceTraceCalls(root, dirOverride, args);
        case 'plexer_find_all':
            return workspaceFindAll(root, dirOverride, args);
        case 'plexer_repo_map':
            return {
                text: federateMap(root, dirOverride, {
                    maxDirs: parseMaxDirs(args),
                    churn: args.churn === true,
                    analyzeGitHistory,
                }),
                isError: false,
            };
        case 'plexer_blast':
            return workspaceBlast(root, dirOverride, args);
        case 'plexer_health':
            return workspaceHealth(root, dirOverride, args);
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

function canonicalPath(p) {
    const abs = resolve(p);
    try {
        return realpathSync(abs);
    }
    catch {
        return abs;
    }
}

function isInsideRoot(base, target) {
    if (!base || !target)
        return false;
    const rel = relative(canonicalPath(base), canonicalPath(target));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export async function callTool(root, name, args, dirOverride) {
    if (!isCanonicalMcpTool(name)) {
        return { text: `unknown tool: ${name}`, isError: true };
    }
    try {
        const targetRoot = resolveMcpRoot(root, args, dirOverride);
        const startupRoot = resolve(root);
        const agyRoot = readAgyLastRepo();
        const isTrustedRoot = isInsideRoot(startupRoot, targetRoot) || isInsideRoot(agyRoot, targetRoot);
        if (!isTrustedRoot) {
            return { text: NO_GRAPH, isError: true };
        }
        const ws = readWorkspace(targetRoot, dirOverride);
        let note = null;
        if (!NO_REFRESH_TOOLS.has(name)) {
            const r = ws
                ? await ensureFreshChildren(targetRoot, ws.children, { contextDir: dirOverride, autoBuild: isTrustedRoot })
                : await ensureFreshGraph(targetRoot, { contextDir: dirOverride, autoBuild: isTrustedRoot });
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
    const parsedLimit = parsePositiveLimit(args.limit, queries.length > 1 ? 3 : 5);
    if (parsedLimit.error)
        return { text: parsedLimit.error, isError: true };
    const { limit } = parsedLimit;
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
    if (matches.length === 0) {
        const suggestions = [...new Set(queries.flatMap((q) => suggestNearTargets(w, q, inPrefix, 3)))].slice(0, 3);
        return { text: unknownSymbolText(queries.join(', '), suggestions), isError: true };
    }
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
    const contextLines = typeof args.context === 'number' && Number.isFinite(args.context)
        ? Math.max(0, Math.min(50, Math.trunc(args.context)))
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

function singleHealth(root, args, dirOverride) {
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
                : undefined;

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
        detector: typeof args.detector === 'string' ? args.detector : undefined,
        diff: args.diff === true ? (typeof args.base === 'string' ? args.base : true) : undefined,
        base: typeof args.base === 'string' ? args.base : undefined,
        in: optIn(args),
        only: typeof args.only === 'string' ? args.only : undefined,
        skip: typeof args.skip === 'string' ? args.skip : undefined,
        max: typeof args.max === 'number' ? args.max : 10,
    });
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
