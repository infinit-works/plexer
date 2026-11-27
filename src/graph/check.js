/**
 * `checkGraph` — is the committed `graph.json` still in sync with the code?
 *
 * Deterministic and fast (tree-sitter only, no LLM, no network): it re-runs
 * Tier-1 extraction and diffs the fresh node set against the committed graph by
 * `id` and `body_hash`. Meant for CI — exit non-zero when a PR changed code but
 * didn't rebuild the graph.
 *
 * Drift categories:
 *   added    a definition exists in code but not in graph.json (run `plexer build`)
 *   removed  a node in graph.json no longer exists in code       (run `plexer build`)
 *   changed  a node's body_hash differs from the committed one   (run `plexer build`)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { contextDirFor, wiringPath } from "../context/node-file.js";
import {
    getSqliteMeta,
    openSqliteStore,
    prepareArrayStmt,
    prepareStmt,
    readGraphMetaFromSqlite,
} from "../storage/sqlite-store.js";
import { walkDir } from "../util/fs.js";
import { contentHash } from "../util/id.js";
import { readWalkConfig } from "../util/state.js";
import { computeRepoConfigHash } from "./build.js";
import { listSourceStats } from "./source-files.js";
import { emptyExtractCache, extractSourceFiles, readExtractCache, readExtractCacheStats } from "./extract-cache.js";
import { readFingerprint } from "./fingerprint.js";
export async function checkGraph(dir, opts = {}) {
    const root = resolve(dir);
    const outDir = contextDirFor(root, opts.contextDir);
    const result = {
        ok: false,
        missing: false,
        configStale: false,
        added: [],
        removed: [],
        changed: [],
        stale: [],
        pending: 0,
        pendingIds: [],
        nodes: 0,
    };
    let wiringRaw = null;
    let committed = null;
    let fromSqlite = false;
    const roStore = openSqliteStore(outDir, { create: false, readOnly: true });
    if (roStore) {
        try {
            const sqlMeta = readGraphMetaFromSqlite(roStore);
            if (sqlMeta) {
                const sql = "SELECT id, path, kind, body_hash FROM graph_nodes ORDER BY id";
                const arrStmt = prepareArrayStmt(roStore, sql);
                let lightNodes;
                if (arrStmt) {
                    const rows = arrStmt.all();
                    lightNodes = new Array(rows.length);
                    for (let i = 0; i < rows.length; i++) {
                        const r = rows[i];
                        lightNodes[i] = { id: r[0], path: r[1], kind: r[2], body_hash: r[3] };
                    }
                }
                else {
                    lightNodes = prepareStmt(roStore, sql).all().map((r) => ({ id: r.id, path: r.path, kind: r.kind, body_hash: r.body_hash }));
                }
                committed = { meta: sqlMeta, nodes: lightNodes };
                fromSqlite = true;
            }
        }
        catch {
            committed = null;
            fromSqlite = false;
        }
    }
    if (!committed) {
        try {
            wiringRaw = readFileSync(wiringPath(outDir), "utf8");
            committed = JSON.parse(wiringRaw);
        }
        catch {
            committed = null;
        }
    }
    if (!committed || !Array.isArray(committed.nodes)) {
        result.missing = true;
        return result;
    }
    const fp = readFingerprint(outDir);
    const fpOnlyDirs = fp?.onlyDirs;
    const onlyDirs = fpOnlyDirs && fpOnlyDirs.length > 0 ? new Set(fpOnlyDirs) : undefined;
    const extensions = opts.extensions ?? (Array.isArray(fp?.extensions) && fp.extensions.length > 0 ? fp.extensions : undefined);
    const walkCfg = readWalkConfig(root, opts.contextDir);
    const walked = walkDir(root, walkCfg.includeDirs, {
        followSubmodules: walkCfg.followSubmodules,
        followNestedRepos: walkCfg.followNestedRepos,
    });
    const sourceStats = listSourceStats(root, outDir, walked, onlyDirs, extensions);
    const strict = Boolean(opts.strict) || process.env.PLEXER_REFRESH === "hash";
    let extractedNodes = null;
    if (!strict) {
        const statsInfo = readExtractCacheStats(outDir);
        const store = roStore ?? openSqliteStore(outDir, { create: false, readOnly: true });
        let dbGraphHash = null;
        if (!fromSqlite && store) {
            try {
                dbGraphHash = getSqliteMeta(store, "graph_hash");
            }
            catch {
                dbGraphHash = null;
            }
        }
        const graphHashMatches = fromSqlite || Boolean(dbGraphHash && wiringRaw && dbGraphHash === contentHash(wiringRaw));
        if (statsInfo.source === "sqlite" && graphHashMatches) {
            const seenPaths = new Set();
            const dirtyFiles = [];
            for (const f of sourceStats) {
                seenPaths.add(f.rel);
                const st = statsInfo.stats.get(f.rel);
                if (!st || !st.hash || st.size !== f.size || st.mtimeMs !== f.mtimeMs) {
                    dirtyFiles.push(f);
                }
            }
            let canFastClean = dirtyFiles.length === 0;
            if (canFastClean) {
                const committedPaths = new Set();
                for (let i = 0; i < committed.nodes.length; i++) {
                    const p = committed.nodes[i].path;
                    if (p) {
                        committedPaths.add(p);
                        if (!seenPaths.has(p)) {
                            canFastClean = false;
                            break;
                        }
                    }
                }
                if (canFastClean && committedPaths.size !== seenPaths.size) {
                    canFastClean = false;
                }
            }
            if (canFastClean) {
                result.nodes = committed.nodes.length;
                const currentConfigHash = computeRepoConfigHash(root, committed.nodes, {
                    contextDir: opts.contextDir,
                    onlyDirs,
                    walked,
                });
                if (committed.meta?.config_hash && committed.meta.config_hash !== currentConfigHash) {
                    result.configStale = true;
                    result.stale.push("config_hash");
                }
                result.ok = !result.configStale;
                return result;
            }
            const committedByPath = new Map();
            for (const n of committed.nodes) {
                if (!n?.path)
                    continue;
                let list = committedByPath.get(n.path);
                if (!list) {
                    list = [];
                    committedByPath.set(n.path, list);
                }
                list.push(n);
            }
            const dirtyCheck = [];
            const cleanNodes = [];
            for (const f of sourceStats) {
                const st = statsInfo.stats.get(f.rel);
                if (st && st.hash && st.size === f.size && st.mtimeMs === f.mtimeMs && committedByPath.has(f.rel)) {
                    cleanNodes.push(...committedByPath.get(f.rel));
                }
                else {
                    dirtyCheck.push(f);
                }
            }
            const dirtyExtracted = dirtyCheck.length > 0
                ? (await extractSourceFiles(dirtyCheck, emptyExtractCache(), {
                    trustStat: false,
                    hasRojoProject: walkCfg.manifestMounts?.hasRojoProject,
                    rojoMountPrefixes: walkCfg.manifestMounts?.rojoMountPrefixes,
                })).nodes
                : [];
            extractedNodes = [...cleanNodes, ...dirtyExtracted];
        }
    }
    if (!extractedNodes) {
        const extracted = await extractSourceFiles(sourceStats, readExtractCache(outDir), {
            trustStat: false,
            hasRojoProject: walkCfg.manifestMounts?.hasRojoProject,
            rojoMountPrefixes: walkCfg.manifestMounts?.rojoMountPrefixes,
        });
        extractedNodes = extracted.nodes;
    }
    const current = new Map(extractedNodes.map((n) => [n.id, n.body_hash]));
    const committedById = new Map(committed.nodes.map((n) => [n.id, n]));
    result.nodes = committedById.size;
    for (const [id, node] of committedById) {
        const now = current.get(id);
        if (now === undefined)
            result.removed.push(id);
        else if (now !== node.body_hash)
            result.changed.push(id);
    }
    for (const id of current.keys()) {
        if (!committedById.has(id))
            result.added.push(id);
    }
    for (const arr of [result.added, result.removed, result.changed]) {
        arr.sort();
    }
    const currentConfigHash = computeRepoConfigHash(root, extractedNodes, {
        contextDir: opts.contextDir,
        onlyDirs,
        walked,
    });
    if (committed.meta?.config_hash && committed.meta.config_hash !== currentConfigHash) {
        result.configStale = true;
        result.stale.push("config_hash");
    }
    result.ok =
        !result.configStale &&
            result.added.length === 0 &&
            result.removed.length === 0 &&
            result.changed.length === 0;
    return result;
}
/** Render a graph-check result as a human-readable report. */
export function formatGraphCheckReport(r) {
    if (r.missing) {
        return "graph check: NO GRAPH\n\nNo plexer/.graph/wiring.json found. Run `plexer build` first.";
    }
    if (r.ok) {
        return `graph check: OK — the wiring graph is in sync with the code (${r.nodes} nodes).`;
    }
    const lines = ["graph check: STALE", ""];
    if (r.configStale) {
        lines.push("config (1):", "  ~ resolver config / scopes changed (config_hash mismatch)");
    }
    if (r.changed.length) {
        lines.push(`changed (${r.changed.length}):`);
        for (const id of r.changed)
            lines.push(`  ~ ${id}`);
    }
    if (r.added.length) {
        lines.push(`added (${r.added.length}):`);
        for (const id of r.added)
            lines.push(`  + ${id}`);
    }
    if (r.removed.length) {
        lines.push(`removed (${r.removed.length}):`);
        for (const id of r.removed)
            lines.push(`  - ${id}`);
    }
    lines.push("", "Run `plexer build` to rebuild the structure.");
    return lines.join("\n");
}