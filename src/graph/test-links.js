/**
 * Unified test-to-source linking (`linkTestsForGraph`):
 * Pairs source files and symbols with their covering test files across 3 tiers:
 *   1. `symbol_call`   — test file has a resolved `calls`/`references` edge to `file#symbol`.
 *   2. `module_import` — test file has a resolved `imports` edge to `file` (or a 1-hop barrel).
 *   3. `stem_companion` — test file stem matches source file stem (`foo.test.ts` <-> `foo.ts`,
 *                         `foo.spec.luau` <-> `foo.luau`, `test_foo.py` <-> `foo.py`).
 */
import { posix } from "node:path";
import { isTestPath } from "../ask/ask.js";
import { pushMap, toPosixPath } from "../util/paths.js";

const TIER_RANK = {
    symbol_call: 3,
    module_import: 2,
    stem_companion: 1,
};

/**
 * Extract the canonical stem of a file path, stripping extensions and test affixes
 * (`foo.test.ts` -> `foo`, `test_bar.py` -> `bar`, `baz_test.go` -> `baz`,
 * `init.spec.luau` -> `<parentDir>`).
 */
export function canonicalFileStem(filePath) {
    const norm = toPosixPath(filePath);
    const base = posix.basename(norm);
    const dir = posix.dirname(norm);
    let stem = base.replace(/\.(?:d\.ts|d\.luau|[A-Za-z0-9]+)$/i, "");
    stem = stem.replace(/\.(?:test|spec|bench|mock|e2e|integration)$/i, "");
    stem = stem.replace(/^(?:test_|spec_|mock_)/i, "");
    stem = stem.replace(/(?:_test|_spec|_bench|_mock)$/i, "");
    if ((stem === "index" || stem === "init" || stem === "__init__" || stem === "mod") && dir && dir !== ".") {
        return posix.basename(dir).toLowerCase();
    }
    return stem.toLowerCase();
}

function directorySimilarity(srcPath, testPath) {
    const srcSegs = toPosixPath( posix.dirname(srcPath) )
        .split("/")
        .filter((s) => s && s !== "." && s !== "src" && s !== "lib" && s !== "app" && s !== "pkg");
    const testSegs = toPosixPath( posix.dirname(testPath) )
        .split("/")
        .filter((s) => s && s !== "." && !/^(?:__tests__|tests?|specs?|bench|benchmarks?)$/i.test(s));
    let shared = 0;
    const len = Math.min(srcSegs.length, testSegs.length);
    for (let i = 0; i < len; i++) {
        if (srcSegs[srcSegs.length - 1 - i] === testSegs[testSegs.length - 1 - i]) {
            shared += 1;
        } else {
            break;
        }
    }
    return shared;
}

function collectDirectAndCompanionTestLinks(graph, byId, testFiles, prodFilesByStem, recordFileTest, recordSymbolTest) {
    // Track 1-hop file imports from non-test files (e.g. `src/index.js` -> `src/foo/bar.js`)
    // so a test importing `src/index.js` still links to its barrel-exported modules when needed.
    const fileImportsOut = new Map();
    for (const e of graph.edges) {
        if (e.relation === "imports") {
            const sNode = byId.get(e.source);
            const tNode = byId.get(e.target);
            if (sNode?.kind === "file" && tNode?.kind === "file" && !isTestPath(sNode.path) && !isTestPath(tNode.path)) {
                pushMap(fileImportsOut, sNode.path, tNode.path);
            }
        }
    }

    // 1. Direct symbol edges & module imports from test files
    for (const e of graph.edges) {
        if (e.relation === "contains") continue;
        const srcNode = byId.get(e.source);
        const tgtNode = byId.get(e.target);
        if (!srcNode || !tgtNode) continue;
        const srcPath = srcNode.path;
        const tgtPath = tgtNode.path;
        if (!srcPath || !tgtPath || !isTestPath(srcPath) || isTestPath(tgtPath)) continue;

        if (e.relation === "imports" || tgtNode.kind === "file") {
            recordFileTest(tgtPath, srcPath, "module_import");
            const barrelTargets = fileImportsOut.get(tgtPath) ?? [];
            const testStem = canonicalFileStem(srcPath);
            for (const bt of barrelTargets) {
                if (canonicalFileStem(bt) === testStem || barrelTargets.length <= 4) {
                    recordFileTest(bt, srcPath, "module_import");
                }
            }
        } else {
            recordSymbolTest(tgtNode.id, tgtPath, srcPath, "symbol_call");
        }
    }

    // 2. Stem-companion pairing (`foo.test.ts` <-> `foo.ts`)
    for (const tPath of testFiles) {
        const stem = canonicalFileStem(tPath);
        if (!stem || stem.length < 2) continue;
        const candidates = prodFilesByStem.get(stem);
        if (!candidates || candidates.length === 0) continue;
        if (candidates.length === 1) {
            recordFileTest(candidates[0], tPath, "stem_companion");
        } else {
            let bestSim = -1;
            let best = [];
            for (const c of candidates) {
                const sim = directorySimilarity(c, tPath);
                if (sim > bestSim) {
                    bestSim = sim;
                    best = [c];
                } else if (sim === bestSim) {
                    best.push(c);
                }
            }
            if (best.length === 1 || bestSim >= 1) {
                for (const c of best) {
                    recordFileTest(c, tPath, "stem_companion");
                }
            }
        }
    }
}

