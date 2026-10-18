/**
 * Shared helpers for the host config writers. Both the hook installers and MCP
 * registration merge plexer entries into a JSON config, own a generated shim, and
 * describe the outcome with the same result record.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
/**
 * Write a plexer-owned file, idempotently: unchanged when the content already
 * matches (only re-applying `mode` if it drifted), else created/updated. `mode`
 * is applied on POSIX; on Windows the exec bit does not exist and is skipped by
 * the caller's expectations.
 */
export function writeOwned(id, path, content, mode) {
    const existed = existsSync(path);
    if (existed && readFileSync(path, 'utf8') === content) {
        if (mode !== undefined && (statSync(path).mode & 0o777) !== mode)
            chmodSync(path, mode);
        return { id, path, action: 'unchanged' };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined)
        chmodSync(path, mode);
    return { id, path, action: existed ? 'updated' : 'created' };
}
/** Whether a hooks-config entry is one plexer installed (so an upgrade replaces
 *  it in place instead of stacking a second copy next to the stale one). The
 *  `?? ''` guards a stray `undefined` entry: `JSON.stringify(undefined)` is
 *  `undefined`, whose `.includes` would throw. */
export function isPlexerEntry(entry) {
    return JSON.stringify(entry ?? '').includes('plexer-hooks.cjs');
}
/**
 * Load a JSON config that plexer is about to merge into, distinguishing the three
 * outcomes an installer must treat differently:
 *   - missing → `{ root: {}, existed: false }`: start fresh, this is a create.
 *   - a plain object → `{ root, existed: true }`: merge into it.
 *   - anything else (parse error, or a top-level array/null/primitive) →
 *     `'unparseable'`: leave the file exactly as the user left it.
 *
 * Deliberately NOT `readJson` from `util/state.js`, which returns `null` for both
 * missing and unparseable — collapsing those two would let a create silently
 * clobber a hand-edited broken `hooks.json`.
 */
export function readJsonObject(path) {
    if (!existsSync(path))
        return { root: {}, existed: false };
    let root;
    try {
        root = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return 'unparseable';
    }
    if (typeof root !== 'object' || root === null || Array.isArray(root))
        return 'unparseable';
    return { root: root, existed: true };
}
export function dirExists(p) {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
export function updateJsonConfig(id, path, mutate) {
    const loaded = readJsonObject(path);
    if (loaded === 'unparseable')
        return { id, path, action: 'skipped-unparseable' };
    const { root, existed } = loaded;
    const before = JSON.stringify(root);
    const next = mutate(root);
    if (next === 'unparseable')
        return { id, path, action: 'skipped-unparseable' };
    const target = next ?? root;
    if (JSON.stringify(target) === before)
        return { id, path, action: 'unchanged' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(target, null, 2)}\n`);
    return { id, path, action: existed ? 'updated' : 'created' };
}
export function upsertHookEvents(id, path, entries, buildEntry) {
    return updateJsonConfig(id, path, (root) => {
        const hooks = (root.hooks ??= {});
        if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))
            return 'unparseable';
        for (const d of entries) {
            if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event]))
                return 'unparseable';
            const prior = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
            hooks[d.event] = [...prior.filter((e) => !isPlexerEntry(e)), buildEntry(d)];
        }
    });
}

