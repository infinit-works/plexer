import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    extractLiterals,
    isTokenDroppedByTokenize,
    stemCounts,
    stemToken,
    tokenize,
    tokenizeExact,
} from "../src/ask/tokenize.js";
import {
    queryAskPostings,
    readAskIndex,
    writeAskIndex,
} from "../src/ask/index-file.js";
import { DatabaseSync } from "node:sqlite";
import { closeSqliteStores, sqliteStorePath } from "../src/storage/sqlite-store.js";
import { ask, formatAsk } from "../src/ask/ask.js";
import { personalizedPageRank } from "../src/ask/graph-rank.js";
import { combineComparableScopes } from "../src/ask/fuse.js";
import { isRedundantSnippet } from "../src/ask/text-helpers.js";
import {
    canFastSliceExplicitSpans,
    formatReadSpans,
    readSpans,
} from "../src/ask/read-spans.js";
import { formatSkeleton, skeleton } from "../src/ask/skeleton.js";
import { readSourceFile } from "../src/util/source.js";
import { fileReader } from "../src/util/span.js";
import { grepGraph, grepGraphMany } from "../src/search/grep.js";
import {
    formatGrepResult,
    runGrepCommand,
    zeroHitNote,
} from "../src/search/grep-cli.js";
import { compileSafeUserRegex } from "../src/search/user-regexp.js";
import {
    edgeWalk,
    impactOfMany,
    MAX_CLOSURE_NODES,
} from "../src/graph/traverse.js";
import { runCallersCommand } from "../src/graph/traverse-cli.js";
import { buildRepoMap, formatRepoMap } from "../src/graph/map.js";
import {
    applyHunks,
    readPreImageFile,
    readPreImageFilesBatch,
} from "../src/blast/diff.js";
import { blastRadius, importSpecMatchesPath } from "../src/blast/blast.js";
import { textReport } from "../src/blast/render.js";
import { ownersFor } from "../src/blast/owners.js";
import { contextDirFor } from "../src/context/node-file.js";
import { loadGraphCached } from "../src/context/graph-store.js";
import { buildGraph } from "../src/index.js";
import {
    createTempTracker,
    initGitCommit,
    runPlexerCli,
    writeFilesAndCommit,
} from "./helpers/git-fixture.js";

const tracker = createTempTracker("plexer-wave2-");
after(() => {
    closeSqliteStores();
    tracker.cleanup();
});

