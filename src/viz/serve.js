/**
 * The `plexer viz` local server. Zero runtime dependencies: node:http serves
 * the viewer bundle, JSON endpoints, and an SSE channel that pings the browser
 * whenever `plexer/` changes on disk.
 *
 *   GET /                  viewer (index.html, app.js, style.css from viewerDir)
 *   GET /api/context-graph empty metadata envelope (blast graph in exported view)
 *   GET /api/code-graph    plexer/.graph/wiring.json passthrough (404 until generated)
 *   GET /api/source        repo-jailed source line excerpt for inspector preview
 *   GET /api/health        health snapshot + per-file findings from plexer/.health/state.json
 *   GET /events            SSE; fs.watch on the context dir, debounced 300ms
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, watch } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { loadGraphCached } from "../context/graph-store.js";
import { computeScoreSnapshot } from "../health/scoring.js";
import { loadHealthConfig, loadHealthState, stateFilePath } from "../health/state.js";
import { buildZoneMap } from "../health/health.js";
import { generateHealthTreemapHtml } from "../health/viz.js";
import { tryRealpath } from "../util/fs.js";
import { relPosix } from "../util/paths.js";
import { readSourceFile } from "../util/source.js";
import { fileReader, isSensitiveOrDotPath, MAX_SOURCE_READ_BYTES } from "../util/span.js";

export function buildVizHealthPayload(contextDir) {
    if (!contextDir || !existsSync(stateFilePath(contextDir))) return null;
    const state = loadHealthState(contextDir);
    const scores = computeScoreSnapshot(state);
    const byFile = Object.create(null);
    let openCount = 0;
    const sevRank = { critical: 4, high: 3, medium: 2, low: 1 };
    const tierUrgency = { T1: 4, T2: 3, T3: 2, T4: 1 };
    for (const iss of Object.values(state.issues || {})) {
        if (!iss || typeof iss !== "object" || iss.status !== "open" || iss.suppressed || typeof iss.file !== "string" || !iss.file) continue;
        openCount += 1;
        let entry = byFile[iss.file];
        if (!entry) {
            entry = {
                count: 0,
                max_severity: "low",
                max_tier: iss.tier || "T4",
                zone: iss.zone || "production",
                issues: [],
            };
            byFile[iss.file] = entry;
        }
        entry.count += 1;
        if (!entry.zone && iss.zone) entry.zone = iss.zone;
        if ((sevRank[iss.severity] || 1) > (sevRank[entry.max_severity] || 1)) {
            entry.max_severity = iss.severity || "medium";
        }
        if ((tierUrgency[iss.tier] || 0) > (tierUrgency[entry.max_tier] || 0)) {
            entry.max_tier = iss.tier || "T2";
        }
        if (entry.issues.length < 15) {
            entry.issues.push({
                id: iss.id,
                detector: iss.detector,
                tier: iss.tier,
                severity: iss.severity,
                span: iss.span,
                zone: iss.zone || entry.zone || "production",
                summary: iss.summary,
            });
        }
    }
    return {
        scan_count: state.scan_count || 0,
        open_count: openCount,
        scores: {
            strict: scores.strict,
            overall: scores.overall,
            objective: scores.objective,
            verified: scores.verified,
        },
        by_file: byFile,
    };
}
const PORT_ATTEMPTS = 10;
const MAX_SSE_CLIENTS = 32;
const WATCH_DEBOUNCE_MS = 300;
const LOOPBACK_HOST_RE = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i;
const LOOPBACK_ORIGIN_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i;
const SECURITY_HEADERS = {
    "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'self'; frame-ancestors 'none'",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
};
const TREEMAP_FRAME_HEADERS = {
    "content-security-policy":
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
    "cross-origin-resource-policy": "same-origin",
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "cache-control": "no-store",
};
const STATIC_FILES = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...SECURITY_HEADERS,
    });
    if (String(res.req?.method ?? "GET").toUpperCase() === "HEAD") {
        res.end();
        return;
    }
    res.end(payload);
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onListening = () => {
            server.removeListener("error", onError);
            resolve(true);
        };
        const onError = (err) => {
            server.removeListener("listening", onListening);
            if (err.code === "EADDRINUSE")
                resolve(false);
            else
                reject(err);
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", onListening);
    });
}
export function readJailedSourceExcerpt(repoRoot, realRepoRoot, contextDir, opts = {}) {
    const relPath = String(opts.relPath ?? "").trim();
    const spanParam = String(opts.spanParam ?? "").trim();
    const full = opts.full === true || opts.full === "1";
    if (!relPath) {
        return { status: 400, body: { error: "missing path parameter" } };
    }
    const absFile = resolve(repoRoot, relPath);
    const relCheck = relPosix(repoRoot, absFile);
    if (!relCheck || relCheck.startsWith("..") || isAbsolute(relCheck) || isSensitiveOrDotPath(relCheck)) {
        return { status: 403, body: { error: "path outside repository root or restricted" } };
    }
    const graph = contextDir ? loadGraphCached(contextDir) : null;
    const isIndexed = graph?._nodesByPath ? graph._nodesByPath.has(relCheck) : graph?.nodes?.some((n) => n.path === relCheck);
    if (!isIndexed) {
        return { status: 403, body: { error: "file is not indexed in the codebase graph" } };
    }
    try {
        if (!existsSync(absFile)) {
            return { status: 404, body: { error: "source file not found" } };
        }
        const realFile = tryRealpath(absFile);
        const realRel = relPosix(realRepoRoot, realFile);
        if (!realRel || realRel.startsWith("..") || isAbsolute(realRel) || isSensitiveOrDotPath(realRel)) {
            return { status: 403, body: { error: "path outside repository root or restricted" } };
        }
        const realStat = statSync(realFile);
        if (!realStat.isFile()) {
            return { status: 404, body: { error: "source file not found" } };
        }
        if (realStat.size > MAX_SOURCE_READ_BYTES) {
            return { status: 413, body: { error: "source file too large or not a regular file" } };
        }
        const raw = readSourceFile(realFile);
        if (raw === null) {
            return { status: 500, body: { error: "unable to read source file" } };
        }
        const allLines = raw.split(/\r?\n/);
        if (allLines.length > 1 && allLines[allLines.length - 1] === "") {
            allLines.pop();
        }
        const totalLines = allLines.length;
        let startLine = 1;
        let endLine = Math.min(totalLines, full ? 250 : 45);
        const m = /^[Ll]?(\d+)(?:[-:][Ll]?(\d+))?/.exec(spanParam);
        if (m) {
            startLine = Math.max(1, Math.min(totalLines || 1, Number(m[1])));
            endLine = m[2]
                ? Math.max(startLine, Math.min(totalLines, Number(m[2])))
                : Math.min(totalLines, startLine + 34);
        }
        const maxLines = full ? 300 : 120;
        const cappedEnd = Math.min(totalLines, endLine, startLine + maxLines - 1);
        const lines = [];
        for (let ln = startLine; ln <= cappedEnd; ln++) {
            lines.push({ n: ln, text: allLines[ln - 1] ?? "" });
        }
        return {
            status: 200,
            body: {
                path: relCheck,
                span: spanParam || `${startLine}-${cappedEnd}`,
                startLine,
                endLine: cappedEnd,
                spanEndLine: endLine,
                totalLines,
                truncated: endLine > cappedEnd,
                lines,
            },
        };
    }
    catch {
        return { status: 500, body: { error: "unable to read source file" } };
    }
}

export function renderHealthTreemapHtml(repoRoot, contextDir) {
    if (!repoRoot || !contextDir)
        return null;
    const graph = loadGraphCached(contextDir);
    if (!graph)
        return null;
    const state = loadHealthState(contextDir);
    const config = loadHealthConfig(contextDir);
    const zoneMap = buildZoneMap(graph, config, repoRoot);
    const readLines = fileReader(repoRoot);
    const res = generateHealthTreemapHtml(contextDir, graph, state, zoneMap, readLines, {
        rootDir: repoRoot,
        write: false,
    });
    return res?.html || null;
}

function handleSourceApiRequest(parsedUrl, res, repoRoot, realRepoRoot, contextDir) {
    const { status, body } = readJailedSourceExcerpt(repoRoot, realRepoRoot, contextDir, {
        relPath: parsedUrl.searchParams.get("path") ?? "",
        spanParam: parsedUrl.searchParams.get("span") ?? "",
        full: parsedUrl.searchParams.get("full") === "1",
    });
    sendJson(res, status, body);
}

function handleVizEventsRequest(req, res, method, sseClients) {
    res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        ...SECURITY_HEADERS,
    });
    if (method === "HEAD") {
        res.end();
        return;
    }
    res.write(": connected\n\n");
    while (sseClients.size >= MAX_SSE_CLIENTS) {
        const oldest = sseClients.values().next().value;
        if (!oldest) break;
        sseClients.delete(oldest);
        try {
            oldest.end();
        }
        catch { /* ignore close error */ }
    }
    sseClients.add(res);
    const cleanup = () => sseClients.delete(res);
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
}

