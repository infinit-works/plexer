/**
 * The on-disk format of the context directory (`plexer/`): linked markdown cards,
 * `.gitignore` / `.ignore` cache setup, and directory resolution.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { relPosix, stripTrailingSlashes } from "../util/paths.js";
import { appendGitignoreEntry, readJson } from "../util/state.js";

/** Gitignored cache dir (extractions, ask-index, fingerprint, config), never committed. */
export const CACHE_DIR = ".cache";

/** Hidden subdir under the context dir that holds machine-only graph artifacts. */
export const GRAPH_DIR = ".graph";

export const GRAPH_FILE = "wiring.json";

/** Absolute path to the wiring graph for a context dir: `<dir>/.graph/wiring.json`. */
export function wiringPath(outDir) {
    return join(outDir, GRAPH_DIR, GRAPH_FILE);
}

/**
 * Read an existing wiring graph for use as the Tier-2 cache. Returns null when the
 * file is absent or unparseable (a fresh build, or a corrupt file we'll replace).
 */
export function readGraph(path) {
    const g = readJson(path);
    return g && g.meta?.version === 1 && Array.isArray(g.nodes) ? g : null;
}

/** Env kill switch — shared across gitignore/ignore, auto-refresh, and worktree seeding. */
export function envTruthy(name) {
    const v = process.env[name];
    return v !== undefined && v !== "" && v !== "0" && v !== "false";
}

/** Absolute path of the `plexer/` directory for a repo root. */
export function contextDirFor(root, override) {
    const chosen = override || process.env.PLEXER_DIR?.trim();
    if (chosen)
        return isAbsolute(chosen) ? chosen : join(root, chosen);
    return join(root, "plexer");
}

const GRAPH_CACHE_NOTE = "plexer's local graph cache — regenerable, not committed (run `plexer build`).";

export function ensureGitignored(root, contextDir) {
    if (envTruthy("PLEXER_NO_GITIGNORE"))
        return;
    const rel = relPosix(root, contextDir);
    if (rel === "" || rel.startsWith(".."))
        return;
    appendGitignoreEntry(root, stripTrailingSlashes(rel), GRAPH_CACHE_NOTE);
}

/**
 * Keep the card tree greppable even though it's gitignored, by writing a root
 * `.ignore` that re-admits `plexer/` while excluding `.cache/` and `.graph/`.
 */
export function ensureSearchable(root, contextDir) {
    if (envTruthy("PLEXER_NO_IGNORE"))
        return;
    const rel = relPosix(root, contextDir);
    if (rel === "" || rel.startsWith(".."))
        return;
    const dir = stripTrailingSlashes(rel);
    const entry = `!${dir}/`;
    const path = join(root, ".ignore");
    let current = "";
    try {
        current = readFileSync(path, "utf8");
    }
    catch { /* no .ignore yet — we create one */ }
    if (current.split(/\r?\n/).some((l) => l.trim() === entry))
        return;
    const gap = current === "" ? "" : current.endsWith("\n") ? "\n" : "\n\n";
    const block = `${gap}# plexer's cards are gitignored but should stay greppable: ripgrep reads\n` +
        `# .ignore before .gitignore, so this re-admits the tree to search only.\n` +
        `${entry}\n${dir}/${CACHE_DIR}/\n${dir}/${GRAPH_DIR}/\n`;
    try {
        writeFileSync(path, current + block);
    }
    catch { /* best-effort */ }
}
