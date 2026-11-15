#!/usr/bin/env node
/**
 * Large-Repo & Discriminative Suite (`L1`–`L8`) 3-arm A/B/C benchmark runner.
 *
 * Evaluates `cold` vs `trail` vs `plexer` across 8 tasks (`L1`–`L8`) spanning 4
 * real-world repositories (`pocketbase/pocketbase`, `tutao/tutanota`,
 * `qutebrowser/qutebrowser`, `flipt-io/flipt`, `NodeBB/NodeBB`):
 *  - `L1`–`L4`: Deep cross-subsystem & multi-hop caller blast-radius traces
 *  - `L5`–`L8`: Multi-file (`2–4` sibling files) code-edit tasks with strict binary
 *               resolution (`resolved` requires 100% of gold sibling files modified +
 *               per-file contract checks) and `0..8` rubric scoring.
 *
 * Usage:
 *   node bench/run-large-ab.js <model> [concurrency=4] [arm=all] [taskFilter=all] [--regrade]
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { LARGE_TASKS } from "./large-tasks.js";
import { ensureSwebenchBaseRepos } from "./ensure-base.js";
import { gradeTaskArm, parseTranscript } from "./grade.js";
import {
    buildTrailAgyHooksJson,
    buildTrailClaudeSettingsJson,
    buildTrailMcpConfigJson,
    getTrailEnv,
    getTrailSkillBody,
    prepareTrailWorktreeDir,
} from "./trail-live-helper.js";

const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rawModelArg = positionals[0] || "sonnet";
export const CLAUDE_MODELS = {
    sonnet: "claude-sonnet-5-5",
    "sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    "opus-5-5": "claude-opus-5-5",
    "claude-opus-5-5": "claude-opus-5-5",
};
export function normalizeModelArg(raw = "sonnet") {
    return raw.startsWith("argon") ||
        raw.startsWith("flash") ||
        raw.startsWith("carbon") ||
        raw.startsWith("gemini-") ||
        raw.endsWith("-agy")
        ? raw
        : raw.replace(/^claude-/, "").replace(/-5-5$/, "");
}
const modelArg = normalizeModelArg(rawModelArg);
const resolvedClaudeModel = CLAUDE_MODELS[rawModelArg] || rawModelArg;
const concurrency = Number(positionals[1] || 4);
const armFilter = positionals[2] || "all";
const taskFilterArg = positionals[3] || "all";
const REINDEX = process.argv.includes("--reindex");
const taskFilterSet =
    taskFilterArg === "all"
        ? null
        : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both"
        ? ["cold", "plexer"]
        : armFilter === "all"
          ? ["cold", "plexer", "trail"]
          : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

export function resolveIsAgy(mArg, env = process.env) {
    return env.FORCE_CLAUDE_CLI === "1"
        ? false
        : env.FORCE_AGY_CLI === "1" ||
          mArg.startsWith("argon") ||
          mArg.startsWith("flash") ||
          mArg.startsWith("carbon") ||
          mArg.startsWith("gemini-") ||
          mArg.endsWith("-agy");
}
const isAgy =
    process.env.FORCE_CLAUDE_CLI === "1"
        ? false
        : process.env.FORCE_AGY_CLI === "1" ||
          modelArg.startsWith("argon") ||
          modelArg.startsWith("flash") ||
          modelArg.startsWith("carbon") ||
          modelArg.startsWith("gemini-") ||
          modelArg.endsWith("-agy");
export const AGY_MODELS = {
    "carbon-low": { model: "gemini-4-carbon-low", effort: "low" },
    "carbon-medium": { model: "gemini-4-carbon-medium", effort: "medium" },
    "carbon-high": { model: "gemini-4-carbon-high", effort: "high" },
    "gemini-4-carbon-low": { model: "gemini-4-carbon-low", effort: "low" },
    "gemini-4-carbon-medium": { model: "gemini-4-carbon-medium", effort: "medium" },
    "gemini-4-carbon-high": { model: "gemini-4-carbon-high", effort: "high" },
    "argon-low": { model: "gemini-4-argon-low", effort: "low" },
    "argon-medium": { model: "gemini-4-argon-medium", effort: "medium" },
    "argon-high": { model: "gemini-4-argon-high", effort: "high" },
    "flash-low": { model: "gemini-3.8-flash-low", effort: "low" },
    "flash-medium": { model: "gemini-3.8-flash-medium", effort: "medium" },
    "flash-high": { model: "gemini-3.8-flash-high", effort: "high" },
    sonnet: { model: "claude-sonnet-5-5-medium", effort: "medium" },
    "sonnet-agy": { model: "claude-sonnet-5-5-medium", effort: "medium" },
    opus: { model: "claude-opus-5-5-medium", effort: "medium" },
    "opus-agy": { model: "claude-opus-5-5-medium", effort: "medium" },
    "gemini-3.8-flash-medium": { model: "gemini-3.8-flash-medium", effort: "medium" },
    "gemini-4-argon-medium": { model: "gemini-4-argon-medium", effort: "medium" },
};

const BASE_CACHE_DIR = "/tmp/plexer-swebench-base";
const logDir = `/tmp/plexer-large-logs/${modelArg}`;
const benchDaemonSock = `/tmp/plexer-large-bench-${process.pid}.sock`;

const basePrompt = [
    "You are an expert software engineer solving a repository engineering task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "For question/diagnosis/blast-radius tasks, answer concisely with exact file paths, line numbers, and symbol names.",
    "For code-edit tasks, apply the requested changes directly to all required files in the repository.",
    "Do NOT run slow full-repository test suites, Docker builds, or package installs — focus on accurate code localization and surgical edits.",
].join("\n");

const skillMdRaw = readFileSync(resolve(import.meta.dirname, "../SKILL.md"), "utf8");
const skillBody = skillMdRaw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
const agyRuleBody = readFileSync(resolve(import.meta.dirname, "../rules/AGENTS.md"), "utf8").trim();
let trailSkillBody = "";

const coldSysFile = join(logDir, "cold-system.txt");
const plexerSysFile = join(logDir, "plexer-system.txt");
const trailSysFile = join(logDir, "trail-system.txt");

const plexerBin = resolve(import.meta.dirname, "../bin/plexer.js");
const plexerHookClient = resolve(import.meta.dirname, "../bin/plexer-hook-client.cjs");
const plexerHooksSettingsFile = join(logDir, "plexer-hooks-settings.json");
const trailHooksSettingsFile = join(logDir, "trail-hooks-settings.json");
const trailMcpConfigFile = join(logDir, "trail-mcp-config.json");
function initRuntimeFiles() {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(coldSysFile, `${basePrompt}\n`, "utf8");
    writeFileSync(plexerSysFile, `${basePrompt}\n\n${skillBody}\n`, "utf8");
    writeFileSync(trailSysFile, trailSkillBody ? `${basePrompt}\n\n${trailSkillBody}\n` : `${basePrompt}\n`, "utf8");
    writeFileSync(trailMcpConfigFile, buildTrailMcpConfigJson(), "utf8");
    writeFileSync(
        plexerHooksSettingsFile,
        JSON.stringify(
            {
                hooks: {
                    UserPromptSubmit: [
                        {
                            hooks: [
                                {
                                    type: "command",
                                    command: `${process.execPath} ${JSON.stringify(plexerBin)} _hook prompt`,
                                    timeout: 15,
                                },
                            ],
                        },
                    ],
                    PostToolUse: [
                        {
                            matcher: "Write|Edit|MultiEdit",
                            hooks: [
                                {
                                    type: "command",
                                    command: `${process.execPath} ${JSON.stringify(plexerBin)} _hook post-edit`,
                                    timeout: 10,
                                },
                            ],
                        },
                    ],
                },
            },
            null,
            2
        ),
        "utf8"
    );
    writeFileSync(trailHooksSettingsFile, buildTrailClaudeSettingsJson(), "utf8");
}

const agyHooksJson = JSON.stringify(
    {
        "plexer-hooks": {
            PreInvocation: [
                {
                    type: "command",
                    command: `env PLEXER_ENABLE_BENCH_HOOKS=1 ${process.execPath} ${JSON.stringify(plexerHookClient)} agy-pre-invocation`,
                    timeout: 15,
                },
            ],
            PreToolUse: [
                {
                    matcher: "read_file|view_file|run_command",
                    hooks: [
                        {
                            type: "command",
                            command: `env PLEXER_ENABLE_BENCH_HOOKS=1 ${process.execPath} ${JSON.stringify(plexerHookClient)} agy-pre-tool`,
                            timeout: 10,
                        },
                    ],
                },
            ],
            PostToolUse: [
                {
                    matcher: "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|read_file|view_file",
                    hooks: [
                        {
                            type: "command",
                            command: `env PLEXER_ENABLE_BENCH_HOOKS=1 ${process.execPath} ${JSON.stringify(plexerHookClient)} agy-post-tool`,
                            timeout: 10,
                        },
                    ],
                },
            ],
            Stop: [
                {
                    type: "command",
                    command: `env PLEXER_ENABLE_BENCH_HOOKS=1 ${process.execPath} ${JSON.stringify(plexerHookClient)} agy-stop`,
                    timeout: 10,
                },
            ],
        },
    },
    null,
    2
);
const trailAgyHooksJson = buildTrailAgyHooksJson();

function makeAgyAgentMd(name, desc, body, hooksPath = null) {
    return [
        "---",
        `name: ${name}`,
        `description: ${desc}`,
        "tools:",
        "  - view_file",
        "  - multi_replace_file_content",
        "  - replace_file_content",
        "  - write_to_file",
        "  - run_command",
        "  - manage_task",
        ...(hooksPath ? ["hooks:", `  - ${hooksPath}`] : []),
        "hidden: true",
        "inheritCustomizations: false",
        "inheritMcp: false",
        "---",
        "",
        "# Agent System Instructions",
        "",
        body,
        "When running shell commands with `run_command`, always set `WaitMsBeforeAsync: 10000` so commands complete synchronously.",
        "",
    ].join("\n");
}

const coldAgyMd = makeAgyAgentMd(
    "bench-cold",
    "Cold baseline software engineering agent for Large-Repo A/B benchmarking.",
    `${basePrompt}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` or \`trail\` commands; use standard repository tools only.`
);

const reindexedBaseIds = new Set();

async function ensureBaseLargeRepo(task, forceReindex = false) {
    const cleanDir = join(BASE_CACHE_DIR, "clean", task.baseId);
    const indexedDir = join(BASE_CACHE_DIR, "indexed", task.baseId);
    const shouldReindex = forceReindex && !reindexedBaseIds.has(task.baseId);

    if (shouldReindex || !existsSync(cleanDir) || !existsSync(join(indexedDir, "plexer", ".graph", "wiring.json"))) {
        await ensureSwebenchBaseRepos(new Set([task.baseId]), { reindex: shouldReindex });
        reindexedBaseIds.add(task.baseId);
    }

    return { cleanDir, indexedDir };
}

export async function prepareWorktree(task, arm) {
    const { cleanDir, indexedDir } = await ensureBaseLargeRepo(task);
    const workDir = `/tmp/plexer-large-${modelArg}-${arm}/${task.id}`;
    const srcDir = arm === "plexer" ? indexedDir : cleanDir;
    if (!existsSync(workDir)) {
        mkdirSync(`/tmp/plexer-large-${modelArg}-${arm}`, { recursive: true });
        cpSync(srcDir, workDir, { recursive: true });
    } else {
        const baseSha = existsSync(cleanDir)
            ? execFileSync("git", ["rev-parse", "HEAD"], { cwd: cleanDir, encoding: "utf8" }).trim()
            : "HEAD";
        try {
            execFileSync("git", ["reset", "--hard", baseSha], { cwd: workDir, stdio: "ignore" });
        } catch {
            rmSync(workDir, { recursive: true, force: true });
            cpSync(srcDir, workDir, { recursive: true });
        }
        execFileSync("git", ["checkout", "--", "."], { cwd: workDir, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents", "-e", "graft", "-e", ".trail"], {
            cwd: workDir,
            stdio: "ignore",
        });
        if (arm === "plexer") {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
            cpSync(join(indexedDir, "plexer"), join(workDir, "plexer"), { recursive: true });
        } else if (existsSync(join(workDir, "plexer"))) {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        }
    }
    if (arm === "trail") {
        rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        prepareTrailWorktreeDir(workDir, task.baseId, cleanDir);
    }

    const excludePath = join(workDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes("graft/")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\npLexer/\nplexer/\ngraft/\n.trail/\n`, "utf8");
        }
    }

    if (isAgy) {
        const agentsDir = join(workDir, ".agents", "agents");
        mkdirSync(agentsDir, { recursive: true });
        const hooksPath = join(workDir, ".agents", "hooks.json");
        writeFileSync(join(agentsDir, "bench-cold.md"), coldAgyMd, "utf8");
        writeFileSync(
            join(agentsDir, "bench-plexer.md"),
            makeAgyAgentMd(
                "bench-plexer",
                "Plexer-equipped software engineering agent for Large-Repo A/B benchmarking.",
                `${basePrompt}\n\nIMPORTANT: Do NOT read external skill files under ~/.gemini/ or ~/.agents/; your plexer instructions are already loaded below.\n\n${agyRuleBody}`,
                hooksPath
            ),
            "utf8"
        );
        if (trailSkillBody) {
            writeFileSync(
                join(agentsDir, "bench-trail.md"),
                makeAgyAgentMd(
                    "bench-trail",
                    "Trail-equipped software engineering agent for Large-Repo A/B benchmarking.",
                    `${basePrompt}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` commands.\n\n${trailSkillBody}`,
                    hooksPath
                ),
                "utf8"
            );
        }
        if (arm === "plexer") {
            writeFileSync(hooksPath, `${agyHooksJson}\n`, "utf8");
        } else if (arm === "trail") {
            writeFileSync(hooksPath, `${trailAgyHooksJson}\n`, "utf8");
        } else if (existsSync(hooksPath)) {
            rmSync(hooksPath, { force: true });
        }
    }

    return workDir;
}

export function gradeLargeTask(task, workDir, parsed) {
    if (task.category === "code-edit" && typeof task.verify === "function") {
        const v = task.verify(workDir);
        const modSet = new Set(v.modifiedFiles || []);
        const gold = task.goldFiles || [];
        const matchedGold = gold.filter((f) => modSet.has(f));
        const fileRecall = gold.length > 0 ? Number((matchedGold.length / gold.length).toFixed(3)) : 1;
        const hasEdits = Boolean(parsed.didModifyFile || modSet.size > 0);
        return {
            score: hasEdits ? v.score : 0,
            maxScore: v.maxScore || 8,
            resolved: Boolean(hasEdits && v.resolved),
            fileRecall,
            modifiedFiles: v.modifiedFiles || [],
            goldSourceFiles: gold,
            checks: v.checks || [],
        };
    }
    const g = gradeTaskArm(task, parsed, workDir);
    const resolved = g.score >= 7;
    return {
        score: g.score,
        maxScore: g.maxScore || 8,
        resolved,
        fileRecall: Number((g.score / (g.maxScore || 8)).toFixed(3)),
        goldSourceFiles: task.goldFiles || [],
        checks: g.checks || [],
    };
}

async function runOne(task, arm) {
    const workDir = await prepareWorktree(task, arm);
    const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
    const promptText = task.prompt(workDir);

    return new Promise((resolveRun, rejectRun) => {
        let cmd;
        let args;
        if (isAgy) {
            const cfg = AGY_MODELS[modelArg] || { model: modelArg, effort: "medium" };
            cmd = "agy";
            args = [
                "-p",
                promptText,
                "--agent",
                arm === "plexer" ? "bench-plexer" : arm === "trail" ? "bench-trail" : "bench-cold",
                "--model",
                cfg.model,
                "--effort",
                cfg.effort,
                "--output-format",
                "stream-json",
                "--dangerously-skip-permissions",
                "--disable-slash-commands",
            ];
        } else {
            cmd = "claude";
            const settingsFile =
                arm === "plexer" ? plexerHooksSettingsFile : arm === "trail" ? trailHooksSettingsFile : null;
            const sysFile =
                arm === "plexer" ? plexerSysFile : arm === "trail" ? trailSysFile : coldSysFile;
            args = [
                "--setting-sources",
                "",
                ...(settingsFile ? ["--settings", settingsFile] : []),
                ...(arm === "trail" ? ["--mcp-config", trailMcpConfigFile] : []),
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--dangerously-skip-permissions",
                "--tools",
                "Bash,Read,Edit,Write,Grep,Glob",
                ...(arm === "trail"
                    ? ["--allowedTools", "Bash,Read,Edit,Write,Grep,Glob,mcp__trail__*"]
                    : []),
                "--append-system-prompt-file",
                sysFile,
                "-p",
                promptText,
                "--model",
                resolvedClaudeModel,
                "--effort",
                "medium",
                "--output-format",
                "stream-json",
                "--verbose",
            ];
        }

        const tmpJsonl = `${outJsonl}.tmp`;
        const outStream = createWriteStream(tmpJsonl, { flags: "w" });
        const env =
            arm === "trail"
                ? getTrailEnv()
                : {
                      ...process.env,
                      ...(isAgy ? { PLEXER_DAEMON_SOCK: benchDaemonSock } : {}),
                      ...(arm === "plexer"
                          ? (isAgy ? {} : { PLEXER_ENABLE_BENCH_HOOKS: "1" })
                          : { PLEXER_ENABLE_BENCH_HOOKS: "0", PLEXER_DISABLE_HOOKS: "1", PLEXER_BENCH_HIDE_CLI: "1" }),
                      GIT_CONFIG_COUNT: "2",
                      GIT_CONFIG_KEY_0: "commit.gpgsign",
                      GIT_CONFIG_VALUE_0: "false",
                      GIT_CONFIG_KEY_1: "tag.gpgsign",
                      GIT_CONFIG_VALUE_1: "false",
                  };
        if (arm === "plexer") {
            if (isAgy)
                delete env.PLEXER_ENABLE_BENCH_HOOKS;
            delete env.PLEXER_DISABLE_HOOKS;
            delete env.PLEXER_BENCH_HIDE_CLI;
        }
        delete env.PLEXER_DIR;
        const child = spawn(cmd, args, {
            cwd: workDir,
            env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        child.stdout.pipe(outStream);
        let stderr = "";
        child.stderr.on("data", (d) => {
            stderr += d.toString();
        });

        child.on("error", (err) => {
            outStream.end();
            rejectRun(err);
        });
        child.on("close", (code) => {
            outStream.end(() => {
                if (code === 0) {
                    renameSync(tmpJsonl, outJsonl);
                }
                const targetJsonl = code === 0 ? outJsonl : tmpJsonl;
                const parsed = parseTranscript(targetJsonl, arm);
                const grade = gradeLargeTask(task, workDir, parsed);
                console.log(
                    `[${modelArg}] ${task.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 resolved=${grade.resolved}`
                );
                resolveRun({
                    taskId: task.id,
                    arm,
                    workDir,
                    transcriptPath: targetJsonl,
                    parsed,
                    grade,
                    code,
                });
            });
        });
    });
}

async function runWave(jobs, maxParallel) {
    const results = [];
    let idx = 0;
    const workers = Array.from({ length: Math.min(maxParallel, jobs.length) }, async () => {
        while (idx < jobs.length) {
            const job = jobs[idx++];
            results.push(await job());
        }
    });
    await Promise.all(workers);
    return results;
}

async function shutdownBenchDaemon(sockPath) {
    await new Promise((resolveDone) => {
        if (!existsSync(sockPath)) {
            resolveDone();
            return;
        }
        const sock = createConnection(sockPath);
        const timer = setTimeout(() => {
            sock.destroy();
            resolveDone();
        }, 200);
        sock.on("connect", () => {
            sock.write(`${JSON.stringify({ id: 1, type: "shutdown" })}\n`);
            clearTimeout(timer);
            sock.end();
            resolveDone();
        });
        sock.on("error", () => {
            clearTimeout(timer);
            resolveDone();
        });
    });
    rmSync(sockPath, { force: true });
}

async function main() {
    trailSkillBody = armsToRun.includes("trail") ? await getTrailSkillBody() : "";
    initRuntimeFiles();

    const selectedTasks = taskFilterSet ? LARGE_TASKS.filter((t) => taskFilterSet.has(t.id)) : LARGE_TASKS;
    const regradeOnly = process.argv.includes("--regrade");
    console.log(
        `${regradeOnly ? "Regrading" : "Starting"} Large-Repo Suite L1–L8 (${modelArg}) benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
    );

    let runs = [];
    if (regradeOnly) {
        for (const t of selectedTasks) {
            for (const arm of armsToRun) {
                const workDir = `/tmp/plexer-large-${modelArg}-${arm}/${t.id}`;
                const outJsonl = join(logDir, `${t.id}-${arm}.jsonl`);
                if (!existsSync(outJsonl) || !existsSync(workDir)) continue;
                const parsed = parseTranscript(outJsonl, arm);
                const grade = gradeLargeTask(t, workDir, parsed);
                console.log(
                    `[${modelArg}] ${t.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 resolved=${grade.resolved}`
                );
                runs.push({ taskId: t.id, arm, workDir, transcriptPath: outJsonl, parsed, grade, code: 0 });
            }
        }
    } else {
        for (const t of selectedTasks) {
            await ensureBaseLargeRepo(t, REINDEX);
        }

        const jobs = [];
        for (const t of selectedTasks) {
            for (const arm of armsToRun) {
                jobs.push(() => runOne(t, arm));
            }
        }

        try {
            runs = (await runWave(jobs, concurrency)).filter((r) => {
                if (r.code !== 0 || r.parsed.cumulativeInputTokens === 0) {
                    console.error(`[${modelArg}] SKIPPING failed/empty run ${r.taskId} (${r.arm}) exit=${r.code} cumIn=${r.parsed.cumulativeInputTokens}`);
                    return false;
                }
                return true;
            });
        } finally {
            if (isAgy)
                await shutdownBenchDaemon(benchDaemonSock);
        }
        if (runs.length === 0) {
            console.error(`[${modelArg}] All runs failed or returned 0 tokens; preserving existing results.`);
            process.exit(1);
        }
    }

    const resultsPath = resolve(import.meta.dirname, `results-large-${modelArg}.json`);
    const prev = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : { tasks: [] };
    const byId = new Map((prev.tasks || []).map((t) => [t.id, t]));

    for (const t of LARGE_TASKS) {
        const existing = byId.get(t.id) || {
            id: t.id,
            title: t.title,
            category: t.category,
            repo: t.repo,
            language: t.language,
            sizeBucket: t.sizeBucket,
            fileCount: t.repoFiles,
            gold_files: t.goldFiles,
        };
        for (const r of runs.filter((x) => x.taskId === t.id)) {
            existing[r.arm] = {
                conversationId: r.parsed.conversationId,
                calls: r.parsed.calls,
                turns: r.parsed.turns,
                toolNames: r.parsed.toolNames,
                toolOutputTokens: r.parsed.toolOutputTokens,
                uncachedInputTokens: r.parsed.uncachedInputTokens,
                cachedInputTokens: r.parsed.cachedInputTokens,
                cumulativeInputTokens: r.parsed.cumulativeInputTokens,
                turn1ContextTokens: r.parsed.turn1ContextTokens || 0,
                turn1UncachedTokens: r.parsed.turn1UncachedTokens || 0,
                postTurn1UncachedTokens: r.parsed.postTurn1UncachedTokens || 0,
                netContextGrowthTokens: r.parsed.netContextGrowthTokens || 0,
                cacheMissTurns: r.parsed.cacheMissTurns || 0,
                finalContextTokens: r.parsed.finalContextTokens,
                totalModelOutputTokens: r.parsed.totalModelOutputTokens,
                searchMs: r.parsed.searchMs,
                totalMs: r.parsed.totalMs,
                ...r.grade,
            };
        }
        if (existing.cold || existing.plexer || existing.trail) {
            byId.set(t.id, existing);
        }
    }

    const taskRows = [...byId.values()].filter((r) => r.cold && r.plexer);
    const emptyArmTotals = () => ({
        calls: 0,
        turns: 0,
        toolOutputTokens: 0,
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cumulativeInputTokens: 0,
        turn1ContextTokens: 0,
        turn1UncachedTokens: 0,
        postTurn1UncachedTokens: 0,
        netContextGrowthTokens: 0,
        cacheMissTurns: 0,
        finalContextTokens: 0,
        totalModelOutputTokens: 0,
        searchMs: 0,
        totalMs: 0,
        score: 0,
        maxScore: 0,
        resolvedCount: 0,
        taskCount: 0,
    });
    const hasAnyTrail = taskRows.some((r) => r.trail);
    const totals = taskRows.reduce(
        (acc, r) => {
            for (const arm of ["cold", "plexer", ...(r.trail ? ["trail"] : [])]) {
                acc[arm].calls += r[arm].calls;
                acc[arm].turns += r[arm].turns;
                acc[arm].toolOutputTokens += r[arm].toolOutputTokens;
                acc[arm].uncachedInputTokens += r[arm].uncachedInputTokens;
                acc[arm].cachedInputTokens += r[arm].cachedInputTokens;
                acc[arm].cumulativeInputTokens += r[arm].cumulativeInputTokens;
                acc[arm].turn1ContextTokens += r[arm].turn1ContextTokens || 0;
                acc[arm].turn1UncachedTokens += r[arm].turn1UncachedTokens || 0;
                acc[arm].postTurn1UncachedTokens += r[arm].postTurn1UncachedTokens || 0;
                acc[arm].netContextGrowthTokens += r[arm].netContextGrowthTokens || 0;
                acc[arm].cacheMissTurns += r[arm].cacheMissTurns || 0;
                acc[arm].finalContextTokens += r[arm].finalContextTokens;
                acc[arm].totalModelOutputTokens += r[arm].totalModelOutputTokens;
                acc[arm].searchMs += r[arm].searchMs;
                acc[arm].totalMs += r[arm].totalMs;
                acc[arm].score += r[arm].score;
                acc[arm].maxScore += r[arm].maxScore;
                acc[arm].resolvedCount += r[arm].resolved ? 1 : 0;
                acc[arm].taskCount += 1;
            }
            return acc;
        },
        {
            cold: emptyArmTotals(),
            plexer: emptyArmTotals(),
            ...(hasAnyTrail ? { trail: emptyArmTotals() } : {}),
        }
    );

    writeFileSync(
        resultsPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), model: modelArg, totals, tasks: taskRows }, null, 2)}\n`,
        "utf8"
    );
    console.log(`Saved Large-Repo Suite L1–L8 results to ${resultsPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
