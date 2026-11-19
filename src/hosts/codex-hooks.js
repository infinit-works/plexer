/**
 * Active-layer install for CLI agents that read user-level hooks.json with
 * SessionStart, UserPromptSubmit, PostToolUse, and Stop semantics. Writes the
 * shared hook shim and wires SessionStart, UserPromptSubmit, PostToolUse, and Stop.
 */
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { formatPlexerHookCommand, isPlexerEntry, updateJsonConfig, upsertHookEvents, writeOwned } from '../util/config-write.js';
import { dirExists } from '../util/fs.js';

const GEMINI_HOOK_DEFS = [
    { event: 'BeforeAgent', matcher: '*', name: 'plexer-before-agent', sub: 'gemini-before-agent', timeout: 15000 },
    { event: 'BeforeTool', matcher: 'read_file|run_shell_command|grep_search', name: 'plexer-before-tool', sub: 'gemini-before-tool', timeout: 8000 },
    { event: 'AfterTool', matcher: 'read_file|write_file|replace', name: 'plexer-after-tool', sub: 'gemini-after-tool', timeout: 8000 },
];

const CURSOR_HOOK_DEFS = [
    { event: 'beforeSubmitPrompt', sub: 'cursor-before-submit', timeout: 15 },
    { event: 'afterFileEdit', sub: 'cursor-after-file-edit', timeout: 10 },
];
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
        const handler = { type: 'command', command: formatPlexerHookCommand(shimPath, d.sub), timeout: d.timeout };
        return d.matcher ? { matcher: d.matcher, hooks: [handler] } : { hooks: [handler] };
    });
    return [shimWrite, cfgWrite];
}

export function geminiHookTargets({ home, repo } = {}) {
    const out = [];
    if (home) {
        out.push(
            { id: 'gemini-hook-shim-global', path: join(home, '.gemini', 'hooks', 'plexer', 'plexer-hooks.cjs'), what: 'global Gemini hook shim' },
            { id: 'gemini-hooks-global', path: join(home, '.gemini', 'settings.json'), what: 'global Gemini CLI hook entries' },
        );
    }
    if (repo) {
        out.push(
            { id: 'gemini-hook-shim', path: join(repo, '.gemini', 'helpers', 'plexer-hooks.cjs'), what: 'repo Gemini hook shim' },
            { id: 'gemini-hooks', path: join(repo, '.gemini', 'settings.json'), what: 'repo Gemini CLI hook entries' },
        );
    }
    return out;
}

export function installGeminiHooks({ home, repo } = {}) {
    const writes = [];
    const shimBody = hooksShim(claudeDistDir());
    const pairs = [
        home ? { shim: join(home, '.gemini', 'hooks', 'plexer', 'plexer-hooks.cjs'), cfg: join(home, '.gemini', 'settings.json'), sfx: '-global' } : null,
        repo ? { shim: join(repo, '.gemini', 'helpers', 'plexer-hooks.cjs'), cfg: join(repo, '.gemini', 'settings.json'), sfx: '' } : null,
    ].filter(Boolean);
    for (const pair of pairs) {
        writes.push(writeOwned(`gemini-hook-shim${pair.sfx}`, pair.shim, shimBody, 0o755));
        writes.push(upsertHookEvents(`gemini-hooks${pair.sfx}`, pair.cfg, GEMINI_HOOK_DEFS, (d) => ({
            matcher: d.matcher,
            hooks: [{ name: d.name, type: 'command', command: formatPlexerHookCommand(pair.shim, d.sub), timeout: d.timeout }],
        })));
    }
    return writes;
}

export function cursorHookTargets(repo) {
    if (!repo) return [];
    return [
        { id: 'cursor-hook-shim', path: join(repo, '.cursor', 'helpers', 'plexer-hooks.cjs'), what: 'Cursor hook shim' },
        { id: 'cursor-hooks', path: join(repo, '.cursor', 'hooks.json'), what: 'Cursor hook entries' },
    ];
}

export function installCursorHooks(repo) {
    if (!repo) return [];
    const shimPath = join(repo, '.cursor', 'helpers', 'plexer-hooks.cjs');
    const cfgPath = join(repo, '.cursor', 'hooks.json');
    const shimWrite = writeOwned('cursor-hook-shim', shimPath, hooksShim(claudeDistDir()), 0o755);
    const cfgWrite = updateJsonConfig('cursor-hooks', cfgPath, (root) => {
        if (root.version === undefined) root.version = 1;
        const hooks = (root.hooks ??= {});
        if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return 'unparseable';
        for (const d of CURSOR_HOOK_DEFS) {
            if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event])) return 'unparseable';
            const prior = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
            hooks[d.event] = [
                ...prior.filter((e) => !isPlexerEntry(e)),
                { command: formatPlexerHookCommand(shimPath, d.sub), timeout: d.timeout },
            ];
        }
    });
    return [shimWrite, cfgWrite];
}