function acceptVizHttpRequest(req, res, boundPort) {
    const hostHeader = String(req.headers?.host ?? "").trim();
    const hostMatch = LOOPBACK_HOST_RE.exec(hostHeader);
    if (!hostMatch || (boundPort && hostMatch[1] && Number(hostMatch[1]) !== boundPort)) {
        sendJson(res, 403, { error: "forbidden Host header" });
        return null;
    }
    const secFetchSite = String(req.headers?.["sec-fetch-site"] ?? "").trim().toLowerCase();
    const originHeader = String(req.headers?.origin ?? "").trim();
    const originMatch = originHeader ? LOOPBACK_ORIGIN_RE.exec(originHeader) : null;
    const originPortMismatch = Boolean(originHeader) && (!originMatch || (boundPort && Number(originMatch[1] || 80) !== boundPort));
    if ((secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") || originPortMismatch) {
        sendJson(res, 403, { error: "cross-site requests are forbidden" });
        return null;
    }
    const method = String(req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
        sendJson(res, 405, { error: "method not allowed" });
        return null;
    }
    const rawTarget = String(req.url ?? "/");
    if (!rawTarget.startsWith("/") || rawTarget.startsWith("//")) {
        sendJson(res, 400, { error: "invalid request URL" });
        return null;
    }
    try {
        return { method, parsedUrl: new URL(rawTarget, "http://127.0.0.1") };
    } catch {
        sendJson(res, 400, { error: "invalid request URL" });
        return null;
    }
}

function serveVizStaticAsset(path, method, res, viewerDir) {
    const asset = Object.hasOwn(STATIC_FILES, path) ? STATIC_FILES[path] : null;
    if (!asset) return false;
    const file = join(viewerDir, asset.file);
    if (!existsSync(file)) {
        res.writeHead(404, { "content-type": "text/plain", ...SECURITY_HEADERS });
        res.end(method === "HEAD" ? undefined : "viewer bundle missing — run the package build");
        return true;
    }
    res.writeHead(200, { "content-type": asset.type, ...SECURITY_HEADERS });
    res.end(method === "HEAD" ? undefined : readFileSync(file));
    return true;
}

function dispatchVizApiRoute(parsedUrl, method, req, res, opts, repoRoot, realRepoRoot, sseClients) {
    const path = parsedUrl.pathname;
    if (path === "/api/context-graph") {
        sendJson(res, 200, { nodes: [], edges: [], meta: { repoName: opts.repoName } });
        return;
    }
    if (path === "/api/code-graph") {
        const parsed = loadGraphCached(opts.contextDir);
        if (!parsed) {
            sendJson(res, 404, { error: "no wiring graph in this context dir — run `plexer build` first" });
            return;
        }
        sendJson(res, 200, parsed);
        return;
    }
    if (path === "/api/source") {
        handleSourceApiRequest(parsedUrl, res, repoRoot, realRepoRoot, opts.contextDir);
        return;
    }
    if (path === "/api/health") {
        sendJson(res, 200, buildVizHealthPayload(opts.contextDir) ?? { open_count: 0, by_file: {}, scores: null });
        return;
    }
    if (path === "/api/treemap") {
        const html = renderHealthTreemapHtml(repoRoot, opts.contextDir);
        const status = html ? 200 : 404;
        const body = html ? html : "treemap unavailable — build index first";
        const ctype = html ? "text/html; charset=utf-8" : "text/plain; charset=utf-8";
        res.writeHead(status, { "content-type": ctype, ...TREEMAP_FRAME_HEADERS });
        res.end(method === "HEAD" ? undefined : body);
        return;
    }
    if (path === "/events") {
        handleVizEventsRequest(req, res, method, sseClients);
        return;
    }
    res.writeHead(404, { "content-type": "text/plain", ...SECURITY_HEADERS });
    res.end(method === "HEAD" ? undefined : "not found");
}

function handleVizHttpRequest(req, res, opts, repoRoot, realRepoRoot, sseClients, boundPort) {
    const validated = acceptVizHttpRequest(req, res, boundPort);
    if (!validated) return;
    if (serveVizStaticAsset(validated.parsedUrl.pathname, validated.method, res, opts.viewerDir)) return;
    dispatchVizApiRoute(validated.parsedUrl, validated.method, req, res, opts, repoRoot, realRepoRoot, sseClients);
}

export async function startVizServer(opts) {
    const repoRoot = resolve(opts.root ?? dirname(opts.contextDir));
    const realRepoRoot = tryRealpath(repoRoot);
    const sseClients = new Set();
    let port = 0;
    const server = createServer((req, res) => {
        try {
            handleVizHttpRequest(req, res, opts, repoRoot, realRepoRoot, sseClients, port);
        }
        catch {
            if (!res.headersSent) {
                sendJson(res, 500, { error: "internal server error" });
            }
            else {
                res.destroy();
            }
        }
    });
    const basePort =
        Number.isInteger(opts?.port) && opts.port > 0 && opts.port <= 65535 ? opts.port : 4400;
    port = basePort;
    let bound = false;
    for (let i = 0; i < PORT_ATTEMPTS && !bound && basePort + i <= 65535; i++) {
        port = basePort + i;
        bound = await listen(server, port);
    }
    if (!bound) {
        const maxTried = Math.min(65535, basePort + PORT_ATTEMPTS - 1);
        throw new Error(`no free port in ${basePort}–${maxTried}`);
    }
    const watchers = new Map();
    let debounce;
    const notifyChange = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            for (const client of sseClients) {
                if (client.destroyed || client.writableEnded) {
                    sseClients.delete(client);
                    continue;
                }
                try {
                    client.write("data: change\n\n");
                }
                catch {
                    sseClients.delete(client);
                }
            }
        }, WATCH_DEBOUNCE_MS);
        debounce.unref?.();
    };
    const ensureSubWatchers = () => {
        for (const subDir of [join(opts.contextDir, ".graph"), join(opts.contextDir, ".health")]) {
            if (!watchers.has(subDir) && existsSync(subDir)) {
                try {
                    const w = watch(subDir, notifyChange);
                    w.on("error", () => {});
                    watchers.set(subDir, w);
                }
                catch { /* ignore watch errors */ }
            }
        }
    };
    const rootWatchDir = existsSync(opts.contextDir) ? opts.contextDir : dirname(opts.contextDir);
    if (existsSync(rootWatchDir)) {
        try {
            const w = watch(rootWatchDir, () => {
                ensureSubWatchers();
                notifyChange();
            });
            w.on("error", () => {});
            watchers.set(rootWatchDir, w);
        }
        catch { /* ignore watch errors */ }
    }
    ensureSubWatchers();
    let closePromise = null;
    return {
        url: `http://127.0.0.1:${port}`,
        port,
        close() {
            if (closePromise)
                return closePromise;
            clearTimeout(debounce);
            for (const w of watchers.values())
                w.close();
            watchers.clear();
            for (const client of sseClients)
                client.end();
            sseClients.clear();
            server.closeAllConnections?.();
            closePromise = new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
            return closePromise;
        },
    };
}
