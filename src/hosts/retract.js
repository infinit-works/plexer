/**
 * Retraction: undo every edit plexer has ever made to a repo.
 *
 * `init` is additive — it writes the files the *currently selected* hosts need
 * and never looks at the rest. So a repo wired by an older version (or by the
 * same version with different `--agents`) keeps the files that run produced,
 * and the two sets accumulate. Retraction is the missing half: it walks every
 * target plexer could ever have written and removes plexer's contribution, so
 * `retract` + `init` converges the repo on exactly this version's intent.
 *
 * The target list is derived from the same registries `init` writes through
 * (`HOSTS`, `mcpTargets`, `hookTargets`, `claudeTargets`), so a host added
 * later is retractable for free — there is no second list to keep in sync.
 *
 * Two invariants, both load-bearing:
 *   1. Never delete what plexer did not write. Inside a file the user owns, only
 *      the marker-fenced region and plexer-named keys are touched; foreign MCP
 *      servers, hooks, and settings are preserved byte for byte.
 *   2. Never leave an empty shell. A file that held nothing but plexer's
 *      contribution is deleted, not truncated to `{}` or a blank document —
 *      an orphan file is the very residue this exists to remove.
 */
import { readFileSync, writeFileSync, existsSync, lstatSync, rmSync, rmdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS } from './registry.js';
import { PLEXER_START, PLEXER_END, hasSection } from './sections.js';
import { mcpTargets, stripTomlSection } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeGlobalTargets } from './claude-global.js';
import { claudeTargets } from '../claude/init.js';
import { isPlexerAllowEntry, isPlexerFooterRegex, isPlexerStatusline } from '../claude/settings-merge.js';
import { dirExists, isPlexerEntry, readJsonObject } from './config-write.js';
import { resolveContextDir, resolveGitExcludePath } from '../util/state.js';
// ---------------------------------------------------------------------------
// primitive operations
// ---------------------------------------------------------------------------
/** True when a file has no non-whitespace content left. */
function isBlank(text) {
    return text.trim() === '';
}
function removeFile(path, apply) {
    try {
        if (lstatSync(dirname(path)).isSymbolicLink())
            return 'absent';
    }
    catch { /* parent dir absent */ }
    if (path.endsWith('SKILL.md')) {
        try {
            if (lstatSync(dirname(dirname(path))).isSymbolicLink())
                return 'absent';
        }
        catch { /* grandparent dir absent */ }
        if (existsSync(join(dirname(path), 'package.json')) || existsSync(join(dirname(path), '.git')))
            return 'absent';
    }
    if (!existsSync(path))
        return 'absent';
    if (apply) {
        rmSync(path, { force: true });
        pruneEmptyDirs(dirname(path));
    }
    return 'deleted';
}
function removeSymlink(path, apply) {
    try {
        if (!lstatSync(path).isSymbolicLink())
            return 'absent';
    }
    catch {
        return 'absent';
    }
    if (apply) {
        rmSync(path, { force: true });
        pruneEmptyDirs(dirname(path));
    }
    return 'deleted';
}
/**
 * Walk up from a just-emptied directory removing empty ancestors, so retracting
 * `.claude/skills/plexer/SKILL.md` doesn't leave a hollow `skills/plexer/` behind.
 * Stops at the first non-empty directory — never climbs out of the repo, because
 * any ancestor that far up has other content in it.
 */
function pruneEmptyDirs(dir) {
    for (let d = dir, i = 0; i < 6; i++) {
        try {
            rmdirSync(d); // throws on a non-empty dir — exactly the guard we want
        }
        catch {
            return; // not a dir, not empty, or not ours to remove
        }
        const parent = dirname(d);
        if (parent === d)
            return;
        d = parent;
    }
}
/**
 * Strip the marker-fenced plexer block from a file the user owns.
 *
 * Paragraph spacing around the removed block is collapsed back to a single
 * blank line, so a file that had prose either side of the block reads exactly
 * as it did before plexer appended to it.
 */
