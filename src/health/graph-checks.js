/**
 * Structural, coupling, dead-code, wrapper, cohesion, and test-topology detectors
 * operating directly on `plexer`'s `wiring.json` graph + source lines.
 */
import { basename, dirname } from "node:path";
import { analyzeGitHistory } from "../blast/history.js";
import { WALK_RELATIONS } from "../graph/relations.js";
import { linkTestsForGraph } from "../graph/test-links.js";
import { globToRegExp, parseLayerRuleEntry } from "../util/paths.js";
import { spanRange } from "../util/span.js";
import { classifyStemConvention } from "./concerns.js";
import { mintIssueId } from "./state.js";
import { SCORED_ZONES, classifyZone, hasInlineSuppression, isSupportOrBenchFile } from "./zones.js";

export { globToRegExp, parseLayerRuleEntry };

function resolveZone(zoneMap, filePath) {
    if (zoneMap && typeof zoneMap.get === "function" && zoneMap.has(filePath)) {
        return zoneMap.get(filePath);
    }
    if (zoneMap && typeof zoneMap === "object" && !(zoneMap instanceof Map) && zoneMap[filePath]) {
        return zoneMap[filePath];
    }
    return classifyZone(filePath);
}

function matchesFileFilter(fileFilter, filePath) {
    if (!fileFilter) return true;
    if (typeof fileFilter === "function") return Boolean(fileFilter(filePath));
    if (fileFilter instanceof Set) return fileFilter.has(filePath);
    if (Array.isArray(fileFilter)) return fileFilter.includes(filePath);
    return true;
}

const ENTRYPOINT_BASENAME_RE =
    /^(index|main|cli|server|app|mod|lib|init|plugin|setup|__init__|__main__)\.[a-z0-9]+$/i;

const LIFECYCLE_METHOD_NAMES = new Set([
    "constructor",
    "__init__",
    "__new__",
    "__del__",
    "__repr__",
    "__str__",
    "__len__",
    "__iter__",
    "__enter__",
    "__exit__",
    "__getitem__",
    "__setitem__",
    "__contains__",
    "init",
    "start",
    "stop",
    "destroy",
    "cleanup",
    "dispose",
    "render",
    "mount",
    "unmount",
    "main",
    "setup",
    "teardown",
]);

function isEntrypointPath(relPath, fileSymbols = []) {
    const norm = relPath.replace(/\\/g, "/");
    const base = basename(norm);
    if (ENTRYPOINT_BASENAME_RE.test(base)) return true;
    if (norm.startsWith("bin/") || norm.startsWith("cmd/") || norm.startsWith("pages/")) return true;
    // Roblox Script / LocalScript entrypoints (`*.server.luau`, `*.client.luau`, `*.plugin.luau`)
    if (/\.(server|client|plugin)\.(luau|lua)$/i.test(base)) return true;
    if (fileSymbols.some((s) => s.exported && s.name === "main" && s.kind === "function")) return true;
    return false;
}

/**
 * Tarjan's Strongly Connected Components algorithm for finding multi-hop file cycles.
 */
function findStronglyConnectedComponents(adj) {
    let index = 0;
    const indices = new Map();
    const lowlink = new Map();
    const onStack = new Set();
    const stack = [];
    const sccs = [];

    function strongconnect(v) {
        indices.set(v, index);
        lowlink.set(v, index);
        index += 1;
        stack.push(v);
        onStack.add(v);

        const neighbors = adj.get(v) || [];
        for (const w of neighbors) {
            if (!indices.has(w)) {
                strongconnect(w);
                lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w)));
            } else if (onStack.has(w)) {
                lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)));
            }
        }

        if (lowlink.get(v) === indices.get(v)) {
            const comp = [];
            while (stack.length > 0) {
                const w = stack.pop();
                onStack.delete(w);
                comp.push(w);
                if (w === v) break;
            }
            if (comp.length >= 2) {
                sccs.push(comp.sort());
            }
        }
    }

    for (const v of adj.keys()) {
        if (!indices.has(v)) strongconnect(v);
    }
    return sccs;
}

function normalizeGraphShape(graph) {
    if (!graph) return { nodes: [], edges: [] };
    if (Array.isArray(graph.nodes)) {
        const edges = (graph.edges || []).map((e) => ({
            ...e,
            source: e.source ?? e.from ?? e.fromFile,
            target: e.target ?? e.to ?? e.toFile,
            relation: e.relation || "imports",
        }));
        return { ...graph, nodes: graph.nodes, edges };
    }
    const nodes = [];
    for (const f of graph.files || []) {
        nodes.push({
            id: f.id ?? f.path,
            kind: "file",
            path: f.path,
            name: basename(f.path || ""),
            lineCount: f.lineCount,
        });
        for (const sym of f.symbols || []) {
            nodes.push({
                ...sym,
                id: sym.id ?? `${f.path}::${sym.name}`,
                kind: sym.kind || "function",
                path: sym.path || f.path,
                exported: Boolean(sym.exported ?? sym.isExported),
            });
        }
    }
    const edges = (graph.edges || []).map((e) => ({
        ...e,
        source: e.source ?? e.from ?? e.fromFile,
        target: e.target ?? e.to ?? e.toFile,
        relation: e.relation || "imports",
    }));
    return { ...graph, nodes, edges };
}

function buildGraphCheckTopology(rawGraph) {
    const graph = normalizeGraphShape(rawGraph);
    const nodeById = new Map();
    const symbolsByFile = new Map();
    const fileNodes = [];

    for (const node of graph.nodes) {
        nodeById.set(node.id, node);
        if (node.kind === "file") {
            fileNodes.push(node);
        } else {
            let list = symbolsByFile.get(node.path);
            if (!list) {
                list = [];
                symbolsByFile.set(node.path, list);
            }
            list.push(node);
        }
    }

    const incomingByTarget = new Map();
    const outgoingBySource = new Map();
    const fileImportOut = new Map();
    const runtimeFileImportOut = new Map();
    const fileImportIn = new Map();

    const addEdgeMap = (map, k, v) => {
        let s = map.get(k);
        if (!s) {
            s = new Set();
            map.set(k, s);
        }
        s.add(v);
    };

    for (const edge of graph.edges) {
        if (!WALK_RELATIONS.has(edge.relation)) continue;
        addEdgeMap(incomingByTarget, edge.target, edge.source);
        addEdgeMap(outgoingBySource, edge.source, edge.target);

        const srcNode = nodeById.get(edge.source);
        const tgtNode = nodeById.get(edge.target);
        if (srcNode && tgtNode && srcNode.path !== tgtNode.path) {
            addEdgeMap(fileImportOut, srcNode.path, tgtNode.path);
            addEdgeMap(fileImportIn, tgtNode.path, srcNode.path);
            if (edge.typeOnly !== true) {
                addEdgeMap(runtimeFileImportOut, srcNode.path, tgtNode.path);
            }
        }
    }

    return {
        nodeById,
        symbolsByFile,
        fileNodes,
        incomingByTarget,
        outgoingBySource,
        fileImportOut,
        runtimeFileImportOut,
        fileImportIn,
    };
}