function commitRepo(root, files, message = "update") {
    for (const [rel, content] of Object.entries(files)) {
        const full = join(root, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", message], { cwd: root });
}

describe("Wave 2: Tokenize, Index, Ask, Spans, Search, Traverse, Map & Blast", () => {
    it("tokenize handles double-consonant -er/-or, compound stems, and tightened structured literals", () => {
        assert.equal(stemToken("logger"), "log");
        assert.equal(stemToken("wrapper"), "wrap");
        assert.equal(stemToken("runner"), "run");
        assert.equal(stemToken("caller"), "call");
        assert.equal(stemToken("processor"), "process");
        assert.equal(stemToken("accessor"), "access");
        assert.ok(!tokenize("logger").includes("logg"));
        const sc = stemCounts(new Map([["mtime", 1], ["bits", 1]]));
        assert.equal(sc.get("modify"), 1);
        assert.equal(sc.get("time"), 1);
        assert.equal(sc.get("binary"), 1);

        assert.equal(isTokenDroppedByTokenize("a"), true);
        assert.equal(isTokenDroppedByTokenize("from"), true);
        assert.equal(isTokenDroppedByTokenize("compute"), false);

        const lits = extractLiterals([
            "const x = a - 10; // -delta negative expression",
            "-- luau comment line with --not-a-flag",
            "/* block comment path/to/ignored */",
            "const re = /foo/g;",
            "function fn(x:string, n:number, cfg:CustomCfg) {",
            '  run("--dry-run", x);',
            "}",
        ].join("\n"));
        assert.ok(!lits.includes("-10"));
        assert.ok(!lits.includes("-delta"));
        assert.ok(!lits.includes("--not-a-flag"));
        assert.ok(!lits.includes("path/to/ignored"));
        assert.ok(!lits.includes("/foo/g"));
        assert.ok(!lits.includes("x:string"));
        assert.ok(!lits.includes("n:number"));
        assert.ok(lits.includes("cfg:customcfg"));
        assert.ok(lits.includes("--dry-run"));
    });

    it("index-file keeps stem body-only, trims exact_ident, caches docs, prunes vanished nodes, and updates lens_sums_json", async () => {
        const repo = tracker.makeTempDir("w2-index-");
        writeFilesAndCommit(repo, {
            "docs/guide.md": "# Guide\nHow payment settlement works.\n",
            "src/alpha.js": "export function computeOrder() { return fromHelper(); }\n",
            "src/beta.js": "export function otherFn() { return 1; }\n",
        });
        await buildGraph(repo);
        const outDir = contextDirFor(repo);
        const g1 = loadGraphCached(outDir);

        // stem channel must contain body stems only, NOT symbol/path-only tokens like "alpha"
        const alphaPostings = queryAskPostings(outDir, { stem: ["alpha", "comput"] });
        assert.equal(alphaPostings.postings.stem.get("alpha")?.length ?? 0, 0);
        // exact_ident channel skips tokens kept by tokenize() ("otherFn"), keeps dropped tokens ("from")
        const exactPostings = queryAskPostings(outDir, { exact_ident: ["otherFn", "from", "fromHelper"] });
        assert.equal(exactPostings.postings.exact_ident.get("otherFn")?.length ?? 0, 0);
        assert.ok((exactPostings.postings.exact_ident.get("from")?.length ?? 0) > 0);

        const db = new DatabaseSync(sqliteStorePath(outDir), { readOnly: true });
        const beforeDocsVersion = db.prepare("SELECT doc_id FROM ask_docs WHERE kind = 'doc'").all();
        assert.equal(beforeDocsVersion.length, 1);
        const metaRaw = db.prepare("SELECT value FROM meta WHERE key = 'lens_sums_json'").get();
        assert.ok(metaRaw && typeof metaRaw.value === "string");
        const sumsBefore = JSON.parse(metaRaw.value);
        assert.ok(sumsBefore.name > 0 && sumsBefore.stem > 0);
        db.close();

        // Incremental rebuild with deleted src/beta.js passed via deletedPaths omitted (only codeNodes updated)
        const g2 = {
            ...g1,
            nodes: g1.nodes.filter((n) => n.path !== "src/beta.js"),
        };
        writeAskIndex(outDir, g2, { repoRoot: repo });
        const q2 = queryAskPostings(outDir, { stem: ["comput"] });
        assert.ok(q2);
        assert.equal(typeof q2.vocab, "object");
        const db2 = new DatabaseSync(sqliteStorePath(outDir), { readOnly: true });
        const betaLeft = db2.prepare("SELECT doc_id FROM ask_docs WHERE path = 'src/beta.js'").all();
        assert.equal(betaLeft.length, 0);
        db2.close();
        assert.equal(existsSync(sqliteStorePath(outDir)), true);

        // Preloaded markdownDocs uses item.content without reading non-existent absPath
        writeAskIndex(outDir, g2, {
            repoRoot: repo,
            dirtyPaths: ["src/alpha.js"],
            markdownDocs: [{
                relPath: "docs/inmem.md",
                absPath: join(repo, "docs/does-not-exist-on-disk.md"),
                content: "# InMemoryGuide\nPreloaded content token inmemtoken.\n",
                hash: "inmem-hash-1",
            }],
        });
        const inMemPostings = queryAskPostings(outDir, { stem: ["inmemtoken"] });
        assert.ok((inMemPostings.postings.stem.get("inmemtoken")?.length ?? 0) > 0);
    });

    it("ask, graph-rank, fuse, and text-helpers normalize single-scope, prune PPR, and compact output", async () => {
        const repo = tracker.makeTempDir("w2-ask-");
        writeFilesAndCommit(repo, {
            "src/sub/billing.js": [
                "export const TAX_RATE = 0.08;",
                "export function computeInvoiceTotal(items) {",
                "  return items.reduce((s, x) => s + x.price * (1 + TAX_RATE), 0);",
                "}",
            ].join("\n"),
            "src/other/unrelated.js": [
                "export function renderBadge() { return 'ok'; }",
            ].join("\n"),
        });
        await buildGraph(repo);

        const singleScope = ask(repo, "computeInvoiceTotal", { in: "src/sub", source: true });
        assert.ok(singleScope.hits.length >= 1);
        assert.ok(singleScope.hits[0].title.includes("computeInvoiceTotal"));
        const txt = formatAsk(singleScope);
        // 1-line title + pointer without [symbol] tag
        assert.ok(!txt.includes("[symbol]"));
        assert.ok(/1\. computeInvoiceTotal · function — src\/sub\/billing\.js:L2-L4/.test(txt));

        // graph-rank pruning preserves seeds & above-floor neighbors, drops tiny tails
        const pprGraph = {
            nodes: [
                { id: "seed", kind: "function", name: "seed", path: "a.js" },
                { id: "warm", kind: "function", name: "warm", path: "a.js" },
                { id: "cold", kind: "function", name: "cold", path: "b.js" },
            ],
            edges: [
                { source: "seed", target: "warm", relation: "calls" },
                { source: "warm", target: "cold", relation: "calls" },
            ],
        };
        const unpruned = personalizedPageRank(pprGraph, new Map([["seed", 1]]), {});
        const pruned = personalizedPageRank(pprGraph, new Map([["seed", 1]]), { rescueFloor: 0.65 });
        assert.ok((unpruned.get("cold") ?? 0) > 0);
        assert.equal(pruned.has("seed"), true);
        assert.equal(pruned.has("cold"), false);

        // fuse single-scope passthrough normalization to [0, 1]
        const fused = combineComparableScopes([
            { scope: "sub", score: 10, id: "a" },
            { scope: "sub", score: 5, id: "b" },
        ]);
        assert.equal(fused.ranked[0].score, 1);
        assert.equal(fused.ranked[1].score, 0.5);

        // isRedundantSnippet inspects L<start>: line when pointer is passed
        const withConst = [
            "L1: export const TAX_RATE = 0.08;",
            "L2: export function computeInvoiceTotal(items) {",
        ].join("\n");
        assert.equal(
            isRedundantSnippet("export function computeInvoiceTotal(items) {", withConst, "src/sub/billing.js:L2-L4"),
            true,
        );
        assert.equal(
            isRedundantSnippet("export const DIFFERENT = 1;", withConst, "src/sub/billing.js:L2-L4"),
            false,
        );
    });

    it("source, span, read-spans, and skeleton strip BOM/trailing-newline, qualify methods, coalesce transitively, and enforce caps", async () => {
        const repo = tracker.makeTempDir("w2-spans-");
        const bomContent = "\uFEFF" + [
            "class ClassA {",
            "  render() { return 'a'; }",
            "}",
            "class ClassB {",
            "  render() { return 'b'; }",
            "}",
            "",
        ].join("\n");
        const bigLines = Array.from({ length: 45 }, (_, i) => `export function fn${i}() { return ${i}; }\n`).join("");
        const manyFiles = {};
        for (let i = 0; i < 15; i++) {
            manyFiles[`src/many/m${String(i).padStart(2, "0")}.js`] =
                `export function handler_${i}_very_long_name_padding() { return ${i}; }\n`.repeat(12);
        }
        writeFilesAndCommit(repo, {
            "src/view.js": bomContent,
            "src/big.js": bigLines,
            "src/CaseFile.js": "export function upperCaseFn() { return 1; }\n",
            "src/casefile.js": "export function lowerCaseFn() { return 2; }\n",
            ...manyFiles,
        });

        // BOM stripped & trailing empty string popped
        assert.ok(!readSourceFile(join(repo, "src/view.js")).startsWith("\uFEFF"));
        const fr = fileReader(repo);
        const f = fr("src/view.js");
        assert.equal(f.length, 6);

        // Fast-slice check strips rootPrefix
        assert.equal(canFastSliceExplicitSpans(repo, [`${join(repo, "src/view.js")}:1-2`]), true);

        // Error when :symbol requested without graph
        const noGraphRes = readSpans(repo, ["src/view.js:render"]);
        assert.ok(noGraphRes.blocks[0].error);

        await buildGraph(repo);

        // Qualified match prefers ClassB.render over ClassA.render
        const qualRes = readSpans(repo, ["src/view.js:ClassB.render"]);
        assert.equal(qualRes.blocks[0].error, undefined);
        assert.equal(qualRes.blocks[0].startLine, 5);
        assert.ok(qualRes.blocks[0].code.includes("return 'b'"));

        // Out-of-range start line produces explicit error
        const oobRes = readSpans(repo, ["src/view.js:99-100"]);
        assert.ok(/out of range/i.test(oobRes.blocks[0].error));

        // Transitive coalescing: [1-5], [10-15], [4-11] -> single merged span [1-15]
        const coalesced = readSpans(repo, ["src/big.js:1-5", "src/big.js:10-15", "src/big.js:4-11"]);
        assert.equal(coalesced.blocks.length, 1);
        assert.equal(coalesced.blocks[0].startLine, 1);
        assert.equal(coalesced.blocks[0].endLine, 15);

        // Edge-trim marker when seenSpans covers >=20 leading lines (<85% covered so not skipped wholly)
        const trimmed = readSpans(repo, ["src/big.js:1-45"], {
            seenSpans: { "src/big.js": [[1, 20]] },
        });
        assert.ok(trimmed.blocks[0].code.includes("[seen:"));

        // Skeleton colliding case files distinct + directory >12 truncation + 8800B cap
        const skelDir = skeleton(repo, "src/many");
        assert.ok(skelDir.omittedFiles > 0);
        const skelDirText = formatSkeleton(skelDir);
        assert.ok(Buffer.byteLength(skelDirText, "utf8") <= 8800);

        const skelUpper = skeleton(repo, "CaseFile.js");
        const skelLower = skeleton(repo, "casefile.js");
        assert.equal(skelUpper.file, "src/CaseFile.js");
        assert.equal(skelLower.file, "src/casefile.js");
        // Different-case non-exact lookup must see ambiguity instead of merging both into one file
        const skelCi = skeleton(repo, "Casefile.js");
        assert.ok(skelCi.error || skelCi.candidates?.length === 2 || skelCi.matches?.length === 2);
    });

    it("grep, grep-cli, and user-regexp support multiline, literal --fixed, inDegree, bounded quantifiers, and multi-pattern dedup", async () => {
        const repo = tracker.makeTempDir("w2-grep-");
        writeFilesAndCommit(repo, {
            "src/a.js": [
                "import { helper } from './b.js';",
                "export function alpha() {",
                "  return helper();",
                "}",
            ].join("\r\n") + "\r\n",
            "src/b.js": "export function helper() { return 1; }\n",
            "src/config.js": 'const val = "a | b";\nexport const onlyA = "a";\n',
        });
        await buildGraph(repo);
        const graph = loadGraphCached(contextDirFor(repo));

        // Multiline ^ / $ over CRLF
        const mRes = grepGraph(graph, repo, "^export function alpha", { in: "src" });
        assert.equal(mRes.groups.length, 1);
        assert.equal(mRes.groups[0].path, "src/a.js");

        // --fixed keeps "|" strictly literal and pops trailing newline so -C doesn't include phantom L+1
        const fRes = grepGraph(graph, repo, "a | b", { fixed: true, context: 2 });
        assert.equal(fRes.groups.length, 1);
        assert.ok(fRes.groups[0].hits[0].text.includes("a | b"));
        assert.ok(fRes.groups[0].contextBlocks[0].lines.every((l) => l.line <= 2));

        // module-level hit gets inDegree from graph
        const modRes = grepGraph(graph, repo, "const val", {});
        assert.equal(modRes.groups.length, 1);
        assert.equal(typeof modRes.groups[0].inDegree, "number");

        // user-regexp: bounded {3} allowed; case-folded (a|A)+ rejected; branch whitespace kept
        assert.ok(compileSafeUserRegex("^(foo|bar){3}$"));
        assert.throws(() => compileSafeUserRegex("(a|A)+", "i"), /catastrophic backtracking/i);
        assert.ok(compileSafeUserRegex(" a | b ").test(" a "));

        // Multi-pattern single-pass scan + cross-pattern dedup + 0 in-edges omitted
        const multi = grepGraphMany(graph, repo, ["helper", "export function helper"], {});
        assert.equal(multi.length, 2);
        const cmdOut = runPlexerCli(repo, ["grep", "helper", "export function helper"]);
        assert.equal(cmdOut.status, 0);
        assert.ok(cmdOut.stdout.includes("helper"));
        assert.ok(!cmdOut.stdout.includes("0 in-edges"));
        const z = zeroHitNote({ pattern: "missing", filesSearched: 3, truncated: { files: 0 } });
        assert.ok(!z.includes("\n"));
    });

    it("traverse, traverse-cli, and map deduplicate edges, detect truncation, surface unlinked calls, and respect caps", async () => {
        const repo = tracker.makeTempDir("w2-trav-");
        writeFilesAndCommit(repo, {
            "src/target.js": [
                "export class Worker {",
                "  runTask() { return 42; }",
                "}",
            ].join("\n"),
            "src/caller.js": [
                "import { Worker } from './target.js';",
                "export function useWorker(w) {",
                "  return w.runTask();",
                "}",
            ].join("\n"),
            "src/string-only.js": [
                "import { Worker } from './target.js';",
                "export function justString(w) {",
                "  const ignored = 'w.runTask()';",
                "  return ignored;",
                "}",
            ].join("\n"),
            "src/orphan.js": "export function neverCalled() { return 0; }\n",
        });
        await buildGraph(repo);
        const graph = loadGraphCached(contextDirFor(repo));

        // Direct traverse dedup & truncation flag check
        const fakeNodes = [
            { id: "n0", kind: "function", name: "root", path: "a.js", startLine: 1, endLine: 2 },
            { id: "n1", kind: "function", name: "child", path: "a.js", startLine: 3, endLine: 4 },
        ];
        const fakeGraph = {
            nodes: fakeNodes,
            edges: [
                { source: "n0", target: "n0", relation: "calls" }, // self-loop skipped
                { source: "n0", target: "n1", relation: "references" },
                { source: "n0", target: "n1", relation: "calls" },
            ],
        };
        const walked = edgeWalk(fakeGraph, fakeNodes[0], "out", 1);
        assert.equal(walked.length, 1);
        assert.equal(walked[0].relation, "calls");

        const exactNodes = Array.from({ length: MAX_CLOSURE_NODES + 1 }, (_, i) => ({
            id: `e${i}`,
            kind: "function",
            name: `ex${i}`,
            path: "exact.js",
            startLine: i + 1,
            endLine: i + 1,
        }));
        const exactEdges = exactNodes.slice(1).map((n) => ({ source: "e0", target: n.id, relation: "calls" }));
        const impExact = impactOfMany({ nodes: exactNodes, edges: exactEdges }, [exactNodes[0]], Number.POSITIVE_INFINITY, "out");
        assert.equal(impExact.length, MAX_CLOSURE_NODES);
        assert.equal(Boolean(impExact.truncated), false);

        const bigNodes = Array.from({ length: MAX_CLOSURE_NODES + 5 }, (_, i) => ({
            id: `b${i}`,
            kind: "function",
            name: `f${i}`,
            path: "big.js",
            startLine: i + 1,
            endLine: i + 1,
        }));
        const bigEdges = bigNodes.slice(1).map((n) => ({ source: "b0", target: n.id, relation: "calls" }));
        const imp = impactOfMany({ nodes: bigNodes, edges: bigEdges }, [bigNodes[0]], Number.POSITIVE_INFINITY, "out");
        assert.equal(imp.truncated, true);

        // Callers output strips strings in unlinked scan, omits "unlinked scan: 0" when callers found, keeps on 0-caller symbols
        const callersHit = runPlexerCli(repo, ["callers", "runTask"]);
        assert.equal(callersHit.status, 0);
        assert.ok(callersHit.stdout.includes("useWorker") || callersHit.stdout.includes("src/caller.js"));
        assert.ok(!callersHit.stdout.includes("unlinked scan: 0 unlinked references"));
        assert.ok(!callersHit.stdout.includes("justString"));

        const zeroHit = runPlexerCli(repo, ["callers", "neverCalled"]);
        assert.equal(zeroHit.status, 0);
        assert.ok(/unlinked scan: 0 unlinked references across \d+ reachable files/.test(zeroHit.stdout));

        const outDirRes = runPlexerCli(repo, ["callers", "useWorker", "--direction", "out"]);
        assert.equal(outDirRes.status, 0);
        assert.ok(outDirRes.stdout.includes("→"));
        assert.ok(!outDirRes.stdout.includes("callers"));

        // Map long directory separator & 8800B cap
        const manyDirsGraph = {
            repoRoot: repo,
            nodes: Array.from({ length: 120 }, (_, i) => ({
                id: `f${i}`,
                kind: "file",
                name: `mod${i}.js`,
                path: `packages/very-long-directory-name-${String(i).padStart(3, "0")}/src/mod${i}.js`,
                startLine: 1,
                endLine: 10,
                language: "javascript",
            })).concat(
                Array.from({ length: 120 }, (_, i) => ({
                    id: `s${i}`,
                    kind: "function",
                    name: `exportedSymbolNumber${i}`,
                    path: `packages/very-long-directory-name-${String(i).padStart(3, "0")}/src/mod${i}.js`,
                    startLine: 2,
                    endLine: 5,
                    exported: true,
                    language: "javascript",
                })),
            ),
            edges: [],
        };
        const map = buildRepoMap(manyDirsGraph);
        const mapText = formatRepoMap(map);
        assert.ok(Buffer.byteLength(mapText, "utf8") <= 8800);
        assert.ok(/packages\/very-long-directory-name-\d+[^\s]*\s+\S/.test(mapText));
    });

    it("blast handles pure deletions, pure insertions, subdir pre-image, cat-file binary/missing, import extensions, private helpers, owners cache, and caveat truncation", async () => {
        const repo = tracker.makeTempDir("w2-blast-");
        writeFilesAndCommit(repo, {
            "pkg/sub/mod.js": [
                "function privateHelper() { return 1; }",
                "export function bar() { return 2; }",
                "",
                "// separator",
                "export function foo() { return 3; }",
            ].join("\n"),
            "pkg/sub/consumer.js": [
                "import { bar, foo } from './mod.js';",
                "export function run() { return bar() + foo(); }",
            ].join("\n"),
            "pkg/utf8.txt": "café 🚀 multibyte line\n",
        });
        writeFileSync(join(repo, "pkg/bin.dat"), Buffer.from([0x00, 0x0a, 0x41, 0x42, 0x00, 0x0d, 0x0a, 0xff]));
        execFileSync("git", ["add", "pkg/bin.dat"], { cwd: repo });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "add binary"], { cwd: repo });
        const commit2Sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
        commitRepo(repo, { "pkg/utf8.txt": "café 🚀 multibyte line v2\n", "pkg/sub/other.js": "export const o = 1;\n" }, "third commit");

        // Verify subdirectory pre-image + cat-file --batch missing/tree/binary/utf8 handling
        const pre = readPreImageFile(repo, "HEAD", "pkg/sub/mod.js");
        assert.ok(pre && pre.includes("export function foo()"));
        const batch = readPreImageFilesBatch(repo, "HEAD", [
            "pkg/sub/mod.js",
            "pkg/sub/consumer.js",
            "pkg/utf8.txt",
            "pkg/bin.dat",
            "pkg/does-not-exist.js",
            "pkg/sub",
        ]);
        assert.equal(batch.size, 4);
        assert.equal(batch.get("pkg/utf8.txt"), "café 🚀 multibyte line v2\n");
        assert.equal(batch.get("pkg/does-not-exist.js"), undefined);
        assert.equal(batch.get("pkg/sub"), undefined);
        assert.ok(batch.get("pkg/bin.dat")?.includes("AB"));

        // Owners cache does not cache partial/starved results from a capped -n batch (even when commits.length >= 1)
        const starved = ownersFor(repo, ["pkg/utf8.txt", "pkg/sub/other.js"], { maxCommits: 1 });
        assert.equal(starved[0].commits, 1);
        // Uncapped ownersFor must NOT read the partial 1-commit result cached above; must see all 2 commits
        const fullOwners = ownersFor(repo, ["pkg/utf8.txt"]);
        assert.equal(fullOwners.length, 1);
        assert.equal(fullOwners[0].commits, 2);
        void commit2Sha;

        // importSpecMatchesPath strips extensions before replacing dots with slashes
        assert.equal(importSpecMatchesPath("src/a.ts", "@scope/widget.ts", "pkg/sub/widget.ts"), true);

        // applyHunks pure deletion marks pureDeletion, preserves rawStart, and clamps start >= 1
        const hunkFiles = [{ path: "pkg/sub/mod.js", status: "modified", ranges: [], hunks: [], lines: [] }];
        applyHunks(
            hunkFiles,
            [
                "diff --git a/pkg/sub/mod.js b/pkg/sub/mod.js",
                "--- a/pkg/sub/mod.js",
                "+++ b/pkg/sub/mod.js",
                "@@ -1,2 +0,0 @@",
                "-line1",
                "-line2",
            ].join("\n"),
        );
        assert.equal(hunkFiles[0].ranges[0].start, 1);
        assert.equal(hunkFiles[0].ranges[0].pureDeletion, true);

        // Pure-deletion interior anchor (line 2 deleted in 4-line fn L1-4 -> hunk +1,0) seeds foo (API path without rootDir)
        const delGraph = {
            nodes: [
                { id: "a.js", kind: "file", name: "a.js", path: "a.js", span: "L1-L4", exported: true },
                { id: "a.js#foo", kind: "function", name: "foo", path: "a.js", span: "L1-L4", exported: true },
                { id: "a.js#bar", kind: "function", name: "bar", path: "a.js", span: "L5-L8", exported: true },
                { id: "b.js#useFoo", kind: "function", name: "useFoo", path: "b.js", span: "L1-L3", exported: true },
            ],
            edges: [
                { source: "b.js#useFoo", target: "a.js#foo", relation: "calls" },
            ],
        };
        const interiorFiles = [{ path: "a.js", status: "modified", ranges: [], oldRanges: [], hunks: [], lines: [] }];
        applyHunks(interiorFiles, [
            "diff --git a/a.js b/a.js",
            "--- a/a.js",
            "+++ b/a.js",
            "@@ -2,1 +1,0 @@",
            "-  const deletedInsideFoo = 1;",
        ].join("\n"));
        const interiorBlast = blastRadius(delGraph, interiorFiles, "working tree");
        assert.equal(interiorBlast.seeds.some((s) => s.id === "a.js#foo"), true);
        assert.equal(interiorBlast.impacted.some((s) => s.id === "b.js#useFoo"), true);

        // Build graph for private helper check
        await buildGraph(repo);
        const graph = loadGraphCached(contextDirFor(repo));
        writeFileSync(
            join(repo, "pkg/sub/mod.js"),
            [
                "function privateHelper() { return 99; }",
                "export function bar() { return 2; }",
                "",
                "// separator",
                "export function foo() { return 3; }",
            ].join("\n"),
            "utf8",
        );
        const blastPriv = blastRadius(graph, [{
            path: "pkg/sub/mod.js",
            status: "modified",
            ranges: [{ start: 1, end: 1 }],
            lines: ["function privateHelper() { return 99; }"],
        }], "working tree");
        assert.equal(blastPriv.impacted.filter((x) => x.path === "pkg/sub/consumer.js").length, 0);

        // Render textReport caps huge impacted lists <= 8192B AND preserves uncovered deleted/unindexed caveats!
        const makeHugeMods = () => [0, 1, 2].map((mIdx) => ({
            label: `area_${mIdx}`,
            role: "source",
            from: mIdx === 0 ? ["src/core.js"] : [],
            files: Array.from({ length: 25 }, (_, i) => `src/area_${mIdx}/sub_component_${i}/extra_nested_directory_padding_segment/handler_${i}.js`),
            symbols: Array.from({ length: 25 }, (_, i) => ({
                id: `sym_${mIdx}_${i}`,
                kind: "function",
                name: `impactedHandler_${mIdx}_${i}_very_long_descriptive_symbol_name`,
                path: `src/area_${mIdx}/sub_component_${i}/extra_nested_directory_padding_segment/handler_${i}.js`,
                span: "L10-L20",
                startLine: 10,
                endLine: 20,
                depth: 1,
                relation: "calls",
                chain: [],
                exported: true,
            })),
        }));
        const hugeTxt = textReport({
            basis: "main...HEAD",
            depth: 2,
            changed: [{ path: "src/core.js", status: "modified" }],
            deleted: ["src/core.js", "src/uncovered-deleted.js"],
            unindexed: ["src/unindexed.xyz"],
            areas: [{ label: "src", tests: "none", files: ["src/core.js"], reached: 0, behavioural: 1 }],
            seeds: [{ id: "seed", kind: "function", name: "coreFn", path: "src/core.js", span: "L1-L5", startLine: 1, endLine: 5 }],
            modules: makeHugeMods(),
            testModules: [],
            tests: [],
            coupling: [],
            untracked: [],
            reviewers: [],
            coChanges: [],
            layerViolations: [],
            healthHotspots: [],
            truncated: false,
            warnings: [],
        });
        assert.ok(Buffer.byteLength(hugeTxt, "utf8") <= 8192);
        assert.ok(hugeTxt.includes("truncated to 8 KB"));
        assert.ok(hugeTxt.includes("src/uncovered-deleted.js"));
        assert.ok(hugeTxt.includes("src/unindexed.xyz"));
        assert.ok(!hugeTxt.includes("src/core.js, src/uncovered-deleted.js"));
    });

    it("CLI smoke: plexer blast from subdir resolves pre-image and seeds fileNode for deleted exported fn body", () => {
        const repo = tracker.makeTempDir("w2-cli-");
        writeFilesAndCommit(repo, {
            "pkg/lib.js": [
                "export function dropFn() {",
                "  const bodyLine = 1;",
                "  return bodyLine + 2;",
                "}",
            ].join("\n"),
            "pkg/use.js": [
                "import './lib.js';",
                "export function main() { return 1; }",
            ].join("\n"),
        });
        runPlexerCli(repo, ["build"]);
        commitRepo(repo, {
            "pkg/lib.js": [
                "export function dropFn() {",
                "  return 2;",
                "}",
            ].join("\n"),
        }, "delete bodyLine in dropFn");

        const res = runPlexerCli(join(repo, "pkg"), ["blast", "--base", "HEAD~1"]);
        assert.equal(res.status, 0);
        assert.ok(res.stdout.includes("dropFn"));
        assert.ok(res.stdout.includes("pkg/use.js"));
    });
});
