/**
 * The `plexer viz` local server. Zero runtime dependencies: node:http serves
 * the viewer bundle, JSON endpoints, and an SSE channel that pings the browser
 * whenever `plexer/` changes on disk.
 *
 *   GET /                  viewer (index.html, app.js, style.css from viewerDir)
 *   GET /api/context-graph empty metadata envelope (blast graph in exported view)
 *   GET /api/code-graph    plexer/.graph/wiring.json passthrough (404 until generated)
 *   GET /api/source        repo-jailed source line excerpt for inspector preview
 *   GET /events            SSE; fs.watch on the context dir, debounced 300ms
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, realpathSync, statSync, watch } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loadGraphCached } from "../graph/load.js";
import { readSourceFile } from "../util/source.js";
const PORT_ATTEMPTS = 10;
const WATCH_DEBOUNCE_MS = 300;
const STATIC_FILES = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};
function sendJson(res, status, body) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
}
function listen(server, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            if (err.code === "EADDRINUSE")
                resolve(false);
            else
                reject(err);
        };
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
            server.removeListener("error", onError);
            resolve(true);
        });
    });
}
export async function startVizServer(opts) {
    const repoRoot = resolve(opts.root ?? dirname(opts.contextDir));
    let realRepoRoot = repoRoot;
    try {
        realRepoRoot = realpathSync(repoRoot);
    }
    catch { /* use resolved repoRoot */ }
    const sseClients = new Set();
    const server = createServer((req, res) => {
        const parsedUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = parsedUrl.pathname;
        const asset = STATIC_FILES[path];
        if (asset) {
            const file = join(opts.viewerDir, asset.file);
            if (!existsSync(file)) {
                res.writeHead(404, { "content-type": "text/plain" });
                res.end("viewer bundle missing — run the package build");
                return;
            }
            res.writeHead(200, { "content-type": asset.type });
            res.end(readFileSync(file));
            return;
        }
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
            const relPath = (parsedUrl.searchParams.get("path") ?? "").trim();
            const spanParam = (parsedUrl.searchParams.get("span") ?? "").trim();
            const full = parsedUrl.searchParams.get("full") === "1";
            if (!relPath) {
                sendJson(res, 400, { error: "missing path parameter" });
                return;
            }
            const absFile = resolve(repoRoot, relPath);
            const relCheck = relative(repoRoot, absFile);
            if (!relCheck || relCheck.startsWith("..") || isAbsolute(relCheck)) {
                sendJson(res, 403, { error: "path outside repository root" });
                return;
            }
            try {
                if (!existsSync(absFile) || !statSync(absFile).isFile()) {
                    sendJson(res, 404, { error: "source file not found" });
                    return;
                }
                const realFile = realpathSync(absFile);
                const realRel = relative(realRepoRoot, realFile);
                if (!realRel || realRel.startsWith("..") || isAbsolute(realRel)) {
                    sendJson(res, 403, { error: "path outside repository root" });
                    return;
                }
                const raw = readSourceFile(realFile);
                if (raw === null) {
                    sendJson(res, 500, { error: "unable to read source file" });
                    return;
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
                sendJson(res, 200, {
                    path: relPath,
                    span: spanParam || `${startLine}-${cappedEnd}`,
                    startLine,
                    endLine: cappedEnd,
                    spanEndLine: endLine,
                    totalLines,
                    truncated: endLine > cappedEnd,
                    lines,
                });
            }
            catch {
                sendJson(res, 500, { error: "unable to read source file" });
            }
            return;
        }
        if (path === "/events") {
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            res.write(": connected\n\n");
            sseClients.add(res);
            req.on("close", () => sseClients.delete(res));
            return;
        }
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
    });
    let port = opts.port;
    let bound = false;
    for (let i = 0; i < PORT_ATTEMPTS && !bound; i++) {
        port = opts.port + i;
        bound = await listen(server, port);
    }
    if (!bound) {
        throw new Error(`no free port in ${opts.port}–${opts.port + PORT_ATTEMPTS - 1}`);
    }
    const watchers = [];
    let debounce;
    const notifyChange = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => {
            for (const client of sseClients)
                client.write("data: change\n\n");
        }, WATCH_DEBOUNCE_MS);
    };
    for (const watchDir of [opts.contextDir, join(opts.contextDir, ".graph")]) {
        if (existsSync(watchDir)) {
            try {
                const w = watch(watchDir, notifyChange);
                w.on("error", () => {});
                watchers.push(w);
            }
            catch { /* ignore watch errors */ }
        }
    }
    return {
        url: `http://127.0.0.1:${port}`,
        close() {
            clearTimeout(debounce);
            for (const w of watchers)
                w.close();
            for (const client of sseClients)
                client.end();
            sseClients.clear();
            return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
        },
    };
}