function stripSection(path, apply) {
    if (!existsSync(path))
        return 'absent';
    const text = readFileSync(path, 'utf8');
    if (!hasSection(text))
        return 'absent';
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r\n|\n/);
    const out = [];
    let pending = [];
    let inSection = false;
    let found = false;
    for (const line of lines) {
        const t = line.trim();
        if (!inSection) {
            if (t === PLEXER_START) {
                inSection = true;
                pending = [line];
                continue;
            }
            out.push(line);
        }
        else {
            pending.push(line);
            if (t === PLEXER_END) {
                inSection = false;
                pending = [];
                found = true;
            }
        }
    }
    if (inSection) {
        out.push(...pending);
    }
    if (!found)
        return 'absent';
    // Collapse the run of blank lines the block left behind, and trim the edges.
    const collapsed = out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n');
    if (!apply)
        return isBlank(collapsed) ? 'deleted' : 'removed';
    if (isBlank(collapsed))
        return removeFile(path, true);
    writeFileSync(path, eol === '\n' ? collapsed : collapsed.replace(/\n/g, '\r\n'));
    return 'removed';
}
function retractJson(path, apply, mutate) {
    if (!existsSync(path))
        return 'absent';
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable')
        return 'skipped-unparseable';
    const { root } = loaded;
    const before = JSON.stringify(root);
    mutate(root);
    if (JSON.stringify(root) === before)
        return 'absent';
    const empty = Object.keys(root).length === 0;
    if (!apply)
        return empty ? 'deleted' : 'removed';
    if (empty)
        return removeFile(path, true);
    writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
    return 'removed';
}
function stripHookEvents(root) {
    if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks))
        return;
    for (const event of Object.keys(root.hooks)) {
        const prior = root.hooks[event];
        if (!Array.isArray(prior))
            continue;
        const kept = prior.filter((e) => !isPlexerEntry(e));
        if (kept.length === 0)
            delete root.hooks[event];
        else
            root.hooks[event] = kept;
    }
    if (Object.keys(root.hooks).length === 0)
        delete root.hooks;
}
/**
 * Delete `<topKey>.plexer` from a JSON config, preserving every other server.
 * An unparseable file is reported and left alone — the user may have comments or
 * a half-finished edit in there, and rewriting it would lose more than it fixes.
 */
function removeJsonKey(path, topKey, apply) {
    return retractJson(path, apply, (root) => {
        const bucket = root[topKey];
        if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket) || !('plexer' in bucket))
            return;
        delete bucket.plexer;
        if (Object.keys(bucket).length === 0)
            delete root[topKey];
    });
}
function removeTopLevelJsonKey(path, key, apply) {
    return retractJson(path, apply, (root) => {
        delete root[key];
    });
}
/**
 * Delete the `[mcp_servers.plexer]` table from a TOML config.
 *
 * Line-based on purpose: a real TOML parse-and-reserialize would reformat the
 * user's whole file. The table runs from its header to the next `[`-header or
 * EOF, which is exactly what `upsertCodexToml` appends.
 */
