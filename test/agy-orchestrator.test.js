import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { agySessionPath, emptyAgySession, readAgySession, writeAgySession } from "../src/agy/session.js";
import { buildPlanExecutionHandoff } from "../src/agy/plan-handoff.js";
import { detectCompactionReset, mergeSpan } from "../src/agy/spans.js";
import { handleAgyPreInvocation } from "../src/hosts/engine/turn0.js";
import { handleAgyPostTool } from "../src/hosts/engine/post-tool.js";
import { handleAgyPreTool } from "../src/hosts/engine/dispatcher.js";
import { parseAgyTranscript } from "../src/hosts/engine/agy-transcript.js";
import {
    GEMINI_HOOK_BUDGETS,
    GEMINI_NARROW_HOOK_BUDGETS,
    XHIGH_GEMINI_HOOK_BUDGETS,
    isExtraHighEffortInput,
    isGeminiModelProfile,
    isHighOrExtraHighEffortInput,
    isOrchestratorInput,
    resolveHookBudgets,
} from "../src/hosts/engine/prompt/budget.js";
import {
    buildAgyCliArgs,
    normalizeAgyModelAlias,
    resolveAgyModelConfig,
} from "../bench/agy-bench-helper.js";
import { parseTranscript } from "../bench/grade.js";

function makeTempRepo(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    mkdirSync(join(dir, "src"), { recursive: true });
    return dir;
}

function extractSysMsg(rawJson) {
    const obj = JSON.parse(rawJson || "{}");
    return obj.injectSteps?.[0]?.systemMessage?.systemMessage || "";
}

