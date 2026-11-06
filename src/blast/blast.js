/**
 * Blast radius of a diff: what else in the repo depends on the lines this change
 * touched.
 *
 * The whole command is a join between two things plexer already has — git's changed
 * line ranges (`diff.js`) and the wiring graph's incoming edges (`traverse.js`) —
 * so there is no new graph logic here, only the seeding rule:
 *
 *   changed line → the innermost symbol whose span contains it → seed
 *
 * Seeding by SYMBOL rather than by file is what makes the answer worth reading: a
 * 400-line file with a one-line edit reports the dependents of that one function,
 * not of everything the file happens to define. The file node is seeded too, so
 * importers (whose edge targets the file, not the symbol) are still found.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isTestPath } from "../ask/ask.js";
import { contextDirFor } from "../context/node-file.js";
import { loadGraphCached } from "../graph/load.js";
import { linkTestsForGraph } from "../graph/test-links.js";
import { impactOfMany, parseWalkDepth } from "../graph/traverse.js";
import { globToRegExp, parseLayerRuleEntry, pushMap, toPosixPath } from "../util/paths.js";
import { readJson } from "../util/state.js";
import { changedFiles, refExists } from "./diff.js";
import { spanRange } from "./evidence.js";
import { analyzeGitHistory, untouchedCoChanges } from "./history.js";
import { dirLabel, moduleIndex, parentDir, shortLabel } from "./modules.js";
/**
 * The innermost symbols whose spans overlap any changed range in `path`.
 *
 * "Innermost" matters for a method: a changed line inside `Cache.get` overlaps both
 * the class span and the method span, and seeding the class would report everyone
 * who touches any part of `Cache`. Nesting is resolved by keeping, for each range,
 * only symbols that contain no other matched symbol.
 */
