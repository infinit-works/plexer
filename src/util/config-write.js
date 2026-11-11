/**
 * Idempotent JSON config, hook entry, and owned-file writers shared by host setup modules.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { dirExists } from "./fs.js";

export function writeOwned(id, path, content, mode) {
    const existed = existsSync(path) && !dirExists(path);
    if (existed && readFileSync(path, "utf8") === content) {
        if (mode !== undefined && (statSync(path).mode & 0o777) !== mode)
            chmodSync(path, mode);
        return { id, path, action: "unchanged" };
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    if (mode !== undefined)
        chmodSync(path, mode);
    return { id, path, action: existed ? "updated" : "created" };
}

export function isPlexerEntry(entry) {
    return JSON.stringify(entry ?? "").includes("plexer-hooks.cjs");
}

export function readJsonObject(path) {
    if (!existsSync(path))
        return { root: {}, existed: false };
    let root;
    try {
        root = JSON.parse(readFileSync(path, "utf8"));
    }
    catch {
        return "unparseable";
    }
    if (typeof root !== "object" || root === null || Array.isArray(root))
        return "unparseable";
    return { root, existed: true };
}

export function updateJsonConfig(id, path, mutate) {
    const loaded = readJsonObject(path);
    if (loaded === "unparseable")
        return { id, path, action: "skipped-unparseable" };
    const { root, existed } = loaded;
    const before = JSON.stringify(root);
    const next = mutate(root);
    if (next === "unparseable")
        return { id, path, action: "skipped-unparseable" };
    const target = next ?? root;
    if (JSON.stringify(target) === before)
        return { id, path, action: "unchanged" };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(target, null, 2)}\n`);
    return { id, path, action: existed ? "updated" : "created" };
}

export function upsertHookEvents(id, path, entries, buildEntry) {
    return updateJsonConfig(id, path, (root) => {
        const hooks = (root.hooks ??= {});
        if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks))
            return "unparseable";
        for (const d of entries) {
            if (hooks[d.event] !== undefined && !Array.isArray(hooks[d.event]))
                return "unparseable";
            const prior = Array.isArray(hooks[d.event]) ? hooks[d.event] : [];
            hooks[d.event] = [...prior.filter((e) => !isPlexerEntry(e)), buildEntry(d)];
        }
    });
}

export const BIN_LAUNCH = { command: "plexer", args: ["mcp"] };

export function mergeJsonKey(id, path, topKey, entry) {
    return updateJsonConfig(id, path, (root) => {
        const bucket = (root[topKey] ??= {});
        if (typeof bucket !== "object" || bucket === null || Array.isArray(bucket))
            return "unparseable";
        bucket.plexer = entry;
    });
}