function checkDeadSymbolsAndWrappersInFile(fNode, lines, fileSymbols, importers, incomingByTarget, potentials, issues) {
    for (const sym of fileSymbols) {
        if (sym.kind !== "function" && sym.kind !== "method") continue;
        const lowerName = sym.name.toLowerCase();
        if (LIFECYCLE_METHOD_NAMES.has(lowerName) || lowerName.startsWith("test")) continue;

        const range = spanRange(sym.span) || { start: 1, end: 1 };
        if (hasInlineSuppression(lines, range.start, "dead_symbols")) continue;

        const callers = incomingByTarget.get(sym.id) || new Set();
        const externalCallers = [...callers].filter((cid) => cid !== sym.id);

        if (!sym.exported) {
            potentials.dead_symbols += 1;
            if (externalCallers.length === 0) {
                const shortName = sym.name.includes(".") ? sym.name.split(".").pop() : sym.name;
                let nameOccurrences = 0;
                for (let i = 0; i < lines.length && nameOccurrences <= 1; i++) {
                    if (lines[i].includes(shortName)) nameOccurrences += 1;
                }
                if (nameOccurrences <= 1) {
                    issues.push({
                        id: mintIssueId("dead_symbols", fNode.path, sym.name),
                        detector: "dead_symbols",
                        category: "dead",
                        dimension: "code_quality",
                        tier: "T2",
                        confidence: "high",
                        severity: "medium",
                        file: fNode.path,
                        line: range.start,
                        end_line: range.end,
                        span: sym.span,
                        identifier: sym.name,
                        summary: `Unreferenced internal ${sym.kind} \`${sym.name}\` has 0 callers in the graph or enclosing file.`,
                        suggestion: `Delete dead ${sym.kind} \`${sym.name}\` at ${fNode.path}:${sym.span}.`,
                    });
                }
            }
        } else if (!isEntrypointPath(fNode.path, fileSymbols)) {
            potentials.unreferenced_exports += 1;
            if (externalCallers.length === 0 && importers.size === 0) {
                issues.push({
                    id: mintIssueId("unreferenced_exports", fNode.path, sym.name),
                    detector: "unreferenced_exports",
                    category: "dead",
                    dimension: "code_quality",
                    tier: "T2",
                    confidence: "medium",
                    severity: "low",
                    file: fNode.path,
                    line: range.start,
                    end_line: range.end,
                    span: sym.span,
                    identifier: sym.name,
                    summary: `Exported ${sym.kind} \`${sym.name}\` has 0 callers across the repository.`,
                    suggestion: `Remove the unused export or delete \`${sym.name}\` if it is not part of an external public SDK.`,
                });
            }
        }

        potentials.passthrough_wrappers += 1;
        const loc = range.end - range.start + 1;
        if (loc >= 2 && loc <= 5 && externalCallers.length <= 1) {
            const bodySlice = lines
                .slice(range.start - 1, range.end)
                .map((l) => l.trim())
                .filter(Boolean);
            const inner = bodySlice.slice(1, -1).join(" ").trim() || bodySlice[bodySlice.length - 1] || "";
            if (/^return\s+[A-Za-z0-9_.:]+\([^()]*\)\s*;?$/.test(inner) && !sym.exported) {
                issues.push({
                    id: mintIssueId("passthrough_wrappers", fNode.path, sym.name),
                    detector: "passthrough_wrappers",
                    category: "dead",
                    dimension: "code_quality",
                    tier: "T2",
                    confidence: "medium",
                    severity: "low",
                    file: fNode.path,
                    line: range.start,
                    end_line: range.end,
                    span: sym.span,
                    identifier: sym.name,
                    summary: `Single-use pass-through wrapper \`${sym.name}\` (${loc} LOC) forwards directly to another function without transformation.`,
                    suggestion: `Inline \`${sym.name}\` at its call site and call the target function directly.`,
                });
            }
        }
    }
}

function checkFacadeModuleInFile(fNode, lines, fileSymbols, issues) {
    if (lines.length < 6 || isEntrypointPath(fNode.path)) return;
    const nonEmpty = lines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//") && !l.startsWith("#") && !l.startsWith("--"));
    const reexportCount = nonEmpty.filter((l) =>
        /^(export\s+\*|export\s+\{.*\}\s+from|from\s+\S+\s+import|__all__\s*=)/.test(l),
    ).length;
    if (
        nonEmpty.length >= 4 &&
        reexportCount / nonEmpty.length >= 0.7 &&
        fileSymbols.filter((s) => s.kind === "function" || s.kind === "class").length === 0
    ) {
        issues.push({
            id: mintIssueId("facade_modules", fNode.path, "facade"),
            detector: "facade_modules",
            category: "dead",
            dimension: "code_quality",
            tier: "T3",
            confidence: "medium",
            severity: "low",
            file: fNode.path,
            line: 1,
            end_line: lines.length,
            span: `L1-L${lines.length}`,
            identifier: basename(fNode.path),
            summary: `Pure re-export facade (${Math.round((reexportCount / nonEmpty.length) * 100)}% re-export lines) adds indirection without domain logic.`,
            suggestion: `Import symbols directly from their defining module and remove the ${fNode.path} facade.`,
        });
    }
}

function checkDeadAndWrapperIssues(ctx, readLines, zoneMap, ignoreRules, potentials, issues) {
    const { nodeById, symbolsByFile, fileNodes, incomingByTarget, fileImportIn } = ctx;
    for (const fNode of fileNodes) {
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (ignoreRules.isIgnored(fNode.path, "dead")) continue;

        const lines = readLines(fNode.path) || [];
        const fileLoc = lines.length;
        const importers = new Set(fileImportIn.get(fNode.path) || []);
        const fileSymbols = symbolsByFile.get(fNode.path) || [];

        for (const sym of fileSymbols) {
            for (const callerId of incomingByTarget.get(sym.id) || []) {
                const callerNode = nodeById.get(callerId);
                if (callerNode && callerNode.path !== fNode.path) {
                    importers.add(callerNode.path);
                }
            }
        }

        potentials.orphaned_files += 1;
        potentials.single_importer_files += 1;
        potentials.facade_modules += 1;

        if (importers.size === 0 && !isEntrypointPath(fNode.path, fileSymbols) && fileSymbols.length > 0) {
            if (!hasInlineSuppression(lines, 1, "orphaned_files")) {
                issues.push({
                    id: mintIssueId("orphaned_files", fNode.path, "orphan"),
                    detector: "orphaned_files",
                    category: "dead",
                    dimension: "code_quality",
                    tier: "T2",
                    confidence: "high",
                    severity: "medium",
                    file: fNode.path,
                    line: 1,
                    end_line: Math.max(1, fileLoc),
                    span: `L1-L${Math.max(1, fileLoc)}`,
                    identifier: basename(fNode.path),
                    summary: `Orphaned module (${fileLoc} LOC, ${fileSymbols.length} symbols) has 0 incoming imports or cross-file callers.`,
                    suggestion: `Delete ${fNode.path} if obsolete, or wire it into its intended caller.`,
                });
            }
        } else if (
            importers.size === 1 &&
            fileLoc > 0 &&
            fileLoc < 90 &&
            fileSymbols.length <= 2 &&
            !isEntrypointPath(fNode.path, fileSymbols) &&
            !hasInlineSuppression(lines, 1, "single_importer_files")
        ) {
            const soleImporter = [...importers][0];
            issues.push({
                id: mintIssueId("single_importer_files", fNode.path, "single_importer"),
                detector: "single_importer_files",
                category: "dead",
                dimension: "code_quality",
                tier: "T3",
                confidence: "low",
                severity: "low",
                file: fNode.path,
                line: 1,
                end_line: fileLoc,
                span: `L1-L${fileLoc}`,
                identifier: basename(fNode.path),
                summary: `Micro-module (${fileLoc} LOC, ${fileSymbols.length} symbol(s)) is only imported by ${soleImporter}.`,
                suggestion: `Consider inlining ${fNode.path} into ${soleImporter} if it does not represent an independent domain boundary.`,
            });
        }

        checkFacadeModuleInFile(fNode, lines, fileSymbols, issues);
        checkDeadSymbolsAndWrappersInFile(fNode, lines, fileSymbols, importers, incomingByTarget, potentials, issues);
    }
}