function formatTestEntries(map) {
    if (!map || map.size === 0) return [];
    return [...map.entries()]
        .map(([testFile, kind]) => ({ testFile, kind }))
        .sort((a, b) => TIER_RANK[b.kind] - TIER_RANK[a.kind] || a.testFile.localeCompare(b.testFile));
}

function buildTestLinksLookupResult(symbolTests, fileTests, byId) {
    return {
        symbolTests,
        fileTests,
        /** All test entries covering `symbolId` (including file-level module/companion tests when `includeFileLevel` is true). */
        testsForSymbol(symbolId, filePath = null, includeFileLevel = true) {
            const merged = new Map();
            const symMap = symbolTests.get(symbolId);
            if (symMap) {
                for (const [tf, kind] of symMap) merged.set(tf, kind);
            }
            if (includeFileLevel) {
                const resolvedPath = filePath ?? byId.get(symbolId)?.path ?? null;
                const fMap = resolvedPath ? fileTests.get(resolvedPath) : null;
                if (fMap) {
                    for (const [tf, kind] of fMap) {
                        const prev = merged.get(tf);
                        if (!prev || TIER_RANK[kind] > TIER_RANK[prev]) {
                            merged.set(tf, kind);
                        }
                    }
                }
            }
            return formatTestEntries(merged);
        },
        /** All test entries covering `filePath`. */
        testsForFile(filePath) {
            return formatTestEntries(fileTests.get(filePath));
        },
    };
}

/**
 * Build and memoize test coverage links for `graph`.
 */
export function linkTestsForGraph(graph) {
    if (
        graph._testLinks &&
        graph._testLinksNodeLen === graph.nodes.length &&
        graph._testLinksEdgeLen === graph.edges.length
    ) {
        return graph._testLinks;
    }

    const byId = graph._byId ?? new Map(graph.nodes.map((n) => [n.id, n]));
    const testFiles = [];
    const prodFiles = [];
    const prodFilesByStem = new Map();

    for (const n of graph.nodes) {
        if (n.kind !== "file") continue;
        if (isTestPath(n.path)) {
            testFiles.push(n.path);
        } else {
            prodFiles.push(n.path);
            const stem = canonicalFileStem(n.path);
            if (stem && stem.length >= 2) {
                pushMap(prodFilesByStem, stem, n.path);
            }
        }
    }

    const symbolTests = new Map();
    const fileTests = new Map();

    const recordFileTest = (prodPath, testPath, kind) => {
        if (!prodPath || !testPath || isTestPath(prodPath)) return;
        let m = fileTests.get(prodPath);
        if (!m) {
            m = new Map();
            fileTests.set(prodPath, m);
        }
        const prev = m.get(testPath);
        if (!prev || TIER_RANK[kind] > TIER_RANK[prev]) {
            m.set(testPath, kind);
        }
    };

    const recordSymbolTest = (symId, prodPath, testPath, kind) => {
        let m = symbolTests.get(symId);
        if (!m) {
            m = new Map();
            symbolTests.set(symId, m);
        }
        const prev = m.get(testPath);
        if (!prev || TIER_RANK[kind] > TIER_RANK[prev]) {
            m.set(testPath, kind);
        }
        recordFileTest(prodPath, testPath, kind);
    };

    collectDirectAndCompanionTestLinks(graph, byId, testFiles, prodFilesByStem, recordFileTest, recordSymbolTest);

    const result = buildTestLinksLookupResult(symbolTests, fileTests, byId);
    graph._testLinks = result;
    graph._testLinksNodeLen = graph.nodes.length;
    graph._testLinksEdgeLen = graph.edges.length;
    return result;
}
