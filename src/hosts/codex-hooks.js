/**
 * Active-layer install for CLI agents that read user-level hooks.json with
 * SessionStart, UserPromptSubmit, PostToolUse, and Stop semantics. Writes the
 * shared hook shim and wires SessionStart, UserPromptSubmit, PostToolUse, and Stop.
 */
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { upsertHookEvents, writeOwned } from '../util/config-write.js';
import { dirExists } from '../util/fs.js';
/**
 * The files installing the Codex hook would touch — pure, no writes. Both live
 * under `~/.codex`, so both are scoped 'global': the hook entries fire in every
 * repo opened with Codex, not just this one. Empty when the CLI isn't installed,
 * mirroring `installCodexHooks`' early return.
 */
export function hookTargets(home) {
    const base = join(home, '.codex');
    if (!dirExists(base))
        return [];
    return [
        {
            hostId: 'agents', id: 'codex-hook-shim',
            path: join(base, 'hooks', 'plexer', 'plexer-hooks.cjs'),
            scope: 'global', kind: 'hook', what: 'post-edit hook shim',
        },
        {
            hostId: 'agents', id: 'codex-hooks',
            path: join(base, 'hooks.json'),
            scope: 'global', kind: 'hook', what: 'SessionStart / UserPromptSubmit / PostToolUse / Stop',
        },
    ];
}
/** Codex reads `timeout` (an alias of its `timeoutSec` field) in seconds, not milliseconds. */
const DESIRED_ENTRIES = [
    { event: 'SessionStart', matcher: 'startup|resume|compact', sub: 'session-start', timeout: 10 },
    { event: 'UserPromptSubmit', sub: 'prompt', timeout: 15 },
    { event: 'PostToolUse', matcher: 'apply_patch|Write|Edit|MultiEdit', sub: 'post-edit', timeout: 10 },
    { event: 'Stop', sub: 'stop', timeout: 10 },
];
export function installCodexHooks(home) {
    const targets = hookTargets(home);
    if (targets.length === 0)
        return [];
    const shimPath = targets[0].path;
    const shimWrite = writeOwned('codex-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
    const cfgWrite = upsertHookEvents('codex-hooks', targets[1].path, DESIRED_ENTRIES, (d) => {
        const handler = { type: 'command', command: `node "${shimPath}" ${d.sub}`, timeout: d.timeout };
        return d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    });
    return [shimWrite, cfgWrite];
}