function buildRuntimeScoredFileAdj(rawGraph, zoneMap = null, fileFilter = null) {
    const graph = normalizeGraphShape(rawGraph);
    const nodeById = new Map((graph.nodes || []).map((n) => [n.id, n]));
    const adj = new Map();
    for (const n of graph.nodes || []) {
        if (n.kind !== "file") continue;
        const z = resolveZone(zoneMap, n.path);
        if (!SCORED_ZONES.has(z)) continue;
        if (!matchesFileFilter(fileFilter, n.path)) continue;
        adj.set(n.path, new Set());
    }
    for (const e of graph.edges || []) {
        if (e.typeOnly === true) continue;
        if (!WALK_RELATIONS.has(e.relation)) continue;
        const sNode = nodeById.get(e.source);
        const tNode = nodeById.get(e.target);
        const sPath = sNode?.path || (adj.has(e.source) ? e.source : null);
        const tPath = tNode?.path || (adj.has(e.target) ? e.target : null);
        if (!sPath || !tPath || sPath === tPath) continue;
        if (!adj.has(sPath)) continue;
        const tZone = resolveZone(zoneMap, tPath);
        if (!SCORED_ZONES.has(tZone)) continue;
        adj.get(sPath).add(tPath);
    }
    const out = new Map();
    for (const [k, set] of adj.entries()) {
        out.set(k, [...set]);
    }
    return out;
}

/**
 * Detect circular file dependencies (`file_cycles`), skipping `e.typeOnly === true` edges.
 */
export function detectCircularDeps(graphOrAdj, zoneMap = null, fileFilter = null) {
    const adj =
        graphOrAdj instanceof Map
            ? graphOrAdj
            : buildRuntimeScoredFileAdj(graphOrAdj, zoneMap, fileFilter);
    const sccs = findStronglyConnectedComponents(adj);
    const out = [];
    for (const comp of sccs) {
        if (fileFilter && !comp.some((f) => matchesFileFilter(fileFilter, f))) continue;
        const primary = comp[0];
        const cycleChain = [...comp, comp[0]].join(" → ");
        out.push({
            id: mintIssueId("file_cycles", primary, `cycle_${comp.length}`),
            detector: "file_cycles",
            category: "coupling",
            dimension: "security",
            tier: "T4",
            confidence: "high",
            severity: comp.length >= 3 ? "high" : "medium",
            file: primary,
            line: 1,
            end_line: 1,
            span: "L1-L1",
            identifier: `${comp.length}-file cycle`,
            cycle: comp,
            summary: `Circular file dependency cycle (${comp.length} files): ${cycleChain}`,
            suggestion: `Break the cycle by extracting shared types/helpers into a leaf module or inverting one dependency edge in ${cycleChain}.`,
        });
    }
    return out;
}

/**
 * Detect reciprocal directory cycles (`directory_cycles`), skipping `e.typeOnly === true` edges.
 */
export function detectDirectoryCycles(graphOrAdj, zoneMap = null, fileFilter = null) {
    const adj =
        graphOrAdj instanceof Map
            ? graphOrAdj
            : buildRuntimeScoredFileAdj(graphOrAdj, zoneMap, fileFilter);
    const dirEdges = new Map();
    for (const [srcFile, targets] of adj.entries()) {
        const srcDir = dirname(srcFile);
        if (srcDir === ".") continue;
        for (const tgtFile of targets) {
            const tgtDir = dirname(tgtFile);
            if (tgtDir === "." || tgtDir === srcDir) continue;
            const key = `${srcDir} -> ${tgtDir}`;
            dirEdges.set(key, (dirEdges.get(key) || 0) + 1);
        }
    }
    const out = [];
    const seenDirPairs = new Set();
    for (const [key, abCount] of dirEdges.entries()) {
        const [dirA, dirB] = key.split(" -> ");
        const pairKey = [dirA, dirB].sort().join("<->");
        if (seenDirPairs.has(pairKey)) continue;
        const baCount = dirEdges.get(`${dirB} -> ${dirA}`) || 0;
        if (baCount > 0) {
            seenDirPairs.add(pairKey);
            out.push({
                id: mintIssueId("directory_cycles", dirA, basename(dirB)),
                detector: "directory_cycles",
                category: "coupling",
                dimension: "security",
                tier: "T4",
                confidence: "high",
                severity: "medium",
                file: dirA,
                line: 1,
                end_line: 1,
                span: "L1-L1",
                identifier: `${dirA} <-> ${dirB}`,
                summary: `Reciprocal directory coupling between \`${dirA}\` (${abCount} edges) and \`${dirB}\` (${baCount} edges).`,
                suggestion: `Establish a one-way layering direction between \`${dirA}\` and \`${dirB}\` or move shared contracts into a common lower-level directory.`,
            });
        }
    }
    return out;
}

function checkCycleAndDirectoryCouplingIssues(runtimeScoredFileAdj, potentials, issues) {
    potentials.file_cycles = Math.max(1, runtimeScoredFileAdj.size);
    const fileCycleIssues = detectCircularDeps(runtimeScoredFileAdj);
    issues.push(...fileCycleIssues);

    const dirCycleIssues = detectDirectoryCycles(runtimeScoredFileAdj);
    potentials.directory_cycles = Math.max(1, runtimeScoredFileAdj.size);
    issues.push(...dirCycleIssues);
}

function checkImportAffinityIssues(scoredFileAdj, fileImportIn, zoneMap, potentials, issues) {
    for (const [filePath, outs] of scoredFileAdj.entries()) {
        potentials.import_affinity_outliers += 1;
        const ownDir = dirname(filePath);
        if (ownDir === ".") continue;
        const ins = [...(fileImportIn.get(filePath) || [])].filter((s) =>
            SCORED_ZONES.has(zoneMap.get(s) || "production"),
        );
        const allPeers = [...outs, ...ins];
        if (allPeers.length < 4) continue;
        const byDir = new Map();
        for (const p of allPeers) {
            const d = dirname(p);
            byDir.set(d, (byDir.get(d) || 0) + 1);
        }
        if ((byDir.get(ownDir) || 0) > 0) continue;
        for (const [peerDir, count] of byDir.entries()) {
            if (peerDir === ownDir || peerDir === ".") continue;
            const ratio = count / allPeers.length;
            if (ratio >= 0.7 && count >= 4) {
                issues.push({
                    id: mintIssueId("import_affinity_outliers", filePath, basename(peerDir)),
                    detector: "import_affinity_outliers",
                    category: "coupling",
                    dimension: "code_quality",
                    tier: "T3",
                    confidence: "medium",
                    severity: "low",
                    file: filePath,
                    line: 1,
                    end_line: 1,
                    span: "L1-L1",
                    identifier: basename(filePath),
                    summary: `Import affinity outlier: ${Math.round(ratio * 100)}% (${count}/${allPeers.length}) of \`${filePath}\`'s edges connect to \`${peerDir}/\` (0 in \`${ownDir}/\`).`,
                    suggestion: `Consider moving \`${filePath}\` into \`${peerDir}/\` using \`plexer health move ${filePath} ${peerDir}/${basename(filePath)}\`.`,
                });
                break;
            }
        }
    }
}

const THIN_WRAPPER_DIR_NAMES = new Set([
    "utils",
    "util",
    "helpers",
    "helper",
    "common",
    "shared",
    "core",
    "internal",
    "misc",
]);

function collectTrackedDirectoryHierarchy(fileNodes, zoneMap) {
    const filesByDir = new Map();
    const childDirsByParent = new Map();
    const allTrackedDirs = new Set();

    for (const fNode of fileNodes) {
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        const d = dirname(fNode.path);
        let arr = filesByDir.get(d);
        if (!arr) {
            arr = [];
            filesByDir.set(d, arr);
        }
        arr.push(fNode.path);

        const parts = d === "." ? [] : d.split("/");
        for (let idx = 0; idx < parts.length; idx++) {
            const curDir = parts.slice(0, idx + 1).join("/");
            allTrackedDirs.add(curDir);
            const parentDir = idx === 0 ? "." : parts.slice(0, idx).join("/");
            allTrackedDirs.add(parentDir);
            let children = childDirsByParent.get(parentDir);
            if (!children) {
                children = new Set();
                childDirsByParent.set(parentDir, children);
            }
            children.add(curDir);
        }
    }
    return { filesByDir, childDirsByParent, allTrackedDirs };
}

