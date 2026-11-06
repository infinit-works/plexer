/**
 * Minimal MCP stdio server: newline-delimited JSON-RPC 2.0.
 * stdout carries protocol messages ONLY; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline';
import { TOOLS, callTool } from './tools.js';
import { mcpInstructions } from './instructions.js';
import { hasPlexerIndex } from '../graph/root.js';
import { mainWorktreeRoot } from '../graph/seed.js';
import { readCurrentVersion } from '../util/cli-meta.js';
function send(msg) {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
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
export function startMcpServer(root = process.cwd(), dirOverride, version = readCurrentVersion(import.meta.url)) {
    let pendingCalls = 0;
    let stdinEnded = false;
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    rl.on('line', (line) => {
        const text = line.trim();
        if (!text)
            return;
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch {
            replyError(null, -32700, 'parse error');
            return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            replyError(null, -32600, 'invalid request');
            return;
        }
        const { id, method, params } = msg;
        const isNotification = id === undefined;
        try {
            switch (method) {
                case 'initialize': {
                    const hasTools = advertised().length > 0;
                    reply(id, {
                        protocolVersion: params?.protocolVersion ?? '2024-11-05',
                        capabilities: { tools: {} },
                        serverInfo: { name: 'plexer', version },
                        ...(hasTools ? { instructions: mcpInstructions() } : {}),
                    });
                    return;
                }
                case 'notifications/initialized':
                case 'notifications/cancelled':
                    return;
                case 'ping':
                    if (!isNotification)
                        reply(id, {});
                    return;
                case 'tools/list': {
                    if (isNotification)
                        return;
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
                case 'tools/call': {
                    if (isNotification)
                        return;
                    const name = String(params?.name ?? '');
                    const args = (params?.arguments ?? {});
                    pendingCalls += 1;
                    callTool(root, name, args, dirOverride)
                        .then((r) => {
                            reply(id, { content: [{ type: 'text', text: r.text }], isError: r.isError });
                        }, (err) => replyError(id, -32603, err instanceof Error ? err.message : String(err)))
                        .finally(() => {
                            pendingCalls -= 1;
                            if (stdinEnded && pendingCalls === 0)
                                process.exit(0);
                        });
                    return;
                }
                default:
                    if (!isNotification)
                        replyError(id, -32601, `method not found: ${method}`);
            }
        }
        catch (err) {
            if (!isNotification)
                replyError(id ?? null, -32603, err instanceof Error ? err.message : String(err));
        }
    });
    process.stdin.on('end', () => {
        stdinEnded = true;
        if (pendingCalls === 0)
            process.exit(0);
    });
}