describe("Antigravity 1.5.14 Full-Matrix Orchestrator Support & Grader", () => {
    it("resolves effort/profile helpers and preserves Orchestrator state across concrete planner & executor modelNames", () => {
        const st = emptyAgySession();
        st.isOrchestratorModel = true;
        st.orchestratorPhase = "plan";

        for (const m of [
            "gemini-4-neon-xhigh",
            "gemini-4-carbon-high",
            "gemini-4-hydrogen-xhigh",
            "claude-opus-5-5-high",
            "claude-sonnet-5-5-high",
            "gemini-pro-orchestrator-neon",
        ]) {
            assert.equal(isOrchestratorInput({ modelName: m }, st), true, `${m} should retain active orchestrator state`);
        }
        assert.equal(isOrchestratorInput({ modelName: "gemini-4-neon-xhigh" }, emptyAgySession()), false);
        assert.equal(isOrchestratorInput({ modelName: "gemini-pro-orchestrator-neon" }, null), true);

        assert.equal(isExtraHighEffortInput({ modelName: "gemini-4-neon-xhigh" }), true);
        assert.equal(isExtraHighEffortInput({ modelName: "gemini-4-hydrogen-xhigh" }), true);
        assert.equal(isExtraHighEffortInput({ modelName: "Gemini 4 Neon (XHigh)" }), true);
        assert.equal(isExtraHighEffortInput({ modelName: "gemini-4-neon-medium" }), false);
        assert.equal(isHighOrExtraHighEffortInput({ modelName: "gemini-4-neon-high" }), true);
        assert.equal(isHighOrExtraHighEffortInput({ modelName: "gemini-4-hydrogen-high" }), true);
        assert.equal(isHighOrExtraHighEffortInput({ modelName: "Gemini 4 Neon (High)" }), true);
        assert.equal(isHighOrExtraHighEffortInput({ modelName: "gemini-4-neon-xhigh" }), true);
        assert.equal(isHighOrExtraHighEffortInput({ modelName: "gemini-4-neon-medium" }), false);
        assert.equal(isHighOrExtraHighEffortInput({ modelName: "gemini-4-hydrogen-low" }), false);
        assert.equal(resolveHookBudgets({ geminiProfile: true, xhighProfile: false }), GEMINI_HOOK_BUDGETS);
        assert.equal(resolveHookBudgets({ geminiProfile: true, xhighProfile: true }), XHIGH_GEMINI_HOOK_BUDGETS);
        assert.equal(resolveHookBudgets({ geminiProfile: true, narrowPrompt: true }), GEMINI_NARROW_HOOK_BUDGETS);
        assert.equal(XHIGH_GEMINI_HOOK_BUDGETS.editMergedBytes, 5000);
        assert.equal(XHIGH_GEMINI_HOOK_BUDGETS.qaMergedBytes, 5800);
        assert.equal(isGeminiModelProfile({ modelName: "claude-sonnet-5-5-high" }, "agy"), false);
        assert.equal(isGeminiModelProfile({ modelName: "gemini-4-hydrogen-xhigh" }, "agy"), true);
    });

    it("handles <USER_SETTINGS_CHANGE>, [plan review] SYSTEM_MESSAGE, PLANNER_RESPONSE switches, and CHECKPOINT compaction", () => {
        const appData = mkdtempSync(join(tmpdir(), "plexer-orch-tx-"));
        try {
            const logsDir = join(appData, "brain", "tx-test", ".system_generated", "logs");
            mkdirSync(logsDir, { recursive: true });
            const txPath = join(logsDir, "transcript.jsonl");
            const entries = [
                {
                    step_index: 0,
                    type: "USER_INPUT",
                    content: "<USER_REQUEST>\nFix billing rate\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 4 Neon (XHigh).\n</USER_SETTINGS_CHANGE>",
                },
                {
                    step_index: 1,
                    type: "PLANNER_RESPONSE",
                    model: "gemini-4-neon-xhigh",
                    tool_calls: [{ name: "exit_plan_mode", args: { plan: "Edit src/rate.js" } }],
                },
                {
                    step_index: 2,
                    type: "PLANNER_RESPONSE",
                    model: "gemini-4-hydrogen-xhigh",
                    tool_calls: [{ name: "edit_file", args: { Path: "/tmp/src/rate.js" } }],
                },
                {
                    step_index: 3,
                    source: "SYSTEM",
                    type: "SYSTEM_MESSAGE",
                    content: "The following is a <SYSTEM_MESSAGE>\n<SYSTEM_MESSAGE> [plan review due] 30 steps",
                },
                {
                    step_index: 4,
                    type: "CHECKPOINT",
                },
            ];
            writeFileSync(txPath, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

            const st = emptyAgySession();
            parseAgyTranscript(txPath, st);
            assert.equal(st.isOrchestratorModel, true);
            assert.equal(st.plannerModel, "gemini-4-neon-xhigh");
            assert.equal(st.executorModel, "gemini-4-hydrogen-xhigh");
            assert.equal(st.orchestratorPhase, "plan");

            // Explicit switch away from Orchestrator clears orchestrator flags
            const st2 = emptyAgySession();
            st2.isOrchestratorModel = true;
            st2.orchestratorPhase = "plan";
            st2.plannerModel = "gemini-4-neon-xhigh";
            const tx2 = join(logsDir, "transcript2.jsonl");
            writeFileSync(
                tx2,
                `${JSON.stringify({
                    step_index: 0,
                    type: "USER_INPUT",
                    content: "<USER_REQUEST>\nHello\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Orchestrator (Neon) to Gemini 4 Hydrogen (Medium).\n</USER_SETTINGS_CHANGE>",
                })}\n`,
                "utf8",
            );
            parseAgyTranscript(tx2, st2);
            assert.equal(st2.isOrchestratorModel, false);
            assert.equal(st2.orchestratorPhase, null);
            assert.equal(st2.plannerModel, null);

            // detectCompactionReset retains orchestrator model identity
            const st3 = emptyAgySession();
            st3.isOrchestratorModel = true;
            st3.plannerModel = "claude-opus-5-5-high";
            st3.executorModel = "gemini-4-hydrogen-xhigh";
            st3.lastInitialNumSteps = 20;
            assert.equal(detectCompactionReset(st3, { initialNumSteps: 4 }), true);
            assert.equal(st3.isOrchestratorModel, true);
            assert.equal(st3.plannerModel, "claude-opus-5-5-high");
        } finally {
            rmSync(appData, { recursive: true, force: true });
        }
    });

    it("supports Q&A vs Edit Turn-0 headers, deferred mixed-model handoffs, post-plan duplicate-read/explore tightening, and enter_plan_mode", async () => {
        const repo = makeTempRepo("plexer-orch-flow-");
        const qaSid = `orch-qa-${process.pid}-${Date.now()}`;
        const editSid = `orch-edit-${process.pid}-${Date.now()}`;
        const mixedSid = `orch-mix-${process.pid}-${Date.now()}`;
        const grillSid = `orch-grill-${process.pid}-${Date.now()}`;
        const noWsSid = `orch-nows-${process.pid}-${Date.now()}`;
        try {
            const targetFile = join(repo, "src", "calc.js");
            const helperFile = join(repo, "src", "helper.js");
            const mediumLines = Array.from({ length: 42 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join("\n");
            writeFileSync(
                targetFile,
                `export function computeTaxRate(amount) {\n    return amount * 0.08;\n}\n${mediumLines}\n`,
                "utf8",
            );
            writeFileSync(
                helperFile,
                "import { computeTaxRate } from './calc.js';\nexport function formatBill(a) { return computeTaxRate(a).toFixed(2); }\n",
                "utf8",
            );
            await buildGraph(repo, { force: true });

            // 1. Q&A prompt in Orchestrator plan mode emits 0-call Q&A header (not "draft plan")
            const qaInit = emptyAgySession();
            qaInit.isOrchestratorModel = true;
            qaInit.orchestratorPhase = "plan";
            writeAgySession(qaSid, qaInit);
            const qaOut = extractSysMsg(
                await handleAgyPreInvocation(
                    {
                        conversationId: qaSid,
                        workspacePaths: [repo],
                        initialNumSteps: 1,
                        modelName: "gemini-4-neon-xhigh",
                        prompt: "How does `computeTaxRate` compute tax and who calls it?",
                    },
                    { captureStdout: true },
                ),
            );
            assert.match(qaOut, /reply citing `file:Lx-Ly` with 0 calls/);
            assert.doesNotMatch(qaOut, /draft plan/);
            let qaGuardMsg = "";
            for (let qt = 0; qt < 5; qt++) {
                qaGuardMsg = extractSysMsg(
                    await handleAgyPreInvocation(
                        { conversationId: qaSid, workspacePaths: [repo], initialNumSteps: 3 + qt, modelName: "gemini-4-neon-xhigh" },
                        { captureStdout: true },
                    ),
                );
                if (qt < 4) assert.equal(qaGuardMsg, "", `high/xhigh Q&A turn ${qt + 1} must remain silent before turn 5`);
            }
            assert.match(qaGuardMsg, /5 search turns elapsed.*synthesize your final answer/i);

            // 2. Edit prompt in plan mode -> Turn-4 wrapup nudge -> exit_plan_mode -> deferred executor handoff + tight dup-read + enter_plan_mode
            const editInit = emptyAgySession();
            editInit.isOrchestratorModel = true;
            editInit.orchestratorPhase = "plan";
            editInit.plannerModel = "gemini-4-neon-xhigh";
            writeAgySession(editSid, editInit);
            const editPlanOut = extractSysMsg(
                await handleAgyPreInvocation(
                    {
                        conversationId: editSid,
                        workspacePaths: [repo],
                        initialNumSteps: 1,
                        modelName: "gemini-4-neon-xhigh",
                        prompt: "Update `computeTaxRate` in `src/calc.js` to accept an optional override rate.",
                    },
                    { captureStdout: true },
                ),
            );
            assert.match(editPlanOut, /plan targets localized \(plan mode is read-only/);

            // Advance 5 silent planning turns, then 6th triggers softened plan-wrapup nudge (not edit-now!)
            let wrapMsg = "";
            for (let t = 0; t < 6; t++) {
                wrapMsg = extractSysMsg(
                    await handleAgyPreInvocation(
                        {
                            conversationId: editSid,
                            workspacePaths: [repo],
                            initialNumSteps: 2 + t,
                            modelName: "gemini-4-neon-xhigh",
                        },
                        { captureStdout: true },
                    ),
                );
                if (t < 5) assert.equal(wrapMsg, "", `planning turn ${t + 1} must remain silent before 6-turn guard`);
            }
            assert.match(wrapMsg, /6 planning turns elapsed.*exit_plan_mode/i);

            // Simulate reading all lines of src/calc.js during planning, then calling exit_plan_mode
            const stBeforeExit = readAgySession(editSid);
            mergeSpan(stBeforeExit.seenSpans, "src/calc.js", 1, 46);
            mergeSpan(stBeforeExit.seenSpans, "src/helper.js", 1, 3);
            writeAgySession(editSid, stBeforeExit);

            handleAgyPostTool(
                {
                    conversationId: editSid,
                    workspacePaths: [repo],
                    modelName: "gemini-4-neon-xhigh",
                    toolCall: { name: "exit_plan_mode", args: { plan: "Modify `src/calc.js:computeTaxRate`." } },
                },
                { captureStdout: true },
            );
            const afterExit = readAgySession(editSid);
            assert.equal(afterExit.orchestratorPhase, "execute");
            assert.equal(afterExit.preEditInvocations, 0);
            assert.ok(afterExit.pendingPlanText);

            // Executor PreInvocation materializes compact no-reread execution directive
            const execMsg = extractSysMsg(
                await handleAgyPreInvocation(
                    {
                        conversationId: editSid,
                        workspacePaths: [repo],
                        initialNumSteps: 8,
                        modelName: "gemini-4-hydrogen-xhigh",
                    },
                    { captureStdout: true },
                ),
            );
            assert.match(execMsg, /\[plexer\] execution handoff: planned targets .* already in context/);
            assert.equal(readAgySession(editSid).executorModel, "gemini-4-hydrogen-xhigh");

            // Post-handoff duplicate read >=30L (normally allowed under 90L) is blocked once with retry escape
            const dupDeny = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: editSid,
                        workspacePaths: [repo],
                        modelName: "gemini-4-hydrogen-xhigh",
                        toolCall: { name: "read_file", args: { Path: targetFile, StartLine: 1, EndLine: 40 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(dupDeny.decision, "deny");
            const dupRetry = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: editSid,
                        workspacePaths: [repo],
                        modelName: "gemini-4-hydrogen-xhigh",
                        toolCall: { name: "read_file", args: { Path: targetFile, StartLine: 1, EndLine: 40 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(dupRetry.decision, "allow");

            // Post-handoff executor exploration guard triggers at turn 2
            await handleAgyPreInvocation(
                { conversationId: editSid, workspacePaths: [repo], initialNumSteps: 10, modelName: "gemini-4-hydrogen-xhigh" },
                { captureStdout: true },
            );
            const execGuard = extractSysMsg(
                await handleAgyPreInvocation(
                    { conversationId: editSid, workspacePaths: [repo], initialNumSteps: 11, modelName: "gemini-4-hydrogen-xhigh" },
                    { captureStdout: true },
                ),
            );
            assert.match(execGuard, /2 execution turns elapsed with 0 edits after `exit_plan_mode`/);

            // enter_plan_mode flips phase back to 'plan' while preserving pendingBlastRadius
            const stWithBlast = readAgySession(editSid);
            stWithBlast.pendingBlastRadius = "[plexer] blast radius for calc.js, callers: formatBill (src/helper.js)";
            writeAgySession(editSid, stWithBlast);
            handleAgyPostTool(
                {
                    conversationId: editSid,
                    workspacePaths: [repo],
                    modelName: "gemini-4-hydrogen-xhigh",
                    toolCall: { name: "enter_plan_mode", args: { reason: "re-check rate edge case" } },
                },
                { captureStdout: true },
            );
            assert.equal(readAgySession(editSid).orchestratorPhase, "plan");
            const returnPlanMsg = extractSysMsg(
                await handleAgyPreInvocation(
                    { conversationId: editSid, workspacePaths: [repo], initialNumSteps: 13, modelName: "gemini-4-neon-xhigh" },
                    { captureStdout: true },
                ),
            );
            assert.match(returnPlanMsg, /blast radius for calc\.js/);

            // 3. Mixed planner->executor (Gemini planner -> Claude executor) uses Claude <=1600B cap on executor Turn 1
            writeAgySession(mixedSid, { ...emptyAgySession(), isOrchestratorModel: true, orchestratorPhase: "plan" });
            const bigPlan = "Update `src/calc.js` and `src/helper.js`.".repeat(1);
            handleAgyPostTool(
                {
                    conversationId: mixedSid,
                    workspacePaths: [repo],
                    modelName: "gemini-4-neon-xhigh",
                    toolCall: { name: "exit_plan_mode", args: { plan: bigPlan } },
                },
                { captureStdout: true },
            );
            const claudeExecMsg = extractSysMsg(
                await handleAgyPreInvocation(
                    {
                        conversationId: mixedSid,
                        workspacePaths: [repo],
                        initialNumSteps: 3,
                        modelName: "claude-sonnet-5-5-high",
                    },
                    { captureStdout: true },
                ),
            );
            assert.match(claudeExecMsg, /\[plexer\] execution handoff/);
            assert.ok(Buffer.byteLength(claudeExecMsg, "utf8") <= 1600);

            // Default buildPlanExecutionHandoff contract without includeExecuteDirective returns null when all seen
            const seenAll = emptyAgySession();
            seenAll.seenSpans = { "src/calc.js": [[1, 50]], "src/helper.js": [[1, 5]] };
            assert.equal(buildPlanExecutionHandoff([repo], "Update `src/calc.js`.", seenAll), null);

            // Deduplicates repeated symbol refs and skips analogy prose symbols in handoffs
            const dedupHandoff = buildPlanExecutionHandoff(
                [repo],
                "Update `src/calc.js:computeTaxRate` and `computeTaxRate` in `src/calc.js` (matching `applyDiscount` and `formatBill`).",
                emptyAgySession(),
            );
            assert.ok(dedupHandoff?.text);
            assert.equal((dedupHandoff.text.match(/computeTaxRate \(src\/calc\.js:/g) || []).length, 1);
            assert.match(dedupHandoff.text, /• computeTaxRate|computeTaxRate \(/);
            assert.doesNotMatch(dedupHandoff.text, /• (?:applyDiscount|formatBill)\b/);

            // 4. Empty workspacePaths never triggers explore-guard, and /grill-me suppresses explore/plan-wrapup nudge on indexed repos
            writeAgySession(noWsSid, { ...emptyAgySession(), isEditPrompt: true });
            await handleAgyPreInvocation(
                { conversationId: noWsSid, workspacePaths: [], initialNumSteps: 1, prompt: "Look for config improvements" },
                { captureStdout: true },
            );
            for (let nt = 0; nt < 5; nt++) {
                const noWsMsg = extractSysMsg(
                    await handleAgyPreInvocation(
                        { conversationId: noWsSid, workspacePaths: [], initialNumSteps: 2 + nt },
                        { captureStdout: true },
                    ),
                );
                assert.doesNotMatch(noWsMsg, /(?:search|planning|exploration) turns elapsed/i);
            }

            writeAgySession(grillSid, { ...emptyAgySession(), isOrchestratorModel: true, orchestratorPhase: "plan" });
            await handleAgyPreInvocation(
                {
                    conversationId: grillSid,
                    workspacePaths: [repo],
                    initialNumSteps: 1,
                    modelName: "gemini-4-neon-xhigh",
                    prompt: "/plan /grill-me Update `computeTaxRate` in `src/calc.js`",
                },
                { captureStdout: true },
            );
            for (let gt = 0; gt < 5; gt++) {
                const grillMsg = extractSysMsg(
                    await handleAgyPreInvocation(
                        { conversationId: grillSid, workspacePaths: [repo], initialNumSteps: 2 + gt, modelName: "gemini-4-neon-xhigh" },
                        { captureStdout: true },
                    ),
                );
                assert.doesNotMatch(grillMsg, /planning turns elapsed.*exit_plan_mode/i);
            }
        } finally {
            for (const sid of [qaSid, editSid, mixedSid, grillSid, noWsSid]) rmSync(agySessionPath(sid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("resolves Orchestrator benchmark aliases, CLI flags, and dual-model grade.js breakdowns", () => {
        assert.equal(normalizeAgyModelAlias("orch-neon"), "orch-neon-high-hydrogen-high");
        const cfgDefault = resolveAgyModelConfig("orch-neon");
        assert.deepEqual(cfgDefault.orchestrator, { planner: "gemini-4-neon-high", executor: "gemini-4-hydrogen-high" });

        assert.equal(normalizeAgyModelAlias("orch-neon-high"), "orch-neon-high-hydrogen-high");
        const cfgHigh = resolveAgyModelConfig("orch-neon-high");
        assert.equal(cfgHigh.isOrchestrator, true);
        assert.equal(cfgHigh.model, "gemini-pro-orchestrator-neon");
        assert.deepEqual(cfgHigh.orchestrator, { planner: "gemini-4-neon-high", executor: "gemini-4-hydrogen-high" });
        const cliHighArgs = buildAgyCliArgs({ promptText: "Fix bug", arm: "plexer", modelCfg: cfgHigh });
        assert.ok(!cliHighArgs.includes("--agent"));
        assert.ok(!cliHighArgs.includes("--effort"));
        assert.ok(cliHighArgs.includes("--settings"));

        assert.equal(normalizeAgyModelAlias("orch-neon-h-xh"), "orch-neon-high-hydrogen-xhigh");
        assert.equal(normalizeAgyModelAlias("orch-neon-high-hydrogen-xhigh"), "orch-neon-high-hydrogen-xhigh");
        const cfgHybrid = resolveAgyModelConfig("orch-neon-h-xh");
        assert.equal(cfgHybrid.isOrchestrator, true);
        assert.equal(cfgHybrid.model, "gemini-pro-orchestrator-neon");
        assert.deepEqual(cfgHybrid.orchestrator, { planner: "gemini-4-neon-high", executor: "gemini-4-hydrogen-xhigh" });
        const cliHybridArgs = buildAgyCliArgs({ promptText: "Fix bug", arm: "plexer", modelCfg: cfgHybrid });
        assert.ok(!cliHybridArgs.includes("--agent"));
        assert.ok(!cliHybridArgs.includes("--effort"));
        assert.ok(cliHybridArgs.includes("--settings"));

        assert.equal(normalizeAgyModelAlias("orch-neon-xhigh"), "orch-neon-xhigh-hydrogen-xhigh");
        const cfg = resolveAgyModelConfig("orch-neon-xhigh");
        assert.equal(cfg.isOrchestrator, true);
        assert.equal(cfg.model, "gemini-pro-orchestrator-neon");
        assert.deepEqual(cfg.orchestrator, { planner: "gemini-4-neon-xhigh", executor: "gemini-4-hydrogen-xhigh" });

        const customCfg = resolveAgyModelConfig("orch:claude-opus-5-5-high:claude-sonnet-5-5-high");
        assert.equal(customCfg.canonicalAlias, "orch-claude-opus-5-5-high-claude-sonnet-5-5-high");
        assert.deepEqual(customCfg.orchestrator, { planner: "claude-opus-5-5-high", executor: "claude-sonnet-5-5-high" });

        const cliArgs = buildAgyCliArgs({ promptText: "Fix bug", arm: "plexer", modelCfg: cfg });
        assert.ok(!cliArgs.includes("--agent"));
        assert.ok(!cliArgs.includes("--effort"));
        assert.ok(cliArgs.includes("--settings"));

        // Verify parseTranscript aggregates modelBreakdown, planHandoffs, and planReviews across both models
        const tmpDir = mkdtempSync(join(tmpdir(), "plexer-orch-grade-"));
        const convId = `test-orch-${process.pid}-${Date.now()}`;
        try {
            const brainDir = join(tmpDir, "brain");
            mkdirSync(brainDir, { recursive: true });
            const streamJsonl = join(tmpDir, "run.jsonl");
            const txDir = join(process.env.HOME || tmpdir(), ".gemini", "antigravity-cli", "brain", convId, ".system_generated", "logs");
            mkdirSync(txDir, { recursive: true });
            const txFile = join(txDir, "transcript_full.jsonl");
            const steps = [
                { step_index: 0, type: "USER_INPUT", created_at: "2026-11-22T10:00:00Z", content: "Implement feature" },
                {
                    step_index: 1,
                    type: "PLANNER_RESPONSE",
                    created_at: "2026-11-22T10:00:05Z",
                    model: "gemini-4-neon-xhigh",
                    input_tokens: 1000,
                    cache_read_tokens: 0,
                    output_tokens: 200,
                    tool_calls: [{ name: "exit_plan_mode", args: { plan: "Edit a.js" } }],
                },
                {
                    step_index: 2,
                    type: "GENERIC",
                    created_at: "2026-11-22T10:00:06Z",
                    content: "Created At: 2026-11-22T10:00:05Z\nCompleted At: 2026-11-22T10:00:06Z\nExited plan mode",
                },
                {
                    step_index: 3,
                    type: "PLANNER_RESPONSE",
                    created_at: "2026-11-22T10:00:10Z",
                    model: "gemini-4-hydrogen-xhigh",
                    input_tokens: 1200,
                    cache_read_tokens: 0,
                    output_tokens: 150,
                    tool_calls: [{ name: "edit_file", args: { Path: "/tmp/a.js" } }],
                },
                {
                    step_index: 4,
                    type: "GENERIC",
                    created_at: "2026-11-22T10:00:11Z",
                    content: "Created At: 2026-11-22T10:00:10Z\nCompleted At: 2026-11-22T10:00:11Z\nEdited",
                },
                {
                    step_index: 5,
                    type: "SYSTEM_MESSAGE",
                    created_at: "2026-11-22T10:00:12Z",
                    content: "[plan review due]",
                },
                {
                    step_index: 6,
                    type: "PLANNER_RESPONSE",
                    created_at: "2026-11-22T10:00:15Z",
                    model: "gemini-4-neon-xhigh",
                    input_tokens: 500,
                    cache_read_tokens: 1500,
                    output_tokens: 80,
                    content: "Done.",
                },
            ];
            writeFileSync(txFile, `${steps.map((s) => JSON.stringify(s)).join("\n")}\n`, "utf8");
            writeFileSync(
                streamJsonl,
                `${JSON.stringify({ event: "init", conversation_id: convId })}\n${JSON.stringify({ event: "result", result: { duration_seconds: 15 } })}\n`,
                "utf8",
            );

            const parsed = parseTranscript(streamJsonl, "plexer");
            assert.deepEqual(parsed.modelsUsed, ["gemini-4-neon-xhigh", "gemini-4-hydrogen-xhigh"]);
            assert.equal(parsed.planHandoffs, 1);
            assert.equal(parsed.planReviews, 1);
            assert.equal(parsed.modelBreakdown["gemini-4-neon-xhigh"].turns, 2);
            assert.equal(parsed.modelBreakdown["gemini-4-neon-xhigh"].calls, 1);
            assert.equal(parsed.modelBreakdown["gemini-4-hydrogen-xhigh"].turns, 1);
            assert.equal(parsed.modelBreakdown["gemini-4-hydrogen-xhigh"].calls, 1);
            assert.equal(parsed.didModifyFile, true);
        } finally {
            rmSync(join(process.env.HOME || tmpdir(), ".gemini", "antigravity-cli", "brain", convId), { recursive: true, force: true });
            rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("detects Turn-0 Orchestrator via annotations/*.pbtxt, avoids parallel dup-read ping-pong, invalidates failed edits, and expands XHigh handoff", async () => {
        const repo = makeTempRepo("plexer-orch-tune-");
        const appData = mkdtempSync(join(tmpdir(), "plexer-ann-"));
        const annSid = `orch-ann-${process.pid}-${Date.now()}`;
        const dupSid = `orch-dup-${process.pid}-${Date.now()}`;
        try {
            const fileA = join(repo, "src", "a.js");
            const fileB = join(repo, "src", "b.js");
            const bigLines = Array.from({ length: 120 }, (_, i) => `export const val_${i + 1} = ${i + 1};`).join("\n");
            writeFileSync(fileA, `export function alpha() {\n    return 1;\n}\n${bigLines}\n`, "utf8");
            writeFileSync(fileB, `export function beta() {\n    return 2;\n}\n${bigLines}\n`, "utf8");
            for (let i = 1; i <= 4; i++) {
                writeFileSync(join(repo, "src", `extra${i}.js`), `export const extra${i} = ${i};\n`, "utf8");
            }
            await buildGraph(repo, { force: true });

            // 1. Turn-0 detection from <appDataDir>/annotations/<cid>.pbtxt (`plan_execute:true`)
            mkdirSync(join(appData, "annotations"), { recursive: true });
            const artDir = join(appData, "brain", annSid);
            mkdirSync(artDir, { recursive: true });
            writeFileSync(join(appData, "annotations", `${annSid}.pbtxt`), 'title:"Test" plan_execute:true\n', "utf8");

            const turn0Msg = extractSysMsg(
                await handleAgyPreInvocation(
                    {
                        conversationId: annSid,
                        workspacePaths: [repo],
                        artifactDirectoryPath: artDir,
                        invocationNum: 0,
                        initialNumSteps: 1,
                        modelName: "gemini-4-neon-xhigh",
                        prompt: "Update `alpha` in `src/a.js` to return 2.",
                    },
                    { captureStdout: true },
                ),
            );
            assert.match(turn0Msg, /plan targets localized \(plan mode is read-only/);
            const annState = readAgySession(annSid);
            assert.equal(annState.isOrchestratorModel, true);
            assert.equal(annState.orchestratorPhase, "plan");
            assert.equal(annState.plannerModel, "gemini-4-neon-xhigh");

            // Mid-session planner switch (Neon XHigh -> Carbon High) while .pbtxt still has plan_execute:true keeps Orchestrator active
            const txOff = join(artDir, ".system_generated", "logs", "transcript.jsonl");
            mkdirSync(join(artDir, ".system_generated", "logs"), { recursive: true });
            writeFileSync(
                txOff,
                `${JSON.stringify({
                    step_index: 2,
                    type: "USER_INPUT",
                    content: "<USER_REQUEST>\nSwitch planner\n</USER_REQUEST>\n<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from Gemini 4 Neon (XHigh) to Gemini 4 Carbon (High).\n</USER_SETTINGS_CHANGE>",
                })}\n`,
                "utf8",
            );
            await handleAgyPreInvocation(
                {
                    conversationId: annSid,
                    workspacePaths: [repo],
                    artifactDirectoryPath: artDir,
                    transcriptPath: txOff,
                    invocationNum: 1,
                    initialNumSteps: 3,
                    modelName: "gemini-4-carbon-high",
                    prompt: "Switch planner",
                },
                { captureStdout: true },
            );
            const afterPlannerSwitch = readAgySession(annSid);
            assert.equal(afterPlannerSwitch.isOrchestratorModel, true);
            assert.equal(afterPlannerSwitch.orchestratorExplicitlyDisabled, false);
            assert.equal(afterPlannerSwitch.plannerModel, "gemini-4-carbon-high");

            // Rewriting .pbtxt without plan_execute:true disables Orchestrator cleanly even across subsequent prompts
            writeFileSync(join(appData, "annotations", `${annSid}.pbtxt`), 'title:"Test"\n', "utf8");
            await handleAgyPreInvocation(
                {
                    conversationId: annSid,
                    workspacePaths: [repo],
                    artifactDirectoryPath: artDir,
                    transcriptPath: txOff,
                    invocationNum: 2,
                    initialNumSteps: 5,
                    modelName: "gemini-4-hydrogen-high",
                    prompt: "Continue without orchestrator",
                },
                { captureStdout: true },
            );
            const afterOff = readAgySession(annSid);
            assert.equal(afterOff.isOrchestratorModel, false);
            assert.equal(afterOff.orchestratorExplicitlyDisabled, true);

            // 2. Parallel duplicate reads on a.js + b.js succeed on first retry without ping-pong,
            //    and failed edit_file invalidates seenSpans without setting editedInPrompt
            const dupInit = emptyAgySession();
            dupInit.isOrchestratorModel = true;
            dupInit.orchestratorPhase = "execute";
            mergeSpan(dupInit.seenSpans, "src/a.js", 1, 120);
            mergeSpan(dupInit.seenSpans, "src/b.js", 1, 120);
            writeAgySession(dupSid, dupInit);

            const denyA = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: dupSid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: fileA, StartLine: 1, EndLine: 95 } },
                    },
                    { captureStdout: true },
                ),
            );
            const denyB = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: dupSid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: fileB, StartLine: 1, EndLine: 95 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(denyA.decision, "deny");
            assert.equal(denyB.decision, "deny");

            const retryA = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: dupSid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: fileA, StartLine: 1, EndLine: 95 } },
                    },
                    { captureStdout: true },
                ),
            );
            const retryB = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: dupSid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: fileB, StartLine: 1, EndLine: 95 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(retryA.decision, "allow");
            assert.equal(retryB.decision, "allow");

            handleAgyPostTool(
                {
                    conversationId: dupSid,
                    workspacePaths: [repo],
                    error: "target content not found",
                    toolCall: { name: "edit_file", args: { Path: fileA } },
                },
                { captureStdout: true },
            );
            const afterFailedEdit = readAgySession(dupSid);
            assert.equal(afterFailedEdit.editedInPrompt, false);
            assert.equal((afterFailedEdit.seenSpans["src/a.js"] || []).length, 0);
            const postFailReadA = JSON.parse(
                handleAgyPreTool(
                    {
                        conversationId: dupSid,
                        workspacePaths: [repo],
                        toolCall: { name: "read_file", args: { Path: fileA, StartLine: 1, EndLine: 95 } },
                    },
                    { captureStdout: true },
                ),
            );
            assert.equal(postFailReadA.decision, "allow");

            // 3. XHigh/High Gemini handoff tightens to <=2200B / 4 targets, medium <=1800B,
            //    filters stop/tool/dunder symbols, and skips seen-file skeleton dumps
            const bigPlan = [
                "Use `edit_file` and check `__init__` and `get` before modifying `src/a.js:L10-L20`",
                "`src/b.js`",
                "`src/extra1.js`",
                "`src/extra2.js`",
                "`src/extra3.js`",
                "`src/extra4.js`",
            ].join(" and ");
            const xhighHandoff = buildPlanExecutionHandoff([repo], bigPlan, emptyAgySession(), {
                geminiProfile: true,
                xhighProfile: true,
                includeExecuteDirective: true,
            });
            assert.ok(xhighHandoff?.text);
            assert.ok(Buffer.byteLength(xhighHandoff.text, "utf8") <= 2200);
            assert.match(xhighHandoff.text, /src\/a\.js:L10-L20/);
            assert.match(xhighHandoff.text, /10: export const val_7 = 7;/);
            assert.equal((xhighHandoff.text.match(/\n • /g) || []).length <= 4, true);

            const highHandoff = buildPlanExecutionHandoff([repo], bigPlan, emptyAgySession(), {
                geminiProfile: true,
                highProfile: true,
                xhighProfile: false,
                includeExecuteDirective: true,
            });
            assert.ok(highHandoff?.text);
            assert.ok(Buffer.byteLength(highHandoff.text, "utf8") <= 2200);
            assert.match(highHandoff.text, /src\/a\.js:L10-L20/);
            assert.match(highHandoff.text, /10: export const val_7 = 7;/);

            const mediumHandoff = buildPlanExecutionHandoff([repo], bigPlan, emptyAgySession(), {
                geminiProfile: true,
                highProfile: false,
                xhighProfile: false,
                includeExecuteDirective: true,
            });
            assert.ok(mediumHandoff?.text);
            assert.ok(Buffer.byteLength(mediumHandoff.text, "utf8") <= 1800);
            assert.equal((mediumHandoff.text.match(/\n • /g) || []).length <= 4, true);

            const claudeHandoff = buildPlanExecutionHandoff([repo], bigPlan, emptyAgySession(), {
                geminiProfile: false,
                xhighProfile: false,
                includeExecuteDirective: true,
            });
            assert.ok(claudeHandoff?.text);
            assert.ok(Buffer.byteLength(claudeHandoff.text, "utf8") <= 1600);

            writeFileSync(join(repo, "src", "noise.py"), "class Widget:\n    def __init__(self):\n        pass\ndef edit_file():\n    return 1\n");
            await buildGraph(repo, { force: true });
            const stopSymHandoff = buildPlanExecutionHandoff(
                [repo],
                "1. Call `edit_file` or inspect `__init__` in `src/a.js:L1-L3`.",
                emptyAgySession(),
                { geminiProfile: true, includeExecuteDirective: true },
            );
            assert.doesNotMatch(String(stopSymHandoff?.text || ""), /src\/noise\.py/, "stop/tool/dunder symbols must not pull unrelated files");

            const partialSeenState = emptyAgySession();
            mergeSpan(partialSeenState.seenSpans, "src/a.js", 1, 3);
            const noSkeletonHandoff = buildPlanExecutionHandoff(
                [repo],
                "Update `alpha` in `src/a.js`.",
                partialSeenState,
                { geminiProfile: true, includeExecuteDirective: true },
            );
            assert.ok(noSkeletonHandoff?.text);
            assert.doesNotMatch(noSkeletonHandoff.text, /val_1|unseen callers|unseen tests/, "partially-seen target file must skip skeleton/caller noise and emit 1-line directive");

            // 4. Post-compaction working-set anchor preserves prior active files into next prompt <= 1800B and clears once consumed
            const cmpSid = `orch-cmp-${process.pid}-${Date.now()}`;
            try {
                const cmpInit = emptyAgySession();
                cmpInit.lastEditedFile = fileA;
                cmpInit.lastInitialNumSteps = 12;
                writeAgySession(cmpSid, cmpInit);
                const anchorMsg = extractSysMsg(
                    await handleAgyPreInvocation(
                        {
                            conversationId: cmpSid,
                            workspacePaths: [repo],
                            invocationNum: 2,
                            initialNumSteps: 2,
                            modelName: "gemini-4-neon-xhigh",
                            prompt: "Continue finishing the remaining edge case.",
                        },
                        { captureStdout: true },
                    ),
                );
                assert.match(anchorMsg, /\[plexer\] post-compaction working-set anchor/);
                assert.match(anchorMsg, /src\/a\.js/);
                const anchorStart = anchorMsg.indexOf("[plexer] post-compaction working-set anchor");
                assert.ok(Buffer.byteLength(anchorMsg.slice(anchorStart), "utf8") <= 1800);
                assert.deepEqual(readAgySession(cmpSid).postCompactAnchorFiles, []);
            } finally {
                rmSync(agySessionPath(cmpSid), { force: true });
            }
        } finally {
            for (const sid of [annSid, dupSid]) rmSync(agySessionPath(sid), { force: true });
            rmSync(appData, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