function checkDirectoryShapeIssues(fileNodes, zoneMap, potentials, issues) {
    const { filesByDir, childDirsByParent, allTrackedDirs } = collectTrackedDirectoryHierarchy(fileNodes, zoneMap);

    potentials.flat_dirs = Math.max(1, allTrackedDirs.size || filesByDir.size);
    for (const dir of [...allTrackedDirs].sort()) {
        const list = filesByDir.get(dir) || [];
        const directChildren = [...(childDirsByParent.get(dir) || [])];
        const fileCount = list.length;
        const childDirCount = directChildren.length;
        const combinedScore = fileCount + 3 * childDirCount;
        const repFile = list[0] || (filesByDir.get(directChildren[0]) || [])[0] || dir;

        if (fileCount > 25 || (fileCount >= 12 && childDirCount >= 10 && combinedScore >= 35)) {
            issues.push({
                id: mintIssueId("flat_dirs", dir, "overloaded_dir"),
                detector: "flat_dirs",
                category: "coupling",
                dimension: "file_health",
                tier: "T4",
                confidence: "medium",
                severity: "low",
                file: repFile,
                line: 1,
                end_line: 1,
                span: "L1-L1",
                identifier: dir,
                kind: "overload",
                summary: `Flat directory \`${dir}/\` holds ${fileCount} production files and ${childDirCount} subdirectories (combined fan-out score ${combinedScore}).`,
                suggestion: `Group cohesive domains inside \`${dir}/\` into focused subdirectories using \`plexer health move\`.`,
            });
            continue;
        }

        if (childDirCount >= 4) {
            const sparseChildren = directChildren.filter(
                (cd) => (filesByDir.get(cd) || []).length <= 1 && (childDirsByParent.get(cd) || new Set()).size === 0,
            );
            if (sparseChildren.length >= 4 && sparseChildren.length / childDirCount >= 0.7) {
                issues.push({
                    id: mintIssueId("flat_dirs", dir, "fragmented_dir"),
                    detector: "flat_dirs",
                    category: "coupling",
                    dimension: "file_health",
                    tier: "T3",
                    confidence: "medium",
                    severity: "low",
                    file: repFile,
                    line: 1,
                    end_line: 1,
                    span: "L1-L1",
                    identifier: "fragmented_dir",
                    kind: "fragmentation",
                    summary: `Fragmented directory \`${dir}/\` has ${sparseChildren.length}/${childDirCount} child directories holding <= 1 file each.`,
                    suggestion: `Consolidate sparse single-file subdirectories under \`${dir}/\` into cohesive modules.`,
                });
                continue;
            }
        }

        if (dir !== ".") {
            const dirBase = basename(dir).toLowerCase();
            const parentDir = dirname(dir);
            const parentSiblingCount =
                (filesByDir.get(parentDir) || []).length + (childDirsByParent.get(parentDir) || new Set()).size;
            if (THIN_WRAPPER_DIR_NAMES.has(dirBase) && fileCount === 1 && childDirCount === 0 && parentSiblingCount >= 5) {
                issues.push({
                    id: mintIssueId("flat_dirs", dir, "thin_wrapper_dir"),
                    detector: "flat_dirs",
                    category: "coupling",
                    dimension: "file_health",
                    tier: "T3",
                    confidence: "medium",
                    severity: "low",
                    file: repFile,
                    line: 1,
                    end_line: 1,
                    span: "L1-L1",
                    identifier: "thin_wrapper_dir",
                    kind: "thin_wrapper",
                    summary: `Thin wrapper directory \`${dir}/\` contains only 1 file (\`${basename(repFile)}\`) inside \`${parentDir}/\`.`,
                    suggestion: `Move \`${repFile}\` directly into \`${parentDir}/\` or its sole domain consumer using \`plexer health move\`.`,
                });
            }
        }
    }

    return filesByDir;
}

function checkPrivateSymbolAccessIssues(ctx, zoneMap, ignoreRules, potentials, issues) {
    const { nodeById, symbolsByFile, fileNodes, incomingByTarget } = ctx;
    const seenPrivatePairs = new Set();
    for (const fNode of fileNodes) {
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (ignoreRules.isIgnored(fNode.path, "coupling")) continue;
        const fileSymbols = symbolsByFile.get(fNode.path) || [];
        for (const sym of fileSymbols) {
            const name = sym.name || "";
            if (!name.startsWith("_") || (name.startsWith("__") && name.endsWith("__"))) continue;
            if (name === "_" || name === "_G" || name === "_VERSION") continue;
            potentials.private_imports += 1;
            const targetDir = dirname(fNode.path);
            for (const callerId of incomingByTarget.get(sym.id) || []) {
                const callerNode = nodeById.get(callerId);
                if (!callerNode || callerNode.path === fNode.path) continue;
                const callerZone = zoneMap.get(callerNode.path) || "production";
                if (!SCORED_ZONES.has(callerZone)) continue;
                if (dirname(callerNode.path) === targetDir) continue;
                const pairKey = `${callerNode.path}::${sym.id}`;
                if (seenPrivatePairs.has(pairKey)) continue;
                seenPrivatePairs.add(pairKey);
                const callerRange = spanRange(callerNode.span) || { start: 1, end: 1 };
                issues.push({
                    id: mintIssueId("private_imports", callerNode.path, `${name}_from_${basename(fNode.path)}`),
                    detector: "private_imports",
                    category: "coupling",
                    dimension: "code_quality",
                    tier: "T3",
                    confidence: "medium",
                    severity: "medium",
                    file: callerNode.path,
                    line: callerRange.start,
                    end_line: callerRange.end,
                    span: callerNode.span || "L1-L1",
                    identifier: name,
                    summary: `Cross-package private symbol access: \`${callerNode.path}\` imports/calls private symbol \`${name}\` from \`${fNode.path}\`.`,
                    suggestion: `Promote \`${name}\` in \`${fNode.path}\` to a public API (remove leading \`_\`) or keep it encapsulated within \`${targetDir}/\`.`,
                });
            }
        }
    }
}

function checkNamingInconsistencyIssues(filesByDir, potentials, issues) {
    potentials.naming_inconsistencies = Math.max(1, filesByDir.size);
    for (const [dir, list] of filesByDir.entries()) {
        if (list.length < 7) continue;
        const convBuckets = new Map();
        for (const filePath of list) {
            const base = basename(filePath);
            if (ENTRYPOINT_BASENAME_RE.test(base)) continue;
            const conv = classifyStemConvention(base);
            if (!conv) continue;
            let cList = convBuckets.get(conv);
            if (!cList) {
                cList = [];
                convBuckets.set(conv, cList);
            }
            cList.push(base);
        }
        if (convBuckets.size < 2) continue;
        const sortedConvs = [...convBuckets.entries()].sort((a, b) => b[1].length - a[1].length);
        const [majName, majFiles] = sortedConvs[0];
        const totalConvFiles = sortedConvs.reduce((s, [, fs]) => s + fs.length, 0);
        for (const [minName, minFiles] of sortedConvs.slice(1)) {
            if (minFiles.length >= 5 && minFiles.length / totalConvFiles >= 0.15) {
                issues.push({
                    id: mintIssueId("naming_inconsistencies", dir, `${majName}_vs_${minName}`),
                    detector: "naming_inconsistencies",
                    category: "coupling",
                    dimension: "file_health",
                    tier: "T3",
                    confidence: "medium",
                    severity: "low",
                    file: list[0],
                    line: 1,
                    end_line: 1,
                    span: "L1-L1",
                    identifier: `${dir} (${minName})`,
                    summary: `Directory \`${dir}/\` mixes filename conventions: ${majFiles.length} \`${majName}\` vs ${minFiles.length} \`${minName}\` (${minFiles.slice(0, 5).join(", ")}).`,
                    suggestion: `Standardize filenames in \`${dir}/\` on \`${majName}\` using \`plexer health move\`.`,
                });
            }
        }
    }
}

