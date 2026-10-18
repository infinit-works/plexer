import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { installClaudeGlobal } from '../hosts/claude-global.js';
import { readJsonObject, writeOwned } from '../hosts/config-write.js';
import { mergePlexerSettings } from './settings-merge.js';
import { statuslineShim, hooksShim } from './shim-template.js';
import { skillTemplate } from './skill-template.js';
import { claudeDistDir } from './paths.js';
import { mergeJsonKey, BIN_LAUNCH } from '../hosts/mcp-config.js';
import { buildGraphIfMissing } from '../hosts/init.js';
export { buildGraphIfMissing };
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
    const mcp = opts.mcp === false
        ? { id: 'claude', path: mcpTarget, action: 'unchanged' }
        : mergeJsonKey('claude', mcpTarget, 'mcpServers', BIN_LAUNCH);
    const global = opts.global === false
        ? []
        : installClaudeGlobal(opts.home ?? homedir(), { hooks: opts.hooks, mcp: opts.mcp });
    const built = buildGraphIfMissing(dir, opts);
    return { settingsPath: settings, shims, skill, mcp, global, warnings, built };
}
