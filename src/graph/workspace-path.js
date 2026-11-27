/**
 * Lightweight workspace.json path & metadata reader without loading ask/grep/extract engines.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { contextDirFor } from "../context/node-file.js";
import { readJson } from "../util/state.js";

export const WORKSPACE_FILE = "workspace.json";

/** Absolute path to the workspace index for a parent root (`<dir>/plexer/workspace.json`). */
export function workspacePath(root, override) {
    return join(contextDirFor(root, override), WORKSPACE_FILE);
}

function isSafeWorkspaceChild(root, child) {
    if (typeof child !== "string")
        return false;
    const c = child.trim();
    if (!c || c === "." || c === ".." || c.startsWith(".") || /[/\\:]/.test(c))
        return false;
    const absRoot = resolve(root);
    const absChild = resolve(absRoot, c);
    const rel = relative(absRoot, absChild);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
        return false;
    if (!existsSync(absChild))
        return true;
    try {
        if (lstatSync(absChild).isSymbolicLink())
            return false;
        const realRoot = realpathSync(absRoot);
        const realChild = realpathSync(absChild);
        const realRel = relative(realRoot, realChild);
        return Boolean(realRel && !realRel.startsWith("..") && !isAbsolute(realRel));
    }
    catch {
        return false;
    }
}

/** Read the workspace index, or null when the parent has none (not a workspace or invalid). */
export function readWorkspaceMeta(root, override) {
    const parsed = readJson(workspacePath(root, override));
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.children))
        return null;
    const children = parsed.children.map(String).filter((c) => isSafeWorkspaceChild(root, c));
    if (children.length === 0 && parsed.children.length > 0)
        return null;
    return { version: 1, children };
}
