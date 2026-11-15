/**
 * Resolve the user-scoped IPC socket path (Unix domain socket or Windows named pipe)
 * for `plexerd` and expose the shared code-fingerprint & socket helpers.
 */
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const require = createRequire(import.meta.url);
const ipc = require('./ipc.cjs');

export function resolveDaemonSocketPath(env = process.env) {
    return ipc.resolveSocketPath(env);
}

export function ensureSocketParentDir(sockPath) {
    if (process.platform === 'win32' || sockPath.startsWith('\\\\.\\pipe\\'))
        return;
    mkdirSync(dirname(sockPath), { recursive: true });
}

export const computeCodeStamp = ipc.computeCodeStamp;
export const waitForSocketTeardown = ipc.waitForSocketTeardown;
export const sendDaemonRpc = ipc.sendRpc;
