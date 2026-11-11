/**
 * Mechanical-to-subjective Concern generator (`generateConcerns`, `cleanupStaleDismissals`)
 * and Holistic Codebase Context builder (`buildHolisticContext`) for `plexer health review --prepare`.
 */
import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import { computeInDegree, WALK_RELATIONS } from "../context/symbol-query.js";
import { SCORED_ZONES } from "./zones.js";

export function computeOutDegree(graph) {
    const deg = new Map();
    for (const e of graph.edges) {
        if (!WALK_RELATIONS.has(e.relation)) continue;
        deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    }
    return deg;
}

const JUDGMENT_DETECTORS = new Set([
    "monster_functions",
    "god_classes",
    "low_cohesion_files",
    "passthrough_wrappers",
    "delegation_heavy_classes",
    "facade_modules",
    "import_affinity_outliers",
    "single_importer_files",
    "signature_variance",
    "naming_inconsistencies",
    "hotspots",
    "package_census",
    "enum_bypasses",
    "deceptive_queries",
]);

const MIN_FILES_FOR_SYSTEMIC = 3;
const MIN_FILES_FOR_SMELL_PATTERN = 5;

function concernFingerprint(concernType, fileKey, detKeys) {
    const payload = `${concernType}::${fileKey}::${detKeys.join(",")}`;
    return `concern_${createHash("sha1").update(payload).digest("hex").slice(0, 12)}`;
}

function isConcernDismissed(dismissals, fingerprint, sourceIds) {
    const entry = dismissals?.[fingerprint];
    if (!entry) return false;
    if (Array.isArray(entry.source_issue_ids) && entry.source_issue_ids.length > 0) {
        return sourceIds.every((id) => entry.source_issue_ids.includes(id));
    }
    return true;
}

function appendSystemicSmellConcerns(openIssues, dismissals, seenFp, concerns) {
    const detToFiles = new Map();
    const detToIds = new Map();
    for (const iss of openIssues) {
        if (!iss.file || iss.file === "repo") continue;
        const key = `${iss.detector}:${iss.category || ""}`;
        let fSet = detToFiles.get(key);
        if (!fSet) {
            fSet = new Set();
            detToFiles.set(key, fSet);
        }
        fSet.add(iss.file);

        let idList = detToIds.get(key);
        if (!idList) {
            idList = [];
            detToIds.set(key, idList);
        }
        idList.push(iss.id);
    }

    for (const [key, fSet] of detToFiles.entries()) {
        if (fSet.size < MIN_FILES_FOR_SMELL_PATTERN) continue;
        const [detector] = key.split(":");
        const sortedFiles = [...fSet].sort();
        const sourceIds = (detToIds.get(key) || []).sort();
        const fp = concernFingerprint("systemic_smell", detector, [detector]);
        if (seenFp.has(fp) || isConcernDismissed(dismissals, fp, sourceIds)) continue;
        seenFp.add(fp);

        concerns.push({
            fingerprint: fp,
            type: "systemic_smell",
            target_dimension: "design_coherence",
            file: sortedFiles[0],
            affected_files: sortedFiles,
            detectors: [detector],
            source_issues: sourceIds,
            summary: `Detector '${detector}' fires across ${sortedFiles.length} files — likely a codebase-wide pattern.`,
            evidence: [
                `Detector: ${detector}`,
                `Affected files (${sortedFiles.length}): ${sortedFiles.slice(0, 10).join(", ")}`,
            ],
            question: `'${detector}' appears in ${sortedFiles.length} files. Can a shared utility, autofixer, or architectural boundary eliminate this class of defect across the repo?`,
        });
    }
}

function appendSystemicPatternConcerns(byFile, dismissals, seenFp, concerns) {
    const comboToFiles = new Map();
    for (const [file, fileIssues] of byFile.entries()) {
        const dets = [
            ...new Set(
                fileIssues.filter((i) => JUDGMENT_DETECTORS.has(i.detector)).map((i) => i.detector),
            ),
        ].sort();
        if (dets.length >= 2) {
            const key = dets.join("+");
            let arr = comboToFiles.get(key);
            if (!arr) {
                arr = [];
                comboToFiles.set(key, arr);
            }
            arr.push(file);
        }
    }

    for (const [comboKey, files] of comboToFiles.entries()) {
        if (files.length < MIN_FILES_FOR_SYSTEMIC) continue;
        const sortedFiles = [...files].sort();
        const detSet = comboKey.split("+");
        const sourceIds = sortedFiles
            .flatMap((f) =>
                (byFile.get(f) || []).filter((i) => detSet.includes(i.detector)).map((i) => i.id),
            )
            .sort();
        const fp = concernFingerprint("systemic_pattern", sortedFiles.join(","), detSet);
        if (seenFp.has(fp) || isConcernDismissed(dismissals, fp, sourceIds)) continue;
        seenFp.add(fp);

        concerns.push({
            fingerprint: fp,
            type: "systemic_pattern",
            target_dimension: "design_coherence",
            file: sortedFiles[0],
            affected_files: sortedFiles,
            detectors: detSet,
            source_issues: sourceIds,
            summary: `${sortedFiles.length} files share the same structural pattern (${detSet.join(", ")})`,
            evidence: [
                `Affected files (${sortedFiles.length}): ${sortedFiles.slice(0, 8).join(", ")}`,
                `Shared detectors: ${detSet.join(", ")}`,
            ],
            question: `These ${sortedFiles.length} files all exhibit (${detSet.join(", ")}). Should this be solved systemically at the architecture level rather than patched file-by-file?`,
        });
    }
}