function removeTomlSection(path, apply) {
    if (!existsSync(path))
        return 'absent';
    const { rest: kept, found } = stripTomlSection(readFileSync(path, 'utf8'));
    if (!found)
        return 'absent';
    if (!apply)
        return isBlank(kept) ? 'deleted' : 'removed';
    if (isBlank(kept))
        return removeFile(path, true);
    writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`);
    return 'removed';
}
/**
 * Remove plexer's fragments from `.claude/settings.json`, keeping the user's.
 *
 * The statusline check is by *shim path*, not exact string equality: an older
 * version's command differed in shape, and `mergePlexerSettings` would read that
 * as a hand-written statusline and refuse to touch it forever. Matching the
 * helper path recognizes plexer's own output across every version that wrote it.
 */
function stripClaudeSettings(path, apply) {
    return retractJson(path, apply, (root) => {
        for (const key of ['statusLine', 'subagentStatusLine']) {
            if (root[key] !== undefined && isPlexerStatusline(root[key]))
                delete root[key];
        }
        stripHookEvents(root);
        if (Array.isArray(root.footerLinksRegexes)) {
            const kept = root.footerLinksRegexes.filter((r) => !isPlexerFooterRegex(r));
            if (kept.length === 0)
                delete root.footerLinksRegexes;
            else
                root.footerLinksRegexes = kept;
        }
        if (root.permissions && Array.isArray(root.permissions.allow)) {
            const kept = root.permissions.allow.filter((a) => !isPlexerAllowEntry(a));
            if (kept.length === 0)
                delete root.permissions.allow;
            else
                root.permissions.allow = kept;
            if (Object.keys(root.permissions).length === 0)
                delete root.permissions;
        }
    });
}
/** Remove plexer's PostToolUse/SessionStart/etc. entries from Codex's or Cursor's hooks.json. */
function stripCodexHooks(path, apply) {
    return retractJson(path, apply, (root) => {
        stripHookEvents(root);
        if (Object.keys(root).length === 1 && root.version === 1)
            delete root.version;
    });
}
/**
 * Drop plexer's block from `.gitignore` / `.ignore`.
 *
 * Both are written as a comment line plus entries; the comment is plexer's own
 * wording, so it identifies the block. Entries are matched individually too, so
 * a hand-tidied file (comment deleted, entry kept) still retracts cleanly.
 */
function stripIgnoreEntries(path, entries, apply, { deleteIfBlank = true } = {}) {
    if (!existsSync(path))
        return 'absent';
    const text = readFileSync(path, 'utf8');
    const kept = text
        .split('\n')
        .filter((l) => {
        const t = l.trim();
        if (t.startsWith('#') && (t.includes('plexer') || t.includes('.ignore before .gitignore, so this re-admits the tree to search only')))
            return false;
        return !entries.some((re) => re.test(t));
    })
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '\n');
    if (kept === text)
        return 'absent';
    if (!apply)
        return isBlank(kept) && deleteIfBlank ? 'deleted' : 'removed';
    if (isBlank(kept)) {
        if (deleteIfBlank)
            return removeFile(path, true);
        writeFileSync(path, '');
        return 'removed';
    }
    writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`);
    return 'removed';
}
function removeDir(path, apply) {
    if (!dirExists(path))
        return 'absent';
    if (apply) {
        rmSync(path, { recursive: true, force: true });
        pruneEmptyDirs(dirname(path));
    }
    return 'deleted';
}
function removePlexerCacheDir(cache, apply) {
    if (!dirExists(cache))
        return 'absent';
    const isPlexerCache =
        existsSync(join(cache, '.graph')) ||
        existsSync(join(cache, '.cache')) ||
        existsSync(join(cache, 'INDEX.md')) ||
        (() => {
            try {
                return readdirSync(cache).length === 0;
            }
            catch {
                return false;
            }
        })();
    if (!isPlexerCache)
        return 'absent';
    return removeDir(cache, apply);
}
function collectKeptRetractPaths(repo, home, exclude, targetSets) {
    /**
     * Paths a *kept* host also writes, which must survive even though some other,
     * unselected host names them too.
     *
     * Three hosts share `AGENTS.md` (agents, hermes, antigravity). Excluding by host
     * id alone would strip that shared block on behalf of a host nobody selected,
     * and the only reason the end state came out right was that `init` happened to
     * rewrite it immediately afterwards. Exclude by path as well, so retraction
     * never depends on what runs next.
     */
    const keptPaths = new Set();
    for (const host of HOSTS) {
        if (exclude.has(host.id))
            keptPaths.add(join(repo, host.relPath));
    }
    for (const t of mcpTargets(repo, [...exclude], { home }))
        keptPaths.add(t.path);
    if (exclude.has('claude')) {
        for (const t of targetSets.repoClaudeTargets)
            keptPaths.add(t.path);
        for (const t of targetSets.globalClaudeTargets)
            keptPaths.add(t.path);
    }
    if (exclude.has('agents'))
        for (const t of targetSets.codexHookTargets)
            keptPaths.add(t.path);
    if (exclude.has('antigravity'))
        for (const t of targetSets.agySkillTargets)
            keptPaths.add(t.path);
    return keptPaths;
}

