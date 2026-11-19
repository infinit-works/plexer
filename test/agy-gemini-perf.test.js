import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canFastSliceExplicitSpans, formatReadSpans, formatSkeleton, readSpans } from "../src/ask/ask.js";
import { buildGraph } from "../src/index.js";
import { runCli } from "../src/cli/cli-main.js";
import { startDaemon } from "../src/daemon/plexerd.js";
import { locateSwarmRoster } from "../src/agy/context-graph.js";
import { linkTestsForGraph } from "../src/graph/test-links.js";
import { fitAgyEphemeral, formatAgyUserMarkdown } from "../src/hosts/engine/agy-context.js";
import { agySessionPath, emptyAgySession, readAgySession, writeAgySession } from "../src/agy/session.js";
import { applySeenSpansFilter, extractInlinedSpansByFile, invalidateEditedSpans, recordEmittedRetrievalTextSpans, recordRetrievalSpans } from "../src/agy/spans.js";
import { checkSwarmEditCollision, seedForkedSwarmSession } from "../src/agy/swarm-sync.js";
import { parseAgyTranscript } from "../src/hosts/engine/agy-transcript.js";
import { buildPlanExecutionHandoff } from "../src/agy/plan-handoff.js";
import { computeReadPreToolWidening, rewriteChainedPlexerCommand, rewriteSingleNpxPlexerCommand } from "../src/agy/pre-tool.js";
import { queryPromptContext } from "../src/claude/hooks.js";
import { relevantRetrieval } from "../src/claude/format.js";
import { handleAgyPreInvocation } from "../src/hosts/engine/turn0.js";
import { handleAgyPreTool } from "../src/hosts/engine/dispatcher.js";
import { handleAgyPostTool, isPlanToolCall, recordEditBlastForAgy } from "../src/hosts/engine/post-tool.js";
import { GEMINI_HOOK_BUDGETS, HOOK_BUDGETS, isGeminiModelProfile, isOrchestratorInput } from "../src/hosts/engine/prompt/budget.js";
import { backfillCompactPointerHits } from "../src/hosts/engine/prompt/pin.js";
import { pointerCovers } from "../src/claude/pin.js";
import { detectPromptIntent, isLikelyEditSessionPrompt, isSyntheticOrMetaPrompt } from "../src/hosts/engine/prompt/intent.js";

const PKG_ROOT = resolve(import.meta.dirname, "..");
const CLI_BIN = join(PKG_ROOT, "bin", "plexer.js");

function sendDaemonReq(socketPath, req) {
    return new Promise((resolveDone, rejectDone) => {
        const conn = createConnection(socketPath);
        let buf = "";
        conn.on("connect", () => conn.write(`${JSON.stringify(req)}\n`));
        conn.on("data", (chunk) => {
            buf += chunk.toString("utf8");
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            const line = buf.slice(0, nl);
            conn.end();
            try { resolveDone(JSON.parse(line)); }
            catch (err) { rejectDone(err); }
        });
        conn.on("error", rejectDone);
    });
}

function makeTempRepo(prefix) {
    const repo = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(repo, "src"), { recursive: true });
    return repo;
}

