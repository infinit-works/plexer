/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { fileUriToPath } from '../util/paths.js';
import { TOOLS, callTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { readCurrentVersion } from '../util/cli-meta.js';
let stdoutClosed = false;
process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
        stdoutClosed = true;
        process.exitCode = 0;
        return;
    }
    throw err;
});
function send(msg) {
    if (stdoutClosed || process.stdout.destroyed || process.stdout.writableEnded)
        return;
    try {
        process.stdout.write(`${JSON.stringify(msg)}\n`);
    }
    catch (err) {
        if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
            stdoutClosed = true;
            return;
        }
        throw err;
    }
}
function reply(id, result) {
    send({ jsonrpc: '2.0', id, result });
}
function replyError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
}
function advertised() {
    return TOOLS;
}
function parseRootUris(roots) {
    if (!Array.isArray(roots)) return [];
    const out = [];
    for (const r of roots) {
        if (!r || typeof r.uri !== 'string' || !r.uri.startsWith('file://')) continue;
        const p = fileUriToPath(r.uri);
        if (p) out.push(p);
    }
    return out;
}
function createMcpRootsRequester(sessionState) {
    let reqCounter = 0;
    const pendingClientReqs = new Map();
    function requestRoots() {
        const reqId = `plexer-roots-${++reqCounter}`;
        let done;
        const p = new Promise((resolve) => { done = resolve; });
        const timer = setTimeout(() => {
            pendingClientReqs.delete(reqId);
            done(sessionState.roots ?? []);
        }, 200);
        if (typeof timer.unref === 'function') timer.unref();
        pendingClientReqs.set(reqId, (msg) => {
            clearTimeout(timer);
            pendingClientReqs.delete(reqId);
            if (!msg.error && msg.result) sessionState.roots = parseRootUris(msg.result.roots);
            else if (sessionState.roots === null) sessionState.roots = [];
            done(sessionState.roots);
        });
        sessionState.pendingRoots = p.finally(() => {
            if (sessionState.pendingRoots === p) sessionState.pendingRoots = null;
        });
        send({ jsonrpc: '2.0', id: reqId, method: 'roots/list', params: {} });
    }
    return { requestRoots, pendingClientReqs };
}

function maybeExit(lifecycle) {
    if (lifecycle.stdinEnded && lifecycle.pendingCalls === 0)
        process.exit(0);
}

function handleMcpToolCall(id, params, root, dirOverride, sessionState, lifecycle) {
    const name = String(params?.name ?? '');
    const args = (params?.arguments ?? {});
    lifecycle.pendingCalls += 1;
    callTool(root, name, args, dirOverride, sessionState)
        .then(
            (r) => reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError }),
            (err) => replyError(id, -32603, err instanceof Error ? err.message : String(err)),
        )
        .finally(() => {
            lifecycle.pendingCalls -= 1;
            maybeExit(lifecycle);
        });
}

function dispatchMcpMessage(msg, ctx) {
    const { id, method, params } = msg;
    if (method === undefined && id !== undefined) {
        const handler = ctx.pendingClientReqs.get(id);
        if (handler) handler(msg);
        return;
    }
    const isNotification = id === undefined;
    try {
        switch (method) {
            case 'initialize': {
                const hasTools = advertised().length > 0;
                reply(id, {
                    protocolVersion: params?.protocolVersion ?? '2024-11-05',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'plexer', version: ctx.version },
                    ...(hasTools ? { instructions: mcpInstructions() } : {}),
                });
                return;
            }
            case 'notifications/initialized':
            case 'notifications/roots/list_changed':
                ctx.requestRoots();
                return;
            case 'notifications/cancelled':
                return;
            case 'ping':
                if (!isNotification) reply(id, {});
                return;
            case 'tools/list': {
                if (isNotification) return;
                reply(id, {
                    tools: advertised().map((t) => ({
                        name: t.name,
                        description: t.description,
                        inputSchema: t.inputSchema,
                        ...(t.annotations ? { annotations: t.annotations } : {}),
                    })),
                });
                return;
            }
            case 'tools/call':
                if (!isNotification) handleMcpToolCall(id, params, ctx.root, ctx.dirOverride, ctx.sessionState, ctx.lifecycle);
                return;
            default:
                if (!isNotification) replyError(id, -32601, `method not found: ${method}`);
        }
    } catch (err) {
        if (!isNotification) replyError(id ?? null, -32603, err instanceof Error ? err.message : String(err));
    }
}

export function startMcpServer(root = process.cwd(), dirOverride, version = readCurrentVersion(import.meta.url)) {
    const lifecycle = { pendingCalls: 0, stdinEnded: false };
    const sessionState = { seenSpans: {}, seenSpansByRepo: {}, roots: null, pendingRoots: null };
    const { requestRoots, pendingClientReqs } = createMcpRootsRequester(sessionState);
    const ctx = { root, dirOverride, version, sessionState, lifecycle, requestRoots, pendingClientReqs };
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
        const text = line.trim();
        if (!text) return;
        let msg;
        try {
            msg = JSON.parse(text);
        } catch {
            replyError(null, -32700, 'parse error');
            return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            replyError(null, -32600, 'invalid request');
            return;
        }
        dispatchMcpMessage(msg, ctx);
    });
    process.stdin.on('end', () => {
        lifecycle.stdinEnded = true;
        rl.close();
        maybeExit(lifecycle);
    });
}