function seedsForFile(symbols, ranges) {
    if (!symbols || symbols.length === 0)
        return [];
    const hit = new Map();
    for (const r of ranges) {
        const overlapping = symbols.filter((s) => s.start <= r.end && s.end >= r.start);
        // Drop any symbol that strictly contains another overlapping one (the class
        // around a changed method), keeping the tightest description of the edit.
        for (const s of overlapping) {
            const containsAnother = overlapping.some((o) => o !== s && o.start >= s.start && o.end <= s.end && (o.start > s.start || o.end < s.end));
            if (!containsAnother)
                hit.set(s.node.id, s.node);
        }
    }
    return [...hit.values()];
}
function blastRadiusFromDir(dir, rawOpts) {
    const root = resolve(dir);
    const dirOpts = rawOpts && typeof rawOpts === "object" && !Array.isArray(rawOpts) ? rawOpts : {};
    const contextDir = contextDirFor(root, dirOpts.contextDir);
    const loaded = loadGraphCached(contextDir);
    if (!loaded)
        throw new Error(`no graph found at ${contextDir} — run \`plexer build\` first`);
    if (dirOpts.base !== undefined && !refExists(root, dirOpts.base))
        throw new Error(`base ref "${dirOpts.base}" is not in this checkout`);
    const diff = changedFiles(root, dirOpts.base);
    if (!diff)
        throw new Error(`could not read a diff in ${root} — is this a git repository?`);
    const parsedDepth = parseWalkDepth(dirOpts.depth, 2);
    if (Number.isNaN(parsedDepth))
        throw new RangeError("depth must be a positive integer or 'all'");
    return blastRadiusIn(loaded, contextDir, diff.files, diff.basis, parsedDepth, {
        rootDir: root,
        layerRules: dirOpts.layerRules ?? dirOpts.layer_rules,
        gitHistory: dirOpts.gitHistory,
        includeHistory: dirOpts.includeHistory,
        since: dirOpts.since,
    });
}
function indexBlastGraphNodes(graph) {
    const fileNodes = new Map();
    const symbolsByFile = new Map();
    const edgesBySource = new Map();
    for (const n of graph.nodes) {
        if (n.kind === "file") {
            fileNodes.set(n.path, n);
            continue;
        }
        const b = spanRange(n.span);
        if (!b)
            continue;
        pushMap(symbolsByFile, n.path, { node: n, ...b });
    }
    for (const e of graph.edges) {
        if (e.relation === "contains")
            continue;
        pushMap(edgesBySource, e.source, e);
    }
    return { fileNodes, symbolsByFile, edgesBySource };
}
function isHitTypeOnly(h, seedIds, edgesBySource, typeOnlyByNodeId) {
    if (h.typeOnly === true)
        return true;
    const srcEdges = edgesBySource.get(h.node.id) ?? [];
    const targetMatches = srcEdges.filter((e) =>
        h.depth === 1 ? seedIds.has(e.target) || (h.via && e.target === h.via.id) : h.via ? e.target === h.via.id : seedIds.has(e.target),
    );
    if (targetMatches.length > 0 && targetMatches.every((e) => Boolean(e.typeOnly)))
        return true;
    if (h.depth > 1 && h.via && typeOnlyByNodeId.get(h.via.id) === true)
        return true;
    return false;
}
function collectBlastSeedsAndImpacts(graph, changed, depth) {
    const { fileNodes, symbolsByFile, edgesBySource } = indexBlastGraphNodes(graph);
    const seeds = [];
    const unindexed = [];
    const deleted = [];
    /** Seed nodes per changed file, kept for the area grouping and the test signal. */
    const seedNodes = new Map();
    /** Merged dependents, keyed by node id, at the shallowest depth any file reached
     * them — plus which changed files did the reaching. */
    const merged = new Map();
    for (const file of changed) {
        if (file.status === "deleted") {
            deleted.push(file.path);
            continue;
        }
        const fileNode = fileNodes.get(file.path);
        if (!fileNode) {
            unindexed.push(file.path);
            continue;
        }
        // No hunk ranges (a rename with no content change, a mode change) or an added
        // file: the unit of change is the file itself.
        const symbolSeeds = file.ranges.length > 0 ? seedsForFile(symbolsByFile.get(file.path), file.ranges) : [];
        for (const node of symbolSeeds) {
            seeds.push({ id: node.id, name: node.name, kind: node.kind, path: node.path, span: node.span, wholeFile: false });
        }
        if (symbolSeeds.length === 0) {
            seeds.push({
                id: fileNode.id, name: fileNode.name, kind: fileNode.kind,
                path: fileNode.path, span: fileNode.span, wholeFile: true,
            });
        }
        // One walk PER CHANGED FILE, not one walk over every seed at once.
        // The FILE node is a seed only when no symbol matched.
        const walkSeeds = symbolSeeds.length > 0 ? symbolSeeds : [fileNode];
        const seedIds = new Set(walkSeeds.map((s) => s.id));
        seedNodes.set(file.path, walkSeeds);
        const hits = impactOfMany(graph, walkSeeds, depth, "in");
        const typeOnlyByNodeId = new Map();
        for (const h of hits) {
            if (!hasNode(h))
                continue;
            const typeOnly = isHitTypeOnly(h, seedIds, edgesBySource, typeOnlyByNodeId);
            typeOnlyByNodeId.set(h.node.id, typeOnly);
            const hit = toImpacted(h, typeOnly);
            const prev = merged.get(hit.id);
            if (!prev)
                merged.set(hit.id, { hit, from: new Set([file.path]) });
            else {
                prev.from.add(file.path);
                const combinedTypeOnly = Boolean(prev.hit.typeOnly && hit.typeOnly);
                if (hit.depth < prev.hit.depth)
                    prev.hit = combinedTypeOnly ? hit : { ...hit, typeOnly: undefined };
                else if (prev.hit.typeOnly && ! combinedTypeOnly)
                    delete prev.hit.typeOnly;
                if (!prev.hit.typeOnly)
                    delete prev.hit.typeOnly;
            }
        }
    }
    return { seeds, unindexed, deleted, seedNodes, merged };
}
/** Compute the blast radius of `changed` against `graph`, or from a repo `dir` and `opts`. */
export function blastRadius(graph, changed, basis = "working tree", opts = { depth: 2 }) {
    if (typeof graph === "string")
        return blastRadiusFromDir(graph, changed);
    const parsedDepth = parseWalkDepth(opts?.depth, 2);
    if (Number.isNaN(parsedDepth))
        throw new RangeError("depth must be a positive integer or 'all'");
    const { seeds, unindexed, deleted, seedNodes, merged } = collectBlastSeedsAndImpacts(graph, changed, parsedDepth);
    const impacted = [...merged.values()].map((m) => m.hit);
    const origins = new Map([...merged].map(([id, m]) => [id, m.from]));
    const index = opts.modules ?? emptyIndex();
    const grouped = groupByModule(impacted, changed, origins, index);
    const res = {
        basis,
        depth: parsedDepth,
        changed,
        unindexed,
        deleted,
        seeds,
        impacted,
        modules: grouped.modules,
        testModules: grouped.testModules,
        areas: changedAreas(graph, changed, seedNodes, index, grouped.modules),
    };
    if (opts?.gitHistory) {
        const coChanges = untouchedCoChanges(opts.gitHistory, changed.map((c) => c.path), graph);
        if (coChanges.length > 0)
            res.coChanges = coChanges;
    }
    const directLayerRules = opts?.layerRules ?? opts?.layer_rules;
    if (Array.isArray(directLayerRules) && directLayerRules.length > 0) {
        const violations = collectLayerViolations(graph, changed, directLayerRules);
        if (violations.length > 0)
            res.layerViolations = violations;
    }
    return res;
}
function collectBlastTestIncoming(graph) {
    const nodeById = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    /** How many edges point AT each node — how central it is in the graph. */
    const inDegree = new Map();
    /** Incoming edge sources per node id, resolved to the source's file path. */
    const incoming = new Map();
    for (const e of graph.edges) {
        inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1);
        const path = nodeById.get(e.source)?.path;
        if (!path || !isTestPath(path))
            continue;
        const at = incoming.get(e.target) ?? new Set();
        at.add(path);
        incoming.set(e.target, at);
    }
    const testLinks = linkTestsForGraph(graph);
    return { inDegree, incoming, testLinks };
}
function buildChangedArea(dir, paths, seedNodes, incoming, changedTests, inDegree, testLinks) {
    const area = {
        label: dir, labelSource: "symbol", key: dir,
        files: [], seeds: 0, tests: "none", testFiles: [], changedTestFiles: [],
        companionTestFiles: [],
        reached: 0, behavioural: 0, unreached: [], seedNames: [],
    };
    const areaCandidates = [];
    for (const path of paths) {
        const nodes = seedNodes.get(path) ?? [];
        area.files.push(path);
        area.seeds += nodes.length;
        for (const node of nodes) {
            const behavioural = node.kind === "function" || node.kind === "method" || node.kind === "class";
            const from = incoming.get(node.id) ?? new Set();
            for (const t of from) {
                if (!area.testFiles.includes(t))
                    area.testFiles.push(t);
                if (changedTests.has(t) && !area.changedTestFiles.includes(t))
                    area.changedTestFiles.push(t);
            }
            if (testLinks) {
                const links = testLinks.testsForSymbol(node.id, path, true);
                for (const { testFile, kind } of links) {
                    if (!area.testFiles.includes(testFile))
                        area.testFiles.push(testFile);
                    if (changedTests.has(testFile) && !area.changedTestFiles.includes(testFile))
                        area.changedTestFiles.push(testFile);
                    if ((kind === "module_import" || kind === "stem_companion") && !area.companionTestFiles.includes(testFile))
                        area.companionTestFiles.push(testFile);
                }
            }
            areaCandidates.push({ name: node.name, behavioural, degree: inDegree.get(node.id) ?? 0 });
            if (!behavioural)
                continue;
            area.behavioural++;
            if (from.size > 0)
                area.reached++;
            else
                area.unreached.push(node.name);
        }
    }
    area.seedNames = areaCandidates
        .sort((a, b) => Number(b.behavioural) - Number(a.behavioural) || b.degree - a.degree || a.name.localeCompare(b.name))
        .map((c) => c.name);
    return area;
}
/**
 * Group the changed files into areas, and work out whether each one's tests moved.
 */