describe("Antigravity Gemini 4 Perf, Concurrency, PreTool/PostTool & CLI Contracts", () => {
    it("isolates concurrent captured CLI runs via AsyncLocalStorage and serves distinct repos concurrently in plexerd", async () => {
        const repoA = makeTempRepo("plexer-conc-a-");
        const repoB = makeTempRepo("plexer-conc-b-");
        const sock = join(tmpdir(), `plexer-conc-${process.pid}-${Date.now()}.sock`);
        let daemon = null;
        try {
            writeFileSync(join(repoA, "src", "alpha.js"), "export function alphaMarker() { return 'alphaOnlyToken'; }\n");
            writeFileSync(join(repoB, "src", "beta.js"), "export function betaMarker() { return 'betaOnlyToken'; }\n");
            await buildGraph(repoA, { force: true });
            await buildGraph(repoB, { force: true });

            const capRun = async (cwd, argv) => {
                let stdout = "";
                let stderr = "";
                let exitCode = 0;
                await runCli(["node", "plexer", ...argv], {
                    isCaptured: true,
                    cwd,
                    writeOut: (s) => { stdout += String(s ?? ""); },
                    writeErr: (s) => { stderr += String(s ?? ""); },
                    exit: (c) => { exitCode = Number(c) || 0; },
                });
                return { stdout, stderr, exitCode };
            };

            const [directA, directB] = await Promise.all([
                capRun(repoA, ["grep", "alphaOnlyToken", "--no-daemon"]),
                capRun(repoB, ["grep", "betaOnlyToken", "--no-daemon"]),
            ]);
            assert.equal(directA.exitCode, 0);
            assert.equal(directB.exitCode, 0);
            assert.match(directA.stdout, /alphaOnlyToken/);
            assert.doesNotMatch(directA.stdout, /betaOnlyToken/);
            assert.match(directB.stdout, /betaOnlyToken/);
            assert.doesNotMatch(directB.stdout, /alphaOnlyToken/);

            daemon = await startDaemon({ socketPath: sock, idleTimeoutMs: 5000 });
            const [rpcA, rpcB] = await Promise.all([
                sendDaemonReq(sock, { id: 1, type: "cli", cwd: repoA, argv: ["grep", "alphaOnlyToken"] }),
                sendDaemonReq(sock, { id: 2, type: "cli", cwd: repoB, argv: ["grep", "betaOnlyToken"] }),
            ]);
            assert.equal(rpcA.ok, true);
            assert.equal(rpcB.ok, true);
            assert.match(rpcA.stdout, /alphaOnlyToken/);
            assert.doesNotMatch(rpcA.stdout, /betaOnlyToken/);
            assert.match(rpcB.stdout, /betaOnlyToken/);
            assert.doesNotMatch(rpcB.stdout, /alphaOnlyToken/);
        } finally {
            if (daemon) await daemon.close();
            rmSync(sock, { force: true });
            rmSync(repoA, { recursive: true, force: true });
            rmSync(repoB, { recursive: true, force: true });
        }
    });

    it("uses stale-while-revalidate when fingerprint is missing and fast-exits mid-turn PreInvocation calls", async () => {
        const repo = makeTempRepo("plexer-swr-");
        const sid = `sess-swr-${process.pid}-${Date.now()}`;
        try {
            writeFileSync(
                join(repo, "src", "billing.js"),
                "export function reconcileLedgerEntries(rows) {\n    return rows.length;\n}\n",
            );
            await buildGraph(repo, { force: true });
            const cacheDir = join(repo, "plexer", ".cache");
            for (const f of readdirSync(cacheDir)) {
                if (f.startsWith("fingerprint")) unlinkSync(join(cacheDir, f));
            }

            const scheduled = [];
            const locked = [];
            const turn0Raw = await handleAgyPreInvocation(
                {
                    conversationId: sid,
                    workspacePaths: [repo],
                    initialNumSteps: 1,
                    modelName: "gemini-4-hydrogen-medium",
                    prompt: "Explain reconcileLedgerEntries",
                },
                {
                    captureStdout: true,
                    scheduleRefresh: (dir) => scheduled.push(dir),
                    withRepoLock: async (dir, fn) => { locked.push(dir); return fn(); },
                },
            );
            const turn0 = JSON.parse(turn0Raw);
            const turn0Msg = turn0.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(turn0Msg, /reconcileLedgerEntries/);
            assert.equal(scheduled.length, 1, "NO_FP must schedule async background refresh");
            assert.equal(locked.length, 0, "NO_FP must not block Turn 0 on synchronous rebuild");

            const midRaw = await handleAgyPreInvocation(
                {
                    conversationId: sid,
                    workspacePaths: [repo],
                    initialNumSteps: 2,
                    modelName: "gemini-4-hydrogen-medium",
                },
                {
                    captureStdout: true,
                    scheduleRefresh: (dir) => scheduled.push(dir),
                    withRepoLock: async (dir, fn) => { locked.push(dir); return fn(); },
                },
            );
            assert.equal(midRaw, "{}\n");
            assert.equal(scheduled.length, 1, "mid-turn fast-exit must skip refreshWorkspaceDirs");
            assert.equal(locked.length, 0);
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("preserves header peeks, avoids re-dumping seen prefixes on widening, and tracks standalone plexer read", async () => {
        const repo = makeTempRepo("plexer-read-widen-");
        const sid = `sess-read-${process.pid}-${Date.now()}`;
        try {
            const lines = [];
            for (let i = 1; i <= 50; i++) lines.push(`// header comment ${i}`);
            lines.push("export function processChunkedWork(items) {");
            for (let i = 0; i < 325; i++) lines.push(`    const step_${i} = items.length + ${i};`);
            lines.push("    return step_324;");
            lines.push("}");
            const chunkedPath = join(repo, "src", "chunked.js");
            writeFileSync(chunkedPath, `${lines.join("\n")}\n`);
            await buildGraph(repo, { force: true });

            const agyState = { seenSpans: {}, fileSliceCounts: {} };
            const peekPlan = computeReadPreToolWidening(
                { Path: chunkedPath, StartLine: 1, EndLine: 40 },
                repo,
                agyState,
            );
            assert.equal(peekPlan, null, "1..40 header peek on >120-line file must not widen");

            agyState.seenSpans = { "src/chunked.js": [[1, 200]] };
            agyState.fileSliceCounts = { "src/chunked.js": 1 };
            const secondPlan = computeReadPreToolWidening(
                { Path: chunkedPath, StartLine: 210, EndLine: 250 },
                repo,
                agyState,
            );
            assert.ok(secondPlan, "repeated slice on uncovered tail must widen");
            assert.equal(secondPlan.startLine, 201, "must not re-dump already seen 1..200 prefix");
            assert.equal(secondPlan.endLine, lines.length);

            const preCmd = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "run_command", args: { CommandLine: "plexer read src/chunked.js:51-90" } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(preCmd.decision, "allow");
            assert.equal(readAgySession(sid).seenSpans?.["src/chunked.js"], undefined, "PreToolUse must not speculatively record spans before read runs");

            let cliOut = "";
            await runCli(["node", "plexer", "read", "src/chunked.js:51-90", "--session", sid], {
                isCaptured: true,
                cwd: repo,
                sessionId: sid,
                writeOut: (s) => { cliOut += s; },
                writeErr: () => {},
                exit: () => {},
            });
            assert.match(cliOut, /L51:/);
            const saved = readAgySession(sid);
            assert.deepEqual(saved.seenSpans?.["src/chunked.js"], [[51, 90]]);
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("gates post-edit pendingBlastRadius by signature/export changes and Turn-0 coverage", async () => {
        const repo = makeTempRepo("plexer-blast-gate-");
        try {
            const calcPath = join(repo, "src", "calc.js");
            writeFileSync(
                calcPath,
                [
                    "export function calc(a, b) {",
                    "    const total = a + b;",
                    "    return total;",
                    "}",
                    "",
                ].join("\n"),
            );
            writeFileSync(
                join(repo, "src", "caller.js"),
                "import { calc } from './calc.js';\nexport function runCalc() { return calc(1, 2); }\n",
            );
            await buildGraph(repo, { force: true });

            const bodyState = { injectedPointers: [], emittedBlastFiles: [] };
            recordEditBlastForAgy(
                [repo],
                repo,
                calcPath,
                bodyState,
                {},
                { Target: "    return total;", Replacement: "    return total + 1;", StartLine: 3 },
            );
            assert.equal(bodyState.pendingBlastRadius ?? null, null, "body-only edit must suppress pendingBlastRadius");

            const sigState = { injectedPointers: [], emittedBlastFiles: [] };
            recordEditBlastForAgy(
                [repo],
                repo,
                calcPath,
                sigState,
                {},
                { Target: "export function calc(a, b) {", Replacement: "export function calc(a, b, c = 0) {", StartLine: 1 },
            );
            assert.match(String(sigState.pendingBlastRadius || ""), /blast radius for calc\.js/);

            const coveredState = {
                injectedPointers: ["src/calc.js:L1-L4", "src/caller.js:L2-L2", "src/extra.js:L1-L5"],
                emittedBlastFiles: [],
            };
            recordEditBlastForAgy(
                [repo],
                repo,
                calcPath,
                coveredState,
                {},
                { Target: "export function calc(a, b) {", Replacement: "export function calc(a, b, c = 0) {", StartLine: 1 },
            );
            assert.equal(coveredState.pendingBlastRadius ?? null, null, ">=3 Turn-0 pointers covering file suppresses blast");
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("detects Gemini vs Claude model profiles, scopes trailing path in grep, and surfaces unlinked property refs in callers", async () => {
        assert.equal(isGeminiModelProfile({ modelName: "gemini-4-neon-medium" }, "agy"), true);
        assert.equal(isGeminiModelProfile({ modelName: "neon-medium" }, "agy"), true);
        assert.equal(isGeminiModelProfile({ modelName: "gemini-4-hydrogen-medium" }, "agy"), true);
        assert.equal(isGeminiModelProfile({ modelName: "argon-medium" }, "agy"), true);
        assert.equal(isGeminiModelProfile({ modelName: "carbon-medium" }, "agy"), true);
        assert.equal(isGeminiModelProfile({}, "agy"), true);
        assert.equal(isGeminiModelProfile({ modelName: "claude-sonnet-5-5-medium" }, "agy"), false);
        assert.equal(isGeminiModelProfile({}, "claude"), false);

        const repo = makeTempRepo("plexer-cli-ergo-");
        try {
            mkdirSync(join(repo, "src", "sub"), { recursive: true });
            mkdirSync(join(repo, "src", "other"), { recursive: true });
            writeFileSync(join(repo, "src", "sub", "hit.js"), "export const needle = 'scopedNeedleHit';\n");
            writeFileSync(join(repo, "src", "other", "miss.js"), "export const needle = 'otherDirMiss';\n");
            writeFileSync(
                join(repo, "src", "bus.ts"),
                "export class AuditBus {\n    emitAuditEvent(ev: string) { return ev; }\n}\n",
            );
            writeFileSync(
                join(repo, "src", "registry.ts"),
                "export function getHandlers(bus: any) {\n    const routes = [bus.emitAuditEvent];\n    return routes;\n}\n",
            );
            writeFileSync(
                join(repo, "src", "standalone.js"),
                "export function isolatedUniqueHelper() { return 42; }\n",
            );
            await buildGraph(repo, { force: true });

            const grepOut = execFileSync(process.execPath, [CLI_BIN, "grep", "needle", "src/sub", "--no-daemon"], {
                cwd: repo,
                encoding: "utf8",
            });
            assert.match(grepOut, /src\/sub\/hit\.js/);
            assert.doesNotMatch(grepOut, /src\/other\/miss\.js/);

            const callersRef = execFileSync(
                process.execPath,
                [CLI_BIN, "callers", "src/bus.ts:AuditBus.emitAuditEvent", "--no-daemon"],
                { cwd: repo, encoding: "utf8" },
            );
            assert.match(callersRef, /unlinked \.emitAuditEvent\(\) call sites \(\d+, scanned \d+ reachable files\):/);
            assert.match(callersRef, /src\/registry\.ts/);

            const callersZero = execFileSync(
                process.execPath,
                [CLI_BIN, "callers", "src/standalone.js:isolatedUniqueHelper", "--no-daemon"],
                { cwd: repo, encoding: "utf8" },
            );
            assert.match(callersZero, /unlinked scan: 0 unlinked references across \d+ reachable files/);

            const skelDirOut = execFileSync(process.execPath, [CLI_BIN, "skeleton", "src", "--no-daemon"], {
                cwd: repo,
                encoding: "utf8",
            });
            assert.match(skelDirOut, /src\/bus\.ts/);
            assert.match(skelDirOut, /isolatedUniqueHelper/);

            writeFileSync(join(repo, "topOnlyNeedle.js"), "export const needle = 'outsideSrcNeedle';\n");
            const grepBareDirOut = execFileSync(process.execPath, [CLI_BIN, "grep", "needle", "src", "--no-daemon"], {
                cwd: repo,
                encoding: "utf8",
            });
            assert.match(grepBareDirOut, /src\/sub\/hit\.js/);
            assert.doesNotMatch(grepBareDirOut, /topOnlyNeedle\.js/);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("tracks exact contiguous per-file seenSpans across gaps/callees and invalidates spans on edit", () => {
        const hitCode = [
            "L10: function checkZero(schema, elem) {",
            "L11:     return helperCheck(elem);",
            "  … (200 lines omitted)",
            "L212: }",
            "// cross-file callee: helperCheck (src/model.js:L50-L55)",
            "L50: function helperCheck(elem) {",
            "L51:     return elem === 0;",
            "L52: }",
        ].join("\n");
        const runs = extractInlinedSpansByFile(hitCode, "src/resolve.js");
        assert.deepEqual(runs, [
            { file: "src/resolve.js", start: 10, end: 11 },
            { file: "src/resolve.js", start: 212, end: 212 },
            { file: "src/model.js", start: 50, end: 52 },
        ]);

        const seen = {};
        recordRetrievalSpans(seen, { hits: [{ pointer: "src/resolve.js:L10-L212", code: hitCode }] });
        assert.deepEqual(seen["src/resolve.js"], [[10, 11], [212, 212]]);
        assert.deepEqual(seen["src/model.js"], [[50, 52]]);

        // If an unseen crux middle or callee appears, applySeenSpansFilter must NOT suppress the hit.
        const unseenCalleeHit = {
            pointer: "src/resolve.js:L10-L11",
            code: "L10: function checkZero() {}\n// cross-file callee: unseenFn (src/other.js:L1-L5)\nL1: function unseenFn() {}",
        };
        assert.equal(applySeenSpansFilter({ hits: [unseenCalleeHit] }, seen).dedupedCount, 0);

        invalidateEditedSpans(seen, "src/resolve.js", 200);
        assert.deepEqual(seen["src/resolve.js"], [[10, 11]]);
    });

    it("widens <=520L 2nd slices without dumping 680L files, inner-method snaps >320L classes, tracks unbounded reads, and coalesces echo dividers", async () => {
        const repo = makeTempRepo("plexer-widen-ext-");
        const sid = `sess-widen-ext-${process.pid}-${Date.now()}`;
        try {
            // 1. 440L file -> 2nd slice widens across uncovered remainder (<= 520L); 680L file -> does not widen (> 520L)
            const lines440 = [];
            for (let i = 1; i <= 440; i++) lines440.push(`// line ${i}`);
            const medPath = join(repo, "src", "big440.js");
            writeFileSync(medPath, `${lines440.join("\n")}\n`);

            const lines680 = [];
            for (let i = 1; i <= 680; i++) lines680.push(`// line ${i}`);
            const bigPath = join(repo, "src", "big680.js");
            writeFileSync(bigPath, `${lines680.join("\n")}\n`);

            // 2. Class > 320L containing a small inner method -> snaps to inner method bounds
            const clsLines = ["export class BigService {"];
            for (let i = 2; i <= 120; i++) clsLines.push(`    field_${i} = ${i};`);
            clsLines.push("    targetMethod(x) {");
            for (let k = 0; k < 25; k++) clsLines.push(`        const v_${k} = x + ${k};`);
            clsLines.push("        return v_24;");
            clsLines.push("    }");
            for (let i = 149; i <= 400; i++) clsLines.push(`    pad_${i}() { return ${i}; }`);
            clsLines.push("}");
            const clsPath = join(repo, "src", "bigclass.js");
            writeFileSync(clsPath, `${clsLines.join("\n")}\n`);

            await buildGraph(repo, { force: true });

            const agyState = { seenSpans: {}, fileSliceCounts: {} };
            // 1st slice on big440
            computeReadPreToolWidening({ Path: medPath, StartLine: 1, EndLine: 20 }, repo, agyState);
            // 2nd slice widens to entire 440L uncovered remainder (<= 520L)
            const widen440 = computeReadPreToolWidening({ Path: medPath, StartLine: 100, EndLine: 130 }, repo, agyState);
            assert.ok(widen440);
            assert.equal(widen440.startLine, 21);
            assert.equal(widen440.endLine, 440);

            // 1st and 2nd slices on big680 (> 520L) widen to a bounded <=400L window instead of dumping 21..680
            computeReadPreToolWidening({ Path: bigPath, StartLine: 1, EndLine: 20 }, repo, agyState);
            const widen680 = computeReadPreToolWidening({ Path: bigPath, StartLine: 100, EndLine: 130 }, repo, agyState);
            assert.ok(widen680, "2nd slice >520L must widen to a bounded window");
            assert.equal(widen680.startLine, 21);
            assert.equal(widen680.endLine, 420);
            assert.equal(widen680.limit, 400);

            // Inner method snap inside BigService (> 320L class)
            const innerSnap = computeReadPreToolWidening({ Path: clsPath, StartLine: 124, EndLine: 130 }, repo, agyState);
            assert.ok(innerSnap, "must snap to inner method instead of failing on enclosing 400L class");
            assert.ok(innerSnap.startLine >= 120 && innerSnap.startLine <= 122);
            assert.ok(innerSnap.endLine >= 147 && innerSnap.endLine <= 149);

            // Unbounded read_file records seenSpans without emitting overwrite
            const unboundedOut = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: bigPath } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(unboundedOut.decision, "allow");
            assert.equal(unboundedOut.overwrite, undefined);
            assert.deepEqual(readAgySession(sid).seenSpans?.["src/big680.js"], [[1, 680]]);

            // PostToolUse edit invalidates seenSpans & resets fileSliceCounts
            handleAgyPostTool(
                {
                    conversationId: sid,
                    workspacePaths: [repo],
                    toolCall: {
                        name: "edit_file",
                        args: { Path: bigPath, Target: "// line 150", Replacement: "// line 150 edited", StartLine: 150 },
                    },
                },
                { captureStdout: true },
            );
            assert.deepEqual(readAgySession(sid).seenSpans?.["src/big680.js"], [[1, 149]]);

            // Coalesce echo dividers between >=2 plexer commands, leave bare echo untouched
            const echoBatch = rewriteChainedPlexerCommand('plexer skeleton src && echo "---" && plexer grep "targetMethod" src');
            assert.match(String(echoBatch || ""), /(?:^plexer|plexer\.js['"]?) _batch [A-Za-z0-9_-]+$/);
            assert.equal(rewriteChainedPlexerCommand('"echo a" && "echo b"'), null);
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("supports Orchestrator Plan->Execute->[plan review], metadata paths, O(1) transcript skip, and swarm fork/collision", async () => {
        const repo = makeTempRepo("plexer-orch-swarm-");
        const appData = mkdtempSync(join(tmpdir(), "plexer-appdata-"));
        const coordSid = `coord-${process.pid}-${Date.now()}`;
        const workerSid = `worker-${process.pid}-${Date.now()}`;
        const metaSid = `meta-${process.pid}-${Date.now()}`;
        try {
            writeFileSync(
                join(repo, "src", "service.js"),
                [
                    "export function computeInvoiceRate(subtotal, rate) {",
                    "    const tax = subtotal * rate;",
                    "    return subtotal + tax;",
                    "}",
                    "",
                ].join("\n"),
            );
            writeFileSync(
                join(repo, "src", "caller.js"),
                "import { computeInvoiceRate } from './service.js';\nexport function bill(x) { return computeInvoiceRate(x, 0.1); }\n",
            );
            writeFileSync(
                join(repo, "src", "formatter.js"),
                "export function formatMoney(n) {\n    return Number(n).toFixed(2);\n}\n",
            );
            writeFileSync(
                join(repo, "src", "tax.js"),
                "import { computeInvoiceRate } from './service.js';\nexport function computeInvoiceTax(subtotal, rate) { return computeInvoiceRate(subtotal, rate) - subtotal; }\n",
            );
            writeFileSync(
                join(repo, "src", "discount.js"),
                "import { computeInvoiceRate } from './service.js';\nexport function computeInvoiceDiscount(subtotal, rate) { return computeInvoiceRate(subtotal, rate) * 0.9; }\n",
            );
            writeFileSync(
                join(repo, "src", "receipt.js"),
                "import { computeInvoiceRate } from './service.js';\nexport function buildInvoiceReceipt(subtotal, rate) { return computeInvoiceRate(subtotal, rate); }\n",
            );
            writeFileSync(
                join(repo, "src", "ledger.js"),
                "export function postJournal(amount) {\n    return amount;\n}\n",
            );
            writeFileSync(
                join(repo, "src", "audit.js"),
                "import { postJournal } from './ledger.js';\nexport function verifyAudit(v) { return postJournal(v); }\n",
            );
            await buildGraph(repo, { force: true });

            assert.equal(isGeminiModelProfile({ modelName: "gemini-pro-orchestrator" }, "agy"), true);
            assert.equal(isOrchestratorInput({ modelName: "gemini-pro-orchestrator-argon" }, null), true);
            assert.equal(isSyntheticOrMetaPrompt("/plan /grill-me Improve the performance of the gemini 4 models in antigravity 2"), true);
            assert.equal(isSyntheticOrMetaPrompt("[plan review due]"), true);

            // 1. Orchestrator Plan turn retains pinned target but suppresses edit-now nudge
            const planTurn = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: coordSid,
                        workspacePaths: [repo],
                        initialNumSteps: 1,
                        modelName: "gemini-pro-orchestrator",
                        prompt: "Update `computeInvoiceRate` in `src/service.js` to round to 2 decimals.",
                    },
                    { captureStdout: true },
                ),
            );
            const planMsg = planTurn.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(planMsg, /plan targets localized \(plan mode is read-only/);
            assert.match(planMsg, /computeInvoiceRate/);

            // 2. exit_plan_mode PostToolUse stages <=2800B handoff and marks execute phase
            handleAgyPostTool(
                {
                    conversationId: coordSid,
                    workspacePaths: [repo],
                    modelName: "gemini-pro-orchestrator",
                    toolCall: { name: "exit_plan_mode", args: { plan: "Modify `src/formatter.js:formatMoney` too." } },
                },
                { captureStdout: true },
            );
            assert.equal(readAgySession(coordSid).orchestratorPhase, "execute");
            const execTurn = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: coordSid,
                        workspacePaths: [repo],
                        initialNumSteps: 4,
                        modelName: "gemini-pro-orchestrator",
                    },
                    { captureStdout: true },
                ),
            );
            const execMsg = execTurn.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(execMsg, /\[plexer\] execution handoff/);
            assert.match(execMsg, /formatMoney/);
            assert.ok(Buffer.byteLength(execMsg, "utf8") <= 2800);

            // 2b. Signature edit in Execute phase -> [plan review due] flushes pendingBlastRadius & switches to plan phase
            writeFileSync(
                join(repo, "src", "ledger.js"),
                "export function postJournal(amount, memo = '') {\n    return amount;\n}\n",
            );
            handleAgyPostTool(
                {
                    conversationId: coordSid,
                    workspacePaths: [repo],
                    modelName: "gemini-pro-orchestrator",
                    toolCall: {
                        name: "edit_file",
                        args: {
                            Path: join(repo, "src", "ledger.js"),
                            Target: "export function postJournal(amount) {",
                            Replacement: "export function postJournal(amount, memo = '') {",
                            StartLine: 1,
                        },
                    },
                },
                { captureStdout: true },
            );
            const reviewTurn = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: coordSid,
                        workspacePaths: [repo],
                        initialNumSteps: 8,
                        modelName: "gemini-pro-orchestrator",
                        prompt: "[plan review due]",
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(readAgySession(coordSid).orchestratorPhase, "plan");
            const reviewMsg = reviewTurn.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(reviewMsg, /audit\.js/);
            assert.doesNotMatch(reviewMsg, /\[plexer\] (?:retrieved context|edit targets|plan targets|no strong match)/);

            // 3. Skip corrupted/unneeded transcript_full.jsonl for GENERIC truncated tool outputs
            const logsDir = join(appData, "brain", metaSid, ".system_generated", "logs");
            mkdirSync(logsDir, { recursive: true });
            const txCompact = join(logsDir, "transcript.jsonl");
            const txFull = join(logsDir, "transcript_full.jsonl");
            writeFileSync(txFull, "{invalid-json-would-throw-if-unnecessarily-loaded\n");
            writeFileSync(
                txCompact,
                `${JSON.stringify({
                    step_index: 0,
                    type: "USER_INPUT",
                    content: `<USER_REQUEST>\nFix bug\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n@[${join(repo, "src", "service.js")}]\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to Orchestrator (Carbon).\n</USER_SETTINGS_CHANGE>`,
                })}\n${JSON.stringify({
                    step_index: 1,
                    type: "GENERIC",
                    content: "huge tool output preview...",
                    truncated_fields: ["content"],
                })}\n`,
            );
            const parsedMetaState = emptyAgySession();
            parseAgyTranscript(txCompact, parsedMetaState);
            assert.equal(parsedMetaState.lastTouchedPath, join(repo, "src", "service.js"));
            assert.equal(parsedMetaState.isOrchestratorModel, true);
            assert.equal(parsedMetaState.orchestratorPhase, "plan");

            // 4. Swarm fork inherits seenSpans + orientedDirs once, and collision emits 1-shot warning
            const swarmDir = join(appData, "brain", coordSid, ".system_generated", "swarm");
            mkdirSync(swarmDir, { recursive: true });
            writeFileSync(
                join(swarmDir, "members.json"),
                JSON.stringify({
                    title: "opt-swarm",
                    members: {
                        "worker-1": { conversation_id: workerSid, state: "working", fork: "coordinator" },
                    },
                }),
            );
            const workerLogs = join(appData, "brain", workerSid, ".system_generated", "logs");
            mkdirSync(workerLogs, { recursive: true });
            writeFileSync(
                join(workerLogs, "transcript.jsonl"),
                `${JSON.stringify({
                    step_index: 1,
                    type: "PLANNER_RESPONSE",
                    tool_calls: [{ name: "edit_file", args: { Path: join(repo, "src", "service.js") } }],
                })}\n`,
            );
            const workerState = emptyAgySession();
            const seeded = seedForkedSwarmSession(workerSid, workerState, { appDataDirs: [appData] });
            assert.equal(seeded, true);
            assert.ok(Object.keys(workerState.seenSpans).length > 0);

            const coordCollisionState = readAgySession(coordSid);
            const collision = checkSwarmEditCollision(coordSid, repo, join(repo, "src", "service.js"), coordCollisionState, { appDataDirs: [appData] });
            assert.match(String(collision || ""), /@worker-1 also edited src\/service\.js/);
        } finally {
            rmSync(agySessionPath(coordSid), { force: true });
            rmSync(agySessionPath(workerSid), { force: true });
            rmSync(agySessionPath(metaSid), { force: true });
            rmSync(appData, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("blocks 100%-covered duplicate read_file once with retry escape, trims unbounded gaps, resets on CHECKPOINT, and hydrates subagent [Message]", async () => {
        const repo = makeTempRepo("plexer-round3-hooks-");
        const appData = mkdtempSync(join(tmpdir(), "plexer-round3-app-"));
        const sid = `sess-r3-dup-${process.pid}-${Date.now()}`;
        const subSid = `sess-r3-sub-${process.pid}-${Date.now()}`;
        try {
            const bigLines = Array.from({ length: 300 }, (_, i) => `export const val_${i + 1} = ${i + 1};`);
            const bigFile = join(repo, "src", "big300.js");
            writeFileSync(bigFile, `${bigLines.join("\n")}\n`);
            const smallFile = join(repo, "src", "tiny60.js");
            writeFileSync(smallFile, `${Array.from({ length: 60 }, (_, i) => `const k_${i} = ${i};`).join("\n")}\n`);
            writeFileSync(
                join(repo, "src", "workerTarget.js"),
                "export function auditShardThree(item) {\n    return item?.id ?? null;\n}\n",
            );
            await buildGraph(repo, { force: true });

            // 1. Mark 1..120 seen; duplicate bounded read >=90L denies once, allows immediate retry
            const st = readAgySession(sid);
            st.seenSpans = { "src/big300.js": [[1, 120]], "src/tiny60.js": [[1, 60]] };
            writeAgySession(sid, st);

            const denyOut = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 1, EndLine: 100 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(denyOut.decision, "deny");
            assert.match(String(denyOut.reason || ""), /already in your context window/);

            const retryOut = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: bigFile, StartLine: 1, EndLine: 100 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(retryOut.decision, "allow");
            assert.equal(retryOut.overwrite, undefined, "immediate exact retry must pass through");

            // 2. Tiny <=80L files still pass through without blocking
            const tinyAllow = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: smallFile, StartLine: 1, EndLine: 60 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(tinyAllow.decision, "allow");

            // 3. Unbounded read on partially-seen >90L file trims to uncovered gap
            const trimOut = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: bigFile } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(trimOut.decision, "allow");
            assert.deepEqual(trimOut.overwrite, { StartLine: 121, EndLine: 300 });

            // 4. CHECKPOINT resets seenSpans and SYSTEM [Message] hydrates full subagent prompt while skipping SYSTEM_SDK
            const logsDir = join(appData, "brain", subSid, ".system_generated", "logs");
            mkdirSync(logsDir, { recursive: true });
            const txCompact = join(logsDir, "transcript.jsonl");
            const txFull = join(logsDir, "transcript_full.jsonl");
            const longTask = `Please inspect auditShardThree in src/workerTarget.js carefully. ${"detail ".repeat(40)}done.`;
            writeFileSync(
                txFull,
                `${JSON.stringify({
                    step_index: 1,
                    source: "SYSTEM",
                    type: "SYSTEM_MESSAGE",
                    content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-16T00:00:00Z sender=coord-1 priority=MESSAGE_PRIORITY_HIGH content=${longTask}\n</SYSTEM_MESSAGE>`,
                })}\n`,
            );
            writeFileSync(
                txCompact,
                [
                    JSON.stringify({
                        step_index: 0,
                        source: "SYSTEM_SDK",
                        type: "SYSTEM_MESSAGE",
                        content: "<SYSTEM_MESSAGE>\n[plexer] This repo is indexed by plexer.\n</SYSTEM_MESSAGE>",
                        truncated_fields: ["content"],
                    }),
                    JSON.stringify({
                        step_index: 1,
                        source: "SYSTEM",
                        type: "SYSTEM_MESSAGE",
                        content: "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-16T00:00:00Z sender=coord-1 priority=MESSAGE_PRIORITY_HIGH content=Please inspect...",
                        truncated_fields: ["content"],
                    }),
                ].join("\n") + "\n",
            );

            const subInvocation = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: subSid,
                        workspacePaths: [repo],
                        transcriptPath: txCompact,
                        modelName: "gemini-4-hydrogen-medium",
                    },
                    { captureStdout: true },
                ),
            );
            const subMsg = subInvocation.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(subMsg, /auditShardThree/, "subagent [Message] must trigger Turn-0 retrieval");

            const subStateAfter = readAgySession(subSid);
            assert.ok(subStateAfter.lastUserPrompt?.includes("done."), "full subagent [Message] must hydrate from transcript_full");
            assert.ok(Object.keys(subStateAfter.seenSpans || {}).length > 0);

            writeFileSync(
                txCompact,
                `${JSON.stringify({
                    step_index: 5,
                    source: "SYSTEM",
                    type: "CHECKPOINT",
                    content: "# Resuming from compaction",
                })}\n`,
                { flag: "a" },
            );
            parseAgyTranscript(txCompact, subStateAfter);
            assert.deepEqual(subStateAfter.seenSpans, {}, "CHECKPOINT must reset seenSpans");
            assert.equal(subStateAfter.lastBlockedReadKey, null);
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(agySessionPath(subSid), { force: true });
            rmSync(appData, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("supports plexer read dedup/fast-slice, grep multi-dir/regex-fallback, Turn-0 callee inline & 4-turn edit guard", async () => {
        const repo = makeTempRepo("plexer-round3-cli-");
        mkdirSync(join(repo, "test"), { recursive: true });
        const sid = `sess-r3-cli-${process.pid}-${Date.now()}`;
        const guardSid = `sess-r3-guard-${process.pid}-${Date.now()}`;
        try {
            const modLines = [
                "import { tinyCallee } from './helper.js';",
                "export function primaryDownload(url, name) {",
                "    const target = formatTarget(name);",
                "    return tinyCallee(url, target);",
                "}",
                "function formatTarget(name) {",
                "    return String(name).trim();",
                "}",
                ...Array.from({ length: 160 }, (_, i) => `export const padLine_${i + 9} = ${i};`),
            ];
            writeFileSync(join(repo, "src", "primary.js"), `${modLines.join("\n")}\n`);
            writeFileSync(
                join(repo, "src", "helper.js"),
                "export function tinyCallee(url, target) {\n    if (!url.includes('.download(')) return target;\n    return `${url}:${target}`;\n}\n",
            );
            writeFileSync(
                join(repo, "test", "primary.test.js"),
                "import { primaryDownload } from '../src/primary.js';\nprimaryDownload('a.download(', 'x');\n",
            );
            writeFileSync(
                join(repo, "src", "casecheck.js"),
                'export function RenderItem() {\n    return "UPPER";\n}\nexport function renderitem() {\n    return "lower";\n}\n',
            );
            await buildGraph(repo, { force: true });

            assert.equal(readSpans(repo, ["src/casecheck.js:RenderItem"]).blocks[0].startLine, 1);
            assert.ok(readSpans(repo, ["src/casecheck.js:renderitem"]).blocks[0].startLine >= 4);
            const ciFallback = readSpans(repo, ["src/casecheck.js:RENDERITEM"]).blocks[0];
            assert.equal(ciFallback.error, undefined);
            assert.match(ciFallback.code, /RenderItem|renderitem/);

            // 1. Explicit-range fast slice & seenSpans dedup / --full bypass
            assert.equal(canFastSliceExplicitSpans(repo, ["src/primary.js:L1-L40"]), true);
            assert.equal(canFastSliceExplicitSpans(repo, ["src/primary.js:primaryDownload"]), false);

            let out1 = "";
            await runCli(["node", "plexer", "read", "src/primary.js:L1-L40", "--session", sid], {
                isCaptured: true, cwd: repo, sessionId: sid, writeOut: (s) => { out1 += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(out1, /L1: import/);

            let outDup = "";
            await runCli(["node", "plexer", "read", "src/primary.js:L1-L40", "--session", sid], {
                isCaptured: true, cwd: repo, sessionId: sid, writeOut: (s) => { outDup += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(outDup, /\[already in session context: src\/primary\.js:L1-L40/);

            let outFull = "";
            await runCli(["node", "plexer", "read", "src/primary.js:L1-L40", "--full", "--session", sid], {
                isCaptured: true, cwd: repo, sessionId: sid, writeOut: (s) => { outFull += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(outFull, /L4:     return tinyCallee/);

            // Request-order pool allocates primary span generously and scales default pool by span count (3 spans -> 12 KB)
            const pooled = readSpans(repo, [
                "src/primary.js:L1-L165",
                "src/helper.js:L1-L4",
                "test/primary.test.js:L1-L2",
            ]);
            const formattedPooled = formatReadSpans(pooled);
            assert.ok(Buffer.byteLength(formattedPooled, "utf8") <= 12200);
            assert.ok(pooled.blocks[0].endLine >= 70, `expected primary span >=70 lines, got ${pooled.blocks[0].endLine}`);

            const capped9k = readSpans(repo, [
                "src/primary.js:L1-L165",
                "src/helper.js:L1-L4",
            ]);
            assert.ok(Buffer.byteLength(formatReadSpans(capped9k), "utf8") <= 9200);

            // 2. Multi-directory grep scope (`src test`) + invalid-regex literal fallback (`\.download(`)
            const multiGrep = execFileSync(
                process.execPath,
                [CLI_BIN, "grep", "tinyCallee", "src", "test"],
                { cwd: repo, encoding: "utf8", env: { ...process.env, PLEXER_NO_DAEMON: "1" } },
            );
            assert.match(multiGrep, /tinyCallee/);

            const literalFallback = execFileSync(
                process.execPath,
                [CLI_BIN, "grep", "\\.download(", "src", "test"],
                { cwd: repo, encoding: "utf8", env: { ...process.env, PLEXER_NO_DAEMON: "1" } },
            );
            assert.match(literalFallback, /invalid regex; matched literal "\.download\("/);
            assert.match(literalFallback, /tinyCallee/);

            // 3. Turn-0 tiny callee inline + 5-turn pre-edit circuit-breaker
            const editT0 = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: guardSid,
                        workspacePaths: [repo],
                        cwd: repo,
                        modelName: "gemini-4-hydrogen-medium",
                        prompt: "Update `primaryDownload` so empty download names are rejected.",
                    },
                    { captureStdout: true },
                ),
            );
            const editMsg = editT0.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(editMsg, /tinyCallee|formatTarget/, "Gemini Turn-0 should inline tiny callee/helper when budget permits");

            for (let turn = 1; turn <= 3; turn++) {
                const mid = JSON.parse(
                    await handleAgyPreInvocation(
                        { conversationId: guardSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-hydrogen-medium" },
                        { captureStdout: true },
                    ),
                );
                assert.equal(mid.injectSteps, undefined, `must not emit pre-edit guard at turn ${turn}`);
            }
            const guardTurn = JSON.parse(
                await handleAgyPreInvocation(
                    { conversationId: guardSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-hydrogen-medium" },
                    { captureStdout: true },
                ),
            );
            const guardText = guardTurn.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(guardText, /4 exploration turns elapsed with 0 edits/, "4th pre-edit invocation should trigger 1-shot guard");

            const repeatAfterGuard = JSON.parse(
                await handleAgyPreInvocation(
                    { conversationId: guardSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-hydrogen-medium" },
                    { captureStdout: true },
                ),
            );
            assert.equal(repeatAfterGuard.injectSteps, undefined, "turn 5 must remain silent until turn 8 stage-2 guard");
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(agySessionPath(guardSid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("Round 4: enforces AGY 2 lifecycle hygiene, 2-stage guard, surgical read safety, >3-caller backfill, & <3ms hook bypass", async () => {
        const repo = makeTempRepo("plexer-round4-");
        const appData = mkdtempSync(join(tmpdir(), "plexer-round4-app-"));
        const artifactDir = join(appData, "brain", "art-r4");
        mkdirSync(artifactDir, { recursive: true });
        const sids = [];
        const mkSid = (p) => {
            const s = `${p}-${process.pid}-${Date.now()}-${sids.length}`;
            sids.push(s);
            return s;
        };
        try {
            // Fixture files for >3 callers + compact pointer backfill + surgical read + exact diff-line blast gate
            const hubLines = [
                "export function hubRouter(mode) {",
                "    if (mode === 'a') return helperOne();",
                "    return helperTwo();",
                "}",
                "function helperOne() { return 1; }",
                "function helperTwo() { return 2; }",
            ];
            writeFileSync(join(repo, "src", "hub.js"), `${hubLines.join("\n")}\n`);
            for (const c of ["c1", "c2", "c3", "c4"]) {
                writeFileSync(
                    join(repo, "src", `${c}.js`),
                    `import { hubRouter } from './hub.js';\nexport function callFrom_${c}() { return hubRouter('${c}'); }\n`,
                );
            }
            const surgicalLines = [
                ...Array.from({ length: 179 }, (_, i) => `// top ${i + 1}`),
                "export function surgicalCenterTarget() {",
                ...Array.from({ length: 85 }, (_, i) => `    const mid_${i} = ${i};`),
                "    return mid_84;",
                "}",
                ...Array.from({ length: 150 }, (_, i) => `// bottom ${i + 1}`),
            ];
            writeFileSync(join(repo, "src", "surgical.js"), `${surgicalLines.join("\n")}\n`);
            writeFileSync(
                join(repo, "src", "editline.js"),
                `${Array.from({ length: 120 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join("\n")}\nexport function alpha(x) {\n    return x;\n}\n`,
            );
            await buildGraph(repo, { force: true });

            // 1. Background task / subagent reply [Message] ignored after USER_INPUT; CHECKPOINT idempotent; mid-turn orient suppressed
            const lifeSid = mkSid("r4-life");
            const txDir = join(appData, "brain", lifeSid, ".system_generated", "logs");
            mkdirSync(txDir, { recursive: true });
            const txFile = join(txDir, "transcript.jsonl");
            writeFileSync(
                txFile,
                [
                    JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "<USER_REQUEST>\nFix hubRouter handling\n</USER_REQUEST>" }),
                    JSON.stringify({
                        step_index: 1,
                        source: "SYSTEM",
                        type: "SYSTEM_MESSAGE",
                        content: `<SYSTEM_MESSAGE>\n[Message] sender=${lifeSid}/task-1065 priority=HIGH content=Task id "${lifeSid}/task-1065" finished\n</SYSTEM_MESSAGE>`,
                    }),
                    JSON.stringify({
                        step_index: 2,
                        source: "SYSTEM",
                        type: "SYSTEM_MESSAGE",
                        content: "<SYSTEM_MESSAGE>\n[Message] sender=subagent-1 priority=HIGH content=Research report from child subagent about unrelated billing\n</SYSTEM_MESSAGE>",
                    }),
                ].join("\n") + "\n",
            );
            const lifeSt = emptyAgySession();
            parseAgyTranscript(txFile, lifeSt);
            assert.equal(lifeSt.hasDirectUserInput, true);
            assert.equal(lifeSt.lastUserPrompt, "Fix hubRouter handling");

            // Simulate /compact CHECKPOINT once -> post-compaction read -> re-parse must not wipe post-compaction spans
            writeFileSync(txFile, `${JSON.stringify({ step_index: 3, source: "SYSTEM", type: "CHECKPOINT", content: "# Resuming" })}\n`, { flag: "a" });
            parseAgyTranscript(txFile, lifeSt);
            assert.equal(lifeSt.lastCheckpointStep, 3);
            lifeSt.seenSpans = { "src/hub.js": [[1, 6]] };
            lifeSt.transcriptOffset = 0; // force re-scan across step 3
            parseAgyTranscript(txFile, lifeSt);
            assert.deepEqual(lifeSt.seenSpans, { "src/hub.js": [[1, 6]] }, "CHECKPOINT step 3 must not wipe state twice");

            // Standalone mid-turn orientation suppressed when !isNewPrompt
            const midOrientSid = mkSid("r4-mid-orient");
            writeAgySession(midOrientSid, { ...emptyAgySession(), lastUserPrompt: "Fix bug", lastProcessedPrompt: "Fix bug", lastUserStep: 0, lastProcessedStep: 0 });
            const midOrientOut = await handleAgyPreInvocation(
                { conversationId: midOrientSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-hydrogen-medium" },
                { captureStdout: true },
            );
            assert.equal(midOrientOut, "{}\n", "standalone mid-turn orientation must stay suppressed when !isNewPrompt");

            // 2. isPlanToolCall ignores task.md / walkthrough.md & pendingPlanAwaitApproval holds implementation_plan.md
            assert.equal(isPlanToolCall("write_file", { Path: join(artifactDir, "task.md") }, { artifactDirectoryPath: artifactDir }, join(artifactDir, "task.md")), false);
            assert.equal(isPlanToolCall("write_file", { Path: join(artifactDir, "walkthrough.md") }, { artifactDirectoryPath: artifactDir }, join(artifactDir, "walkthrough.md")), false);
            assert.equal(isPlanToolCall("write_file", { Path: join(artifactDir, "implementation_plan.md"), ArtifactMetadata: { RequestFeedback: true } }, { artifactDirectoryPath: artifactDir }, join(artifactDir, "implementation_plan.md")), true);

            const planHoldSid = mkSid("r4-planhold");
            const planPath = join(artifactDir, "implementation_plan.md");
            writeFileSync(planPath, "1. Update `hubRouter` in `src/hub.js`.\n");
            handleAgyPostTool(
                {
                    conversationId: planHoldSid,
                    workspacePaths: [repo],
                    artifactDirectoryPath: artifactDir,
                    toolCall: { name: "write_file", args: { Path: planPath, ArtifactMetadata: { RequestFeedback: true } } },
                },
                { captureStdout: true },
            );
            assert.equal(readAgySession(planHoldSid).pendingPlanAwaitApproval, true);
            const preApprovalMid = await handleAgyPreInvocation(
                { conversationId: planHoldSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-hydrogen-medium" },
                { captureStdout: true },
            );
            assert.equal(preApprovalMid, "{}\n", "implementation_plan.md handoff must wait until user approval or exit_plan_mode");

            const casualProseHandoff = buildPlanExecutionHandoff([repo], "Check `callFrom_c1` without naming any file path.", emptyAgySession());
            assert.equal(casualProseHandoff, null, "casual prose backticks without matching repo file must not pull files");

            // 3. Exact diff-line seenSpans invalidation on { Path, Target, Replacement } edit_file & strict blastRadius gate
            const editLineSid = mkSid("r4-editline");
            const editLineFile = join(repo, "src", "editline.js");
            writeAgySession(editLineSid, { ...emptyAgySession(), seenSpans: { "src/editline.js": [[1, 123]] } });
            writeFileSync(
                editLineFile,
                `${Array.from({ length: 120 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join("\n")}\nexport function alpha(x) {\n    return x + 1;\n}\n`,
            );
            handleAgyPostTool(
                {
                    conversationId: editLineSid,
                    workspacePaths: [repo],
                    toolCall: {
                        name: "edit_file",
                        args: { Path: editLineFile, Target: "export function alpha(x) {\n    return x;\n}", Replacement: "export function alpha(x) {\n    return x + 1;\n}" },
                    },
                },
                { captureStdout: true },
            );
            assert.deepEqual(readAgySession(editLineSid).seenSpans?.["src/editline.js"], [[1, 121]], "diff-line resolver must preserve lines above modified body line");

            const blastStateNew = { injectedPointers: [], emittedBlastFiles: [], seenSpans: {} };
            recordEditBlastForAgy(
                [repo], repo, join(repo, "src", "hub.js"), blastStateNew, {},
                { Target: "function helperTwo() { return 2; }", Replacement: "function helperTwo() { return 2; }\nexport function brandNewFn() { return 3; }" },
            );
            assert.equal(blastStateNew.pendingBlastRadius ?? null, null, "adding brand-new export must not trigger blastRadius");

            const blastStateAllSeen = {
                injectedPointers: [],
                emittedBlastFiles: [],
                seenSpans: { "src/c1.js": [[1, 3]], "src/c2.js": [[1, 3]], "src/c3.js": [[1, 3]], "src/c4.js": [[1, 3]] },
            };
            recordEditBlastForAgy(
                [repo], repo, join(repo, "src", "hub.js"), blastStateAllSeen, {},
                { Target: "export function hubRouter(mode) {", Replacement: "export function hubRouter(mode, extra = 0) {", StartLine: 1 },
            );
            assert.equal(blastStateAllSeen.pendingBlastRadius ?? null, null, "blastRadius suppressed when all external callers already in seenSpans");

            // 4. Issue-style edit intent + 2-stage 4/8-turn escalation
            const swePrompt = `Working directory: ${repo}\n\n${"Line of context describing regression in hubRouter when mode is undefined. ".repeat(4)}\nFix \`hubRouter\` in \`src/hub.js\`.`;
            assert.equal(isLikelyEditSessionPrompt(swePrompt), true);
            assert.equal(detectPromptIntent("Fix hubRouter bug", {}).editEnvelope, false, "Fix must stay excluded from detectPromptIntent EDIT_VERB_RE");
            assert.equal(isLikelyEditSessionPrompt("Why does `hubRouter` return 1?"), false);

            const escSid = mkSid("r4-esc");
            await handleAgyPreInvocation(
                { conversationId: escSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-carbon-medium", prompt: swePrompt },
                { captureStdout: true },
            );
            assert.equal(readAgySession(escSid).isEditPrompt, true);
            for (let t = 1; t <= 8; t++) {
                const res = JSON.parse(
                    await handleAgyPreInvocation(
                        { conversationId: escSid, workspacePaths: [repo], cwd: repo, modelName: "gemini-4-carbon-medium" },
                        { captureStdout: true },
                    ),
                );
                const msg = res.injectSteps?.[0]?.systemMessage?.systemMessage || "";
                if (t === 4) assert.match(msg, /4 exploration turns elapsed/);
                else if (t === 8) assert.match(msg, /8 exploration turns elapsed.*Stop running further/);
                else assert.equal(res.injectSteps, undefined, `expected no escalation message on turn ${t}`);
            }

            // 5. Gemini >3-caller inlining & <=28L backfill (Round 6 calibrated budgets)
            assert.equal(HOOK_BUDGETS.editMergedBytes, 4000);
            assert.equal(GEMINI_HOOK_BUDGETS.editMergedBytes, 5800);
            const gemPin = queryPromptContext(repo, "Update `hubRouter` in `src/hub.js`.", { geminiProfile: true });
            const gemTxt = relevantRetrieval(gemPin, {}, 5, { geminiProfile: true });
            assert.match(String(gemTxt || ""), /caller in src\/c[1-4]\.js:/, "Gemini must inline up to 3 callers even when >3 callers exist");

            // 6. Surgical mid-file >=60L read untouched; >=35L overlap trimmed; single npx plexer & WaitMsBeforeAsync rewritten; <3ms bypass
            const surgState = { seenSpans: {}, fileSliceCounts: {}, lastFileReadEnd: {} };
            const surgicalPath = join(repo, "src", "surgical.js");
            assert.equal(
                computeReadPreToolWidening({ Path: surgicalPath, StartLine: 180, EndLine: 260 }, repo, surgState),
                null,
                "intentional >=60L mid-file surgical read must not over-widen",
            );
            surgState.seenSpans = { "src/surgical.js": [[1, 220]] };
            const trimmedSurg = computeReadPreToolWidening({ Path: surgicalPath, StartLine: 180, EndLine: 270 }, repo, surgState);
            assert.deepEqual(trimmedSurg && { s: trimmedSurg.startLine, e: trimmedSurg.endLine }, { s: 221, e: 270 });

            assert.match(String(rewriteSingleNpxPlexerCommand('npx plexer grep "hubRouter" src') || ""), /(?:^plexer|plexer\.js)\b.*grep.*hubRouter/);
            const bumped = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: escSid,
                        workspacePaths: [repo],
                        toolCall: { name: "run_command", args: { CommandLine: "npx plexer read src/hub.js:L1-L6", WaitMsBeforeAsync: 500 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(bumped.decision, "allow");
            assert.equal(bumped.overwrite?.WaitMsBeforeAsync, 5000);
            assert.match(String(bumped.overwrite?.CommandLine || ""), /read src\/hub\.js:L1-L6/);

            const bypassOut = execFileSync(
                process.execPath,
                [join(PKG_ROOT, "bin", "plexer-hook-client.cjs"), "agy-pre-tool"],
                {
                    cwd: repo,
                    input: JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "git status" } } }),
                    encoding: "utf8",
                    env: { ...process.env, PLEXER_DAEMON_SOCK: "/nonexistent/plexer-bypass-test.sock" },
                },
            );
            assert.equal(bypassOut.trim(), '{"decision":"allow"}');

            // 7. --fixed pipe-separated identifiers natively match both symbols without regex errors
            const fixedPipeOut = execFileSync(
                process.execPath,
                [CLI_BIN, "grep", "hubRouter|surgicalCenterTarget", "src", "--fixed"],
                { cwd: repo, encoding: "utf8", env: { ...process.env, PLEXER_NO_DAEMON: "1" } },
            );
            assert.match(fixedPipeOut, /hubRouter/);
            assert.match(fixedPipeOut, /surgicalCenterTarget/);
        } finally {
            for (const s of sids) rmSync(agySessionPath(s), { force: true });
            rmSync(appData, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("Round 5: preserves 12KB Turn-0 + post-fit seenSpans, App user_markdown + sidecar link, <9.5KB CLI pipes, generic pin guard, page-1 widen, repeatable --in & swarm cache", async () => {
        const repo = makeTempRepo("plexer-r5-");
        const appData = mkdtempSync(join(tmpdir(), "plexer-r5-app-"));
        const sids = [];
        const mkSid = (label) => {
            const s = `${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            sids.push(s);
            return s;
        };
        const prevPath = process.env.PATH;
        try {
            // 1. Fixture files: large top-of-file module, 40L..60L query-backfill module, overloaded `close`, stem vs barrel tests, dash literal `--!strict`
            mkdirSync(join(repo, "src", "ui"), { recursive: true });
            mkdirSync(join(repo, "src", "net"), { recursive: true });
            mkdirSync(join(repo, "src", "sub"), { recursive: true });
            mkdirSync(join(repo, "test"), { recursive: true });

            const pageLines = ["describe('LargeSuite', () => {"];
            for (let i = 1; i <= 420; i++) pageLines.push(`  const stepItem_${i} = ${i};`);
            pageLines.push("});");
            writeFileSync(join(repo, "src", "large_suite.js"), `${pageLines.join("\n")}\n`);

            writeFileSync(
                join(repo, "src", "store.js"),
                "export function updateStoreEntry(k, v) { return [k, v]; }\nexport function clearStoreCache() { return 0; }\n",
            );
            writeFileSync(
                join(repo, "src", "barrel.js"),
                "export { updateStoreEntry } from './store.js';\nexport { alphaNetworkFetch } from './net/client.js';\n",
            );
            const mediumLines = ["export function renderHeaderSummary(ctx) {"];
            for (let i = 1; i <= 42; i++) {
                mediumLines.push(i === 28
                    ? "  const pendingConfirmationToken = ctx.pendingEmailConfirmToken();"
                    : `  const headerField_${i} = ctx.f${i};`);
            }
            mediumLines.push("  return pendingConfirmationToken;\n}");
            writeFileSync(join(repo, "src", "header.js"), `${mediumLines.join("\n")}\n`);

            writeFileSync(
                join(repo, "src", "net", "client.js"),
                "//--!strict\nexport class AlphaNetworkClient {\n  close() { return true; }\n  connect() { return 1; }\n}\nexport function alphaNetworkFetch() { return new AlphaNetworkClient(); }\n",
            );
            writeFileSync(
                join(repo, "src", "ui", "dialog_a.js"),
                "export class DialogAlpha { close() { return 'a'; } }\n",
            );
            writeFileSync(
                join(repo, "src", "ui", "dialog_b.js"),
                "export class DialogBeta { close() { return 'b'; } }\n",
            );
            writeFileSync(
                join(repo, "src", "sub", "worker_note.js"),
                "//--!strict\nexport function subWorkerFlag() { return 'ok'; }\n",
            );
            writeFileSync(
                join(repo, "test", "store.test.js"),
                "import { updateStoreEntry } from '../src/store.js';\nupdateStoreEntry('a', 1);\n",
            );
            writeFileSync(
                join(repo, "test", "barrel_consumer.test.js"),
                "import { updateStoreEntry } from '../src/barrel.js';\nupdateStoreEntry('b', 2);\n",
            );

            await buildGraph(repo, { force: true });
            const graph = JSON.parse(execFileSync(process.execPath, [CLI_BIN, "ask", "AlphaNetworkClient", "--json"], { cwd: repo, encoding: "utf8", env: { ...process.env, PLEXER_NO_DAEMON: "1" } }));
            assert.ok(graph.hits.length >= 1);

            // 2. fitAgyEphemeral 12KB preservation + numbered-block clean drop + post-fit seenSpans accuracy
            const hitBlock1 = ` 1. alphaFn · function: src/net/client.js:L1-L4\n\`\`\`\nL1: a\nL2: b\nL3: c\nL4: d\n\`\`\``;
            const hitBlock2 = ` 2. droppedFn · function: src/header.js:L1-L4\n\`\`\`\nL1: ${"x".repeat(400)}\nL2: ${"y".repeat(400)}\nL3: z\n\`\`\``;
            const bigText = `[plexer] retrieved context:\n${hitBlock1}\n${hitBlock2}`;
            const fitted = fitAgyEphemeral(bigText, 600);
            assert.ok(!fitted.includes("...(truncated)"), "numbered hit drop avoids mid-fence truncation");
            assert.ok(!fitted.includes("src/header.js"), "dropped second hit omitted from fitted text");
            const seenPostFit = {};
            recordEmittedRetrievalTextSpans(seenPostFit, fitted);
            assert.ok(Array.isArray(seenPostFit["src/net/client.js"]));
            assert.equal(seenPostFit["src/header.js"], undefined, "dropped Turn-0 block must not poison seenSpans");
            assert.equal(fitAgyEphemeral("x".repeat(10000), 12000).length, 10000, "10KB payload fits 12KB default intact");

            // 3. Default App user_markdown + sidecar link (CLI & opt-out stay undefined)
            const appSid = mkSid("r5-app-md");
            const appDir = join(appData, "antigravity");
            const appTPath = join(appDir, "brain", appSid, ".system_generated", "logs", "transcript.jsonl");
            mkdirSync(join(appTPath, ".."), { recursive: true });
            writeFileSync(appTPath, JSON.stringify({ step_index: 0, type: "USER_INPUT", content: "Inspect `AlphaNetworkClient` and `updateStoreEntry`" }) + "\n");
            const appRes = JSON.parse(await handleAgyPreInvocation({
                conversationId: appSid,
                workspacePaths: [repo],
                transcriptPath: appTPath,
                modelName: "gemini-4-hydrogen-medium",
                prompt: "Inspect `AlphaNetworkClient` and `updateStoreEntry`",
            }, { captureStdout: true }));
            const appMd = appRes.injectSteps?.[0]?.systemMessage?.metadata?.user_markdown || "";
            assert.match(appMd, /^\[plexer\]/);
            assert.match(appMd, /\[Graph\]\(sidecar:\/\/plexer\/viz\/\?tab=context\)/);

            const cliSid = mkSid("r5-cli-md");
            const cliRes = JSON.parse(await handleAgyPreInvocation({
                conversationId: cliSid,
                workspacePaths: [repo],
                transcriptPath: join(appData, "antigravity-cli", "brain", cliSid, ".system_generated", "logs", "transcript.jsonl"),
                modelName: "gemini-4-carbon-medium",
                prompt: "Inspect `AlphaNetworkClient` and `updateStoreEntry`",
            }, { captureStdout: true }));
            assert.equal(cliRes.injectSteps?.[0]?.systemMessage?.metadata, undefined, "CLI transcript skips user_markdown");

            const optOutSid = mkSid("r5-optout-md");
            const optOutRes = JSON.parse(await handleAgyPreInvocation({
                conversationId: optOutSid,
                workspacePaths: [repo],
                transcriptPath: appTPath,
                modelName: "gemini-4-hydrogen-medium",
                prompt: "Inspect `AlphaNetworkClient`",
            }, { captureStdout: true, enableUserMarkdown: false }));
            assert.equal(optOutRes.injectSteps?.[0]?.systemMessage?.metadata, undefined, "PLEXER_AGY_USER_MARKDOWN=0 opts out cleanly");

            // 4. <9.5KB 3-span read cap, continuation hint, PreToolUse strips multi-span --full, & seenSpans safe against middle-truncation
            const p1 = "L".repeat(20);
            writeFileSync(join(repo, "src", "big1.js"), Array.from({ length: 140 }, (_, i) => `export const bigA_${i + 1} = "${p1}";`).join("\n") + "\n");
            writeFileSync(join(repo, "src", "big2.js"), Array.from({ length: 140 }, (_, i) => `export const bigB_${i + 1} = "${p1}";`).join("\n") + "\n");
            writeFileSync(join(repo, "src", "big3.js"), Array.from({ length: 140 }, (_, i) => `export const bigC_${i + 1} = "${p1}";`).join("\n") + "\n");
            const read3 = readSpans(repo, ["src/big1.js:L1-L140", "src/big2.js:L1-L140", "src/big3.js:L1-L140"]);
            const read3Txt = formatReadSpans(read3);
            assert.ok(Buffer.byteLength(read3Txt, "utf8") < 9500, `3-span read exceeded 9.5KB: ${Buffer.byteLength(read3Txt, "utf8")}`);
            assert.match(read3Txt, /run `plexer read src\/big\d\.js:L\d+-L\d+` or use read_file/);
            assert.doesNotMatch(String(rewriteSingleNpxPlexerCommand("plexer read src/big1.js:L1-L140 src/big2.js:L1-L140 --full") || ""), /--full/);
            const fakeBin = join(appData, "bin");
            mkdirSync(fakeBin, { recursive: true });
            writeFileSync(join(fakeBin, process.platform === "win32" ? "plexer.cmd" : "plexer"), "#!/bin/sh\n");
            process.env.PATH = `${fakeBin}${process.platform === "win32" ? ";" : ":"}${prevPath || ""}`;
            assert.equal(rewriteSingleNpxPlexerCommand("plexer read src/big1.js:L1-L140 --full"), null, "single-span --full stays intact on PATH");
            process.env.PATH = "";
            assert.match(
                String(rewriteSingleNpxPlexerCommand("plexer read src/big1.js:L1-L140 --full") || ""),
                /plexer\.js['"]? read src\/big1\.js:L1-L140 --full$/,
                "single-span --full keeps --full off PATH",
            );
            process.env.PATH = prevPath;

            const truncSid = mkSid("r5-trunc-read");
            const prevAgyAgent = process.env.ANTIGRAVITY_AGENT;
            process.env.ANTIGRAVITY_AGENT = "1";
            try {
                let truncOut = "";
                await runCli(["node", "plexer", "read", "src/big1.js:L1-L140", "src/big2.js:L1-L140", "--full", "--session", truncSid], {
                    isCaptured: true, cwd: repo, antigravityPipeCap: false,
                    writeOut: (s) => { truncOut += s; }, writeErr: () => {}, exit: () => {},
                });
                assert.ok(Buffer.byteLength(truncOut, "utf8") > 9500);
                const tState = readAgySession(truncSid);
                assert.equal(tState.seenSpans["src/big2.js"], undefined, "middle-truncated tail span must not enter seenSpans");
            } finally {
                if (prevAgyAgent === undefined) delete process.env.ANTIGRAVITY_AGENT;
                else process.env.ANTIGRAVITY_AGENT = prevAgyAgent;
            }

            // 5. Generic unmatched `stream.close()` pin rejection + stem test link rank + 29..140L crux backfill
            const pinCtx = queryPromptContext(repo, "Fix `stream.close()` regression in `AlphaNetworkClient` and check `pendingEmailConfirmToken` in `renderHeaderSummary`.", { geminiProfile: true });
            const dialogPinned = (pinCtx?.hits || []).some((h) => h.pinned && /dialog_a|dialog_b/.test(h.pointer || ""));
            assert.equal(dialogPinned, false, "unmatched `stream.close` must not pin unrelated UI dialogs");
            assert.ok((pinCtx?.hits || []).some((h) => h.pinned && /AlphaNetworkClient/.test(h.title || "")), "compound class pins cleanly");

            const backfillHits = [
                { pointer: "src/net/client.js:L1-L5", code: "L1: // keep\n" },
                { pointer: "src/header.js:L1-L45" },
            ];
            backfillCompactPointerHits(repo, backfillHits, 4000, pointerCovers, "pendingConfirmationToken pendingEmailConfirmToken");
            assert.match(String(backfillHits[1].code || ""), /pendingEmailConfirmToken/, "backfill inlines query-matched window inside 29-140L span");

            const { loadGraphCached } = await import("../src/context/graph-store.js");
            const { contextDirFor } = await import("../src/util/paths.js");
            const links = linkTestsForGraph(loadGraphCached(contextDirFor(repo)));
            const storeTests = links.testsForFile("src/store.js");
            assert.equal(storeTests[0]?.testFile, "test/store.test.js", "exact stem companion test must outrank indirect barrel test");

            // 6. Top-of-file page-1 widening, bare plexer off-PATH rewrite, repeatable --in & --!strict grep
            const page1 = computeReadPreToolWidening({ Path: join(repo, "src", "large_suite.js"), StartLine: 1, EndLine: 130 }, repo, { seenSpans: {}, fileSliceCounts: {}, lastFileReadEnd: {} });
            assert.ok(page1 && page1.startLine === 1 && page1.endLine >= 250 && page1.endLine <= 360, `expected page-1 widen, got ${JSON.stringify(page1)}`);

            process.env.PATH = "";
            const offPathCmd = rewriteSingleNpxPlexerCommand("plexer read src/store.js:L1-L2");
            assert.match(String(offPathCmd || ""), /plexer\.js.*read src\/store\.js:L1-L2/);
            process.env.PATH = prevPath;

            const dashGrepOut = execFileSync(
                process.execPath,
                [CLI_BIN, "grep", "--!strict", "--in", "src/net", "--in", "src/sub", "--fixed"],
                { cwd: repo, encoding: "utf8", env: { ...process.env, PLEXER_NO_DAEMON: "1" } },
            );
            assert.match(dashGrepOut, /src\/net\/client\.js/);
            assert.match(dashGrepOut, /src\/sub\/worker_note\.js/);

            // 7. RequestFeedback: false guard, orchestratorPhase reset, multi-turn subagentSenderId, & swarm mtime cache
            const planArtifact = join(appData, "brain", appSid, "implementation_plan.md");
            assert.equal(isPlanToolCall("write_file", { ArtifactMetadata: { RequestFeedback: false } }, { artifactDirectoryPath: join(appData, "brain", appSid) }, planArtifact), false);
            assert.equal(isPlanToolCall("write_file", { ArtifactMetadata: { RequestFeedback: true } }, { artifactDirectoryPath: join(appData, "brain", appSid) }, planArtifact), true);

            const orchSid = mkSid("r5-orch-reset");
            const orchState = emptyAgySession();
            orchState.isOrchestratorModel = true;
            orchState.orchestratorPhase = "execute";
            orchState.pendingPlanHandoff = "[plexer] stale handoff";
            orchState.pendingPlanAwaitApproval = true;
            writeAgySession(orchSid, orchState);
            await handleAgyPreInvocation({ conversationId: orchSid, workspacePaths: [repo], cwd: repo, modelName: "Orchestrator", prompt: "Explain `updateStoreEntry`" }, { captureStdout: true });
            assert.notEqual(readAgySession(orchSid).orchestratorPhase, "execute");

            const subSid = mkSid("r5-sub-multi");
            const subLog = join(appData, "brain", subSid, ".system_generated", "logs", "transcript.jsonl");
            mkdirSync(join(subLog, ".."), { recursive: true });
            const parentId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
            writeFileSync(subLog, [
                JSON.stringify({ step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: `[Message] timestamp=t1 sender=${parentId} content=Inspect AlphaNetworkClient` }),
                JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "" }),
                JSON.stringify({ step_index: 2, source: "SYSTEM", type: "SYSTEM_MESSAGE", content: `[Message] timestamp=t2 sender=${parentId} content=Also inspect updateStoreEntry` }),
            ].join("\n") + "\n");
            const subState = emptyAgySession();
            parseAgyTranscript(subLog, subState);
            assert.equal(subState.lastUserPrompt, "Also inspect updateStoreEntry");
            assert.equal(subState.subagentSenderId, parentId);

            // Populate dummy brain dirs and verify second locateSwarmRoster miss hits cache fast
            const swarmBrain = join(appData, "brain");
            for (let i = 0; i < 40; i++) mkdirSync(join(swarmBrain, `dummy-${i}`), { recursive: true });
            assert.equal(locateSwarmRoster("missing-worker-x", [appData]), null);
            const tWarm0 = performance.now();
            for (let i = 0; i < 50; i++) locateSwarmRoster(`missing-worker-${i}`, [appData]);
            const avgMissMs = (performance.now() - tWarm0) / 50;
            assert.ok(avgMissMs < 0.5, `warm locateSwarmRoster miss too slow: ${avgMissMs.toFixed(3)}ms`);
        } finally {
            process.env.PATH = prevPath;
            for (const s of sids) rmSync(agySessionPath(s), { force: true });
            rmSync(appData, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
