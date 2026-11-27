import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { agySessionPath, emptyAgySession, readAgySession, writeAgySession } from "../src/agy/session.js";
import { stampSeenMtime } from "../src/agy/spans.js";
import { checkSwarmEditCollision } from "../src/agy/swarm-sync.js";
import { readSpans, formatReadSpans } from "../src/ask/read-spans.js";
import { relevantRetrieval } from "../src/claude/format.js";
import { installCodexHooks, installGeminiHooks } from "../src/hosts/codex-hooks.js";
import { handleHostPostTool } from "../src/hosts/engine/post-tool.js";
import { dispatchHostEvent, handleHostPreTool } from "../src/hosts/engine/dispatcher.js";
import { handleAgyPreInvocation, handleTurn0Hook } from "../src/hosts/engine/turn0.js";
import { runHostsInit } from "../src/hosts/init.js";
import { mcpInstructions } from "../src/mcp/instructions.js";
import { TOOLS, callTool } from "../src/mcp/tools.js";
import { fmtLine, hasInlinedLine, LINE_PREFIX_RE } from "../src/util/span.js";
import { evaluateAgyPreTool } from "../src/agy/pre-tool.js";
import { runCli } from "../src/cli/cli-main.js";

function makeTempDir(prefix = "plexer-cost-v3-") {
    return mkdtempSync(join(tmpdir(), prefix));
}