function checkLowCohesionInFile(fNode, lines, funcs, classes, outgoingBySource, potentials, issues) {
    potentials.low_cohesion_files += 1;
    if (lines.length <= 250 || funcs.length < 6 || classes.length > 0) return;

    const funcIds = new Set(funcs.map((f) => f.id));
    const adj = new Map();
    for (const id of funcIds) adj.set(id, new Set());
    for (const id of funcIds) {
        for (const tgt of outgoingBySource.get(id) || []) {
            if (funcIds.has(tgt) && tgt !== id) {
                adj.get(id).add(tgt);
                adj.get(tgt).add(id);
            }
        }
    }
    const visited = new Set();
    let components = 0;
    for (const id of funcIds) {
        if (visited.has(id)) continue;
        components += 1;
        const queue = [id];
        visited.add(id);
        while (queue.length > 0) {
            const cur = queue.pop();
            for (const nb of adj.get(cur) || []) {
                if (!visited.has(nb)) {
                    visited.add(nb);
                    queue.push(nb);
                }
            }
        }
    }
    if (components >= 4 && components / funcs.length >= 0.65) {
        issues.push({
            id: mintIssueId("low_cohesion_files", fNode.path, "cohesion"),
            detector: "low_cohesion_files",
            category: "cohesion",
            dimension: "file_health",
            tier: "T4",
            confidence: "medium",
            severity: "low",
            file: fNode.path,
            line: 1,
            end_line: lines.length,
            span: `L1-L${lines.length}`,
            identifier: basename(fNode.path),
            summary: `Low intra-file cohesion: \`${fNode.path}\` (${lines.length} LOC, ${funcs.length} functions) splits into ${components} disconnected call-graph components.`,
            suggestion: `Split unrelated function groups in \`${fNode.path}\` into focused domain modules.`,
        });
    }
}

function checkClassCohesionInFile(fNode, lines, funcs, classes, potentials, issues) {
    for (const cls of classes) {
        potentials.god_classes += 1;
        potentials.delegation_heavy_classes += 1;
        const range = spanRange(cls.span);
        if (!range) continue;
        const clsLoc = range.end - range.start + 1;
        const methods = funcs.filter((fn) => {
            const r = spanRange(fn.span);
            return r && r.start >= range.start && r.end <= range.end;
        });
        if ((methods.length > 15 || clsLoc > 500) && !hasInlineSuppression(lines, range.start, "god_classes")) {
            issues.push({
                id: mintIssueId("god_classes", fNode.path, cls.name),
                detector: "god_classes",
                category: "cohesion",
                dimension: "file_health",
                tier: "T4",
                confidence: "high",
                severity: "medium",
                file: fNode.path,
                line: range.start,
                end_line: range.end,
                span: cls.span,
                identifier: cls.name,
                summary: `God ${cls.kind} \`${cls.name}\` spans ${clsLoc} LOC with ${methods.length} methods.`,
                suggestion: `Split \`${cls.name}\` along distinct state and responsibility seams.`,
            });
        }

        if (methods.length >= 4) {
            let delegatingCount = 0;
            for (const m of methods) {
                const r = spanRange(m.span);
                if (!r || r.end - r.start + 1 > 6) continue;
                const bodyText = lines.slice(r.start - 1, r.end).join(" ");
                if (/\b(?:return\s+)?(?:this|self)\.[A-Za-z0-9_]+[.:][A-Za-z0-9_]+\(/.test(bodyText)) {
                    delegatingCount += 1;
                }
            }
            const ratio = delegatingCount / methods.length;
            if (ratio > 0.5 && delegatingCount >= 3) {
                issues.push({
                    id: mintIssueId("delegation_heavy_classes", fNode.path, cls.name),
                    detector: "delegation_heavy_classes",
                    category: "cohesion",
                    dimension: "code_quality",
                    tier: "T3",
                    confidence: "medium",
                    severity: "medium",
                    file: fNode.path,
                    line: range.start,
                    end_line: range.end,
                    span: cls.span,
                    identifier: cls.name,
                    summary: `Middle-man class \`${cls.name}\` forwards ${delegatingCount}/${methods.length} (${Math.round(ratio * 100)}%) of its methods directly to an inner delegate.`,
                    suggestion: `Expose the underlying component directly or collapse the forwarding wrapper methods on \`${cls.name}\`.`,
                });
            }
        }
    }
}

function checkMonsterAndClassCohesionIssues(ctx, readLines, zoneMap, ignoreRules, potentials, issues) {
    const { symbolsByFile, fileNodes, outgoingBySource } = ctx;
    for (const fNode of fileNodes) {
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (ignoreRules.isIgnored(fNode.path, "cohesion")) continue;

        const lines = readLines(fNode.path) || [];
        const fileSymbols = symbolsByFile.get(fNode.path) || [];
        const funcs = fileSymbols.filter((s) => s.kind === "function" || s.kind === "method");
        const classes = fileSymbols.filter((s) => s.kind === "class" || s.kind === "struct");

        for (const fn of funcs) {
            potentials.monster_functions += 1;
            const range = spanRange(fn.span);
            if (!range) continue;
            const loc = range.end - range.start + 1;
            if (loc > 100 && !hasInlineSuppression(lines, range.start, "monster_functions")) {
                issues.push({
                    id: mintIssueId("monster_functions", fNode.path, fn.name),
                    detector: "monster_functions",
                    category: "cohesion",
                    dimension: "file_health",
                    tier: "T3",
                    confidence: "high",
                    severity: loc > 180 ? "high" : "medium",
                    file: fNode.path,
                    line: range.start,
                    end_line: range.end,
                    span: fn.span,
                    identifier: fn.name,
                    summary: `Monster ${fn.kind} \`${fn.name}\` spans ${loc} LOC (${fNode.path}:${fn.span}).`,
                    suggestion: `Decompose \`${fn.name}\` into smaller single-responsibility helpers with early guard clauses.`,
                });
            }
        }

        checkClassCohesionInFile(fNode, lines, funcs, classes, potentials, issues);
        checkLowCohesionInFile(fNode, lines, funcs, classes, outgoingBySource, potentials, issues);
    }
}

function checkSignatureVarianceIssues(ctx, readLines, zoneMap, ignoreRules, potentials, issues) {
    const { symbolsByFile, fileNodes } = ctx;
    const fnsByName = new Map();
    let totalFnsChecked = 0;

    for (const fNode of fileNodes) {
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (ignoreRules.isIgnored(fNode.path, "cohesion")) continue;
        const lines = readLines(fNode.path) || [];
        const fileSymbols = symbolsByFile.get(fNode.path) || [];

        for (const sym of fileSymbols) {
            if (sym.kind !== "function") continue;
            const name = sym.name;
            if (!name || name.startsWith("_") || name.toLowerCase().startsWith("test")) continue;
            if (LIFECYCLE_METHOD_NAMES.has(name.toLowerCase())) continue;
            if (
                ["get", "post", "put", "delete", "patch", "handle", "run", "configure", "new"].includes(
                    name.toLowerCase(),
                )
            ) {
                continue;
            }

            const range = spanRange(sym.span);
            const defLine = range ? lines[range.start - 1] || "" : sym.signature || "";
            const parenMatch = /\(([^)]*)\)/.exec(defLine);
            if (!parenMatch) continue;
            const rawParams = parenMatch[1]
                .split(",")
                .map((p) =>
                    p
                        .trim()
                        .replace(/:.*$/, "")
                        .replace(/=.*$/, "")
                        .trim(),
                )
                .filter((p) => p && p !== "self" && p !== "cls" && p !== "this");

            totalFnsChecked += 1;
            let group = fnsByName.get(name);
            if (!group) {
                group = [];
                fnsByName.set(name, group);
            }
            group.push({
                file: fNode.path,
                line: range ? range.start : 1,
                span: sym.span || "L1-L1",
                params: rawParams,
                sigKey: `${rawParams.length}:${rawParams.join(",")}`,
            });
        }
    }

    potentials.signature_variance = Math.max(1, totalFnsChecked);
    for (const [fnName, entries] of fnsByName.entries()) {
        const distinctFiles = new Set(entries.map((e) => e.file));
        if (distinctFiles.size < 3) continue;
        const distinctSigs = new Set(entries.map((e) => e.sigKey));
        if (distinctSigs.size < 2) continue;

        const primary = entries[0];
        const variantDesc = entries
            .slice(0, 4)
            .map((e) => `${e.file}:L${e.line}(${e.params.join(", ")})`)
            .join("; ");
        issues.push({
            id: mintIssueId("signature_variance", primary.file, fnName),
            detector: "signature_variance",
            category: "cohesion",
            dimension: "code_quality",
            tier: "T3",
            confidence: "medium",
            severity: "low",
            file: primary.file,
            line: primary.line,
            end_line: primary.line,
            span: primary.span,
            identifier: fnName,
            variants: entries,
            summary: `Function \`${fnName}\` is defined across ${distinctFiles.size} files with ${distinctSigs.size} different parameter signatures (${variantDesc}).`,
            suggestion: `Unify \`${fnName}\` onto a consistent parameter contract or rename divergent helpers to reflect their distinct roles.`,
        });
    }
}

