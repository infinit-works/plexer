'use strict';
/**
 * Shared zero-dependency CJS IPC & code-fingerprint helpers for `plexerd`,
 * `socket-path.js`, and `bin/plexer-hook-client.cjs`.
 */
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

function walkStampTree(dir, acc) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkStampTree(full, acc);
        }
        else if (entry.isFile()) {
            try {
                const st = fs.statSync(full);
                acc.count += 1;
                acc.size += st.size;
                const mtimeMicros = Math.round(st.mtimeMs * 1000);
                if (mtimeMicros > acc.maxMtime)
                    acc.maxMtime = mtimeMicros;
            }
            catch { /* file vanished mid-scan */ }
        }
    }
}

function computeCodeStamp(pkgRoot = path.resolve(__dirname, '../..')) {
    let version = '';
    const acc = { count: 0, size: 0, maxMtime: 0 };
    const pkgFile = path.join(pkgRoot, 'package.json');
    try {
        version = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version || '';
        const st = fs.statSync(pkgFile);
        acc.count += 1;
        acc.size += st.size;
        acc.maxMtime = Math.round(st.mtimeMs * 1000);
    }
    catch { /* ignore missing package.json */ }
    walkStampTree(path.join(pkgRoot, 'bin'), acc);
    walkStampTree(path.join(pkgRoot, 'src'), acc);
    return `${version}:${acc.count}:${acc.size}:${acc.maxMtime}`;
}

function resolveSocketPath(env = process.env, homeOverride = null) {
    if (env.PLEXER_DAEMON_SOCK && env.PLEXER_DAEMON_SOCK.trim()) {
        return env.PLEXER_DAEMON_SOCK.trim();
    }
    if (process.platform === 'win32') {
        let user = 'default';
        try {
            user = os.userInfo().username.replace(/[^a-zA-Z0-9._-]/g, '_');
        }
        catch { /* ignore */ }
        return `\\\\.\\pipe\\plexer-daemon-${user}`;
    }
    const xdg = env.XDG_RUNTIME_DIR;
    if (xdg && fs.existsSync(xdg)) {
        try {
            fs.accessSync(xdg, fs.constants.W_OK);
            return path.join(xdg, 'plexer-daemon.sock');
        }
        catch { /* fallback */ }
    }
    return path.join(homeOverride || os.homedir(), '.cache', 'plexer', 'daemon.sock');
}

function sendRpc(sockPath, reqObj, opts = {}) {
    const connectTimeoutMs = Math.max(10, Number(opts.connectTimeoutMs) || 120);
    const rpcTimeoutMs = Math.max(50, Number(opts.rpcTimeoutMs) || 7500);
    return new Promise((resolve, reject) => {
        const sock = net.createConnection(sockPath);
        const decoder = new StringDecoder('utf8');
        let settled = false;
        let connected = false;
        let buf = '';
        let rpcTimer = null;

        const finishErr = (err, phase) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(connectTimer);
            if (rpcTimer)
                clearTimeout(rpcTimer);
            try { sock.destroy(); } catch { /* ignore */ }
            if (err && typeof err === 'object' && !err.phase)
                err.phase = phase;
            reject(err);
        };

        const connectTimer = setTimeout(() => {
            if (!settled && !connected) {
                const err = new Error('connect timeout');
                err.code = 'CONNECT_TIMEOUT';
                finishErr(err, 'connect');
            }
        }, connectTimeoutMs);

        sock.on('connect', () => {
            connected = true;
            clearTimeout(connectTimer);
            rpcTimer = setTimeout(() => {
                if (!settled) {
                    const err = new Error('rpc timeout');
                    err.code = 'RPC_TIMEOUT';
                    finishErr(err, 'rpc');
                }
            }, rpcTimeoutMs);
            sock.write(`${JSON.stringify(reqObj)}\n`);
        });

        sock.on('data', (chunk) => {
            buf += Buffer.isBuffer(chunk) ? decoder.write(chunk) : String(chunk);
            const nl = buf.indexOf('\n');
            if (nl !== -1 && !settled) {
                let parsed;
                try {
                    parsed = JSON.parse(buf.slice(0, nl));
                }
                catch (err) {
                    finishErr(err, 'rpc');
                    return;
                }
                settled = true;
                clearTimeout(connectTimer);
                if (rpcTimer)
                    clearTimeout(rpcTimer);
                sock.end();
                resolve(parsed);
            }
        });

        sock.on('error', (err) => {
            finishErr(err, connected ? 'rpc' : 'connect');
        });

        sock.on('close', () => {
            if (!settled) {
                const err = new Error('socket closed before response');
                err.code = 'ECONNRESET';
                finishErr(err, connected ? 'rpc' : 'connect');
            }
        });
    });
}

function isSocketReachable(sockPath, timeoutMs = 40) {
    return new Promise((resolveDone) => {
        const sock = net.createConnection(sockPath);
        const timer = setTimeout(() => {
            try { sock.destroy(); } catch { /* ignore */ }
            resolveDone(false);
        }, timeoutMs);
        sock.on('connect', () => {
            clearTimeout(timer);
            sock.end();
            resolveDone(true);
        });
        sock.on('error', () => {
            clearTimeout(timer);
            resolveDone(false);
        });
    });
}

async function waitForSocketTeardown(sockPath, maxWaitMs = 500) {
    const isPipe = process.platform === 'win32' || sockPath.startsWith('\\\\.\\pipe\\');
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
        if (isPipe) {
            if (!(await isSocketReachable(sockPath, 30)))
                return true;
        }
        else if (!fs.existsSync(sockPath)) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 20));
    }
    return isPipe ? !(await isSocketReachable(sockPath, 30)) : !fs.existsSync(sockPath);
}

module.exports = {
    computeCodeStamp,
    resolveSocketPath,
    sendRpc,
    waitForSocketTeardown,
};