describe("Workstream 3: Cost Reduction, Host Hook Parity & Compact 123: Wire Format", () => {
    it("exports fmtLine, tolerant LINE_PREFIX_RE, and boundary-safe hasInlinedLine", () => {
        assert.equal(fmtLine(42, "const x = 1;"), "42: const x = 1;");
        assert.equal(LINE_PREFIX_RE.exec("42: const x = 1;")?.[1], "42");
        assert.equal(LINE_PREFIX_RE.exec("L42: const x = 1;")?.[1], "42");
        assert.equal(hasInlinedLine("10: a\n110: b", 1), false, "10:/110: must never false-match line 1");
        assert.equal(hasInlinedLine("10: a\n110: b", 10), true);
        assert.equal(hasInlinedLine("L7: legacy", 7), true);
    });

    it("supports read --callers, MCP include_callers, MCP trace_calls seenSpans, and compact MCP schemas", async () => {
        const repo = makeTempDir("plexer-v3-mcp-");
        try {
            mkdirSync(join(repo, "src"), { recursive: true });
            const serviceBody = [
                "export function computeInvoiceSum(items) {",
                ...Array.from({ length: 16 }, (_, i) => `    const part_${i} = items.length + ${i};`),
                "    return part_0;",
                "}",
            ].join("\n") + "\n";
            writeFileSync(join(repo, "src", "service.js"), serviceBody);
            writeFileSync(
                join(repo, "src", "consumer.js"),
                "import { computeInvoiceSum } from './service.js';\nexport function checkoutOrder(items) {\n    return computeInvoiceSum(items);\n}\n",
            );
            await buildGraph(repo, { force: true });

            const rs = readSpans(repo, ["src/service.js:L1-L18"], { callers: true });
            const rsOut = formatReadSpans(rs);
            assert.match(rsOut, /^1: export function computeInvoiceSum/m);
            assert.match(rsOut, /callers: checkoutOrder \(src\/consumer\.js:L2/);

            const mcpSess = { roots: [repo], seenSpansByRepo: {} };
            const readRes = await callTool(repo, "plexer_read", { spans: "src/service.js:L1-L18", include_callers: true }, undefined, mcpSess);
            assert.equal(readRes.isError, false);
            assert.match(readRes.text, /callers: checkoutOrder \(src\/consumer\.js:L2/);

            const traceSess = { roots: [repo], seenSpansByRepo: {} };
            const trace1 = await callTool(repo, "plexer_trace_calls", { symbol: "computeInvoiceSum", source: true }, undefined, traceSess);
            assert.equal(trace1.isError, false);
            assert.match(trace1.text, /1: export function computeInvoiceSum/);

            const trace2 = await callTool(repo, "plexer_trace_calls", { symbol: "computeInvoiceSum", source: true }, undefined, traceSess);
            assert.equal(trace2.isError, false);
            assert.match(trace2.text, /\[seen: src\/service\.js:L1-L19/);

            assert.equal(TOOLS.length, 9);
            const instr = mcpInstructions();
            assert.ok(instr.length <= 1000);
            assert.ok(instr.includes("<n>:"));
            assert.ok(instr.includes("[seen:]"));
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("enforces 0 B OOB silence, read-only subagent explore guard skip, and indexed-only mid-loop hints", async () => {
        const repo = makeTempDir("plexer-v3-oob-");
        const sidOob = `v3-oob-${process.pid}-${Date.now()}`;
        const sidSub = `v3-sub-${process.pid}-${Date.now()}`;
        const sidMd = `v3-md-${process.pid}-${Date.now()}`;
        try {
            mkdirSync(join(repo, "src"), { recursive: true });
            writeFileSync(join(repo, "src", "auth.js"), "export function verifySessionJwt(tok) {\n    return Boolean(tok);\n}\n");
            writeFileSync(join(repo, "README.md"), "# Documentation\nPlain markdown file.\n");
            await buildGraph(repo, { force: true });

            const agyOobOut = JSON.parse(
                await handleAgyPreInvocation(
                    { conversationId: sidOob, workspacePaths: [repo], prompt: "Explain PostgreSQL MVCC tuple visibility rules" },
                    { captureStdout: true },
                ),
            );
            assert.deepEqual(agyOobOut, {}, "OOB prompt in agy-pre-invocation must emit 0 B");

            const claudeOobOut = await handleTurn0Hook(
                "claude",
                { session_id: `${sidOob}-claude`, cwd: repo, prompt: "Explain PostgreSQL MVCC tuple visibility rules" },
                { captureStdout: true },
            );
            assert.equal(claudeOobOut, "", "OOB prompt in Claude UserPromptSubmit must emit 0 B");

            const genericWeak = relevantRetrieval(
                {
                    query: "explain error handling",
                    coverage: 0.20,
                    coverageStrong: 0.05,
                    hits: [{ kind: "function", title: "error · function", pointer: "src/auth.js:L1-L3", code: "1: err" }],
                },
                {},
                4,
                { geminiProfile: true },
            );
            assert.equal(genericWeak, null, "generic-only collision without path/strong coverage must return null");

            const subState = {
                ...emptyAgySession(),
                turn0Matched: true,
                preEditInvocations: 12,
                exploreGuardStage: 0,
                orientedDirs: [repo],
            };
            writeAgySession(sidSub, subState);
            const subOut = JSON.parse(
                await handleAgyPreInvocation(
                    {
                        conversationId: sidSub,
                        workspacePaths: [repo],
                        tools: ["run_command", "read_file"],
                        prompt: "You are a research subagent with read-only access. Summarize verifySessionJwt.",
                    },
                    { captureStdout: true },
                ),
            );
            const subMsg = subOut.injectSteps?.[0]?.systemMessage?.systemMessage || "";
            assert.doesNotMatch(subMsg, /exploration turns elapsed/i);

            writeAgySession(sidMd, { ...emptyAgySession(), seenSpans: {} });
            handleHostPostTool("claude", {
                session_id: sidMd,
                cwd: repo,
                tool_name: "Read",
                tool_input: { file_path: join(repo, "README.md"), offset: 1, limit: 20 },
            }, { captureStdout: true });
            const mdState = readAgySession(sidMd);
            assert.equal(mdState.pendingMidLoopFile ?? null, null, "non-indexed README.md read must not stage mid-loop hint");
            assert.equal(mdState.midLoopHintEmitted ?? false, false);
        } finally {
            rmSync(agySessionPath(sidOob), { force: true });
            rmSync(agySessionPath(`${sidOob}-claude`), { force: true });
            rmSync(agySessionPath(sidSub), { force: true });
            rmSync(agySessionPath(sidMd), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("provides Codex/Claude/Gemini hook parity, 220L/12KB Read caps, 35L/1.4KB Turn-0 dup-read deny, Swarm pre-tool warn & shell invalidation", async () => {
        const home = makeTempDir("plexer-v3-home-");
        const repo = makeTempDir("plexer-v3-hooks-");
        const sid = `v3-hooks-${process.pid}-${Date.now()}`;
        const appData = makeTempDir("plexer-v3-appdata-");
        const worker1Sid = `w1-${Date.now()}`;
        const worker2Sid = `w2-${Date.now()}`;
        try {
            mkdirSync(join(home, ".codex"), { recursive: true });
            mkdirSync(join(home, ".gemini", "config"), { recursive: true });
            installCodexHooks(home);
            const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks;
            assert.equal(codexHooks.PreToolUse?.[0]?.matcher, "Read|Bash|Grep|Glob|shell");
            assert.ok(codexHooks.PostToolUse?.some((h) => h.matcher?.includes("Read")));

            installGeminiHooks({ repo });
            const gemHooks = JSON.parse(readFileSync(join(repo, ".gemini", "settings.json"), "utf8")).hooks;
            assert.ok(gemHooks.BeforeTool?.[0]?.matcher?.includes("glob"));
            assert.ok(gemHooks.AfterTool?.[0]?.matcher?.includes("ExitPlanMode"));

            mkdirSync(join(repo, "src"), { recursive: true });
            const file190 = join(repo, "src", "big190.js");
            writeFileSync(
                file190,
                [
                    "export function handleTurn0Target(input) {",
                    ...Array.from({ length: 187 }, (_, i) => `    const v_${i} = input + ${i};`),
                    "    return v_0;",
                    "}",
                ].join("\n") + "\n",
            );
            await buildGraph(repo, { force: true });

            // Claude Read widens 190L file under new 220L/12KB cap
            const widenState = { seenSpans: {}, seenMtimes: {} };
            const widenOut = evaluateAgyPreTool(
                { tool_name: "Read", tool_input: { file_path: file190, offset: 1, limit: 60 } },
                { workspaceDirs: [repo], repoRoot: repo, agyState: widenState, hostKind: "claude", geminiProfile: false },
            );
            assert.equal(widenOut.decision, "allow");
            assert.equal(widenOut.overwrite?.EndLine, 190);

            // Unedited Turn-0 40-line span triggers 35L/1.4KB duplicate-read deny on 1st attempt, allow on 2nd retry
            const t0State = {
                turn0Matched: true,
                editedInPrompt: false,
                turn0SeenKeys: ["src/big190.js"],
                seenSpans: { "src/big190.js": [[1, 45]] },
                seenMtimes: {},
            };
            stampSeenMtime(t0State, "src/big190.js", file190);
            const t0Deny = evaluateAgyPreTool(
                { tool_name: "Read", tool_input: { file_path: file190, offset: 1, limit: 40 } },
                { workspaceDirs: [repo], repoRoot: repo, agyState: t0State, hostKind: "claude", geminiProfile: false },
            );
            assert.equal(t0Deny.decision, "deny");
            const t0Retry = evaluateAgyPreTool(
                { tool_name: "Read", tool_input: { file_path: file190, offset: 1, limit: 40 } },
                { workspaceDirs: [repo], repoRoot: repo, agyState: t0State, hostKind: "claude", geminiProfile: false },
            );
            assert.equal(t0Retry.decision, "allow");

            // Codex `shell` tool rewrites exploration slice reads cleanly
            writeAgySession(sid, { ...emptyAgySession(), seenSpans: { "src/big190.js": [[1, 45]] }, editSeq: 1 });
            const shellPre = JSON.parse(
                handleHostPreTool("claude", {
                    session_id: sid,
                    cwd: repo,
                    tool_name: "shell",
                    tool_input: { command: "sed -n '1,10p' src/big190.js" },
                }, { captureStdout: true }),
            );
            assert.match(shellPre.hookSpecificOutput?.updatedInput?.command || "", /(?:\bplexer|plexer\.js['"]?)\s+read\b/);

            // Bash git checkout invalidates seenSpans & bumps editSeq
            dispatchHostEvent("post-tool-use", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "git checkout -- src/big190.js" },
            }, { captureStdout: true });
            const postGit = readAgySession(sid);
            assert.equal(postGit.seenSpans?.["src/big190.js"], undefined);
            assert.equal(postGit.editSeq, 2);

            // batch + callers share in-memory sessionCache cleanly without split-brain
            const sharedCache = new Map();
            const enc = Buffer.from(JSON.stringify([["read", "src/big190.js:L1-L25"]]), "utf8").toString("base64url");
            let bOut1 = "";
            await runCli(["node", "plexer", "--session", sid, "_batch", enc], {
                isCaptured: true, cwd: repo, sessionId: sid, sessionCache: sharedCache,
                writeOut: (s) => { bOut1 += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(bOut1, /^1: export function handleTurn0Target/m);
            let rOut2 = "";
            await runCli(["node", "plexer", "--session", sid, "read", "src/big190.js:L1-L25"], {
                isCaptured: true, cwd: repo, sessionId: sid, sessionCache: sharedCache,
                writeOut: (s) => { rOut2 += s; }, writeErr: () => {}, exit: () => {},
            });
            assert.match(rOut2, /\[seen: src\/big190\.js:L1-L25/);

            // Proactive Swarm preTool collision warning returns msg without writing pendingBlastRadius
            writeAgySession(worker1Sid, { ...emptyAgySession(), emittedBlastFiles: ["src/big190.js"] });
            const swarmDir = join(appData, "brain", sid, ".system_generated", "swarm");
            mkdirSync(swarmDir, { recursive: true });
            writeFileSync(
                join(swarmDir, "members.json"),
                JSON.stringify({
                    members: {
                        "editor-1": { conversation_id: worker1Sid, state: "waiting" },
                        "worker-2": { conversation_id: worker2Sid, state: "working" },
                    },
                }),
            );
            const preState = { isSwarmMember: true, emittedSwarmCollisions: [] };
            const warnMsg = checkSwarmEditCollision(worker2Sid, repo, file190, preState, { appDataDirs: [appData], preTool: true });
            assert.match(warnMsg || "", /@editor-1 also edited src\/big190\.js/);
            assert.equal(preState.pendingBlastRadius, undefined);

            // Antigravity plugin rule dedup skips repo AGENTS.md when plugin covers it alone,
            // while multi-consumer init (agents + antigravity) writes AGENTS.md once.
            const repoOnlyAgy = makeTempDir("plexer-v3-onlyagy-");
            const repoBoth = makeTempDir("plexer-v3-both-");
            try {
                const initAgy = runHostsInit(repoOnlyAgy, { agents: ["antigravity"], mcp: false, hooks: true, global: true, home });
                assert.equal(existsSync(join(repoOnlyAgy, "AGENTS.md")), false);
                assert.equal(initAgy.written.length, 0);

                const initBoth = runHostsInit(repoBoth, { agents: ["antigravity", "agents"], mcp: false, hooks: false, global: false, home });
                assert.equal(existsSync(join(repoBoth, "AGENTS.md")), true);
                assert.equal(initBoth.written.filter((w) => w.path.endsWith("AGENTS.md")).length, 1);
            } finally {
                rmSync(repoOnlyAgy, { recursive: true, force: true });
                rmSync(repoBoth, { recursive: true, force: true });
            }
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(agySessionPath(worker1Sid), { force: true });
            rmSync(home, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
            rmSync(appData, { recursive: true, force: true });
        }
    });
});