function enqueueGlobalRetractTargets(home, exclude, targetSets, enqueueTarget) {
    if (exclude.size === 0) {
        const binLink = join(home, '.local', 'bin', 'plexer');
        enqueueTarget({ hostId: 'global', path: binLink, what: 'plexer CLI symlink', scope: 'global', run: (a) => removeSymlink(binLink, a) });
    }
    if (!exclude.has('claude')) {
        const [shim, settings, mcp] = targetSets.globalClaudeTargets;
        for (const t of [
            { hostId: 'claude', path: shim.path, what: shim.what, scope: 'global', run: (a) => removeFile(shim.path, a) },
            { hostId: 'claude', path: settings.path, what: settings.what, scope: 'global', run: (a) => stripClaudeSettings(settings.path, a) },
            { hostId: 'claude', path: mcp.path, what: mcp.what, scope: 'global', run: (a) => removeJsonKey(mcp.path, 'mcpServers', a) },
        ])
            enqueueTarget(t);
        const claudeSkillLink = join(home, '.claude', 'skills', 'plexer');
        enqueueTarget({ hostId: 'claude', path: claudeSkillLink, what: 'plexer skill symlink', scope: 'global', run: (a) => removeSymlink(claudeSkillLink, a) });
    }
    if (!exclude.has('agents')) {
        for (const t of targetSets.codexHookTargets) {
            enqueueTarget({
                hostId: t.hostId, path: t.path, what: t.what, scope: 'global',
                run: (a) => (t.path.endsWith('.json') ? stripCodexHooks(t.path, a) : removeFile(t.path, a)),
            });
        }
        const agentsSkillLink = join(home, '.agents', 'skills', 'plexer');
        enqueueTarget({ hostId: 'agents', path: agentsSkillLink, what: 'plexer skill symlink', scope: 'global', run: (a) => removeSymlink(agentsSkillLink, a) });
    }
    if (!exclude.has('antigravity')) {
        for (const t of targetSets.agySkillTargets) {
            enqueueTarget({
                hostId: t.hostId, path: t.path, what: t.what, scope: 'global',
                run: (a) => (t.path.endsWith('hooks.json') ? removeTopLevelJsonKey(t.path, 'plexer-hooks', a) : removeFile(t.path, a)),
            });
        }
        const geminiSkillLink = join(home, '.gemini', 'skills', 'plexer');
        enqueueTarget({ hostId: 'antigravity', path: geminiSkillLink, what: 'plexer skill symlink', scope: 'global', run: (a) => removeSymlink(geminiSkillLink, a) });
    }
}

/**
 * Every target plexer could have written, in removal order.
 *
 * Derived from the live registries, NOT hand-listed: `HOSTS` gives the
 * instruction files, `mcpTargets` over *all* host ids gives the MCP configs
 * (with the format and top-level key each one needs), and `claudeTargets`
 * gives the Claude Code layer. That's what keeps this complete as hosts are
 * added — see the module note.
 */