/**
 * Detect high-fan-in production hubs that lack covering tests (`symbol_call`, `module_import`, or `stem_companion`).
 */
export function detectUntestedHubs(rawGraph, zoneMap = null, config = null, fileFilter = null, ctx = null, ignoreRules = null, potentials = null) {
    const graph = normalizeGraphShape(rawGraph);
    const topo = ctx || buildGraphCheckTopology(graph);
    const { nodeById, symbolsByFile, fileNodes, incomingByTarget, fileImportIn } = topo;
    const testLinks = linkTestsForGraph(graph);
    const minProdImporters = Number(config?.untested_hub_threshold ?? config?.min_hub_importers ?? 6);
    const found = [];

    for (const fNode of fileNodes) {
        const zone = resolveZone(zoneMap, fNode.path);
        if (zone !== "production") continue;
        if (ignoreRules && ignoreRules.isIgnored(fNode.path, "tests")) continue;
        if (!matchesFileFilter(fileFilter, fNode.path)) continue;

        if (potentials) potentials.untested_hubs += 1;
        const importers = [...(fileImportIn.get(fNode.path) || [])];
        const fileSymbols = symbolsByFile.get(fNode.path) || [];
        for (const sym of fileSymbols) {
            for (const callerId of incomingByTarget.get(sym.id) || []) {
                const callerNode = nodeById.get(callerId);
                if (callerNode && callerNode.path !== fNode.path) {
                    importers.push(callerNode.path);
                }
            }
        }
        const uniqueImporters = [...new Set(importers)];
        const prodImporters = uniqueImporters.filter((p) => resolveZone(zoneMap, p) === "production");
        const testImporters = uniqueImporters.filter((p) => resolveZone(zoneMap, p) === "test");
        const linkedTests = testLinks.testsForFile(fNode.path);

        if (prodImporters.length >= minProdImporters && testImporters.length === 0 && linkedTests.length === 0) {
            found.push({
                id: mintIssueId("untested_hubs", fNode.path, "untested_hub"),
                detector: "untested_hubs",
                category: "tests",
                dimension: "test_health",
                tier: "T3",
                confidence: "medium",
                severity: prodImporters.length >= 10 ? "high" : "medium",
                file: fNode.path,
                line: 1,
                end_line: 1,
                span: "L1-L1",
                identifier: basename(fNode.path),
                summary: `High-fan-in production hub \`${fNode.path}\` (${prodImporters.length} production dependents) has 0 direct test callers, module imports, or companion test files.`,
                suggestion: `Add unit tests covering the core contracts and edge cases of \`${fNode.path}\`.`,
            });
        }
    }
    return found;
}

function checkTestHealthIssues(graph, ctx, readLines, zoneMap, ignoreRules, config, potentials, issues) {
    const { fileNodes } = ctx;
    const testFiles = fileNodes.filter(
        (f) => resolveZone(zoneMap, f.path) === "test" && !isSupportOrBenchFile(f.path),
    );
    if (testFiles.length > 0) {
        const hubIssues = detectUntestedHubs(graph, zoneMap, config, null, ctx, ignoreRules, potentials);
        issues.push(...hubIssues);
    }

    const ASSERT_RE =
        /\b(assert|expect|should|check|verify|require\.|assert\.|assertEqual|assert_eq|assert_ne|toBe|toEqual|toThrow|rejects|resolves|t\.Error|t\.Fatal)\b/i;
    for (const tNode of testFiles) {
        if (ignoreRules.isIgnored(tNode.path, "tests")) continue;
        potentials.hollow_tests += 1;
        const lines = readLines(tNode.path) || [];
        if (lines.length < 5) continue;
        const hasAssertion = lines.some((l) => ASSERT_RE.test(l));
        if (!hasAssertion && !hasInlineSuppression(lines, 1, "hollow_tests")) {
            issues.push({
                id: mintIssueId("hollow_tests", tNode.path, "hollow_test"),
                detector: "hollow_tests",
                category: "tests",
                dimension: "test_health",
                tier: "T2",
                confidence: "high",
                severity: "medium",
                file: tNode.path,
                line: 1,
                end_line: lines.length,
                span: `L1-L${lines.length}`,
                identifier: basename(tNode.path),
                summary: `Test file \`${tNode.path}\` (${lines.length} LOC) contains 0 assertions (\`assert\`, \`expect\`, \`toBe\`, etc.).`,
                suggestion: `Add behavioral assertions to \`${tNode.path}\` or move it to a fixtures/helpers directory if it is not a test spec.`,
            });
        }
    }
}

function classifyRobloxLayer(relPath) {
    const norm = relPath.replace(/\\/g, "/");
    if (
        /(?:^|\/)(?:Server|ServerScriptService|ServerStorage)\//i.test(norm) ||
        /\.server\.(?:luau|lua)$/i.test(norm)
    ) {
        return "server";
    }
    if (
        /(?:^|\/)(?:Client|StarterPlayer|StarterPlayerScripts|StarterCharacterScripts|StarterGui|ReplicatedFirst)\//i.test(
            norm,
        ) ||
        /\.client\.(?:luau|lua)$/i.test(norm)
    ) {
        return "client";
    }
    if (/(?:^|\/)(?:Shared|ReplicatedStorage)\//i.test(norm)) {
        return "shared";
    }
    return null;
}

function classifyConventionalLayer(relPath) {
    const norm = relPath.replace(/\\/g, "/");
    if (/^(?:src\/)?(?:util|utils|base|common)\//i.test(norm)) {
        return { rank: 0, label: "foundational leaf (util/base)" };
    }
    if (/^(?:bin|cli|app|src\/(?:cli|app|hosts|viewer|commands))\//i.test(norm)) {
        return { rank: 2, label: "top-level entrypoint/UI (bin/cli/app/hosts/viewer)" };
    }
    return null;
}

