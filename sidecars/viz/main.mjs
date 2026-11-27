import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeStats, readStats, readWiring } from '../../src/util/state.js';
import { hasPlexerIndex, nearestPlexerRoot } from '../../src/graph/root.js';
import { isWithinRoot, tryRealpath } from '../../src/util/fs.js';
import { contextDirFor, fileUriToPath } from '../../src/util/paths.js';
import {
    buildVizHealthPayload,
    getCachedCodeGraphPayload,
    getCachedTreemapPayload,
    readJailedSourceExcerpt,
    renderHealthTreemapHtml,
} from '../../src/viz/serve.js';
import { loadGraphCached } from '../../src/context/graph-store.js';
import { readAgySession, readAgyLastRepo } from '../../src/agy/session.js';
import { resolveAgyWorkspaceDirs } from '../../src/agy/multi-workspace.js';
import { buildAgyContextGraph, computeSidecarRev } from '../../src/agy/context-graph.js';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VIEWER_DIR = resolve(PACKAGE_ROOT, 'src', 'viewer');

export function parseEnvWorkspacePaths(env = {}) {
    const out = [];
    const seen = new Set();
    const pushUnique = (rawPath) => {
        const trimmed = String(rawPath ?? '').trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        out.push(trimmed);
    };
    const rawMulti = env?.ANTIGRAVITY_WORKSPACE_PATHS;
    if (typeof rawMulti === 'string' && rawMulti.trim()) {
        const trimmed = rawMulti.trim();
        let parsedJson = false;
        if (trimmed.startsWith('[')) {
            try {
                const arr = JSON.parse(trimmed);
                if (Array.isArray(arr)) {
                    for (const item of arr) {
                        if (typeof item === 'string') pushUnique(item);
                    }
                    parsedJson = true;
                }
            } catch { /* fall back to delimiter split */ }
        }
        if (!parsedJson) {
            const splitRe = delimiter === ':' ? /[,\n]|(?<!\bfile):(?!\/\/)/ : /[,\n;]/;
            for (const part of trimmed.split(splitRe)) {
                pushUnique(part);
            }
        }
    }
    if (env?.ANTIGRAVITY_PROJECT_DIR)
        pushUnique(env.ANTIGRAVITY_PROJECT_DIR);
    return out;
}

function collectActiveWorkspaceRoots({ sessionId, env = {} } = {}) {
    const candidates = [...parseEnvWorkspacePaths(env)];
    const sess = sessionId ? readAgySession(sessionId) : null;
    if (Array.isArray(sess?.orientedDirs))
        candidates.push(...sess.orientedDirs);
    if (sess?.lastTouchedPath)
        candidates.push(sess.lastTouchedPath);
    const cleaned = candidates.map((c) => fileUriToPath(c)).filter(Boolean);
    if (cleaned.length === 0)
        return [];
    return resolveAgyWorkspaceDirs({ workspacePaths: cleaned });
}

export function resolveSidecarRepo(wsUri, sessionId = null, fallbackWsUri = null) {
    if (wsUri) {
        const p = fileUriToPath(wsUri);
        if (p) {
            const { root } = nearestPlexerRoot(resolve(p));
            return root;
        }
    }
    const sess = sessionId ? readAgySession(sessionId) : null;
    if (sess?.lastTouchedPath) {
        const touched = resolve(sess.lastTouchedPath);
        const startDir = existsSync(touched)
            ? (statSync(touched).isDirectory() ? touched : dirname(touched))
            : dirname(touched);
        const { root } = nearestPlexerRoot(startDir);
        if (hasPlexerIndex(root))
            return root;
    }
    const candidate = readAgyLastRepo() || fileUriToPath(fallbackWsUri) || process.cwd();
    const { root } = nearestPlexerRoot(resolve(candidate));
    return root;
}