function targets(repo, opts) {
    const home = opts.home ?? homedir();
    const exclude = new Set(opts.exclude ?? []);
    const out = [];
    const targetSets = {
        repoClaudeTargets: claudeTargets(repo),
        globalClaudeTargets: claudeGlobalTargets(home),
        codexHookTargets: hookTargets(home),
        agySkillTargets: antigravitySkillTargets(home),
    };
    const keptPaths = collectKeptRetractPaths(repo, home, exclude, targetSets);
    /** Queue a target unless a kept host owns that path, or it's already queued. */
    const seen = new Set();
    const enqueueTarget = (t) => {
        if (keptPaths.has(t.path) || seen.has(t.path))
            return;
        seen.add(t.path);
        out.push(t);
    };
    // 1. Instruction files, one per host. Owned files go wholesale; shared files
    //    lose only their fenced block.
    for (const host of HOSTS) {
        if (exclude.has(host.id))
            continue;
        const path = join(repo, host.relPath);
        enqueueTarget(host.kind === 'owned'
            ? { hostId: host.id, path, what: 'plexer-owned instruction file', scope: 'repo', run: (a) => removeFile(path, a) }
            : { hostId: host.id, path, what: 'fenced plexer section', scope: 'repo', run: (a) => stripSection(path, a) });
    }
    // 2. MCP registrations. Asking for every host id at once yields the union of
    //    config files, each already carrying its format and top-level key.
    const allIds = HOSTS.map((h) => h.id).filter((id) => !exclude.has(id));
    for (const t of mcpTargets(repo, allIds, { home })) {
        if (opts.global === false && t.scope === 'global')
            continue;
        enqueueTarget({
            hostId: t.hostId, path: t.path, what: t.what, scope: t.scope,
            run: (a) => (t.format === 'toml' ? removeTomlSection(t.path, a) : removeJsonKey(t.path, t.topKey, a)),
        });
    }
    // 3. Claude Code: settings fragments, both shims, the skill, and the .mcp.json key.
    if (!exclude.has('claude')) {
        const [settings, statusline, hooks, skill, mcp] = targetSets.repoClaudeTargets.map((t) => t.path);
        for (const t of [
            { hostId: 'claude', path: settings, what: 'statusline + hooks + allowlist + footer regex', scope: 'repo', run: (a) => stripClaudeSettings(settings, a) },
            { hostId: 'claude', path: statusline, what: 'statusline shim', scope: 'repo', run: (a) => removeFile(statusline, a) },
            { hostId: 'claude', path: hooks, what: 'hooks shim', scope: 'repo', run: (a) => removeFile(hooks, a) },
            { hostId: 'claude', path: skill, what: 'plexer skill', scope: 'repo', run: (a) => removeFile(skill, a) },
            { hostId: 'claude', path: mcp, what: 'mcpServers.plexer', scope: 'repo', run: (a) => removeJsonKey(mcp, 'mcpServers', a) },
        ])
            enqueueTarget(t);
    }
    // 4. Global: Claude Code's user-level copy, Codex's hook shim + entries,
    //    Antigravity's shared skill + hooks, and global bin/skill symlinks.
    if (opts.global !== false) {
        enqueueGlobalRetractTargets(home, exclude, targetSets, enqueueTarget);
    }
    // 5. The graph cache and the ignore entries that admit it. Last, so a failure
    //    here can't strand the wiring half-retracted.
    if (opts.cache !== false) {
        const cache = resolveContextDir(repo);
        const gitignore = join(repo, '.gitignore');
        const gitExclude = resolveGitExcludePath(repo);
        const ignore = join(repo, '.ignore');
        const cacheTargets = [
            { hostId: 'graph', path: cache, what: 'local graph cache', scope: 'repo', run: (a) => removePlexerCacheDir(cache, a) },
            { hostId: 'graph', path: gitignore, what: 'plexer/ ignore entry', scope: 'repo', run: (a) => stripIgnoreEntries(gitignore, [/^\/?plexer\/?$/], a) },
            { hostId: 'graph', path: ignore, what: 'plexer/ search re-admit entries', scope: 'repo', run: (a) => stripIgnoreEntries(ignore, [/^!?plexer\/?$/, /^plexer\/\.(cache|graph)\/?$/], a) },
        ];
        if (gitExclude) {
            cacheTargets.push({
                hostId: 'graph',
                path: gitExclude,
                what: 'plexer/ git exclude entry',
                scope: 'repo',
                run: (a) => stripIgnoreEntries(gitExclude, [/^\/?plexer\/?$/], a, { deleteIfBlank: false }),
            });
        }
        for (const t of cacheTargets)
            enqueueTarget(t);
    }
    return out;
}
// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
/** What a retraction *would* remove. Pure — touches nothing. */
export function planRetract(repo, opts = {}) {
    return targets(repo, { ...opts, apply: false }).map(({ run, ...t }) => ({ ...t, action: run(false) }));
}
/**
 * Remove plexer's contribution from every target. Reports every target it
 * considered, including the ones that were already clean, so a caller can show
 * either the full sweep or just what changed.
 */
export function runRetract(repo, opts = {}) {
    const apply = opts.apply !== false;
    return targets(repo, opts).map(({ run, ...t }) => ({ ...t, action: run(apply) }));
}
/** The subset worth showing a user: targets that had something to remove. */
export function changed(retractions) {
    return retractions.filter((r) => r.action !== 'absent');
}