function matchConfiguredLayerIndex(relPath, layers) {
    const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
    for (let i = 0; i < layers.length; i++) {
        const prefix = String(layers[i] || "")
            .trim()
            .replace(/\\/g, "/")
            .replace(/^\.\//, "")
            .replace(/\/+$/, "");
        if (!prefix) continue;
        if (norm === prefix || norm.startsWith(`${prefix}/`) || norm.includes(`/${prefix}/`)) {
            return { index: i, prefix };
        }
    }
    return null;
}

function checkLayerViolationIssues(scoredFileAdj, config, ignoreRules, potentials, issues) {
    potentials.layer_violation = Math.max(1, scoredFileAdj.size);
    const configuredLayers = Array.isArray(config?.layers)
        ? config.layers
        : typeof config?.layers === "string"
          ? config.layers
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
          : [];

    for (const [srcFile, targets] of scoredFileAdj.entries()) {
        if (ignoreRules.isIgnored(srcFile, "layer_violation")) continue;
        const srcCustom = configuredLayers.length >= 2 ? matchConfiguredLayerIndex(srcFile, configuredLayers) : null;
        const srcRoblox = classifyRobloxLayer(srcFile);
        const srcConv = classifyConventionalLayer(srcFile);

        for (const tgtFile of targets) {
            if (srcFile === tgtFile) continue;

            // 1. Explicit configured layer order (lower index cannot import higher index)
            if (srcCustom) {
                const tgtCustom = matchConfiguredLayerIndex(tgtFile, configuredLayers);
                if (tgtCustom && srcCustom.index < tgtCustom.index) {
                    issues.push({
                        id: mintIssueId("layer_violation", srcFile, `${srcCustom.prefix}_to_${tgtCustom.prefix}_${basename(tgtFile)}`),
                        detector: "layer_violation",
                        category: "coupling",
                        dimension: "security",
                        tier: "T3",
                        confidence: "high",
                        severity: "high",
                        file: srcFile,
                        line: 1,
                        end_line: 1,
                        span: "L1-L1",
                        identifier: `${srcCustom.prefix} -> ${tgtCustom.prefix}`,
                        summary: `Upward architectural layer violation: lower layer \`${srcFile}\` (\`${srcCustom.prefix}\`) imports higher layer \`${tgtFile}\` (\`${tgtCustom.prefix}\`).`,
                        suggestion: `Invert the dependency or move the shared contract from \`${tgtCustom.prefix}\` down into \`${srcCustom.prefix}\`.`,
                    });
                    continue;
                }
            }

            // 2. Zero-config Roblox Client / Shared / Server boundary rules
            const tgtRoblox = classifyRobloxLayer(tgtFile);
            if (srcRoblox && tgtRoblox && srcRoblox !== tgtRoblox) {
                const illegalRoblox =
                    (srcRoblox === "shared" && (tgtRoblox === "server" || tgtRoblox === "client")) ||
                    (srcRoblox === "client" && tgtRoblox === "server") ||
                    (srcRoblox === "server" && tgtRoblox === "client");
                if (illegalRoblox) {
                    issues.push({
                        id: mintIssueId("layer_violation", srcFile, `roblox_${srcRoblox}_to_${tgtRoblox}_${basename(tgtFile)}`),
                        detector: "layer_violation",
                        category: "coupling",
                        dimension: "security",
                        tier: "T3",
                        confidence: "high",
                        severity: "high",
                        file: srcFile,
                        line: 1,
                        end_line: 1,
                        span: "L1-L1",
                        identifier: `${srcRoblox} -> ${tgtRoblox}`,
                        summary: `Roblox DataModel boundary violation: \`${srcRoblox}\` module \`${srcFile}\` imports \`${tgtRoblox}\` module \`${tgtFile}\`.`,
                        suggestion: `Keep \`shared\` (\`ReplicatedStorage\`) free of \`client\`/\`server\` imports, and never cross-import between \`client\` and \`server\`.`,
                    });
                    continue;
                }
            }

            // 3. Zero-config leaf foundational (util/base) -> top-level entrypoint/UI (bin/cli/app/hosts/viewer)
            const tgtConv = classifyConventionalLayer(tgtFile);
            if (srcConv && tgtConv && srcConv.rank < tgtConv.rank) {
                issues.push({
                    id: mintIssueId("layer_violation", srcFile, `leaf_to_top_${basename(tgtFile)}`),
                    detector: "layer_violation",
                    category: "coupling",
                    dimension: "security",
                    tier: "T3",
                    confidence: "high",
                    severity: "medium",
                    file: srcFile,
                    line: 1,
                    end_line: 1,
                    span: "L1-L1",
                    identifier: `leaf -> entrypoint (${basename(tgtFile)})`,
                    summary: `Upward layer violation: ${srcConv.label} \`${srcFile}\` imports ${tgtConv.label} \`${tgtFile}\`.`,
                    suggestion: `Foundational \`util\`/\`base\` modules must have zero upward imports into CLI, app, host, or viewer layers.`,
                });
            }
        }
    }
}

const LAYER_CHECK_RELATIONS = new Set(["imports", "calls", "references", "extends", "implements"]);

/**
 * Evaluate explicit glob `config.layer_rules` (`{ from, to, allowTypeOnly, reason }`)
 * and inline `forbid: <from> -> <to>` entries in `plan?.policies` across `graph.edges`.
 */
export function detectLayerViolations(rawGraph, zoneMap = null, config = null, fileFilter = null, plan = null) {
    const graph = normalizeGraphShape(rawGraph);
    const rawRules = [];
    const entries = [
        ...(Array.isArray(config?.layer_rules) ? config.layer_rules : []),
        ...(Array.isArray(config?.layerRules) ? config.layerRules : []),
        ...(Array.isArray(plan?.policies) ? plan.policies : []),
        ...(Array.isArray(config?.policies) ? config.policies : []),
    ];
    for (const entry of entries) {
        const parsed = parseLayerRuleEntry(entry);
        if (!parsed) continue;
        const toList = Array.isArray(parsed.to) ? parsed.to : [parsed.to];
        for (const to of toList) {
            if (!rawRules.some((r) => r.from === parsed.from && r.to === to)) {
                rawRules.push({
                    from: parsed.from,
                    to,
                    allowTypeOnly: parsed.allowTypeOnly !== false,
                    reason: parsed.reason || null,
                });
            }
        }
    }

    if (rawRules.length === 0) return [];

    const compiledRules = rawRules.map((r) => ({
        ...r,
        fromRe: globToRegExp(r.from),
        toRe: globToRegExp(r.to),
    }));

    const nodeById = new Map((graph?.nodes || []).map((n) => [n.id, n]));
    const out = [];
    const seenViolations = new Set();

    for (const edge of graph?.edges || []) {
        if (!LAYER_CHECK_RELATIONS.has(edge.relation)) continue;
        const sNode = nodeById.get(edge.source);
        const tNode = nodeById.get(edge.target);
        const srcPath = (sNode?.path || "").replace(/\\/g, "/");
        const tgtPath = (tNode?.path || "").replace(/\\/g, "/");
        if (!srcPath || !tgtPath || srcPath === tgtPath) continue;

        const srcZone = resolveZone(zoneMap, srcPath);
        if (!SCORED_ZONES.has(srcZone)) continue;
        if (!matchesFileFilter(fileFilter, srcPath)) continue;

        for (const rule of compiledRules) {
            if (edge.typeOnly === true && rule.allowTypeOnly !== false) continue;
            if (rule.fromRe.test(srcPath) && rule.toRe.test(tgtPath)) {
                const dedupKey = `${srcPath}::${tgtPath}::${rule.from}->${rule.to}`;
                if (seenViolations.has(dedupKey)) continue;
                seenViolations.add(dedupKey);

                const range = spanRange(sNode?.span) || { start: edge.line || 1, end: edge.line || 1 };
                const ln = edge.line || range.start || 1;
                out.push({
                    id: mintIssueId(
                        "layer_violation",
                        srcPath,
                        `${rule.from}_to_${rule.to}_${basename(tgtPath)}`,
                    ),
                    detector: "layer_violation",
                    category: "coupling",
                    dimension: "security",
                    tier: "T4",
                    confidence: "high",
                    severity: "high",
                    file: srcPath,
                    target_file: tgtPath,
                    line: ln,
                    end_line: ln,
                    span: `L${ln}-L${ln}`,
                    identifier: `${rule.from} -> ${rule.to}`,
                    summary: `Layer boundary violation: \`${srcPath}\` (\`${rule.from}\`) ${edge.relation} \`${tgtPath}\` (\`${rule.to}\`)${rule.reason ? ` — ${rule.reason}` : ""}.`,
                    suggestion: `Remove or invert the forbidden dependency from \`${srcPath}\` to \`${tgtPath}\` (${rule.from} -> ${rule.to}).`,
                });
            }
        }
    }

    return out;
}

/**
 * Detect hidden temporal co-change coupling between production files in different directories
 * (`coCommits >= 4`, `couplingRatio >= 0.65`) that have zero direct static edges in `graph.edges`.
 */
export function detectTemporalCoupling(
    rawGraph,
    rootDir,
    contextDir = null,
    zoneMap = null,
    config = null,
    fileFilter = null,
) {
    if (!rootDir) return [];
    const graph = normalizeGraphShape(rawGraph);
    const history = config?.gitHistory || analyzeGitHistory(rootDir, contextDir);
    if (!history || !history.coChanges) return [];

    const byId = new Map((graph?.nodes || []).map((n) => [n.id, n]));
    const prodFiles = new Set();
    for (const n of graph?.nodes || []) {
        if (n.kind !== "file") continue;
        const z = resolveZone(zoneMap, n.path);
        if (SCORED_ZONES.has(z)) prodFiles.add(n.path.replace(/\\/g, "/"));
    }

    const staticPairs = new Set();
    for (const e of graph?.edges || []) {
        if (e.relation === "contains") continue;
        const sNode = byId.get(e.source);
        const tNode = byId.get(e.target);
        const sf = (sNode?.path || (prodFiles.has(e.source) ? e.source : "")).replace(/\\/g, "/");
        const tf = (tNode?.path || (prodFiles.has(e.target) ? e.target : "")).replace(/\\/g, "/");
        if (sf && tf && sf !== tf) {
            staticPairs.add(`${sf}\0${tf}`);
            staticPairs.add(`${tf}\0${sf}`);
        }
    }

    const out = [];
    const seenPairs = new Set();
    for (const [rawSrc, partners] of Object.entries(history.coChanges)) {
        const srcFile = rawSrc.replace(/\\/g, "/");
        if (!prodFiles.has(srcFile)) continue;
        for (const entry of partners || []) {
            const partnerFile = String(entry.partner || "").replace(/\\/g, "/");
            if (!prodFiles.has(partnerFile)) continue;
            if (dirname(srcFile) === dirname(partnerFile)) continue;
            if (Number(entry.coCommits || 0) < 4 || Number(entry.couplingRatio || 0) < 0.65) {
                continue;
            }
            if (staticPairs.has(`${srcFile}\0${partnerFile}`)) continue;

            const [fileA, fileB] = [srcFile, partnerFile].sort();
            const pairKey = `${fileA}\0${fileB}`;
            if (seenPairs.has(pairKey)) continue;
            seenPairs.add(pairKey);

            if (!matchesFileFilter(fileFilter, fileA) && !matchesFileFilter(fileFilter, fileB)) {
                continue;
            }

            out.push({
                id: mintIssueId("temporal_coupling", fileA, basename(fileB)),
                detector: "temporal_coupling",
                category: "coupling",
                dimension: "code_quality",
                tier: "T2",
                confidence: "medium",
                severity: "medium",
                file: fileA,
                partner_file: fileB,
                co_commits: entry.coCommits,
                coupling_ratio: entry.couplingRatio,
                line: 1,
                end_line: 1,
                span: "L1-L1",
                identifier: `${basename(fileA)} <-> ${basename(fileB)}`,
                summary: `Hidden temporal coupling: \`${fileA}\` and \`${fileB}\` co-changed in ${entry.coCommits} commits (${Math.round(entry.couplingRatio * 100)}% coupling) across different directories with 0 direct static graph edges.`,
                suggestion: `Extract the shared schema, constant, or contract linking \`${fileA}\` and \`${fileB}\` into an explicit imported module.`,
            });
        }
    }

    return out;
}

function runCouplingAndLayerGraphChecks(
    graph,
    ctx,
    zoneMap,
    ignoreRules,
    wantCoupling,
    config,
    opts,
    potentials,
    issues,
) {
    const scoredFileAdj = new Map();
    const runtimeScoredFileAdj = new Map();
    for (const fNode of ctx.fileNodes) {
        const zone = zoneMap.get(fNode.path) || "production";
        if (!SCORED_ZONES.has(zone)) continue;
        if (ignoreRules.isIgnored(fNode.path, "coupling")) continue;
        const outs = [...(ctx.fileImportOut.get(fNode.path) || [])].filter((t) =>
            SCORED_ZONES.has(zoneMap.get(t) || "production"),
        );
        const runtimeOuts = [...(ctx.runtimeFileImportOut.get(fNode.path) || [])].filter((t) =>
            SCORED_ZONES.has(zoneMap.get(t) || "production"),
        );
        scoredFileAdj.set(fNode.path, outs);
        runtimeScoredFileAdj.set(fNode.path, runtimeOuts);
    }
    checkCycleAndDirectoryCouplingIssues(runtimeScoredFileAdj, potentials, issues);
    checkLayerViolationIssues(runtimeScoredFileAdj, config, ignoreRules, potentials, issues);

    const explicitLayerViolations = detectLayerViolations(
        graph,
        zoneMap,
        config,
        opts.fileFilter || null,
        opts.plan || null,
    ).filter((iss) => !ignoreRules.isIgnored(iss.file, "layer_violation"));
    const existingIds = new Set(issues.map((i) => i.id));
    for (const lv of explicitLayerViolations) {
        if (!existingIds.has(lv.id)) {
            issues.push(lv);
            existingIds.add(lv.id);
        }
    }

    if (wantCoupling) {
        potentials.temporal_coupling = Math.max(1, scoredFileAdj.size);
        if (opts.rootDir) {
            const tempIssues = detectTemporalCoupling(
                graph,
                opts.rootDir,
                opts.contextDir || null,
                zoneMap,
                config,
                opts.fileFilter || null,
            ).filter((iss) => !ignoreRules.isIgnored(iss.file, "coupling"));
            issues.push(...tempIssues);
        }
        checkImportAffinityIssues(scoredFileAdj, ctx.fileImportIn, zoneMap, potentials, issues);
        const filesByDir = checkDirectoryShapeIssues(ctx.fileNodes, zoneMap, potentials, issues);
        checkPrivateSymbolAccessIssues(ctx, zoneMap, ignoreRules, potentials, issues);
        checkNamingInconsistencyIssues(filesByDir, potentials, issues);
    }
}

/**
 * Run all graph & topology checks (`dead`, `coupling`, `cohesion`, `tests`).
 */
export function runGraphChecks(
    graph,
    readLines,
    zoneMap,
    ignoreRules,
    enabledCategories,
    config = null,
    opts = {},
) {
    const issues = [];
    const potentials = {
        dead_symbols: 0,
        unreferenced_exports: 0,
        orphaned_files: 0,
        single_importer_files: 0,
        passthrough_wrappers: 0,
        facade_modules: 0,
        delegation_heavy_classes: 0,
        file_cycles: 0,
        directory_cycles: 0,
        layer_violation: 0,
        temporal_coupling: 0,
        import_affinity_outliers: 0,
        private_imports: 0,
        flat_dirs: 0,
        package_census: 0,
        naming_inconsistencies: 0,
        signature_variance: 0,
        low_cohesion_files: 0,
        monster_functions: 0,
        god_classes: 0,
        untested_hubs: 0,
        hollow_tests: 0,
    };

    const ctx = buildGraphCheckTopology(graph);
    const wantDead = enabledCategories.has("dead");
    const wantCoupling = enabledCategories.has("coupling");
    const wantCohesion = enabledCategories.has("cohesion");
    const wantTests = enabledCategories.has("tests");
    const wantSecurity = enabledCategories.has("security");

    if (wantDead) {
        checkDeadAndWrapperIssues(ctx, readLines, zoneMap, ignoreRules, potentials, issues);
    }

    if (wantCoupling || wantSecurity) {
        runCouplingAndLayerGraphChecks(
            graph,
            ctx,
            zoneMap,
            ignoreRules,
            wantCoupling,
            config,
            opts,
            potentials,
            issues,
        );
    }

    if (wantCohesion) {
        checkMonsterAndClassCohesionIssues(ctx, readLines, zoneMap, ignoreRules, potentials, issues);
        checkSignatureVarianceIssues(ctx, readLines, zoneMap, ignoreRules, potentials, issues);
    }

    if (wantTests) {
        checkTestHealthIssues(graph, ctx, readLines, zoneMap, ignoreRules, config, potentials, issues);
    }

    return { issues, potentials };
}
