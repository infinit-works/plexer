import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { installAntigravitySkill } from "../src/hosts/antigravity.js";
import { installCodexHooks } from "../src/hosts/codex-hooks.js";
import { mergePlexerHooks } from "../src/claude/settings-merge.js";
import { runRetract } from "../src/hosts/retract.js";
import { runGlobalSetup } from "../src/hosts/setup.js";
import { buildGraph } from "../src/index.js";
import { readStats } from "../src/util/state.js";

const HOOKS_PATH = new URL("../src/claude/hooks.js", import.meta.url).pathname;

function runHookEvent(event, stdinObj, extraEnv = {}) {
    const script = `import { main } from ${JSON.stringify(HOOKS_PATH)}; await main(${JSON.stringify(event)});`;
    return execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        env: {
            ...process.env,
            PLEXER_TEST_STDIN: JSON.stringify(stdinObj),
            ...extraEnv,
        },
    });
}

describe("Antigravity Hooks, Retraction & Global Setup", () => {
    it("installs Antigravity skill + hooks.json preserving foreign keys and retracts cleanly", () => {
        const home = mkdtempSync(join(tmpdir(), "plexer-agy-home-"));
        const repo = mkdtempSync(join(tmpdir(), "plexer-agy-repo-"));
        try {
            const hooksJson = join(home, ".gemini", "config", "hooks.json");
            mkdirSync(join(home, ".gemini", "config"), { recursive: true });
            writeFileSync(hooksJson, JSON.stringify({ "other-plugin": { Stop: [] } }, null, 2));

            const res = installAntigravitySkill(home);
            assert.equal(res.length, 3);
            assert.ok(existsSync(join(home, ".gemini", "skills", "plexer", "SKILL.md")));
            assert.ok(existsSync(join(home, ".gemini", "config", "helpers", "plexer-hooks.cjs")));

            const merged = JSON.parse(readFileSync(hooksJson, "utf8"));
            assert.ok(merged["other-plugin"], "foreign top-level key preserved");
            assert.ok(merged["plexer-hooks"], "plexer-hooks added");
            assert.ok(Array.isArray(merged["plexer-hooks"].PreInvocation));
            assert.ok(Array.isArray(merged["plexer-hooks"].PostToolUse));
            assert.ok(Array.isArray(merged["plexer-hooks"].Stop));

            runRetract(repo, { home, apply: true });
            assert.ok(!existsSync(join(home, ".gemini", "config", "helpers", "plexer-hooks.cjs")));
            const afterRetract = JSON.parse(readFileSync(hooksJson, "utf8"));
            assert.ok(afterRetract["other-plugin"], "foreign key still present after retract");
            assert.equal(afterRetract["plexer-hooks"], undefined, "plexer-hooks removed");
        } finally {
            rmSync(home, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });

    it("writes Claude Code and Codex hook timeouts in seconds", () => {
        // Both hosts read `timeout` in seconds; 10000 there is ~2.8 hours, not 10s.
        const timeoutsOf = (hooks) => Object.values(hooks).flat().flatMap((block) => block.hooks.map((h) => h.timeout));
        const assertSeconds = (timeouts, host) => {
            assert.ok(timeouts.length > 0, `${host}: no hook timeouts written`);
            for (const t of timeouts) assert.ok(Number.isInteger(t) && t > 0 && t <= 60, `${host}: timeout ${t} is not seconds-scale`);
        };
        assertSeconds(timeoutsOf(mergePlexerHooks({}).merged.hooks), "Claude Code");

        const home = mkdtempSync(join(tmpdir(), "plexer-codex-home-"));
        try {
            mkdirSync(join(home, ".codex"), { recursive: true });
            installCodexHooks(home);
            assertSeconds(timeoutsOf(JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks), "Codex");
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    });

    it("runs agy-pre-invocation, agy-post-edit (in-process freshness + blast radius), and agy-stop", async () => {
        const repo = mkdtempSync(join(tmpdir(), "plexer-agy-lifecycle-"));
        const sessionId = `test-agy-${Date.now()}`;
        try {
            execFileSync("git", ["init", "-q"], { cwd: repo });
            mkdirSync(join(repo, "src"), { recursive: true });
            const utilFile = join(repo, "src", "util.ts");
            const appFile = join(repo, "src", "app.ts");
            writeFileSync(utilFile, "export function helper(x: number): number { return x + 1; }\n");
            writeFileSync(appFile, "import { helper } from './util';\nexport function run(): number { return helper(41); }\n");

            await buildGraph(repo);
            const builtStats = readStats(repo);
            assert.equal(builtStats.dirty, false);
            assert.equal(builtStats.nodeCount, 4);
            assert.ok(builtStats.edgeCount >= 2);

            const transcriptPath = join(repo, "transcript.jsonl");
            writeFileSync(
                transcriptPath,
                JSON.stringify({ role: "user", step: 1, content: "<USER_REQUEST>Where is helper called in app?</USER_REQUEST>" }) + "\n",
            );

            // 1. Pre-invocation: emits orientation + retrieval
            const preOut1 = JSON.parse(
                runHookEvent("agy-pre-invocation", {
                    sessionId,
                    workspacePaths: [repo],
                    transcriptPath,
                }),
            );
            assert.ok(Array.isArray(preOut1.injectSteps));
            const preMsg1 = preOut1.injectSteps[0].systemMessage?.systemMessage ?? preOut1.injectSteps[0].ephemeralMessage;
            assert.ok(preMsg1.includes("[plexer] This repo is indexed by plexer."));

            // 2. Modify util.ts and trigger agy-post-edit (via both replace_file_content and edit_file)
            writeFileSync(utilFile, "export function helper(x: number): number { return x + 2; }\n");
            const postOut = JSON.parse(
                runHookEvent("agy-post-edit", {
                    sessionId,
                    workspacePaths: [repo],
                    toolCall: { name: "edit_file", args: { Path: JSON.stringify(utilFile) } },
                }),
            );
            assert.deepEqual(postOut, {});
            const stats = readStats(repo);
            assert.equal(stats.dirty, true);
            assert.ok(stats.staleCount >= 1);
            assert.equal(stats.lastFile, "util.ts");

            // 3. Next agy-pre-invocation flushes pendingBlastRadius
            const preOut2 = JSON.parse(
                runHookEvent("agy-pre-invocation", {
                    sessionId,
                    workspacePaths: [repo],
                    transcriptPath,
                }),
            );
            assert.ok(Array.isArray(preOut2.injectSteps));
            assert.ok(preOut2.injectSteps[0].ephemeralMessage.includes("blast radius for util.ts"));

            // 4. agy-stop returns decision: allow
            const stopOut = JSON.parse(
                runHookEvent(
                    "agy-stop",
                    {
                        sessionId,
                        workspacePaths: [repo],
                        transcriptPath,
                    },
                    { PLEXER_TEST_SYNC_RUN: "/nonexistent-sync-run" },
                ),
            );
            assert.equal(stopOut.decision, "allow");
        } finally {
            rmSync(repo, { recursive: true, force: true });
            rmSync(join(tmpdir(), `plexer-agy-${sessionId}.json`), { force: true });
        }
    });

    it("runs runGlobalSetup against a temp home and binDir (MCP opt-in on CLI/skill hosts)", () => {
        const home = mkdtempSync(join(tmpdir(), "plexer-setup-home-"));
        const binDir = mkdtempSync(join(tmpdir(), "plexer-setup-bin-"));
        try {
            mkdirSync(join(home, ".claude"), { recursive: true });
            mkdirSync(join(home, ".codex"), { recursive: true });
            mkdirSync(join(home, ".gemini", "config"), { recursive: true });

            const res = runGlobalSetup({ home, binDir });
            assert.equal(res.bin.length, 1);
            assert.ok(lstatSync(join(binDir, "plexer")).isSymbolicLink());
            assert.ok(lstatSync(join(home, ".agents", "skills", "plexer")).isSymbolicLink());
            assert.ok(lstatSync(join(home, ".claude", "skills", "plexer")).isSymbolicLink());
            assert.ok(lstatSync(join(home, ".gemini", "skills", "plexer")).isSymbolicLink());
            assert.ok(existsSync(join(home, ".gemini", "config", "hooks.json")));
            assert.equal(existsSync(join(home, ".gemini", "config", "mcp_config.json")), false, "MCP must be opt-in by default on CLI/skill hosts");
            assert.equal(existsSync(join(home, ".claude.json")), false, "Claude global MCP must be opt-in by default");

            const resOptIn = runGlobalSetup({ home, binDir, mcp: true });
            assert.ok(resOptIn.mcp.length >= 2);
            assert.ok(existsSync(join(home, ".gemini", "config", "mcp_config.json")), "mcp: true must register Antigravity MCP");
            assert.ok(existsSync(join(home, ".claude.json")), "mcp: true must register Claude global MCP");
        } finally {
            rmSync(home, { recursive: true, force: true });
            rmSync(binDir, { recursive: true, force: true });
        }
    });

    it("scopes runGlobalSetup to opts.agents, retracts global symlinks, and preserves unclosed fenced sections", async () => {
        const { parseAgyTranscript, emptyAgySession } = await import("../src/hosts/antigravity-hooks.js");
        const home = mkdtempSync(join(tmpdir(), "plexer-scoped-home-"));
        const repo = mkdtempSync(join(tmpdir(), "plexer-scoped-repo-"));
        try {
            mkdirSync(join(home, ".claude"), { recursive: true });
            mkdirSync(join(home, ".codex"), { recursive: true });
            mkdirSync(join(home, ".gemini", "config"), { recursive: true });

            // Scoped to ["claude"]: must not touch .codex or .gemini
            const res = runGlobalSetup({ home, agents: ["claude"] });
            assert.equal(res.skills.length, 1);
            assert.equal(res.skills[0].id, "claude-skill");
            assert.equal(existsSync(join(home, ".gemini", "config", "hooks.json")), false);
            assert.equal(existsSync(join(home, ".codex", "hooks.json")), false);
            assert.ok(lstatSync(join(home, ".local", "bin", "plexer")).isSymbolicLink());
            assert.ok(lstatSync(join(home, ".claude", "skills", "plexer")).isSymbolicLink());

            // Unclosed <!-- plexer:start --> in AGENTS.md must not truncate user text on runRetract
            const agentsMd = join(repo, "AGENTS.md");
            const malformed = "# User Header\n\n<!-- plexer:start -->\n# User content after unclosed start\n";
            writeFileSync(agentsMd, malformed);
            runRetract(repo, { home, apply: true });
            assert.equal(readFileSync(agentsMd, "utf8"), malformed, "unclosed marker must not delete trailing user content");
            assert.equal(existsSync(join(home, ".local", "bin", "plexer")), false, "global bin symlink must be retracted");
            assert.equal(existsSync(join(home, ".claude", "skills", "plexer")), false, "global skill symlink must be retracted");

            // Partial JSONL line without trailing newline must not advance transcriptOffset
            const transcriptPath = join(repo, "partial.jsonl");
            const line1 = JSON.stringify({ type: "USER_INPUT", step_index: 7, content: "<USER_REQUEST>First prompt</USER_REQUEST>" }) + "\n";
            const halfLine = '{"type":"USER_INPUT","step_index":8,"content":"<USER_REQ';
            writeFileSync(transcriptPath, line1 + halfLine);
            const state = emptyAgySession();
            parseAgyTranscript(transcriptPath, state);
            assert.equal(state.lastUserStep, 7, "step_index parsed from complete line");
            assert.equal(state.transcriptOffset, Buffer.byteLength(line1, "utf8"), "incomplete trailing line not consumed");

            // resolveAgyRepoDir must prioritize lastTouchedPath / cwd over workspacePaths[0]
            // even when lastTouchedPath is an unindexed git repo and workspacePaths[0] has plexer/INDEX.md
            const { resolveAgyRepoDir } = await import("../src/hosts/antigravity-hooks.js");
            const indexedWs = mkdtempSync(join(tmpdir(), "plexer-ws-indexed-"));
            const unindexedRepo = mkdtempSync(join(tmpdir(), "plexer-repo-cold-"));
            try {
                mkdirSync(join(indexedWs, "plexer"), { recursive: true });
                writeFileSync(join(indexedWs, "plexer", "INDEX.md"), "# Indexed Workspace\n");
                execFileSync("git", ["init", "-q"], { cwd: unindexedRepo });
                const resolved = resolveAgyRepoDir(
                    { workspacePaths: [indexedWs] },
                    { lastTouchedPath: join(unindexedRepo, "src", "foo.ts") },
                );
                assert.equal(resolved, unindexedRepo, "must resolve unindexed active repo instead of leaking indexed workspace");

                // Reading a skill/config file under ~/.gemini or ~/.agents must not hijack workspacePaths[0]
                const resolvedWithSkillRead = resolveAgyRepoDir(
                    { workspacePaths: [unindexedRepo] },
                    { lastTouchedPath: join(homedir(), ".gemini/config/skills/review/SKILL.md") },
                );
                assert.equal(resolvedWithSkillRead, unindexedRepo, "skill path under .gemini must not hijack workspace root");

                // Subdirectory with secondary marker (e.g. test/default.project.json) inside a .git repo
                // must resolve to the enclosing .git root and never be treated as a standalone repo
                const { isAutoBuildableRepo, nearestPlexerRoot } = await import("../src/graph/root.js");
                mkdirSync(join(unindexedRepo, "test", "unit"), { recursive: true });
                writeFileSync(join(unindexedRepo, "test", "default.project.json"), '{"name":"test"}\n');
                assert.equal(
                    isAutoBuildableRepo(join(unindexedRepo, "test")),
                    false,
                    "subdirectory with default.project.json inside a .git repo must not be auto-buildable",
                );
                assert.equal(
                    nearestPlexerRoot(join(unindexedRepo, "test", "unit")).root,
                    unindexedRepo,
                    "nearestPlexerRoot must walk past test/default.project.json to the enclosing .git root",
                );
                assert.equal(
                    resolveAgyRepoDir(
                        { workspacePaths: [unindexedRepo] },
                        { lastTouchedPath: join(unindexedRepo, "test", "unit", "Clock.spec.luau") },
                    ),
                    unindexedRepo,
                    "resolveAgyRepoDir must resolve test/unit/*.spec.luau to enclosing .git root, not test/",
                );
            } finally {
                rmSync(indexedWs, { recursive: true, force: true });
                rmSync(unindexedRepo, { recursive: true, force: true });
            }

            // Cold/unindexed git repo auto-builds plexer/ on Turn 1 in handleAgyPreInvocation & callTool,
            // prefers transcript_full.jsonl over truncated transcript.jsonl, and strips slash commands
            const { agySessionPath } = await import("../src/hosts/antigravity-hooks.js");
            const { callTool } = await import("../src/mcp/tools.js");
            const coldRepo = mkdtempSync(join(tmpdir(), "plexer-agy-lifecycle-cold-"));
            const logsDir = join(coldRepo, ".logs");
            const sid = `test-cold-${Date.now()}`;
            try {
                execFileSync("git", ["init", "-q"], { cwd: coldRepo });
                mkdirSync(join(coldRepo, "src"), { recursive: true });
                mkdirSync(logsDir, { recursive: true });
                writeFileSync(
                    join(coldRepo, "src", "tracker.py"),
                    "def compute_revenue_summary(sales):\n    return sum(s.get('amount', 0) for s in sales)\n",
                );
                // Compact transcript is truncated, while transcript_full.jsonl has the full USER_REQUEST
                writeFileSync(
                    join(logsDir, "transcript.jsonl"),
                    JSON.stringify({
                        type: "USER_INPUT",
                        step_index: 0,
                        content: "<USER_REQUEST>\n/plan /grill-me ",
                        truncated_fields: ["content"],
                    }) + "\n",
                );
                writeFileSync(
                    join(logsDir, "transcript_full.jsonl"),
                    JSON.stringify({
                        type: "USER_INPUT",
                        step_index: 0,
                        content:
                            "<USER_REQUEST>\n/plan /grill-me how does compute_revenue_summary calculate sales in tracker.py?\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlong metadata\n</ADDITIONAL_METADATA>",
                    }) + "\n",
                );

                const hookOut = JSON.parse(
                    runHookEvent("agy-pre-invocation", {
                        conversationId: sid,
                        workspacePaths: [coldRepo],
                        transcriptPath: join(logsDir, "transcript.jsonl"),
                    }),
                );

                assert.equal(existsSync(join(coldRepo, "plexer", ".graph", "wiring.json")), true, "cold repo must auto-build wiring.json on Turn 1");
                assert.equal(existsSync(join(coldRepo, "plexer", "INDEX.md")), true, "cold repo must auto-build INDEX.md on Turn 1");
                assert.equal(existsSync(join(coldRepo, ".gitignore")), false, "auto-build must not create or dirty tracked .gitignore");
                assert.equal(existsSync(join(coldRepo, ".ignore")), false, "auto-build without --cards must not create .ignore");
                const excludeText = readFileSync(join(coldRepo, ".git", "info", "exclude"), "utf8");
                assert.ok(excludeText.includes("/plexer/"), "auto-build must write /plexer/ to .git/info/exclude");
                assert.ok(Array.isArray(hookOut.injectSteps) && hookOut.injectSteps.length === 1, "PreInvocation must inject Turn-1 context on cold repo");
                const hookMsg = hookOut.injectSteps[0].systemMessage?.systemMessage ?? hookOut.injectSteps[0].ephemeralMessage;
                assert.ok(hookMsg.includes("compute_revenue_summary"), "PreInvocation must retrieve symbol from transcript_full.jsonl after stripping slash commands");

                // Also verify callTool auto-builds a second cold repo when called via MCP
                const coldMcpRepo = mkdtempSync(join(tmpdir(), "plexer-mcp-cold-"));
                try {
                    execFileSync("git", ["init", "-q"], { cwd: coldMcpRepo });
                    mkdirSync(join(coldMcpRepo, "src"), { recursive: true });
                    writeFileSync(join(coldMcpRepo, "src", "app.py"), "def start_server(port):\n    return port\n");
                    const mcpRes = await callTool(tmpdir(), "plexer_find_code", {
                        query: "start_server",
                        dir: coldMcpRepo,
                    });
                    assert.equal(mcpRes.isError, false, "MCP callTool on cold repo must succeed");
                    assert.ok(mcpRes.text.includes("start_server"), "MCP callTool must return indexed symbol from auto-built graph");
                } finally {
                    rmSync(coldMcpRepo, { recursive: true, force: true });
                }
            } finally {
                rmSync(coldRepo, { recursive: true, force: true });
                rmSync(agySessionPath(sid), { force: true });
            }
        } finally {
            rmSync(home, { recursive: true, force: true });
            rmSync(repo, { recursive: true, force: true });
        }
    });
});
