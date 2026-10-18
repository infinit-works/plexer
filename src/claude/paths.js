import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
// Resolving plexer's own CLI and sibling scripts relative to THIS file — not the project dir —
// ensures hooks work regardless of the active working directory.
const CLAUDE_DIR = dirname(fileURLToPath(import.meta.url));
export function packageRootDir() {
    return resolve(CLAUDE_DIR, '..', '..');
}
/** Absolute path to this package's `src/claude` dir. Baked into the generated shims at
 * init time as their primary resolution candidate, so the statusline/hooks find plexer
 * without runtime guesswork. */
export function claudeDistDir() {
    return CLAUDE_DIR;
}
/** Absolute path to a sibling script in the claude dir (e.g. `sync-run.js`). */
export function claudeScriptPath(name) {
    return join(CLAUDE_DIR, name);
}

