import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../src/index.js";
import { startDaemon } from "../src/daemon/plexerd.js";
import { agySessionPath, emptyAgySession } from "../src/agy/session.js";
import { resolveAgyRepoDir } from "../src/hosts/engine/agy-context.js";
import { handleAgyPreInvocation } from "../src/hosts/engine/turn0.js";
import { handleAgyPreTool } from "../src/hosts/engine/dispatcher.js";
import { handleAgyPostTool } from "../src/hosts/engine/post-tool.js";
import { installAntigravitySkill } from "../src/hosts/antigravity.js";
import { rewriteChainedPlexerCommand } from "../src/agy/pre-tool.js";
import {
    applySeenSpansFilter,
    detectCompactionReset,
    isSpanCovered,
    mergeSpan,
    normalizeRelFile,
    parsePointerSpan,
    recordRetrievalSpans,
} from "../src/agy/spans.js";
import { buildSidecarSummary } from "../sidecars/viz/main.mjs";

const PKG_ROOT = resolve(import.meta.dirname, "..");
const CLI_BIN = join(PKG_ROOT, "bin", "plexer.js");
const HOOK_CLIENT = join(PKG_ROOT, "bin", "plexer-hook-client.cjs");

function makeLongModuleLines() {
    const lines = [
        "// Fixture 500-line module with distinct multi-line AST symbols",
        "export function alphaHeader(x) {",
    ];
    for (let i = 0; i < 38; i++) lines.push(`    const h${i} = x + ${i};`);
    lines.push("    return h37;");
    lines.push("}");
    lines.push("");
    lines.push("export function computeInvoiceLedgerTotal(entries, taxRate = 0.08) {");
    for (let i = 0; i < 55; i++) lines.push(`    const step_${i} = (entries.length || 1) + ${i};`);
    lines.push("    return Math.round((step_54 * (1 + taxRate)) * 100) / 100;");
    lines.push("}");
    lines.push("");
    for (let fnIdx = 0; fnIdx < 7; fnIdx++) {
        lines.push(`export function fillerBlock_${fnIdx}(v) {`);
        for (let k = 0; k < 54; k++) lines.push(`    const k_${fnIdx}_${k} = v + ${k};`);
        lines.push(`    return k_${fnIdx}_53;`);
        lines.push("}");
        lines.push("");
    }
    while (lines.length < 500) {
        lines.push(`// tail padding line ${lines.length + 1}`);
    }
    return lines;
}

async function createFixtureRepo() {
    const repo = mkdtempSync(join(tmpdir(), "plexer-agy-first-"));
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, ".system_generated", "steps", "5"), { recursive: true });

    const smallLines = [
        'import { computeInvoiceLedgerTotal } from "./ledger.js";',
        "",
        "export function formatCurrencyAmount(amount) {",
        "    return `$${Number(amount).toFixed(2)}`;",
        "}",
        "",
        "export function settleCustomerBilling(order) {",
        "    const total = computeInvoiceLedgerTotal(order.items || [], 0.07);",
        "    const label = formatCurrencyAmount(total);",
        "    return { total, label };",
        "}",
    ];
    while (smallLines.length < 80) smallLines.push(`// small pad ${smallLines.length + 1}`);

    const consumerLines = [
        'import { settleCustomerBilling } from "./small.js";',
        "",
        "export function checkoutSessionHandler(cart) {",
        "    return settleCustomerBilling(cart);",
        "}",
        "",
        "export function retryFailedCheckout(cart) {",
        "    return settleCustomerBilling(cart);",
        "}",
    ];

    writeFileSync(join(repo, "src", "small.js"), `${smallLines.join("\n")}\n`);
    writeFileSync(join(repo, "src", "ledger.js"), `${makeLongModuleLines().join("\n")}\n`);
    writeFileSync(join(repo, "src", "consumer.js"), `${consumerLines.join("\n")}\n`);
    writeFileSync(join(repo, "src", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(repo, ".system_generated", "steps", "5", "output.txt"), "step output line 1\nstep output line 2\n");

    execFileSync("git", ["init", "-q"], { cwd: repo });
    await buildGraph(repo, { force: true });
    return repo;
}

