import { isPlexerEntry } from '../util/config-write.js';
const SL_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/plexer-statusline.cjs"';
/** Stable marker for "this statusLine is Plexer's", not the full command string —
 * an older shim path or a PLEXER_DIR wrapper still names this file. */
const PLEXER_STATUSLINE_HELPER = 'plexer-statusline.cjs';
const FOOTER = 'plexer/[\\w./-]+\\.md';
const ALLOW_ENTRIES = [
    'Bash(plexer:*)',
    'Bash(npx plexer:*)',
    'Bash(npx @plexer/cli:*)',
];
/** Where the repo-level install's shims sit, relative to whatever project is open. */
const REPO_HELPERS = '${CLAUDE_PROJECT_DIR:-.}/.claude/helpers';
/**
 * `helpers` is the directory holding `plexer-hooks.cjs`, and it is a parameter for
 * one reason: the user-level install (see hosts/claude-global.js) has to name an
 * absolute path. A `${CLAUDE_PROJECT_DIR}` command works only where a previous
 * `plexer init` wrote a shim into that project — which is exactly the case the
 * global copy exists to cover, so it cannot reuse the repo form.
 */
function hookCmd(arg, helpers = REPO_HELPERS) {
    return `node "${helpers}/plexer-hooks.cjs" ${arg}`;
}
/** Claude Code reads a hook's `timeout` in seconds, not milliseconds. */
function plexerBlocks(helpers) {
    return {
        PreToolUse: [
            { matcher: 'Read|Bash', hooks: [{ type: 'command', command: hookCmd('pre-tool-use', helpers), timeout: 8 }] },
        ],
        PostToolUse: [
            { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCmd('post-edit', helpers), timeout: 10 }] },
            { matcher: 'Read|ExitPlanMode', hooks: [{ type: 'command', command: hookCmd('post-tool-use', helpers), timeout: 8 }] },
        ],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt', helpers), timeout: 15 }] }],
        SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: hookCmd('session-start', helpers), timeout: 8 }] }],
        Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop', helpers), timeout: 8 }] }],
    };
}
/**
 * Is this allowlist entry one plexer wrote?
 */
export function isPlexerAllowEntry(entry) {
    return /^Bash\((?:plexer|npx (?:plexer|@plexer\/cli))(?::|\))/.test(String(entry));
}
/** Is this footer regex plexer's? It points at the card tree, which is plexer's alone. */
export function isPlexerFooterRegex(re) {
    return String(re).includes('plexer/');
}
function envNoStatusline() {
    const v = process.env.PLEXER_NO_STATUSLINE;
    return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}
/** True when init should write (or refresh) Plexer's Claude Code statusLine. */
export function statuslineWanted(opts = {}) {
    return opts.statusline !== false && !envNoStatusline();
}
export function isPlexerStatusline(value) {
    if (!value || typeof value !== 'object')
        return false;
    const command = value.command;
    return typeof command === 'string' && command.includes(PLEXER_STATUSLINE_HELPER);
}
function applyStatusline(merged, key, warnings, wanted, foreignWarning) {
    const current = merged[key];
    const ours = isPlexerStatusline(current);
    if (!wanted) {
        if (!current || ours)
            delete merged[key];
        else
            warnings.push(foreignWarning);
        return;
    }
    if (!current || ours) {
        merged[key] = { type: 'command', command: SL_CMD };
        return;
    }
    warnings.push(foreignWarning);
}
export function mergePlexerSettings(existing, opts = {}) {
    const { merged } = opts.hooks === false ? { merged: { ...(existing ?? {}) } } : mergePlexerHooks(existing);
    const warnings = [];
    const wanted = statuslineWanted(opts);
    applyStatusline(merged, 'statusLine', warnings, wanted, 'Existing statusLine left untouched (a session allows only one). To use Plexer, point it at .claude/helpers/plexer-statusline.cjs.');
    applyStatusline(merged, 'subagentStatusLine', warnings, wanted, 'Existing subagentStatusLine left untouched.');
    // Drop plexer's own prior regex before re-adding, so a change to FOOTER replaces
    // the old pattern instead of stacking beside it. The user's regexes are kept.
    const priorFooter = Array.isArray(merged.footerLinksRegexes) ? merged.footerLinksRegexes : [];
    merged.footerLinksRegexes = [...priorFooter.filter((r) => !isPlexerFooterRegex(r)), FOOTER];
    // headless/subagent runs hard-deny Bash by default; without an allowlist entry
    // `plexer ask`'s own Bash calls (and the skill it installs) can't run out-of-box.
    // Same shape as the hooks merge above: drop plexer's prior entries, then add the
    // current set. Append-only left a renamed invocation form in the user's settings
    // forever, with nothing able to remove it.
    merged.permissions = { ...(merged.permissions ?? {}) };
    const priorAllow = Array.isArray(merged.permissions.allow) ? merged.permissions.allow : [];
    merged.permissions.allow = [...priorAllow.filter((e) => !isPlexerAllowEntry(e)), ...ALLOW_ENTRIES];
    return { merged, warnings };
}
/**
 * The hook blocks alone, merged into a settings file, with the shims addressed by
 * absolute path — `~/.claude/settings.json`, where a write reaches every project on
 * the machine (see hosts/claude-global.js for why that copy has to exist).
 *
 * Hooks only, deliberately. `mergePlexerSettings` also claims the statusline, the
 * footer regex and a Bash allowlist, and each of those is a reasonable thing to
 * accept for a repo you ran `plexer init` in and an unreasonable thing to impose on
 * every repo you ever open — a statusline especially, since a session allows exactly
 * one and taking it globally would silently outrank the user's own. The hooks are the
 * piece that has to be global, because they are what a worktree loses.
 *
 * Same idempotent shape as the repo merge: plexer's prior entries are dropped before
 * the current set is added, so re-running converges instead of stacking.
 */
export function mergePlexerHooks(existing, helpers) {
    const merged = { ...(existing ?? {}) };
    merged.hooks = { ...(merged.hooks ?? {}) };
    for (const [event, blocks] of Object.entries(plexerBlocks(helpers))) {
        const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
        const foreign = prior.filter((e) => !isPlexerEntry(e));
        merged.hooks[event] = [...foreign, ...blocks];
    }
    return { merged };
}
