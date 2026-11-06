import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { namedIdentifiers, pinnedHits, pointerCovers, resolveNamedDefinitions } from "../src/claude/pin.js";
import { detectPromptIntent, isSyntheticOrMetaPrompt } from "../src/claude/hooks.js";
import { formatRetrieval, relevantRetrieval } from "../src/claude/format.js";
import { parseInjection, needCoverage } from "../bench/needcov.js";
import { readsFromBash, hitsFromResult, goldRanges } from "../bench/replay.js";

const graph = {
    nodes: [
        { id: "a.js#skeleton", name: "skeleton", kind: "function", path: "src/a.js", span: "L3-L6" },
        { id: "a.js#helper", name: "helper", kind: "function", path: "src/a.js", span: "L8-L9" },
        { id: "b.js#close", name: "close", kind: "method", path: "src/b.js", span: "L1-L2" },
        { id: "c.js#close", name: "close", kind: "method", path: "src/c.js", span: "L1-L2" },
        { id: "d.js#close", name: "close", kind: "method", path: "src/d.js", span: "L1-L2" },
        { id: "a.test.js#skeletonCase", name: "skeletonCase", kind: "function", path: "test/a.test.js", span: "L1-L3" },
        { id: "a.js#alias", name: "aliasName", kind: "variable", path: "src/a.js", span: "L11-L11" },
    ],
};