export function buildSidecarSummary(repoDir, sessionId) {
    const root = resolve(repoDir || process.cwd());
    const indexed = hasPlexerIndex(root);
    const ctxDir = contextDirFor(root);
    const stats = indexed ? (readStats(root) ?? computeStats(readWiring(root) ?? {})) : null;
    const health = indexed ? buildVizHealthPayload(ctxDir) : null;
    const session = sessionId ? readAgySession(sessionId) : null;

    let hotspots = [];
    if (indexed) {
        try {
            const g = loadGraphCached(ctxDir);
            const inDeg = new Map();
            for (const e of g?.edges ?? [])
                inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
            hotspots = (g?.nodes ?? [])
                .filter((n) => n.kind !== 'file' && n.name)
                .map((n) => ({ name: n.name, kind: n.kind, path: n.path, span: n.span, fanIn: inDeg.get(n.id) || 0 }))
                .sort((a, b) => b.fanIn - a.fanIn)
                .slice(0, 12);
        } catch {
            hotspots = [];
        }
    }

    return {
        repo: root,
        repoName: basename(root),
        indexed,
        stats,
        health: health ? { openCount: health.open_count, scores: health.scores } : null,
        session: session
            ? {
                seenFiles: Object.keys(session.seenSpans ?? {}),
                emittedBlastFiles: session.emittedBlastFiles ?? [],
                lastReadRelFile: session.lastReadRelFile ?? null,
            }
            : null,
        hotspots,
    };
}

function makeResponse(ResponseClass, body, opts) {
    if (ResponseClass)
        return new ResponseClass(body, opts);
    return { body, ...opts };
}

function injectPreloadScript(html) {
    if (html.includes('/preload.js'))
        return html;
    if (html.includes('</head>'))
        return html.replace('</head>', '  <script src="/preload.js"></script>\n</head>');
    return `<script src="/preload.js"></script>\n${html}`;
}

function resolveScopedRepoRoot(realReq, matchingRoot) {
    let start = realReq;
    try {
        if (existsSync(realReq) && !statSync(realReq).isDirectory()) {
            start = dirname(realReq);
        }
    } catch { /* ignore */ }
    let cur = start;
    while (isWithinRoot(cur, matchingRoot)) {
        if (hasPlexerIndex(cur)) return cur;
        if (cur === matchingRoot) break;
        const up = dirname(cur);
        if (up === cur) break;
        cur = up;
    }
    const nearest = tryRealpath(nearestPlexerRoot(start).root);
    if (isWithinRoot(nearest, matchingRoot)) return nearest;
    return matchingRoot;
}

function authorizeSidecarRepo(data, { allowedRoots, strictWs, hostEnv, envSid, sid }) {
    const hasExplicitScope = strictWs || Array.isArray(allowedRoots);
    const rawRoots = Array.isArray(allowedRoots)
        ? allowedRoots.map(fileUriToPath).filter(Boolean)
        : collectActiveWorkspaceRoots({ sessionId: sid, env: hostEnv });
    const roots = [...new Set(rawRoots.map((r) => tryRealpath(resolve(r))))];
    if (strictWs && !Array.isArray(allowedRoots) && roots.length === 0) {
        const startup = resolveSidecarRepo(null, envSid, null);
        if (startup) roots.push(tryRealpath(resolve(startup)));
    }
    if (data?.ws && (hasExplicitScope || roots.length > 0)) {
        const requested = fileUriToPath(data.ws);
        if (!requested) return { ok: false };
        const realReq = tryRealpath(resolve(requested));
        const matchingRoot = roots.find((root) => isWithinRoot(realReq, root));
        if (!matchingRoot) return { ok: false };
        return { ok: true, repo: resolveScopedRepoRoot(realReq, matchingRoot) };
    }
    if (hasExplicitScope) {
        if (roots.length === 0) return { ok: false };
        const candidate = tryRealpath(resolveSidecarRepo(null, envSid, null));
        const matchingRoot = roots.find((root) => isWithinRoot(candidate, root));
        return { ok: true, repo: matchingRoot ? resolveScopedRepoRoot(candidate, matchingRoot) : roots[0] };
    }
    const fallback = resolveSidecarRepo(data?.ws, sid, data?.fallback_ws);
    if (roots.length > 0 && !roots.some((root) => isWithinRoot(tryRealpath(fallback), root))) {
        return { ok: true, repo: roots[0] };
    }
    return { ok: true, repo: fallback };
}