/**
 * Generate synthesized structural & systemic concerns from open mechanical findings.
 * Bridges mechanical detectors to `design_coherence` and holistic subjective review.
 */
export function generateConcerns(state, graph = null, zoneMap = null) {
    const dismissals = state.concern_dismissals || {};
    const openIssues = Object.values(state.issues || {}).filter((i) => {
        if (i.status !== "open" || i.suppressed) return false;
        if (i.file && i.file !== "repo") {
            const z =
                (zoneMap && typeof zoneMap.get === "function" ? zoneMap.get(i.file) : null) ||
                i.zone;
            if (z && !SCORED_ZONES.has(z)) return false;
        }
        return true;
    });
    const byFile = new Map();

    for (const iss of openIssues) {
        const f = iss.file || "repo";
        if (f === "repo") continue;
        let list = byFile.get(f);
        if (!list) {
            list = [];
            byFile.set(f, list);
        }
        list.push(iss);
    }

    const concerns = [];
    const seenFp = new Set();

    // 1. Per-file multi-detector concerns
    for (const [file, fileIssues] of byFile.entries()) {
        const judgment = fileIssues.filter((i) => JUDGMENT_DETECTORS.has(i.detector));
        if (judgment.length === 0) continue;

        const detSet = [...new Set(judgment.map((i) => i.detector))].sort();
        if (detSet.length < 2 && !(detSet.length >= 1 && fileIssues.length >= 3)) {
            continue;
        }

        const sourceIds = (judgment.length >= 2 ? judgment : fileIssues).map((i) => i.id).sort();
        const fp = concernFingerprint("file_hotspot", file, detSet);
        if (seenFp.has(fp) || isConcernDismissed(dismissals, fp, sourceIds)) continue;
        seenFp.add(fp);

        concerns.push({
            fingerprint: fp,
            type: "file_hotspot",
            target_dimension: "design_coherence",
            file,
            detectors: detSet,
            source_issues: sourceIds,
            summary: `${file} accumulates ${fileIssues.length} findings across [${detSet.join(", ")}] — likely mixing unrelated responsibilities.`,
            evidence: judgment.slice(0, 5).map((i) => `${i.span}: [${i.detector}] ${i.summary}`),
            question: `Does \`${file}\` mix multiple distinct responsibilities that should be split along clearer domain seams, or is this complexity inherent to one cohesive domain?`,
        });
    }

    // 2. Cross-file detector-combination patterns (>= 3 files sharing the same >= 2 judgment detectors)
    appendSystemicPatternConcerns(byFile, dismissals, seenFp, concerns);
    appendSystemicSmellConcerns(openIssues, dismissals, seenFp, concerns);
    return concerns;
}

/**
 * Remove concern dismissals whose underlying `source_issue_ids` are no longer open.
 */
export function cleanupStaleDismissals(state) {
    const dismissals = state.concern_dismissals;
    if (!dismissals || typeof dismissals !== "object") return 0;
    const openIds = new Set(
        Object.values(state.issues || {})
            .filter((i) => i.status === "open" && !i.suppressed)
            .map((i) => i.id),
    );
    let removed = 0;
    for (const [fp, entry] of Object.entries(dismissals)) {
        const src = entry?.source_issue_ids;
        if (Array.isArray(src) && src.length > 0 && !src.some((id) => openIds.has(id))) {
            delete dismissals[fp];
            removed += 1;
        }
    }
    return removed;
}

export function classifyStemConvention(filename, includeFlat = false) {
    const stem = filename.includes(".") ? filename.slice(0, filename.indexOf(".")) : filename;
    if (!stem) return null;
    if (stem.includes("-") && stem === stem.toLowerCase()) return "kebab-case";
    if (/^[A-Z]/.test(stem) && !stem.includes("-")) return "PascalCase";
    if (/^[a-z]/.test(stem) && /[A-Z]/.test(stem) && !stem.includes("-")) return "camelCase";
    if (stem.includes("_") && stem === stem.toLowerCase()) return "snake_case";
    if (includeFlat && stem === stem.toLowerCase() && !stem.includes("-")) return "flat_lower";
    return null;
}

