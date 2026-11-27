import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../src/index.js";
import { agySessionPath, emptyAgySession, readAgySession, writeAgySession } from "../src/agy/session.js";
import {
    computeReadPreToolWidening,
    evaluateAgyPreTool,
    rewriteSingleNpxPlexerCommand,
} from "../src/agy/pre-tool.js";
import { rewriteShellExplorationCommand } from "../src/agy/shell-rewrite.js";
import { dispatchHostEvent, handleHostPreTool } from "../src/hosts/engine/dispatcher.js";
import { formatGrepResult } from "../src/search/grep-cli.js";
import { queryPromptContext } from "../src/claude/hooks.js";
import { relevantRetrieval } from "../src/claude/format.js";

const PKG_ROOT = resolve(import.meta.dirname, "..");

function makeRepo(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    return dir;
}

describe("Round 6 compaction, shell routing, dedup, exploration gate, & grep compaction", () => {
    it("prevents backward re-widening over >=25L seen prefixes on <500L files", async () => {
        const repo = makeRepo("plexer-r6-widen-");
        try {
            mkdirSync(join(repo, "src"), { recursive: true });
            const lines = Array.from({ length: 491 }, (_, i) => `export const line_${i + 1} = ${i + 1};`);
            const testFile = join(repo, "src", "DownloadManagerTest.ts");
            writeFileSync(testFile, `${lines.join("\n")}\n`, "utf8");
            await buildGraph(repo, { force: true });

            const state = emptyAgySession();
            state.seenSpans = { "src/DownloadManagerTest.ts": [[1, 400]] };
            state.fileSliceCounts = { "src/DownloadManagerTest.ts": 1 };

            const tailPlan = computeReadPreToolWidening(
                { Path: testFile, StartLine: 395, EndLine: 491 },
                repo,
                state,
            );
            assert.ok(tailPlan, "overlapping tail request after 1..400 must trim off already-seen prefix");
            assert.equal(tailPlan.startLine, 401);
            assert.equal(tailPlan.endLine, 491);
            assert.equal(tailPlan.limit, 91);

            // Also works on <260-line files so smallFileWiden never re-dumps seen 1..150
            const smallFile = join(repo, "src", "SmallService.ts");
            writeFileSync(
                smallFile,
                `${Array.from({ length: 240 }, (_, i) => `export const s_${i + 1} = ${i + 1};`).join("\n")}\n`,
                "utf8",
            );
            const smallState = emptyAgySession();
            smallState.seenSpans = { "src/SmallService.ts": [[1, 150]] };
            smallState.fileSliceCounts = { "src/SmallService.ts": 1 };
            const smallTail = computeReadPreToolWidening(
                { Path: smallFile, StartLine: 145, EndLine: 240 },
                repo,
                smallState,
            );
            assert.ok(smallTail);
            assert.equal(smallTail.startLine, 151);
            assert.equal(smallTail.endLine, 240);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("rewrites safe cat/sed/head/grep/rg/git-log commands while leaving pipelines, docs, and BRE untouched", async () => {
        const repo = makeRepo("plexer-r6-shell-");
        try {
            mkdirSync(join(repo, "src", "api"), { recursive: true });
            mkdirSync(join(repo, "public", "language"), { recursive: true });
            writeFileSync(
                join(repo, "src", "api", "auth.ts"),
                `${Array.from({ length: 300 }, (_, i) => `export function fn_${i + 1}() { return ${i + 1}; }`).join("\n")}\n`,
                "utf8",
            );
            writeFileSync(join(repo, "public", "language", "en.json"), '{"hello":"world"}\n', "utf8");
            await buildGraph(repo, { force: true });

            const sid = `r6-shell-${process.pid}`;
            assert.match(
                String(rewriteShellExplorationCommand("cat -n src/api/auth.ts", { repoRoot: repo, sessionId: sid }) || ""),
                /read\s+['"]?src\/api\/auth\.ts:L1-L220['"]?\s+--session/,
            );
            assert.match(
                String(rewriteShellExplorationCommand(`cd ${repo}; sed -n 227,280p src/api/auth.ts;`, { repoRoot: repo, sessionId: sid }) || ""),
                /read\s+['"]?src\/api\/auth\.ts:L227-L280['"]?\s+--session/,
            );
            assert.match(
                String(rewriteShellExplorationCommand("head -n 80 src/api/auth.ts", { repoRoot: repo, sessionId: sid }) || ""),
                /read\s+['"]?src\/api\/auth\.ts:L1-L80['"]?/,
            );
            assert.match(
                String(rewriteShellExplorationCommand('grep -rn "fn_10" src/api', { repoRoot: repo, sessionId: sid }) || ""),
                /grep\s+fn_10\s+--in\s+src\/api/,
            );
            assert.match(
                String(rewriteShellExplorationCommand('git grep -F "fn_10" src', { repoRoot: repo, sessionId: sid }) || ""),
                /grep\s+fn_10\s+--fixed\s+--in\s+src/,
            );
            assert.equal(
                rewriteShellExplorationCommand("git log -p src/api/auth.ts", { repoRoot: repo }),
                "git log -p src/api/auth.ts -n 3",
            );
            assert.equal(rewriteShellExplorationCommand("git log -n 2 -p src/api/auth.ts", { repoRoot: repo }), null);

            // Unsafe or unindexed commands must NOT be rewritten
            assert.equal(rewriteShellExplorationCommand("cat src/api/auth.ts | grep fn_10", { repoRoot: repo }), null);
            assert.equal(rewriteShellExplorationCommand("grep -l fn_10 src/api/auth.ts", { repoRoot: repo }), null);
            assert.equal(rewriteShellExplorationCommand('grep -rn "a\\|b" src/api', { repoRoot: repo }), null);
            assert.equal(rewriteShellExplorationCommand('grep -rn "hello" public/language', { repoRoot: repo }), null);
            assert.equal(rewriteShellExplorationCommand("python3 - <<'EOF'\nprint(1)\nEOF", { repoRoot: repo }), null);

            // Single non---full plexer read appends --session when sid is passed
            const withSess = rewriteSingleNpxPlexerCommand("plexer read src/api/auth.ts:L1-L20", sid);
            assert.match(String(withSess || ""), new RegExp(`--session ${sid}`));

            // Hook client fast bypass keeps git status fast while routing cat/sed/grep/git diff/git log
            const statusBypass = execFileSync(
                process.execPath,
                [join(PKG_ROOT, "bin", "plexer-hook-client.cjs"), "pre-tool-use"],
                {
                    cwd: repo,
                    input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" } }),
                    encoding: "utf8",
                    env: { ...process.env, PLEXER_DAEMON_SOCK: "/nonexistent/r6-bypass.sock" },
                },
            );
            assert.equal(statusBypass.trim(), "{}");
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("dedups duplicate searches, unchanged git diff, enforces Turn-6 gate, and routes Claude PreToolUse/PostToolUse", async () => {
        const repo = makeRepo("plexer-r6-gate-");
        const sid = `r6-gate-${process.pid}-${Date.now()}`;
        try {
            mkdirSync(join(repo, "src"), { recursive: true });
            const targetFile = join(repo, "src", "service.ts");
            writeFileSync(
                targetFile,
                `${Array.from({ length: 80 }, (_, i) => `export function serviceStep${i}() { return ${i}; }`).join("\n")}\n`,
                "utf8",
            );
            writeFileSync(join(repo, "src", "other.ts"), "export const other = 1;\n", "utf8");
            await buildGraph(repo, { force: true });

            const initState = emptyAgySession();
            initState.isEditPrompt = true;
            initState.editTargetFiles = ["src/service.ts"];
            initState.seenSpans = { "src/service.ts": [[1, 80]] };
            writeAgySession(sid, initState);

            // 1. Duplicate search blocked with 1-retry escape & cleared on edit
            const grep1 = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "plexer grep serviceStep1" },
            }, { captureStdout: true }));
            assert.ok(
                grep1.hookSpecificOutput?.permissionDecision === undefined
                    || grep1.hookSpecificOutput?.permissionDecision === "allow",
                `first plexer grep must not be denied, got: ${JSON.stringify(grep1)}`,
            );

            const grepDup = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "plexer grep serviceStep1" },
            }, { captureStdout: true }));
            assert.equal(grepDup.hookSpecificOutput?.permissionDecision, "deny");
            assert.match(grepDup.hookSpecificOutput?.permissionDecisionReason, /Identical search/);

            // Unchanged git diff blocked, then allowed after edit increments editSeq
            const diff1 = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "git diff" },
            }, { captureStdout: true }));
            assert.equal(diff1.hookSpecificOutput?.permissionDecision, undefined);

            const diffDup = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "git diff" },
            }, { captureStdout: true }));
            assert.equal(diffDup.hookSpecificOutput?.permissionDecision, "deny");
            assert.match(diffDup.hookSpecificOutput?.permissionDecisionReason, /No files have been modified/);

            // 2. Turn-6 exploration gate blocks broad searches while allowing unseen reads and tests
            const s = readAgySession(sid);
            s.preEditToolTurns = 6;
            s.lastPreEditToolAtMs = Date.now();
            writeAgySession(sid, s);

            const gateGrep = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Grep",
                tool_input: { pattern: "serviceStep", path: repo },
            }, { captureStdout: true }));
            assert.equal(gateGrep.hookSpecificOutput?.permissionDecision, "allow");
            assert.match(gateGrep.hookSpecificOutput?.additionalContext, /Exploration budget reached/);

            const gateAgyNative = evaluateAgyPreTool(
                { conversationId: sid, toolCall: { name: "grep_search", args: { Query: "other", SearchPath: repo } } },
                { repoRoot: repo, agyState: readAgySession(sid), sessionId: sid },
            );
            assert.equal(gateAgyNative.decision, "deny");

            // Targeted unseen file Read & test command stay 100% allowed
            const unseenRead = handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Read",
                tool_input: { file_path: join(repo, "src", "other.ts"), offset: 1, limit: 10 },
            }, { captureStdout: true });
            assert.doesNotMatch(unseenRead, /"deny"/);

            const testCmd = handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "npm test" },
            }, { captureStdout: true });
            assert.equal(testCmd.trim(), "{}");

            // Recording an edit clears editedInPrompt/gate, increments editSeq, and clears seenSearchKeys
            dispatchHostEvent("post-edit", {
                session_id: sid,
                cwd: repo,
                tool_name: "Edit",
                tool_input: { file_path: targetFile },
            }, { captureStdout: true });
            const afterEdit = readAgySession(sid);
            assert.equal(afterEdit.editedInPrompt, true);
            assert.ok(afterEdit.editSeq >= 1);
            assert.deepEqual(afterEdit.seenSearchKeys, []);

            const diffAfterEdit = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "git diff" },
            }, { captureStdout: true }));
            assert.equal(diffAfterEdit.hookSpecificOutput?.permissionDecision, undefined);

            const grepAfterEdit = JSON.parse(handleHostPreTool("claude", {
                session_id: sid,
                cwd: repo,
                tool_name: "Bash",
                tool_input: { command: "plexer grep serviceStep1" },
            }, { captureStdout: true }));
            assert.ok(
                grepAfterEdit.hookSpecificOutput?.permissionDecision === undefined
                    || grepAfterEdit.hookSpecificOutput?.permissionDecision === "allow",
                `post-edit plexer grep must not be denied, got: ${JSON.stringify(grepAfterEdit)}`,
            );
        } finally {
            rmSync(agySessionPath(sid), { force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("compacts dense multi-hit plexer grep output while preserving explicit -C context", async () => {
        const groups = Array.from({ length: 18 }, (_, i) => ({
            symbol: { name: `handler_${i}`, kind: "function", path: `src/mod${i}.ts`, span: `L10-L30` },
            path: `src/mod${i}.ts`,
            inDegree: 20 - i,
            contextBlocks: [{
                lines: [
                    { line: 10, text: `// surrounding before ${i} ${"x".repeat(40)}` },
                    { line: 11, text: `export function handler_${i}() { return targetCall(); }` },
                    { line: 12, text: `// surrounding after ${i} ${"y".repeat(40)}` },
                ],
            }],
            hits: [{ line: 11, text: `export function handler_${i}() { return targetCall(); }` }],
            omittedHits: 0,
        }));
        const result = {
            pattern: "targetCall",
            totalHits: 22,
            filesSearched: 40,
            groups,
            truncated: { files: 0, hits: 0 },
        };

        const compact = formatGrepResult(result, { explicitContext: false });
        assert.ok(Buffer.byteLength(compact, "utf8") <= 3100, `expected <=3100B, got ${Buffer.byteLength(compact, "utf8")}`);
        assert.doesNotMatch(compact, /\/\/ surrounding before/, "dense >16 hit grep strips context lines by default");
        assert.match(compact, /handler_15/, "shows >=16 compact symbol groups within 3000B budget");

        const explicit = formatGrepResult(result, { explicitContext: true });
        assert.match(explicit, /\/\/ surrounding before 0/, "explicit -C preserves surrounding context");
    });

    it("caps non-Gemini multi-subsystem Q&A and edit Turn-0 injections compactly", async () => {
        const repo = makeRepo("plexer-r6-t0-");
        try {
            for (const d of ["api", "db", "auth", "worker"]) {
                mkdirSync(join(repo, "src", d), { recursive: true });
                writeFileSync(
                    join(repo, "src", d, `${d}.ts`),
                    `${Array.from({ length: 60 }, (_, i) => `export function ${d}FlowStep_${i}(x: number) { return x + ${i}; }`).join("\n")}\n`,
                    "utf8",
                );
            }
            await buildGraph(repo, { force: true });
            const ctx = queryPromptContext(
                repo,
                "How do `apiFlowStep_0`, `dbFlowStep_0`, `authFlowStep_0`, and `workerFlowStep_0` interact?",
                { geminiProfile: false },
            );
            const txt = relevantRetrieval(ctx, {}, 4, { geminiProfile: false }) || "";
            assert.ok(Buffer.byteLength(txt, "utf8") <= 5200, `expected <=5200B non-Gemini multi-subsystem Q&A injection, got ${Buffer.byteLength(txt, "utf8")}B`);
        } finally {
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