describe("pin: named-definition pinning", () => {
    it("extracts identifiers named as code (backticks, call syntax), skipping paths/flags/stopwords", () => {
        const ids = namedIdentifiers("Change `skeleton(repoDir, opts)` in `src/a.js`, add `--all-matches`, keep `true`; call helper() too.").map((x) => x.name);
        assert.ok(ids.includes("skeleton"));
        assert.ok(ids.includes("repoDir"));
        assert.ok(ids.includes("helper"));
        assert.ok(!ids.includes("true"));
        assert.ok(!ids.some((x) => x === "all" || x === "matches"));
    });

    it("resolves unique names, skips ambiguous names without a file hint, tests, and one-line aliases", () => {
        const pins = resolveNamedDefinitions(graph, "Fix `skeleton()` and `close()` and `skeletonCase` and `aliasName`");
        assert.deepEqual(pins.map((p) => p.node.id), ["a.js#skeleton"]);
        const hinted = resolveNamedDefinitions(graph, "Fix `close()`", { hintFiles: ["src/b.js"] });
        assert.deepEqual(hinted.map((p) => p.node.id), ["b.js#close"]);
    });

    it("inlines pinned bodies with L<n>: numbering and keeps them on top of the ranked cap", () => {
        const root = mkdtempSync(join(tmpdir(), "plexer-pin-"));
        try {
            mkdirSync(join(root, "src"), { recursive: true });
            writeFileSync(join(root, "src/a.js"), "// x\n\nfunction skeleton(dir) {\n  return 1;\n  // body\n}\n\nfunction helper() {\n}\n");
            const pins = pinnedHits(root, graph, "Update `skeleton(dir)`");
            assert.equal(pins.length, 1);
            assert.match(pins[0].code, /^L3: function skeleton\(dir\) \{/);
            assert.equal(pins[0].pointer, "src/a.js:L3-L6");
            const ranked = [1, 2, 3, 4, 5].map((i) => ({ kind: "symbol", title: `h${i}`, pointer: `src/z${i}.js:L1-L2` }));
            const txt = relevantRetrieval({ hits: [...pins, ...ranked], isEditPrompt: true }, {});
            assert.match(txt, /1\. skeleton · function \(named in prompt\)/);
            assert.match(txt, /h4/); // four ranked hits survive alongside the pin
            assert.doesNotMatch(txt, /h5/);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("pointerCovers only drops ranked hits fully inside a pin", () => {
        assert.equal(pointerCovers("f.js:L10-L50", "f.js:L20-L30"), true);
        assert.equal(pointerCovers("f.js:L20-L30", "f.js:L10-L50"), false);
        assert.equal(pointerCovers("f.js:L10-L50", "g.js:L20-L30"), false);
    });

    it("resolves receiver-qualified and exported overloaded definitions and suppresses un-inlined call sites", () => {
        const overloadGraph = {
            nodes: [
                { id: "src/Graph.luau#insert", name: "insert", kind: "function", path: "src/Graph.luau", span: "L10-L20", signature: "local function insert(n)", exported: false },
                { id: "src/Store.luau#insert", name: "insert", kind: "function", path: "src/Store.luau", span: "L30-L50", signature: "function Store.insert(p, v)", exported: true },
            ],
        };
        const qualPins = resolveNamedDefinitions(overloadGraph, "Use `Store.insert(proxy, v)` to mutate", { hintFiles: ["src/Graph.luau", "src/Store.luau"] });
        assert.deepEqual(qualPins.map((p) => p.node.id), ["src/Store.luau#insert"]);

        const exportPins = resolveNamedDefinitions(overloadGraph, "Helpers (`insert`) on store", { hintFiles: ["src/Graph.luau", "src/Store.luau"] });
        assert.deepEqual(exportPins.map((p) => p.node.id), ["src/Store.luau#insert"]);

        assert.deepEqual(detectPromptIntent("Implement custom CA cert in DesktopNetworkClient used by DesktopDownloadManager"), {
            editEnvelope: true,
            wantsCallSites: false,
        });
        assert.deepEqual(detectPromptIntent("Who calls hasPermission and where is it used across the codebase?"), {
            editEnvelope: false,
            wantsCallSites: true,
        });

        const formatted = formatRetrieval({
            isEditPrompt: false,
            hits: [
                {
                    kind: "symbol",
                    title: "hasPermission · function",
                    pointer: "src/Auth.luau:L10-L20",
                    code: "L10: function Auth.hasPermission() end",
                    wantsCallSites: false,
                    callSites: ["callerA (src/A.luau:L1-L5) → L3: Auth.hasPermission()"],
                },
                {
                    kind: "symbol",
                    title: "other · function",
                    pointer: "src/B.luau:L1-L10",
                    wantsCallSites: true,
                    callSites: ["callerB (src/C.luau:L1-L5) → L2: other()"],
                },
            ],
        });
        assert.ok(!formatted.includes("call sites ("), "non-caller Q&A hits and un-inlined pointer hits should not emit call sites blocks");
    });
});

describe("bench: replay + NeedCov parsing", () => {
    it("parses ranged and whole-file reads from shell commands", () => {
        const r = readsFromBash("cd /tmp/plexer-ab-opus-cold/flux; sed -n 70,160p src/Graph.luau; cat src/init.luau | head; nl -ba src/Clock.luau | sed -n '5,9p'; head -40 src/A.luau", "/tmp/plexer-ab-opus-cold/flux");
        assert.deepEqual(r, [
            { file: "src/Graph.luau", a: 70, b: 160 },
            { file: "src/init.luau", a: null, b: null },
            { file: "src/Clock.luau", a: 5, b: 9 },
            { file: "src/A.luau", a: 1, b: 40 },
        ]);
        assert.deepEqual(readsFromBash("python3 - <<'EOF'\nprint(open('src/x.py').read())\nEOF\n", null), []);
    });

    it("parses grep hits and gold hunks", () => {
        assert.deepEqual(hitsFromResult("src/a.js:12:foo\nsrc/b.ts-3-bar\nnoise", null, null), [
            { file: "src/a.js", line: 12 },
            { file: "src/b.ts", line: 3 },
        ]);
        assert.deepEqual(hitsFromResult("12:foo", null, "src/a.js"), [{ file: "src/a.js", line: 12 }]);
        assert.deepEqual(goldRanges("--- a/src/x.py\n+++ b/src/x.py\n@@ -10,3 +10,4 @@ def f():\n"), [{ file: "src/x.py", a: 10, b: 12 }]);
    });

    it("scores inlined vs pointed coverage per enclosing symbol", () => {
        const ctx = " 1. skeleton · function: src/a.js:L3-L6\n```\nL3: function skeleton(dir) {\nL4:   return 1;\n```\n 2. helper · function: src/a.js:L8-L9";
        const inj = parseInjection(ctx);
        assert.deepEqual([...inj.inl.get("src/a.js")], [3, 4]);
        const need = { reads: { "src/a.js": [[3, 6, "opus/cold"], [8, 9, "opus/cold"]] }, hits: {}, wholeFiles: {}, gold: {} };
        const nc = needCoverage(ctx, graph, need);
        assert.equal(nc.needCov, 0.25); // skeleton 2/4 lines inlined, helper 0/2 → (0.5 + 0) / 2
        assert.equal(nc.locCov, 1); // both symbols are named by a pointer
    });

    it("filters synthetic harness notifications, slash-only commands, and short operational follow-ups", () => {
        assert.equal(isSyntheticOrMetaPrompt("<task-notification>\n<task-id>wio2w1n2j</task-id>\nDone `skeleton()`"), true);
        assert.equal(isSyntheticOrMetaPrompt("Another Claude session sent a message: <agent-message from=\"abc\">Report</agent-message>"), true);
        assert.equal(isSyntheticOrMetaPrompt("<system-reminder>\n## The user forked this session from another session"), true);
        assert.equal(isSyntheticOrMetaPrompt("[Request interrupted by user]"), true);
        assert.equal(isSyntheticOrMetaPrompt("/plan /grill-me"), true);
        assert.equal(isSyntheticOrMetaPrompt("Commit steps 1 and 2."), true);
        assert.equal(isSyntheticOrMetaPrompt("Tested, commit Stage 1."), true);
        assert.equal(isSyntheticOrMetaPrompt("yes, go ahead and push"), true);
        assert.equal(isSyntheticOrMetaPrompt("Commit changes to `src/claude/hooks.js` and update `relevantRetrieval`"), false);
        assert.equal(isSyntheticOrMetaPrompt("How does `queryPromptContext` rank multi-clause edit prompts?"), false);
    });

    it("blocks short body-only collisions and prevents Turn 2+ tail promotion while allowing new symbols", () => {
        // Short 4-word conversational prompt with a single body-only collision (broad=0.33, strong=0) must not pass
        const session1 = {};
        const weakShort = relevantRetrieval(
            {
                query: "create random password",
                coverage: 0.33,
                coverageStrong: 0,
                hits: [{ kind: "symbol", title: "create_pool · function", pointer: "src/db.py:L4-L5", code: "L4: def create_pool(): pass" }],
            },
            session1,
        );
        assert.match(weakShort, /^\[plexer\] no strong match/);

        // Turn 1 injects top hit; Turn 2 with the same top hit already seen must NOT promote tail hits[1..3]
        const session2 = { injectedPointers: ["src/a.js:L1-L10"] };
        const tailAttempt = relevantRetrieval(
            {
                query: "follow up on the same flow",
                coverage: 0.45,
                coverageStrong: 0.25,
                hits: [
                    { kind: "symbol", title: "topHit · function", pointer: "src/a.js:L1-L10", code: "L1: function topHit() {}" },
                    { kind: "symbol", title: "tailHit · function", pointer: "src/b.js:L1-L10", code: "L1: function tailHit() {}" },
                ],
            },
            session2,
            4,
            { followUp: true },
        );
        assert.equal(tailAttempt, null, "Turn 2+ must not promote tail hits when topRanked was already injected");

        // Turn 2+ with a brand-new pinned symbol DOES inject and caps code to <= 1500B
        const longCode = Array.from({ length: 60 }, (_, i) => `L${i + 1}: const line_${i} = "${"x".repeat(35)}";`).join("\n");
        const followUpPin = relevantRetrieval(
            {
                query: "update newTarget",
                coverage: 0.5,
                coverageStrong: 0.4,
                isEditPrompt: true,
                hits: [
                    { kind: "symbol", title: "newTarget · function (named in prompt)", pointer: "src/c.js:L1-L60", pinned: true, code: longCode },
                ],
            },
            session2,
            4,
            { followUp: true },
        );
        assert.ok(followUpPin && followUpPin.includes("newTarget"), "Turn 2+ must inject newly named pin");
        assert.ok(Buffer.byteLength(followUpPin, "utf8") < 1800, "Turn 2+ injection must respect compact follow-up budget");
    });
});