/**
 * Pure route builder used by both `SidecarApp` in `runMain()` and unit tests.
 */
export function createSidecarHandlers({
    ResponseClass,
    viewerDir = VIEWER_DIR,
    appDataDirs,
    allowedRoots,
    strictWs = false,
    env = null,
} = {}) {
    const readViewerAsset = (name) => readFileSync(resolve(viewerDir, name), 'utf8');
    const hostEnv = env ?? {};
    const hasExplicitScope = strictWs || Array.isArray(allowedRoots);
    const envSid = () => String(hostEnv.ANTIGRAVITY_CONVERSATION_ID || '');
    const sessionIdOf = (data) => (hasExplicitScope ? envSid() : String(data?.sid || envSid()));
    const authorizeRepoOf = (data) => authorizeSidecarRepo(data, {
        allowedRoots,
        strictWs,
        hostEnv,
        envSid: envSid(),
        sid: sessionIdOf(data),
    });
    const forbiddenResponse = () => makeResponse(
        ResponseClass,
        JSON.stringify({ error: 'workspace outside active scope' }),
        { contentType: 'application/json; charset=utf-8', status: 403 },
    );

    const serveIndex = () => makeResponse(
        ResponseClass,
        injectPreloadScript(readViewerAsset('index.html')),
        { contentType: 'text/html; charset=utf-8', status: 200 },
    );

    return {
        pages: {
            '/': serveIndex,
            '/index.html': serveIndex,
            '/app.js': () => makeResponse(ResponseClass, readViewerAsset('app.js'), {
                contentType: 'text/javascript; charset=utf-8',
                status: 200,
            }),
            '/style.css': () => makeResponse(ResponseClass, readViewerAsset('style.css'), {
                contentType: 'text/css; charset=utf-8',
                status: 200,
            }),
        },
        apis: {
            '/api/rev': (data) => {
                const auth = authorizeRepoOf(data);
                if (!auth.ok) return forbiddenResponse();
                const sid = sessionIdOf(data);
                return {
                    rev: computeSidecarRev({ repoRoot: auth.repo, sid, appDataDirs }),
                    repo: auth.repo,
                };
            },
            '/api/code-graph': (data) => {
                const auth = authorizeRepoOf(data);
                if (!auth.ok) return forbiddenResponse();
                const cached = getCachedCodeGraphPayload(contextDirFor(auth.repo));
                if (!cached) {
                    return makeResponse(ResponseClass, JSON.stringify({ nodes: [], edges: [] }), {
                        contentType: 'application/json; charset=utf-8',
                        status: 200,
                        headers: { 'cache-control': 'no-cache' },
                    });
                }
                return makeResponse(ResponseClass, cached.json, {
                    contentType: 'application/json; charset=utf-8',
                    status: 200,
                    headers: { etag: cached.etag, 'cache-control': 'no-cache' },
                });
            },
            '/api/context-graph': (data) => {
                const auth = authorizeRepoOf(data);
                if (!auth.ok) return forbiddenResponse();
                const sid = sessionIdOf(data);
                return buildAgyContextGraph({ repoRoot: auth.repo, sid, appDataDirs });
            },
            '/api/health': (data) => {
                const auth = authorizeRepoOf(data);
                if (!auth.ok) return forbiddenResponse();
                return buildVizHealthPayload(contextDirFor(auth.repo)) ?? { open_count: 0, by_file: {}, scores: null };
            },
            '/api/source': (data) => {
                const auth = authorizeRepoOf(data);
                if (!auth.ok) return forbiddenResponse();
                const { status, body } = readJailedSourceExcerpt(auth.repo, tryRealpath(auth.repo), contextDirFor(auth.repo), {
                    relPath: data?.path ?? '',
                    spanParam: data?.span ?? '',
                    full: data?.full === '1' || data?.full === true,
                });
                return makeResponse(ResponseClass, JSON.stringify(body), {
                    contentType: 'application/json; charset=utf-8',
                    status,
                });
            },
            '/api/treemap': (data) => {
                const auth = authorizeRepoOf(data);
                if (!auth.ok) return forbiddenResponse();
                const cached = hasPlexerIndex(auth.repo) ? getCachedTreemapPayload(auth.repo, contextDirFor(auth.repo)) : null;
                if (!cached?.html) {
                    return makeResponse(
                        ResponseClass,
                        'treemap unavailable — build index first',
                        { contentType: 'text/plain; charset=utf-8', status: 404 },
                    );
                }
                return makeResponse(ResponseClass, cached.html, {
                    contentType: 'text/html; charset=utf-8',
                    status: 200,
                    headers: {
                        etag: cached.etag,
                        'cache-control': 'no-cache',
                        'x-frame-options': 'SAMEORIGIN',
                        'content-security-policy':
                            "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; frame-ancestors 'self'",
                    },
                });
            },
        },
    };
}