function changedAreas(graph, changed, seedNodes, index, modules) {
    const changedTests = new Set(changed.filter((c) => isTestPath(c.path)).map((c) => c.path));
    const { inDegree, incoming, testLinks } = collectBlastTestIncoming(graph);
    const groups = new Map();
    for (const path of seedNodes.keys()) {
        if (isTestPath(path))
            continue;
        const dir = dirLabel(path);
        pushMap(groups, dir, path);
    }
    coarsen(groups, MAX_AREAS);
    const byKey = new Map();
    const reachByArea = new Map();
    for (const [dir, paths] of groups) {
        const area = buildChangedArea(dir, paths, seedNodes, incoming, changedTests, inDegree, testLinks);
        byKey.set(dir, area);
        const concept = sharedConcept(area.files, index);
        area.label = concept ?? hubLabel(area.seedNames, area.key);
        area.labelSource = concept ? "concept" : "symbol";
        area.files.sort();
        area.testFiles.sort();
        area.changedTestFiles.sort();
        area.companionTestFiles.sort();
        area.tests =
            area.behavioural === 0 ? "na"
                : area.changedTestFiles.length > 0 ? "changed"
                    : area.testFiles.length > 0 ? "stale"
                        : "none";
        const fileSet = new Set(area.files);
        reachByArea.set(area, modules.filter((m) => m.from.some((f) => fileSet.has(f))).length);
    }
    return [...byKey.values()].sort((a, b) => (reachByArea.get(b) ?? 0) - (reachByArea.get(a) ?? 0) || b.files.length - a.files.length || a.label.localeCompare(b.label));
}
function collectBlastHealthHotspots(contextDir, changed, impacted) {
    const stateFile = contextDir ? join(contextDir, ".health", "state.json") : "";
    if (!stateFile || !existsSync(stateFile)) return [];
    const state = readJson(stateFile);
    if (!state || typeof state !== "object") return [];
    const changedSet = new Set(changed.map((c) => c.path));
    const impactedSet = new Set(
        impacted.filter((i) => i.depth === 1 && !changedSet.has(i.path)).map((i) => i.path),
    );
    const byFile = new Map();
    for (const iss of Object.values(state.issues || {})) {
        if (iss.status !== "open" || iss.suppressed || !iss.file) continue;
        const role = changedSet.has(iss.file)
            ? "changed"
            : impactedSet.has(iss.file)
              ? "impacted"
              : null;
        if (!role) continue;
        let entry = byFile.get(iss.file);
        if (!entry) {
            entry = { file: iss.file, role, count: 0, max_tier: "T1", issues: [] };
            byFile.set(iss.file, entry);
        }
        entry.count += 1;
        if (String(iss.tier || "T1") > String(entry.max_tier || "T1")) {
            entry.max_tier = iss.tier || "T2";
        }
        if (entry.issues.length < 5) {
            entry.issues.push({
                id: iss.id,
                detector: iss.detector,
                tier: iss.tier,
                severity: iss.severity,
                span: iss.span,
                summary: iss.summary,
            });
        }
    }
    return [...byFile.values()].sort(
        (a, b) =>
            (a.role === "changed" ? 0 : 1) - (b.role === "changed" ? 0 : 1) ||
            b.count - a.count ||
            a.file.localeCompare(b.file),
    );
}

