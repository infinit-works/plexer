/**
 * User-level install for Claude Code: the copy of plexer's wiring that lives
 * outside every repo.
 *
 * Everything `plexer init` writes for Claude Code inside a repo (`.mcp.json` and
 * `.claude/settings.json`) can be ignored by `.gitignore` or omitted in a new
 * `git worktree add`. `~/.claude/` is outside any working tree, so Claude Code
 * reads it for every project and worktree.
 */
import { join } from 'node:path';
import { hooksShim } from '../claude/shim-template.js';
import { claudeDistDir } from '../claude/paths.js';
import { mergePlexerHooks } from '../claude/settings-merge.js';
import { toPosixPath } from '../util/paths.js';
import { updateJsonConfig, writeOwned } from './config-write.js';
import { mergeJsonKey, BIN_LAUNCH } from './mcp-config.js';
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
    if (opts.mcp !== false) {
        try {
            out.push(mergeJsonKey(mcp.id, mcp.path, 'mcpServers', BIN_LAUNCH));
        }
        catch {
            out.push({ id: mcp.id, path: mcp.path, action: 'skipped-unparseable' });
        }
    }
    return out;
}
