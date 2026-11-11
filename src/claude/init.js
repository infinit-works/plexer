import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { hasPlexerIndex } from '../graph/root.js';
import { toPosixPath } from '../util/paths.js';
import { BIN_LAUNCH, mergeJsonKey, readJsonObject, updateJsonConfig, writeOwned } from '../util/config-write.js';
import { mergePlexerHooks, mergePlexerSettings } from './settings-merge.js';
import { statuslineShim, hooksShim, skillTemplate } from './shim-template.js';
import { claudeDistDir } from './paths.js';

/** The directory the user-level shim lives in — the base every hook command names. */
export function globalHelpersDir(home) {
    return join(home, '.claude', 'helpers');
}
/**
 * The files a user-level install would touch — pure, no writes, so `--dry-run` and
 * the picker can report them up front. All three are scoped 'global': they apply to
 * every project opened with Claude Code, not just this one.
 */
export function claudeGlobalTargets(home) {
    const g = (id, path, kind, what) => ({ hostId: 'claude', id, path, scope: 'global', kind, what });
    return [
        g('claude-global-shim', join(globalHelpersDir(home), 'plexer-hooks.cjs'), 'hook', 'hooks shim (user level)'),
        g('claude-global-hooks', join(home, '.claude', 'settings.json'), 'hook', 'SessionStart / UserPromptSubmit / PostToolUse / Stop'),
        g('claude-global-mcp', join(home, '.claude.json'), 'mcp', 'mcpServers.plexer'),
    ];
}
/**
 * Install the user-level copy: the shim, the hook entries that call it, and the
 * user-scope MCP registration.
 */
export function installClaudeGlobal(home, opts = {}) {
    const [shim, settings, mcp] = claudeGlobalTargets(home);
    const out = [];
    if (opts.hooks !== false) {
        let shimAction = 'skipped-unparseable';
        try {
            const res = writeOwned(shim.id, shim.path, hooksShim(claudeDistDir()), 0o755);
            shimAction = res.action;
            out.push(res);
        }
        catch {
            out.push({ id: shim.id, path: shim.path, action: 'skipped-unparseable' });
        }
        if (shimAction !== 'skipped-unparseable') {
            try {
                const helpers = toPosixPath(globalHelpersDir(home));
                out.push(updateJsonConfig(settings.id, settings.path, (existing) => mergePlexerHooks(existing, helpers).merged));
            }
            catch {
                out.push({ id: settings.id, path: settings.path, action: 'skipped-unparseable' });
            }
        }
    }
    if (opts.mcp === true) {
        try {
            out.push(mergeJsonKey(mcp.id, mcp.path, 'mcpServers', BIN_LAUNCH));
        }
        catch {
            out.push({ id: mcp.id, path: mcp.path, action: 'skipped-unparseable' });
        }
    }
    return out;
}
/**
 * Build the graph if it isn't there yet. Not Claude-specific: the wiring for any
 * host points at `plexer/`, so `plexer init` builds whichever hosts were selected.
 * Best-effort; the user can always run `plexer build`.
 */
export function buildGraphIfMissing(dir, opts) {
    if (opts.build === false || !opts.cliPath || hasPlexerIndex(dir))
        return false;
    try {
        execFileSync(process.execPath, [...process.execArgv, opts.cliPath, 'build', '.'], { cwd: dir, stdio: 'inherit', timeout: 300000 });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front. All repo-local: the Claude Code layer never writes
 * outside the project.
 */
export function claudeTargets(dir) {
    const t = (path, what, kind = 'claude') => ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind, what });
    return [
        t(join(dir, '.claude', 'settings.json'), 'plexer statusline + hook blocks'),
        t(join(dir, '.claude', 'helpers', 'plexer-statusline.cjs'), 'statusline shim'),
        t(join(dir, '.claude', 'helpers', 'plexer-hooks.cjs'), 'hooks shim', 'hook'),
        t(join(dir, '.claude', 'skills', 'plexer', 'SKILL.md'), 'plexer skill'),
        // Tagged 'mcp' so the picker doesn't label Claude Code as having no MCP.
        t(join(dir, '.mcp.json'), 'mcpServers.plexer', 'mcp'),
    ];
}
export function runInit(dir, opts = {}) {
    // Same list `--dry-run` and the picker report, so the two can't drift apart.
    const [settings, statusline, hooks, skill, mcpTarget] = claudeTargets(dir).map((t) => t.path);
    const loadedSettings = readJsonObject(settings);
    let warnings = [];
    if (loadedSettings === 'unparseable') {
        warnings.push('Existing .claude/settings.json could not be parsed and was left untouched.');
    }
    else {
        const mergedRes = mergePlexerSettings(loadedSettings.root, {
            statusline: opts.statusline,
            hooks: opts.hooks,
        });
        warnings = mergedRes.warnings;
        mkdirSync(dirname(settings), { recursive: true });
        writeFileSync(settings, `${JSON.stringify(mergedRes.merged, null, 2)}\n`);
    }
    const bakedDir = claudeDistDir();
    writeOwned('claude-statusline', statusline, statuslineShim(bakedDir), 0o755);
    const shims = [statusline];
    if (opts.hooks !== false) {
        writeOwned('claude-hooks', hooks, hooksShim(bakedDir), 0o755);
        shims.push(hooks);
    }
    writeOwned('claude-skill', skill, skillTemplate());
    const mcp = opts.mcp === true
        ? mergeJsonKey('claude', mcpTarget, 'mcpServers', BIN_LAUNCH)
        : { id: 'claude', path: mcpTarget, action: 'unchanged' };
    const global = opts.global === false
        ? []
        : installClaudeGlobal(opts.home ?? homedir(), { hooks: opts.hooks, mcp: opts.mcp });
    const built = buildGraphIfMissing(dir, opts);
    return { settingsPath: settings, shims, skill, mcp, global, warnings, built };
}