export function attachDaemonShutdownHooks(daemon, proc = process) {
    if (!daemon || daemon.alreadyRunning) return async () => {};
    let closedAsync = false;
    const cleanupSync = () => {
        if (daemon.socketPath && process.platform !== 'win32' && !daemon.socketPath.startsWith('\\\\.\\pipe\\')) {
            try { rmSync(daemon.socketPath, { force: true }); } catch { /* ignore */ }
        }
    };
    const cleanupAsync = async () => {
        if (!closedAsync) {
            closedAsync = true;
            try { await daemon.close?.(); } catch { /* ignore */ }
        }
        cleanupSync();
    };
    const onSignal = (sig) => {
        void cleanupAsync().finally(() => {
            proc.exit?.(sig === 'SIGINT' ? 130 : 143);
        });
    };
    proc.once('SIGINT', onSignal);
    proc.once('SIGTERM', onSignal);
    proc.once('exit', cleanupSync);
    return cleanupAsync;
}

async function runMain() {
    const { startDaemon } = await import('../../src/daemon/plexerd.js');
    if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
        const daemon = await startDaemon({ persistent: true, argv: ['--persistent'] });
        const cleanupDaemon = attachDaemonShutdownHooks(daemon);
        try {
            const { SidecarApp, Response } = await import('sidecar_sdk');
            const app = new SidecarApp();
            const startupRoots = collectActiveWorkspaceRoots({
                sessionId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
                env: process.env,
            });
            if (startupRoots.length === 0) {
                const fallbackRepo = resolveSidecarRepo(null, process.env.ANTIGRAVITY_CONVERSATION_ID || '');
                if (fallbackRepo) startupRoots.push(fallbackRepo);
            }
            const handlers = createSidecarHandlers({
                ResponseClass: Response,
                allowedRoots: startupRoots,
                strictWs: true,
                env: process.env,
            });
            for (const [route, fn] of Object.entries(handlers.pages)) {
                app.page(route, fn);
            }
            for (const [route, fn] of Object.entries(handlers.apis)) {
                app.api(route, fn, 'GET');
            }
            await app.run();
        } finally {
            await cleanupDaemon();
        }
        return;
    }
    if (process.argv.includes('--daemon')) {
        const persistent = process.argv.includes('--persistent') || true;
        const daemon = await startDaemon({ persistent, argv: ['--persistent'] });
        attachDaemonShutdownHooks(daemon);
    }
}

const isEntry = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntry) {
    await runMain();
}