function computeCouplingMatrix(graph, nodeById) {
    const dirEdges = new Map();
    for (const edge of graph.edges) {
        if (!WALK_RELATIONS.has(edge.relation)) continue;
        const s = nodeById.get(edge.source);
        const t = nodeById.get(edge.target);
        if (!s || !t || s.path === t.path) continue;
        const sDir = dirname(s.path);
        const tDir = dirname(t.path);
        if (sDir === tDir) continue;
        const key = `${sDir} -> ${tDir}`;
        dirEdges.set(key, (dirEdges.get(key) || 0) + 1);
    }
    return [...dirEdges.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15)
        .map(([edge, count]) => ({ edge, count }));
}

function filterHolisticOpenIssues(state, zoneMap) {
    return Object.values(state.issues || {}).filter((i) => {
        if (i.status !== "open" || i.suppressed) return false;
        if (i.detector === "hollow_tests") return true;
        if (i.file && i.file !== "repo") {
            const z =
                (zoneMap && typeof zoneMap.get === "function" ? zoneMap.get(i.file) : null) ||
                i.zone;
            if (z && !SCORED_ZONES.has(z)) return false;
        }
        return true;
    });
}

/**
 * Build the objective Holistic Context packet (`architecture`, `conventions`, `errors`,
 * `testing`, `structure`, `codebase_stats`, `concerns`) for `review_packet_blind.json`.
 */
export function buildHolisticContext(graph, state, zoneMap, readLines) {
    const inDeg = computeInDegree(graph);
    const outDeg = computeOutDegree(graph);
    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

    const prodFiles = [];
    const testFiles = [];
    let totalProdLoc = 0;
    const namingByDir = Object.create(null);
    const dirProfiles = Object.create(null);

    for (const node of graph.nodes) {
        if (node.kind !== "file") continue;
        const zone =
            (zoneMap && typeof zoneMap.get === "function" ? zoneMap.get(node.path) : null) ||
            "production";
        const lines = typeof readLines === "function" ? readLines(node.path) : null;
        const loc =
            Array.isArray(lines) && lines.length > 0 ? lines.length : Number(node.lineCount) || 0;

        if (zone === "test") {
            testFiles.push({ path: node.path, loc });
            continue;
        }
        if (!SCORED_ZONES.has(zone)) continue;

        const fanIn = inDeg.get(node.id) || 0;
        const fanOut = outDeg.get(node.id) || 0;
        totalProdLoc += loc;
        prodFiles.push({ path: node.path, loc, fan_in: fanIn, fan_out: fanOut });

        const dir = dirname(node.path);
        const conv = classifyStemConvention(basename(node.path), true);
        if (conv) {
            if (!namingByDir[dir]) namingByDir[dir] = Object.create(null);
            namingByDir[dir][conv] = (namingByDir[dir][conv] || 0) + 1;
        }

        if (!dirProfiles[dir]) {
            dirProfiles[dir] = { file_count: 0, total_loc: 0, total_fan_in: 0, total_fan_out: 0 };
        }
        dirProfiles[dir].file_count += 1;
        dirProfiles[dir].total_loc += loc;
        dirProfiles[dir].total_fan_in += fanIn;
        dirProfiles[dir].total_fan_out += fanOut;
    }

    const couplingMatrix = computeCouplingMatrix(graph, nodeById);
    const topHubs = [...prodFiles]
        .sort((a, b) => b.fan_in - a.fan_in || b.loc - a.loc)
        .slice(0, 12);
    const rootFiles = prodFiles.filter((f) => dirname(f.path) === ".");
    const openIssues = filterHolisticOpenIssues(state, zoneMap);
    const errorByDir = {};
    for (const iss of openIssues) {
        if (iss.category === "catches" || iss.detector === "silent_catches") {
            const d = dirname(iss.file || "repo");
            errorByDir[d] = (errorByDir[d] || 0) + 1;
        }
    }

    return {
        codebase_stats: {
            production_files: prodFiles.length,
            production_loc: totalProdLoc,
            test_files: testFiles.length,
            languages: graph.languages || [],
        },
        architecture: {
            top_hubs: topHubs,
            open_cycle_issues: openIssues.filter(
                (i) => i.detector === "file_cycles" || i.detector === "directory_cycles",
            ).length,
        },
        structure: {
            root_files: rootFiles,
            directory_profiles: dirProfiles,
            coupling_matrix: couplingMatrix,
        },
        conventions: { naming_by_directory: namingByDir },
        errors: { silent_catches_by_directory: errorByDir },
        testing: {
            production_files: prodFiles.length,
            test_files: testFiles.length,
            untested_hubs: openIssues.filter((i) => i.detector === "untested_hubs").map((i) => i.file),
            hollow_tests: openIssues.filter((i) => i.detector === "hollow_tests").map((i) => i.file),
        },
        concerns: generateConcerns(state, graph, zoneMap),
    };
}
