/**
 * Module labels for the blast diagram — groups changed and affected files by
 * directory so blast reports and diagrams summarize areas cleanly.
 */
import { stripTrailingSlashes } from "../util/paths.js";
/**
 * Build the path → module-label lookup for a blast report.
 */
export function moduleIndex(_contextDir) {
    return {
        hasConcepts: false,
        labelOf: (path) => shortLabel(dirLabel(path)),
        conceptOf: () => null,
    };
}
/** Longest label a circle can hold before the text overruns it. */
const MAX_LABEL = 30;
const CLAUSE_BREAK = /\s(?:\(|—|-\s)|:\s|\s(?:via|and|for|with|using|in|across|over|from|of|by|to)\s/i;
/** Trim a label to fit inside a diagram node. */
export function shortLabel(label) {
    const bare = label.replace(/^concepts?:\s*/i, "").trim();
    if (bare.length <= MAX_LABEL)
        return bare;
    const at = CLAUSE_BREAK.exec(bare);
    if (at && at.index >= 8 && at.index <= MAX_LABEL)
        return bare.slice(0, at.index).trimEnd();
    // No usable joint: a word-boundary cut, marked, because this one really does stop
    // mid-phrase and a reader must not take the fragment for the whole name.
    const cut = bare.lastIndexOf(" ", MAX_LABEL);
    return `${bare.slice(0, cut > MAX_LABEL / 2 ? cut : MAX_LABEL).trimEnd()}…`;
}
/** The parent directory of a directory label, or "" at the top level. */
export function parentDir(dir) {
    const trimmed = stripTrailingSlashes(dir);
    const cut = trimmed.lastIndexOf("/");
    return cut === -1 ? "" : `${trimmed.slice(0, cut)}/`;
}
/** Fallback label: the file's directory, or `(root)` for a top-level file. */
export function dirLabel(path) {
    const cut = path.lastIndexOf("/");
    return cut === -1 ? "(root)" : path.slice(0, cut) + "/";
}
