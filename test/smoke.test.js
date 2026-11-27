import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { installAntigravitySkill } from "../src/hosts/antigravity.js";
import { installCodexHooks } from "../src/hosts/codex-hooks.js";
import { mergePlexerHooks } from "../src/claude/settings-merge.js";
import { runRetract } from "../src/hosts/retract.js";
import { runGlobalSetup } from "../src/hosts/setup.js";
import { buildGraph } from "../src/index.js";
import { agySessionPath } from "../src/agy/session.js";
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
    it("installs Antigravity plugin, migrates legacy plexer-hooks preserving foreign keys, and retracts cleanly", () => {
        const home = mkdtempSync(join(tmpdir(), "plexer-agy-home-"));
        const repo = mkdtempSync(join(tmpdir(), "plexer-agy-repo-"));
        try {
            const hooksJson = join(home, ".gemini", "config", "hooks.json");
            const legacyShim = join(home, ".gemini", "config", "helpers", "plexer-hooks.cjs");
            mkdirSync(join(home, ".gemini", "config", "helpers"), { recursive: true });
            writeFileSync(legacyShim, "// legacy\n");
            writeFileSync(hooksJson, JSON.stringify({
                "other-plugin": { Stop: [] },
                "plexer-hooks": { Stop: [{ type: "command", command: "node legacy" }] },
            }, null, 2));

            const res = installAntigravitySkill(home);
            assert.ok(res.some((r) => r.id === "antigravity-plugin"));
            assert.equal(existsSync(join(home, ".gemini", "skills", "plexer", "SKILL.md")), false, "Antigravity plugin install must not create redundant ~/.gemini/skills/plexer when Gemini CLI is absent");

            const pluginDir = join(home, ".gemini", "config", "plugins", "plexer");
            assert.ok(lstatSync(pluginDir).isSymbolicLink(), "Antigravity plugin directory symlink created");
            assert.ok(existsSync(join(pluginDir, "plugin.json")), "plugin.json present inside linked plugin");
            assert.ok(existsSync(join(pluginDir, "hooks.json")), "hooks.json present inside linked plugin");
            assert.equal(existsSync(legacyShim), false, "legacy plexer-hooks.cjs shim removed");

            const afterInstall = JSON.parse(readFileSync(hooksJson, "utf8"));
            assert.ok(afterInstall["other-plugin"], "foreign top-level key preserved");
            assert.equal(afterInstall["plexer-hooks"], undefined, "legacy plexer-hooks stripped on migration");

            runRetract(repo, { home, apply: true });
            assert.equal(existsSync(pluginDir), false, "Antigravity plugin symlink retracted");
            const afterRetract = JSON.parse(readFileSync(hooksJson, "utf8"));
            assert.ok(afterRetract["other-plugin"], "foreign key still present after retract");
            assert.equal(afterRetract["plexer-hooks"], undefined, "plexer-hooks remains removed");
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
            writeFileSync(utilFile, "export function computeAnswer(x: number): number { return x + 1; }\n");
            writeFileSync(appFile, "import { computeAnswer } from './util';\nexport function run(): number { return computeAnswer(41); }\n");

            await buildGraph(repo);
            const builtStats = readStats(repo);
            assert.equal(builtStats.dirty, false);
            assert.equal(builtStats.nodeCount, 4);
            assert.ok(builtStats.edgeCount >= 2);

            const transcriptPath = join(repo, "transcript.jsonl");
            writeFileSync(
                transcriptPath,
                JSON.stringify({ role: "user", step: 1, content: "<USER_REQUEST>Summarize the history of ancient Rome.</USER_REQUEST>" }) + "\n",
            );

            // 1a. OOB Pre-invocation stays completely silent (0 B, no orientation dump)
            const oobOut = JSON.parse(
                runHookEvent("agy-pre-invocation", {
                    sessionId,
                    workspacePaths: [repo],
                    transcriptPath,
                }),
            );
            assert.deepEqual(oobOut, {});

            // 1b. Repo-relevant Pre-invocation emits retrieved context for matched symbol
            writeFileSync(
                transcriptPath,
                JSON.stringify({ role: "user", step: 2, content: "<USER_REQUEST>Where is computeAnswer called in app?</USER_REQUEST>" }) + "\n",
            );
            const preOut1 = JSON.parse(
                runHookEvent("agy-pre-invocation", {
                    sessionId,
                    workspacePaths: [repo],
                    transcriptPath,
                }),
            );
            assert.ok(Array.isArray(preOut1.injectSteps));
            const preMsg1 = preOut1.injectSteps[0].systemMessage?.systemMessage ?? preOut1.injectSteps[0].ephemeralMessage;
            assert.ok(preMsg1.includes("computeAnswer") && preMsg1.includes("util.ts"));

            // 2. Modify util.ts in an editing session without pre-injected util.ts spans and trigger agy-post-edit
            const editSessionId = `${sessionId}-edit`;
            const editTranscriptPath = join(repo, "transcript-edit.jsonl");
            writeFileSync(
                editTranscriptPath,
                JSON.stringify({ role: "user", step: 1, content: "<USER_REQUEST>Check blast behavior</USER_REQUEST>" }) + "\n",
            );
            writeFileSync(utilFile, "export function computeAnswer(x: number): number { return x + 2; }\n");
            const postOut = JSON.parse(
                runHookEvent("agy-post-edit", {
                    sessionId: editSessionId,
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
                    sessionId: editSessionId,
                    workspacePaths: [repo],
                    transcriptPath: editTranscriptPath,
                }),
            );
            assert.ok(Array.isArray(preOut2.injectSteps));
            const preMsg2 = preOut2.injectSteps[0].systemMessage?.systemMessage ?? preOut2.injectSteps[0].ephemeralMessage;
            assert.ok(preMsg2.includes("blast radius for util.ts"));

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
            rmSync(agySessionPath(sessionId), { force: true });
            rmSync(agySessionPath(`${sessionId}-edit`), { force: true });
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
            assert.equal(existsSync(join(home, ".gemini", "skills", "plexer")), false, "runGlobalSetup must not create ~/.gemini/skills/plexer without Gemini CLI or explicit agents: ['gemini']");
            assert.ok(lstatSync(join(home, ".gemini", "config", "plugins", "plexer")).isSymbolicLink());
            assert.equal(existsSync(join(home, ".gemini", "config", "hooks.json")), false);
            assert.equal(existsSync(join(home, ".gemini", "config", "mcp_config.json")), false, "MCP must be opt-in by default on CLI/skill hosts");
            assert.equal(existsSync(join(home, ".claude.json")), false, "Claude global MCP must be opt-in by default");

            const resGemini = runGlobalSetup({ home, binDir, agents: ["gemini"] });
            assert.ok(resGemini.skills.some((s) => s.id === "gemini-skill"));
            assert.ok(lstatSync(join(home, ".gemini", "skills", "plexer")).isSymbolicLink(), "setup({ agents: ['gemini'] }) must install ~/.gemini/skills/plexer");

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
        const { parseAgyTranscript } = await import("../src/hosts/engine/agy-transcript.js");
        const { emptyAgySession } = await import("../src/agy/session.js");
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
            const { resolveAgyRepoDir } = await import("../src/hosts/engine/agy-context.js");
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

    it("fails open with valid JSON on runtime exit 127 across plugin, Claude, and Codex hook commands, and propagates script exit codes", () => {
        if (process.platform === "win32") return;
        const tmp = mkdtempSync(join(tmpdir(), "plexer-hook-run-"));
        const home = mkdtempSync(join(tmpdir(), "plexer-hook-home-"));
        try {
            const fakeBinDir = join(tmp, "fake-bin");
            mkdirSync(fakeBinDir, { recursive: true });
            const fakeNode = join(fakeBinDir, "node");
            writeFileSync(
                fakeNode,
                "#!/bin/sh\necho 'node: error while loading shared libraries: libsimdjson.so.36: cannot open shared object file' >&2\nexit 127\n",
            );
            chmodSync(fakeNode, 0o755);

            const failOpenEnv = {
                ...process.env,
                PATH: `${fakeBinDir}:${process.env.PATH || "/usr/bin:/bin"}`,
                XDG_DATA_HOME: tmp,
            };
            delete failOpenEnv.AGENT_HOOK_NODE;

            const exit2Script = join(tmp, "exit2.js");
            writeFileSync(exit2Script, "process.exit(2);\n");

            const pkgRoot = new URL("..", import.meta.url).pathname;
            const runnerPath = join(pkgRoot, "bin", "plexer-hook-run.sh");
            const clientPath = join(pkgRoot, "bin", "plexer-hook-client.cjs");

            for (const [ev, expected] of [
                ["agy-pre-tool", { decision: "allow" }],
                ["agy-stop", { decision: "allow" }],
                ["agy-pre-invocation", {}],
                ["agy-post-tool", {}],
            ]) {
                const res = spawnSync("sh", [runnerPath, clientPath, ev], {
                    cwd: pkgRoot,
                    encoding: "utf8",
                    env: failOpenEnv,
                });
                assert.equal(res.status, 0, `${ev}: expected fail-open exit 0, stderr=${res.stderr}`);
                assert.deepEqual(JSON.parse(res.stdout), expected, `${ev}: expected valid fallback JSON`);
                assert.match(res.stderr, /warning:/, `${ev}: expected warning on stderr`);
            }

            const non127 = spawnSync("sh", [runnerPath, exit2Script], {
                cwd: pkgRoot,
                encoding: "utf8",
                env: { ...process.env, AGENT_HOOK_NODE: process.execPath },
            });
            assert.equal(non127.status, 2, "non-127 script exit code must propagate");

            const claudeCmd = mergePlexerHooks({}, join(tmp, "helpers")).merged.hooks.PreToolUse[0].hooks[0].command;
            const claudeRes = spawnSync("sh", ["-c", claudeCmd], {
                encoding: "utf8",
                env: failOpenEnv,
            });
            assert.equal(claudeRes.status, 0, `Claude command failed: ${claudeRes.stderr}`);
            assert.deepEqual(JSON.parse(claudeRes.stdout), {});
            assert.match(claudeRes.stderr, /warning:/);

            mkdirSync(join(home, ".codex"), { recursive: true });
            installCodexHooks(home);
            const codexHooks = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8")).hooks;
            const codexCmd = codexHooks.SessionStart[0].hooks[0].command;
            const codexRes = spawnSync("sh", ["-c", codexCmd], {
                encoding: "utf8",
                env: failOpenEnv,
            });
            assert.equal(codexRes.status, 0, `Codex command failed: ${codexRes.stderr}`);
            assert.deepEqual(JSON.parse(codexRes.stdout), {});
            assert.match(codexRes.stderr, /warning:/);
        } finally {
            rmSync(tmp, { recursive: true, force: true });
            rmSync(home, { recursive: true, force: true });
        }
    });
});
