/**
 * The file set a graph build parses, and its stat metadata.
 *
 * Shared between `build.js` and `fingerprint.js` so the freshness probe
 * enumerates the exact same files without an import cycle.
 */
import { statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { takeCachedStat, walkDir } from "../util/fs.js";
import { pathUnderPrefix, relPosix } from "../util/paths.js";
import { readWalkConfig } from "../util/state.js";
import {
    containerExtensions,
    containerLangOf,
    depthExtensions,
    genericExtensions,
    genericLangOf,
    languageOf,
} from "./languages.js";
/** Every extension plexer has a parser for (depth + breadth + container), sorted
 * and de-duped — the authoritative answer to "what does `-e` actually support". */
export function supportedExtensions() {
    return [...new Set([...depthExtensions(), ...genericExtensions(), ...containerExtensions()])].sort();
}
/** Normalize a user-supplied extension: ensure a leading dot, lower-case. */
function normExt(e) {
    const t = e.trim().toLowerCase();
    return t.startsWith(".") ? t : `.${t}`;
}
/**
 * The subset of user-supplied `-e` extensions that no parser claims (depth or breadth).
 * The CLI warns on whatever this returns so an unsupported extension is never a quiet no-op.
 */
export function unsupportedExtensions(exts) {
    const supported = new Set(supportedExtensions());
    return exts.filter((e) => !supported.has(normExt(e)));
}
/** Keep only files whose repo-relative path is at or under one of `onlyDirs`.
 * No-op when `onlyDirs` is empty/absent. The whitelist is carried in the graph
 * itself (the fingerprint records it at build time), never in the source repo,
 * so a build and the query-path freshness probe read the identical set. */
export function filterByOnlyDirs(files, root, onlyDirs) {
    if (!onlyDirs || onlyDirs.size === 0)
        return files;
    const dirs = [...onlyDirs];
    return files.filter((abs) => {
        const rel = relPosix(root, abs);
        return dirs.some((d) => pathUnderPrefix(rel, d));
    });
}
export function listSourceFiles(root, outDir, repoFiles, onlyDirs, extensions) {
    if (!repoFiles) {
        const walkCfg = readWalkConfig(resolve(root), outDir);
        repoFiles = walkDir(root, walkCfg.includeDirs, {
            followSubmodules: walkCfg.followSubmodules,
            followNestedRepos: walkCfg.followNestedRepos,
        });
    }
    const outPrefix = outDir.endsWith(sep) ? outDir : `${outDir}${sep}`;
    const extSet = extensions && extensions.length > 0 ? new Set(extensions.map(normExt)) : null;
    // A file is a source file if a depth-tier grammar (languageOf), a breadth-tier
    // grammar (genericLangOf) or a container (containerLangOf) claims its extension.
    // All three must agree here or `build` and `check` would enumerate different sets.
    return filterByOnlyDirs(repoFiles.filter((f) => f !== outDir && !f.startsWith(outPrefix) &&
        (!extSet || extSet.has(extname(f).toLowerCase())) &&
        (languageOf(f) !== null || genericLangOf(f) !== null || containerLangOf(f) !== null)), root, onlyDirs);
}
/**
 * {@link listSourceFiles} plus each file's `(size, mtimeMs)` — the currency of
 * both the freshness probe and the extraction cache. Files that vanish between
 * the walk and the stat are dropped (same fail-soft posture as `walkDir`).
 */
export function listSourceStats(root, outDir, repoFiles, onlyDirs, extensions) {
    const out = [];
    for (const abs of listSourceFiles(root, outDir, repoFiles, onlyDirs, extensions)) {
        let s = takeCachedStat(abs);
        if (!s) {
            try {
                s = statSync(abs);
            }
            catch {
                continue;
            }
        }
        out.push({ abs, rel: relPosix(root, abs), size: s.size, mtimeMs: s.mtimeMs });
    }
    return out;
}