function loadLayerRules(contextDir, opts = {}) {
    if (Array.isArray(opts.layerRules))
        return opts.layerRules.map(parseLayerRuleEntry).filter(Boolean);
    if (Array.isArray(opts.layer_rules))
        return opts.layer_rules.map(parseLayerRuleEntry).filter(Boolean);
    if (!contextDir)
        return [];
    const cfgFile = join(contextDir, ".health", "config.json");
    const planFile = join(contextDir, ".health", "plan.json");
    const parsedCfg = existsSync(cfgFile) ? readJson(cfgFile) : null;
    const parsedPlan = existsSync(planFile) ? readJson(planFile) : null;
    const rawEntries = [
        ...(Array.isArray(parsedCfg?.layer_rules) ? parsedCfg.layer_rules : []),
        ...(Array.isArray(parsedCfg?.layerRules) ? parsedCfg.layerRules : []),
        ...(Array.isArray(parsedPlan?.policies) ? parsedPlan.policies : []),
        ...(Array.isArray(parsedCfg?.policies) ? parsedCfg.policies : []),
    ];
    return rawEntries.map(parseLayerRuleEntry).filter(Boolean);
}

function collectLayerViolations(graph, changed, rules) {
    if (!Array.isArray(rules) || rules.length === 0 || !graph?.edges || !graph?.nodes)
        return [];
    const changedSet = new Set(changed.filter((c) => c.status !== "deleted").map((c) => c.path));
    if (changedSet.size === 0)
        return [];
    const compiledRules = [];
    for (const rawRule of rules) {
        const rule = parseLayerRuleEntry(rawRule);
        if (!rule)
            continue;
        const ruleFrom = rule.from;
        const toList = Array.isArray(rule.to) ? rule.to : rule.to ? [rule.to] : [];
        if (!ruleFrom || toList.length === 0)
            continue;
        compiledRules.push({
            ruleFrom,
            fromRe: globToRegExp(ruleFrom),
            toRes: toList.map((t) => ({ ruleTo: t, re: globToRegExp(t) })),
            allowTypeOnly: Boolean(rule.allowTypeOnly),
            reason: rule.reason,
        });
    }
    if (compiledRules.length === 0)
        return [];
    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const violations = [];
    const seen = new Set();
    for (const e of graph.edges) {
        if (e.relation === "contains")
            continue;
        const sourceFile = byId.get(e.source)?.path ?? (byId.has(e.source) ? e.source : null);
        const targetFile = byId.get(e.target)?.path ?? (byId.has(e.target) ? e.target : null);
        if (!sourceFile || !targetFile || sourceFile === targetFile)
            continue;
        if (!changedSet.has(sourceFile))
            continue;
        const normSource = toPosixPath(sourceFile).replace(/^\.\//, "");
        const normTarget = toPosixPath(targetFile).replace(/^\.\//, "");
        for (const rule of compiledRules) {
            if (rule.allowTypeOnly && e.typeOnly)
                continue;
            if (!rule.fromRe.test(normSource))
                continue;
            for (const { ruleTo, re } of rule.toRes) {
                if (!re.test(normTarget))
                    continue;
                const key = `${sourceFile}\0${targetFile}\0${rule.ruleFrom}\0${ruleTo}`;
                if (seen.has(key))
                    continue;
                seen.add(key);
                violations.push({
                    sourceFile,
                    targetFile,
                    relation: e.relation,
                    ruleFrom: rule.ruleFrom,
                    ruleTo,
                    reason: rule.reason ?? `${rule.ruleFrom} cannot depend on ${ruleTo}`,
                });
            }
        }
    }
    return violations.sort(
        (a, b) =>
            a.sourceFile.localeCompare(b.sourceFile) ||
            a.targetFile.localeCompare(b.targetFile) ||
            a.ruleFrom.localeCompare(b.ruleFrom) ||
            a.ruleTo.localeCompare(b.ruleTo),
    );
}

/** Convenience wrapper: build the module index from a context dir. */
export function blastRadiusIn(graph, contextDir, changed, basis, depth, opts = {}) {
    const parsedDepth = parseWalkDepth(depth, 2);
    if (Number.isNaN(parsedDepth))
        throw new RangeError("depth must be a positive integer or 'all'");
    const res = blastRadius(graph, changed, basis, { depth: parsedDepth, modules: moduleIndex(contextDir) });
    const hotspots = collectBlastHealthHotspots(contextDir, changed, res.impacted);
    if (hotspots.length > 0) {
        res.healthHotspots = hotspots;
    }
    const rootDir = opts.rootDir ?? (contextDir ? dirname(resolve(contextDir)) : null);
    const history = opts.includeHistory === false
        ? null
        : (opts.gitHistory ??
            (rootDir && existsSync(rootDir)
                ? analyzeGitHistory(rootDir, contextDir, opts.since ? { since: opts.since } : undefined)
                : null));
    if (history) {
        const coChanges = untouchedCoChanges(history, changed.map((c) => c.path), graph);
        if (coChanges.length > 0) {
            res.coChanges = coChanges;
        }
    }
    const rules = loadLayerRules(contextDir, opts);
    if (rules.length > 0) {
        const violations = collectLayerViolations(graph, changed, rules);
        if (violations.length > 0) {
            res.layerViolations = violations;
        }
    }
    return res;
}
function hasNode(h) {
    // Unresolved endpoints (an import module string no node exists for) carry no
    // location, so they can neither be grouped nor opened — dropped rather than
    // rendered as a box with no file behind it.
    return h.node !== null;
}
function toImpacted(h, typeOnly = false) {
    const isTypeOnly = Boolean(h.typeOnly || typeOnly);
    return {
        id: h.node.id, name: h.node.name, kind: h.node.kind,
        path: h.node.path, span: h.node.span, relation: h.relation, depth: h.depth,
        ...(isTypeOnly ? { typeOnly: true } : {}),
    };
}
function emptyIndex() {
    return { hasConcepts: false, labelOf: (p) => p, conceptOf: () => null };
}
/**
 * The concept claiming EVERY file in a cluster, or null when they disagree.
 *
 * Unanimity is the point: a concept that covers three of five files describes
 * something narrower than the cluster, and stamping its name on the whole thing is
 * how a diagram starts lying about what it drew.
 */
function sharedConcept(paths, index) {
    const concepts = new Set(paths.map((p) => index.conceptOf(p)));
    const [only] = concepts;
    return concepts.size === 1 && only ? shortLabel(only) : null;
}
/**
 * The deterministic backstop label: the cluster's most significant symbol.
 *
 * Reached with no concept, no cache and no API key, so this is what guarantees a
 * circle never carries a bare directory. It is a fact rather than a guess — the
 * reviewer can grep the name — which is why it beats borrowing a neighbouring
 * concept: on plexer's own graph that borrowing labelled the freshness gate
 * "Graph Extraction and Loading", which misleads worse than any path.
 */
export function hubLabel(names, fallback) {
    const [head] = names.filter(Boolean);
    // The hub alone, with no "+8" tail: how many symbols came with it is already the
    // circle's second line and the table's own column, and repeating it in the label
    // turned "writeGraph" into "writeGraph +8", which reads as a version number.
    return head ? shortLabel(head) : fallback;
}
/**
 * Group dependents into modules. `origins` carries, per dependent, the changed
 * files whose walk actually reached it — so a module's `from` is the real arrow
 * set, not every changed file in the PR.
 */
function groupByModule(impacted, changed, origins, modules) {
    const changedPaths = new Set(changed.map((c) => c.path));
    const byKey = new Map();
    for (const hit of impacted) {
        // A dependent inside a file the PR already changes is not "reach" — it is the
        // diff. Reviewers see it in the diff itself; repeating it as blast radius is
        // what makes these comments feel like noise.
        if (changedPaths.has(hit.path))
            continue;
        // Cluster by concept where one exists, else by directory. Clustering and
        // LABELLING are separate steps now: the key only has to be stable, while the
        // label goes through the ladder below and may end up naming a symbol.
        const key = modules.conceptOf(hit.path) ?? dirLabel(hit.path);
        let mod = byKey.get(key);
        if (!mod) {
            mod = { label: key, labelSource: "symbol", key, files: [], symbols: [], from: [] };
            byKey.set(key, mod);
        }
        mod.symbols.push(hit);
        if (!mod.files.includes(hit.path))
            mod.files.push(hit.path);
    }
    for (const mod of byKey.values()) {
        const from = new Set();
        for (const s of mod.symbols)
            for (const p of origins.get(s.id) ?? [])
                from.add(p);
        mod.from = [...from].sort();
        mod.files.sort();
        mod.symbols.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
        // Shallowest symbol first after that sort, so it is the cluster's hub: the
        // thing one hop from the diff rather than an arbitrary member.
        const concept = sharedConcept(mod.files, modules);
        mod.label = concept ?? hubLabel(mod.symbols.map((s) => s.name), mod.key);
        mod.labelSource = concept ? "concept" : "symbol";
    }
    // Test-only modules are separated, not just sorted last. On a repo with a test
    // per module they are the majority of the graph's dependents — plexer's own 24-file
    // PR produced 31 modules, 24 of them a single test file — so leaving them in the
    // same list means they crowd out every module a reviewer needs whatever the caps
    // are. "Your tests reference the thing you changed" is one line, not 24 sections.
    const bySize = (a, b) => b.symbols.length - a.symbols.length || a.label.localeCompare(b.label);
    const all = [...byKey.values()];
    return {
        modules: all.filter((m) => !isTestOnly(m)).sort(bySize),
        testModules: all.filter(isTestOnly).sort(bySize),
    };
}
/**
 * Directory groups the diff is folded down to before anything is drawn.
 *
 * Kept here rather than in the renderer because it is a statement about the diff,
 * not about the picture: five areas is roughly what a reviewer holds in their head,
 * and the renderer then draws all of them.
 */
const MAX_AREAS = 5;
/**
 * Fold directory groups into their parents until there are at most `max`.
 *
 * The deepest group goes first, and only into a parent that already exists, so
 * `src/ai/llm/` joins `src/ai/` rather than everything collapsing towards the repo
 * root. When no group has an existing parent, one is created — but never at the top
 * level, since a single `(root)` area is no grouping at all.
 */
function coarsen(groups, max) {
    const depth = (dir) => dir.split("/").length;
    while (groups.size > max) {
        const keys = [...groups.keys()].sort((a, b) => depth(b) - depth(a) || (groups.get(a).length - groups.get(b).length));
        const pick = keys.find((k) => groups.has(parentDir(k)) && parentDir(k) !== "") ??
            keys.find((k) => parentDir(k) !== "");
        if (!pick)
            return;
        const parent = parentDir(pick);
        groups.set(parent, [...(groups.get(parent) ?? []), ...groups.get(pick)]);
        groups.delete(pick);
    }
}
/** True when every file in the module is a test file. */
function isTestOnly(mod) {
    return mod.files.length > 0 && mod.files.every((f) => isTestPath(f));
}