describe("Antigravity-First Plugin, PreToolUse Overwrite, Session State & Daemon", () => {
    it("PreToolUse widens small files, AST-snaps 1st large slice, widens 2nd large slice, and skips non-repo/binary/spill/byteOffset reads", async () => {
        const repo = await createFixtureRepo();
        const outsideFile = join(tmpdir(), `plexer-outside-${process.pid}.js`);
        writeFileSync(outsideFile, "export const outside = true;\n");
        const sid = `pretool-${process.pid}`;
        try {
            const smallPath = join(repo, "src", "small.js");
            const outSmall = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: smallPath, StartLine: 10, EndLine: 30 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(outSmall.decision, "allow");
            assert.deepEqual(outSmall.overwrite, { StartLine: 1, EndLine: 80 });
            assert.equal(typeof outSmall.overwrite.StartLine, "number");
            assert.equal(typeof outSmall.overwrite.EndLine, "number");

            const ledgerPath = join(repo, "src", "ledger.js");
            const ledgerTotalLines = readFileSync(ledgerPath, "utf8").replace(/\n$/, "").split("\n").length;
            const outSlice1 = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "view_file", args: { AbsolutePath: ledgerPath, StartLine: 55, EndLine: 75 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(outSlice1.decision, "allow");
            assert.ok(outSlice1.overwrite, "1st slice inside multi-line symbol must snap to AST bounds");
            assert.equal(outSlice1.overwrite.StartLine, 44);
            assert.equal(outSlice1.overwrite.EndLine, 101);
            assert.ok(outSlice1.overwrite.EndLine < ledgerTotalLines);

            const outSlice2 = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: ledgerPath, StartLine: 120, EndLine: 150 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(outSlice2.decision, "allow");
            assert.deepEqual(outSlice2.overwrite, { StartLine: 1, EndLine: ledgerTotalLines });

            const noOps = [
                { Path: join(repo, ".system_generated", "steps", "5", "output.txt"), StartLine: 1, EndLine: 10 },
                { Path: join(repo, "src", "icon.png"), StartLine: 1, EndLine: 5 },
                { Path: smallPath, StartLine: 1, EndLine: 20, ByteOffset: 100 },
                { Path: smallPath },
                { Path: outsideFile, StartLine: 1, EndLine: 1 },
            ];
            for (const args of noOps) {
                const res = JSON.parse(
                    handleAgyPreTool(
                        {
                            conversationId: sid,
                            workspacePaths: [repo],
                            toolCall: { name: "read_file", args },
                        },
                        { captureStdout: true },
                    ),
                );
                assert.equal(res.decision, "allow");
                assert.equal(res.overwrite, undefined, `expected no overwrite for ${JSON.stringify(args)}`);
            }
        } finally {
            rmSync(repo, { recursive: true, force: true });
            rmSync(outsideFile, { force: true });
            rmSync(agySessionPath(sid), { force: true });
        }
    });

    it("PreToolUse coalesces &&-chained plexer reads into _batch under 9000 bytes and leaves arbitrary commands untouched", async () => {
        const repo = await createFixtureRepo();
        const sid = `batch-${process.pid}`;
        try {
            const cmdRes = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: {
                            name: "run_command",
                            args: { CommandLine: "plexer read src/small.js:1-20 && plexer callers settleCustomerBilling" },
                        },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(cmdRes.decision, "allow");
            assert.match(cmdRes.overwrite?.CommandLine || "", /^plexer _batch [A-Za-z0-9_-]+$/);

            const b64Token = cmdRes.overwrite.CommandLine.split(" ")[2];
            const noDaemonEnv = { ...process.env, PLEXER_NO_DAEMON: "1" };
            const outSmallBatch = execFileSync(process.execPath, [CLI_BIN, "_batch", b64Token], {
                cwd: repo,
                encoding: "utf8",
                env: noDaemonEnv,
            });
            assert.match(outSmallBatch, /settleCustomerBilling/);
            assert.match(outSmallBatch, /checkoutSessionHandler/);
            assert.ok(Buffer.byteLength(outSmallBatch, "utf8") <= 9000);

            const bigBatchCmd = rewriteChainedPlexerCommand(
                "plexer read src/ledger.js:1-500 && plexer read src/small.js:1-80 && plexer skeleton src/ledger.js src/small.js src/consumer.js",
            );
            assert.ok(bigBatchCmd);
            const bigToken = bigBatchCmd.split(" ")[2];
            const outBigBatch = execFileSync(process.execPath, [CLI_BIN, "_batch", bigToken], {
                cwd: repo,
                encoding: "utf8",
                env: noDaemonEnv,
            });
            assert.ok(Buffer.byteLength(outBigBatch, "utf8") <= 9000, "pooled _batch output must stay <= 9000 bytes");

            const ignoredCmds = [
                "git status && npm test",
                '"echo a" && "echo b"',
                "plexer read src/small.js:1-20 | head -n 5",
            ];
            for (const CommandLine of ignoredCmds) {
                const res = JSON.parse(
                    handleAgyPreTool(
                        {
                            conversationId: sid,
                            workspacePaths: [repo],
                            toolCall: { name: "run_command", args: { CommandLine } },
                        },
                        { captureStdout: true },
                    ),
                );
                assert.equal(res.decision, "allow");
                assert.equal(res.overwrite, undefined, `must not rewrite: ${CommandLine}`);
            }
        } finally {
            rmSync(repo, { recursive: true, force: true });
            rmSync(agySessionPath(sid), { force: true });
        }
    });

    it("tracks session seenSpans, resets on /compact, emits 1-shot mid-loop hint, sets user_markdown, and strips read-only subagent boilerplate", async () => {
        const repo = await createFixtureRepo();
        const sidMatched = `sess-match-${process.pid}`;
        const sidMiss = `sess-miss-${process.pid}`;
        const sidSub = `sess-sub-${process.pid}`;
        try {
            const turn1 = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidMatched,
                        workspacePaths: [repo],
                        initialNumSteps: 2,
                        prompt: "Explain settleCustomerBilling and computeInvoiceLedgerTotal",
                    },
                    { captureStdout: true },
                ),
            );
            assert.ok(Array.isArray(turn1.injectSteps) && turn1.injectSteps.length === 1);
            assert.equal(turn1.injectSteps[0].systemMessage.metadata, undefined);

            const cliAskSeen = execFileSync(
                process.execPath,
                [CLI_BIN, "ask", "settleCustomerBilling", "--session", sidMatched],
                { cwd: repo, encoding: "utf8", env: { ...process.env, PLEXER_NO_DAEMON: "1" } },
            );
            assert.match(cliAskSeen, /\[already in session context: src\/small\.js:/);

            // Simulate agent reading src/small.js:1-80, then asking about formatCurrencyAmount (not yet in injectedPointers)
            handleAgyPostTool(
                {
                    conversationId: sidMatched,
                    workspacePaths: [repo],
                    toolCall: { name: "read_file", args: { Path: join(repo, "src", "small.js"), StartLine: 1, EndLine: 80 } },
                },
                { captureStdout: true },
            );
            const turn2 = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidMatched,
                        workspacePaths: [repo],
                        initialNumSteps: 20,
                        prompt: "Check formatCurrencyAmount",
                    },
                    { captureStdout: true },
                ),
            );
            const t2Text = turn2.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(t2Text, /\[already in session context: src\/small\.js:/);

            // Simulate /compact resetting step count from 20 -> 4 and clearing seenSpans
            const turnCompacted = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidMatched,
                        workspacePaths: [repo],
                        initialNumSteps: 4,
                        prompt: "Explain settleCustomerBilling from scratch",
                    },
                    { captureStdout: true },
                ),
            );
            const tCompText = turnCompacted.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.doesNotMatch(tCompText, /\[already in session context:/);
            assert.match(tCompText, /L\d+:/);

            // Turn 0 miss -> read_file PostToolUse -> at most one <=600B mid-loop graph hint -> silent afterward
            await handleAgyPreInvocation(
                {
                    conversationId: sidMiss,
                    workspacePaths: [repo],
                    initialNumSteps: 1,
                    prompt: "zzqxyNonExistentSymbolProbe",
                },
                { captureStdout: true },
            );
            handleAgyPostTool(
                {
                    conversationId: sidMiss,
                    workspacePaths: [repo],
                    toolCall: { name: "read_file", args: { Path: join(repo, "src", "small.js"), StartLine: 1, EndLine: 80 } },
                },
                { captureStdout: true },
            );
            const midHint = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidMiss,
                        workspacePaths: [repo],
                        initialNumSteps: 3,
                    },
                    { captureStdout: true, enableUserMarkdown: true },
                ),
            );
            const hintMsg = midHint.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(hintMsg, /^\[plexer\] graph context for src\/small\.js:/);
            assert.ok(Buffer.byteLength(hintMsg, "utf8") <= 600);
            assert.match(midHint.injectSteps[0].systemMessage.metadata.user_markdown, /graph context for `small\.js`/);

            const midStepNext = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidMiss,
                        workspacePaths: [repo],
                        initialNumSteps: 5,
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(midStepNext.injectSteps, undefined);

            const isoSid = `iso-check-${process.pid}`;
            const isoOut = await handleAgyPreInvocation(
                {
                    conversationId: isoSid,
                    cwd: "/tmp/plexer-ab-carbon-medium-cold/flux",
                    prompt: "Explain Store",
                },
                { captureStdout: true },
            );
            assert.equal(isoOut, "{}\n");
            assert.equal(existsSync(agySessionPath(isoSid)), false);

            // Read-only subagent boilerplate stripping & CLI nudge suppression
            const subRes = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidSub,
                        workspacePaths: [repo],
                        agentName: "research",
                        prompt: "You are a read-only codebase research subagent. Do not edit files. Use read_file only.\nFind settleCustomerBilling implementation",
                    },
                    { captureStdout: true },
                ),
            );
            const subMsg = subRes.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.match(subMsg, /settleCustomerBilling/);
            assert.doesNotMatch(subMsg, /plexer read /);
            assert.doesNotMatch(subMsg, /-> Edit /);
        } finally {
            rmSync(repo, { recursive: true, force: true });
            rmSync(agySessionPath(sidMatched), { force: true });
            rmSync(agySessionPath(sidMiss), { force: true });
            rmSync(agySessionPath(sidSub), { force: true });
        }
    });

    it("isolates plugin CWD in resolveAgyRepoDir and protects symlinked ~/.gemini/config/skills during plugin install", () => {
        const emptyNonGitDir = mkdtempSync(join(tmpdir(), "plexer-non-git-"));
        const home = mkdtempSync(join(tmpdir(), "plexer-sym-home-"));
        try {
            const resolved = resolveAgyRepoDir(
                { workspacePaths: [emptyNonGitDir] },
                emptyAgySession(),
                { pluginRoot: PKG_ROOT, callerCwd: PKG_ROOT },
            );
            assert.equal(resolved, emptyNonGitDir);

            const geminiSkills = join(home, ".gemini", "skills");
            mkdirSync(geminiSkills, { recursive: true });
            symlinkSync(PKG_ROOT, join(geminiSkills, "plexer"));
            mkdirSync(join(home, ".gemini", "config"), { recursive: true });
            symlinkSync(geminiSkills, join(home, ".gemini", "config", "skills"));

            installAntigravitySkill(home, { hooks: true, skills: false, pkgRoot: PKG_ROOT });
            assert.ok(lstatSync(join(home, ".gemini", "config", "plugins", "plexer")).isSymbolicLink());
            assert.ok(existsSync(join(geminiSkills, "plexer", "SKILL.md")), "must never unlink shared ~/.gemini/skills/plexer via symlinked config/skills");
        } finally {
            rmSync(emptyNonGitDir, { recursive: true, force: true });
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("runs plexerd hook RPC (<80ms warm), CLI fast-path, PLEXER_NO_DAEMON fallback, and sidecar summary cleanly", async () => {
        const repo = await createFixtureRepo();
        const sockDir = mkdtempSync(join(tmpdir(), "plexer-sock-"));
        const sockPath = join(sockDir, "d.sock");
        const sid = `daemon-${process.pid}`;
        const daemon = await startDaemon({ socketPath: sockPath, idleTimeoutMs: 60000 });
        try {
            assert.equal(daemon.alreadyRunning, false);
            const env = { ...process.env, PLEXER_NO_DAEMON: "0", PLEXER_DAEMON_SOCK: sockPath, PLEXER_ENABLE_BENCH_HOOKS: "1" };

            // 1st warm-up hook call over Unix socket (use async execFile so in-process daemon event loop stays unblocked)
            const preInvRes = await execFileAsync(process.execPath, [HOOK_CLIENT, "agy-pre-invocation"], {
                cwd: PKG_ROOT,
                env: {
                    ...env,
                    PLEXER_TEST_STDIN: JSON.stringify({
                        conversationId: sid,
                        workspacePaths: [repo],
                        initialNumSteps: 1,
                        prompt: "Inspect settleCustomerBilling in src/small.js",
                    }),
                },
            });
            const preInv = JSON.parse(preInvRes.stdout);
            assert.ok(preInv.injectSteps?.length === 1);

            const t0 = performance.now();
            const [preToolRes, stopRes] = await Promise.all([
                execFileAsync(process.execPath, [HOOK_CLIENT, "agy-pre-tool"], {
                    cwd: PKG_ROOT,
                    env: {
                        ...env,
                        PLEXER_TEST_STDIN: JSON.stringify({
                            conversationId: sid,
                            workspacePaths: [repo],
                            toolCall: { name: "read_file", args: { Path: join(repo, "src", "small.js"), StartLine: 5, EndLine: 25 } },
                        }),
                    },
                }),
                execFileAsync(process.execPath, [HOOK_CLIENT, "agy-stop"], {
                    cwd: PKG_ROOT,
                    env: {
                        ...env,
                        PLEXER_TEST_STDIN: JSON.stringify({ conversationId: sid, workspacePaths: [repo] }),
                    },
                }),
            ]);
            const warmMs = performance.now() - t0;
            assert.deepEqual(JSON.parse(preToolRes.stdout), { decision: "allow", overwrite: { StartLine: 1, EndLine: 80 } });
            assert.deepEqual(JSON.parse(stopRes.stdout), { decision: "allow" });
            assert.ok(warmMs < 2500, `expected parallel warm socket round-trips within CI budget, got ${warmMs.toFixed(1)}ms`);

            const cliFastRes = await execFileAsync(process.execPath, [CLI_BIN, "callers", "settleCustomerBilling"], {
                cwd: repo,
                env,
            });
            assert.match(cliFastRes.stdout, /checkoutSessionHandler/);

            const noDaemonRes = await execFileAsync(process.execPath, [HOOK_CLIENT, "agy-pre-tool"], {
                cwd: PKG_ROOT,
                env: {
                    ...env,
                    PLEXER_NO_DAEMON: "1",
                    PLEXER_TEST_STDIN: JSON.stringify({
                        conversationId: sid,
                        workspacePaths: [repo],
                        toolCall: { name: "run_command", args: { CommandLine: "plexer read src/small.js:1-10 && plexer callers settleCustomerBilling" } },
                    }),
                },
            });
            const noDaemonFallback = JSON.parse(noDaemonRes.stdout);
            assert.match(noDaemonFallback.overwrite?.CommandLine || "", /^plexer _batch /);

            const summary = buildSidecarSummary(repo, sid);
            assert.equal(summary.indexed, true);
            assert.ok(summary.stats.nodeCount > 0);
            assert.ok(summary.hotspots.length > 0);
            assert.ok(summary.session.seenFiles.includes("src/small.js"));
        } finally {
            await daemon.close();
            rmSync(sockDir, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
            rmSync(agySessionPath(sid), { force: true });
        }
    });

    it("normalizes paths, coalesces spans, dedupes seen hits, and resets compaction state in agy/spans", () => {
        assert.equal(normalizeRelFile(".\\src\\agy\\spans.js"), "src/agy/spans.js");
        assert.equal(normalizeRelFile("./src/ask/ask.js"), "src/ask/ask.js");
        assert.equal(normalizeRelFile("/abs/path/file.js"), "/abs/path/file.js");
        assert.equal(normalizeRelFile(""), "");

        assert.deepEqual(parsePointerSpan("src/ask/ask.js:L10-L45, extra"), {
            file: "src/ask/ask.js",
            start: 10,
            end: 45,
        });
        assert.deepEqual(parsePointerSpan("./src/a.js:12"), { file: "src/a.js", start: 12, end: 12 });
        assert.equal(parsePointerSpan("not-a-pointer"), null);

        const seenSpans = {};
        mergeSpan(seenSpans, "./src/a.js", 10, 20);
        mergeSpan(seenSpans, "src\\a.js", 21, 30); // adjacent -> coalesces
        mergeSpan(seenSpans, "src/a.js", 40, 50);
        assert.deepEqual(seenSpans["src/a.js"], [
            [10, 30],
            [40, 50],
        ]);
        assert.equal(isSpanCovered(seenSpans, "src/a.js", 10, 30), true);
        assert.equal(isSpanCovered(seenSpans, "src/a.js", 10, 45), false);

        const spansFromHits = {};
        const askResult = {
            hits: [
                {
                    pointer: "src/a.js:L10-L15",
                    code: "L10: const a = 1;\nL11: const b = 2;\nL12: return a + b;",
                },
                {
                    pointer: "src/b.js:L1-L5",
                    code: "L1: export const x = 1;",
                },
            ],
        };
        recordRetrievalSpans(spansFromHits, { hits: [askResult.hits[0]] });
        assert.deepEqual(spansFromHits["src/a.js"], [[10, 12]]);

        const filtered = applySeenSpansFilter(askResult, spansFromHits);
        assert.equal(filtered.dedupedCount, 1);
        assert.equal(filtered.ask.hits[0].alreadySeen, true);
        assert.equal(filtered.ask.hits[0].code, "// [already in session context: src/a.js:L10-L12]");
        assert.equal(filtered.ask.hits[1].alreadySeen, undefined);
        assert.equal(filtered.ask.hits[1].code, "L1: export const x = 1;");

        const agyState = {
            seenSpans: spansFromHits,
            injectedPointers: ["src/a.js:L10-L12"],
            midLoopHintEmitted: true,
            pendingMidLoopFile: "src/a.js",
            fileSliceCounts: { "src/a.js": 2 },
            nudges: 3,
            orientedDirs: ["src"],
        };
        assert.equal(detectCompactionReset(agyState, { initialNumSteps: 10 }), false);
        assert.equal(agyState.lastInitialNumSteps, 10);
        assert.equal(detectCompactionReset(agyState, { initialNumSteps: 12 }), false);
        assert.equal(detectCompactionReset(agyState, { initialNumSteps: 3 }), true);
        assert.deepEqual(agyState.seenSpans, {});
        assert.deepEqual(agyState.injectedPointers, []);
        assert.equal(agyState.midLoopHintEmitted, false);
        assert.equal(agyState.pendingMidLoopFile, null);
        assert.deepEqual(agyState.fileSliceCounts, {});
        assert.equal(agyState.nudges, 0);
        assert.deepEqual(agyState.orientedDirs, []);
    });
});
