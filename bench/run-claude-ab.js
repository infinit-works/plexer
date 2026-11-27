#!/usr/bin/env node
/**
 * Reproducible A/B runner for Claude Code (`sonnet` and `opus`) across all 12
 * tasks (`T1`–`T12`) in `bench/tasks.js`.
 *
 * Enforces strict symmetry:
 *  - Clean isolated worktrees (`/tmp/plexer-ab-<model>-{cold,plexer}/<repo>`)
 *  - `--setting-sources ""` + `--disable-slash-commands` + `--strict-mcp-config`
 *    (no user hooks, no global CLAUDE.md, no skills/plugins/MCP servers)
 *  - `--tools "Bash,Read,Edit,Write,Grep,Glob"` (no subagent spawning)
 *  - Identical prompts and flags, differing ONLY by `--append-system-prompt-file`
 *    (base prompt vs base prompt + `SKILL.md`) and presence of `<repo>/plexer/`.
 *  - Runs read-only tasks (`T1`–`T8`) before code-edit tasks (`T9`–`T12`).
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.js";
import { checkWorktreeIsolation, gradeManifest, parseTranscript } from "./grade.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { ensureAbBaseRepos } from "./ensure-base.js";
import { summarizePairedSuite } from "./stats.js";
import {
    buildPlexerClaudeSettingsJson,
    shutdownBenchDaemon,
} from "./agy-bench-helper.js";

const rawArgs = process.argv.slice(2);
const trialsIdx = rawArgs.indexOf("--trials");
const TRIALS = trialsIdx >= 0 && Number(rawArgs[trialsIdx + 1]) > 0 ? Math.floor(Number(rawArgs[trialsIdx + 1])) : 1;
const positionals = [];
for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--trials") {
        i++;
        continue;
    }
    if (!rawArgs[i].startsWith("--")) positionals.push(rawArgs[i]);
}
const rawModelArg = positionals[0] || "sonnet";
const CLAUDE_MODEL_MAP = {
    sonnet: "claude-sonnet-5-5",
    "sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    "opus-5-5": "claude-opus-5-5",
    "claude-opus-5-5": "claude-opus-5-5",
};
const modelArg = rawModelArg.replace(/^claude-/, "").replace(/-5-5$/, "");
const resolvedModelId = CLAUDE_MODEL_MAP[rawModelArg] || rawModelArg;
const concurrency = Number(positionals[1] || 4);
const armFilter = positionals[2] || "both"; // "both" | "all" | "cold" | "plexer" | comma-separated
const taskFilterArg = positionals[3] || "all";
const effortArg = positionals[4] || "medium";
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both" || armFilter === "all"
        ? ["cold", "plexer"]
        : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

const logDir = `/tmp/plexer-claude-logs/${modelArg}`;

const basePrompt = [
    "You are an expert software engineer solving a repository diagnosis, refactoring blast-radius, or code-editing task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "Be concise, accurate, and cite exact `file:Lx-Ly` line spans as requested.",
].join("\n");

const skillMdRaw = readFileSync(resolve(import.meta.dirname, "../SKILL.md"), "utf8");
const skillBody = skillMdRaw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

const coldSysFile = join(logDir, "cold-system.txt");
const plexerSysFile = join(logDir, "plexer-system.txt");

const plexerHookClient = resolve(import.meta.dirname, "../bin/plexer-hook-client.cjs");
const benchDaemonSock = `/tmp/plexer-claude-bench-${process.pid}.sock`;
const plexerHooksSettingsFile = join(logDir, "plexer-hooks-settings.json");
function initRuntimeFiles() {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(coldSysFile, `${basePrompt}\n`, "utf8");
    writeFileSync(plexerSysFile, `${basePrompt}\n\n${skillBody}\n`, "utf8");
    writeFileSync(plexerHooksSettingsFile, buildPlexerClaudeSettingsJson(plexerHookClient), "utf8");
}

function resetRepoWorktree(repo, arm) {
    const cloneDir = `/tmp/plexer-ab-${modelArg}-${arm}/${repo}`;
    const baseCleanDir = `/tmp/plexer-ab-base/clean/${repo}`;
    const baseSource = arm === "plexer" ? `/tmp/plexer-ab-base/indexed/${repo}` : baseCleanDir;
    if (!existsSync(cloneDir)) {
        mkdirSync(`/tmp/plexer-ab-${modelArg}-${arm}`, { recursive: true });
        cpSync(baseSource, cloneDir, { recursive: true });
    }
    if (existsSync(baseCleanDir)) {
        const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseCleanDir, encoding: "utf8" }).trim();
        try {
            execFileSync("git", ["reset", "--hard", baseSha], { cwd: cloneDir, stdio: "ignore" });
        } catch {
            rmSync(cloneDir, { recursive: true, force: true });
            cpSync(baseSource, cloneDir, { recursive: true });
        }
    }
    execFileSync("git", ["checkout", "--", "."], { cwd: cloneDir, stdio: "ignore" });
    execFileSync("git", ["clean", "-fd", "-e", "plexer"], { cwd: cloneDir, stdio: "ignore" });
    if (arm === "plexer" && existsSync(`/tmp/plexer-ab-base/indexed/${repo}/plexer`)) {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
        cpSync(`/tmp/plexer-ab-base/indexed/${repo}/plexer`, join(cloneDir, "plexer"), { recursive: true });
    }
    const cacheDir = join(cloneDir, "plexer", ".cache");
    if (existsSync(cacheDir)) {
        for (const f of readdirSync(cacheDir)) {
            if (f.startsWith("session-")) {
                rmSync(join(cacheDir, f), { force: true });
            }
        }
    }
    return cloneDir;
}

async function runOne(task, arm) {
    const cloneDir = `/tmp/plexer-ab-${modelArg}-${arm}/${task.repo}`;
    if (task.category === "code-edit") {
        resetRepoWorktree(task.repo, arm);
    }
    return new Promise((resolveRun, rejectRun) => {
        const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
        const sysFile = arm === "plexer" ? plexerSysFile : coldSysFile;
        const settingsFile = arm === "plexer" ? plexerHooksSettingsFile : null;
        const promptText = task.prompt(cloneDir);

        const args = [
            "--setting-sources",
            "",
            ...(settingsFile ? ["--settings", settingsFile] : []),
            "--disable-slash-commands",
            "--strict-mcp-config",
            "--dangerously-skip-permissions",
            "--tools",
            "Bash,Read,Edit,Write,Grep,Glob",
            "--append-system-prompt-file",
            sysFile,
            "-p",
            promptText,
            "--model",
            resolvedModelId,
            "--effort",
            effortArg,
            "--output-format",
            "stream-json",
            "--verbose",
        ];

        const outStream = createWriteStream(outJsonl, { flags: "w" });
        const env = {
            ...process.env,
            PLEXER_DAEMON_SOCK: benchDaemonSock,
            PLEXER_DISABLE_HOOKS: arm === "plexer" ? "0" : "1",
            ...(arm === "plexer"
                ? { PLEXER_ENABLE_BENCH_HOOKS: "1" }
                : { PLEXER_ENABLE_BENCH_HOOKS: "0", PLEXER_BENCH_HIDE_CLI: "1" }),
        };
        if (arm === "plexer")
            delete env.PLEXER_BENCH_HIDE_CLI;
        const child = spawn("claude", args, {
            cwd: cloneDir,
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
                console.log(`[${modelArg}] finished ${task.id} (${arm}) exit=${code}`);
                if (code !== 0) {
                    console.error(`[${modelArg}] ${task.id} (${arm}) stderr: ${stderr.slice(0, 300)}`);
                }
                resolveRun({ taskId: task.id, arm, cloneDir, transcriptPath: outJsonl, code });
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

async function main() {
    initRuntimeFiles();

    const selectedTasks = taskFilterSet ? TASKS.filter((t) => taskFilterSet.has(t.id)) : TASKS;
    const readOnlyTasks = selectedTasks.filter((t) => t.category !== "code-edit");
    const editTasks = selectedTasks.filter((t) => t.category === "code-edit");

    console.log(`Starting Claude (${modelArg}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`);

    await ensureAbBaseRepos(new Set(selectedTasks.map((t) => t.repo)));

    if (readOnlyTasks.length > 0) {
        const readOnlyRepos = new Set(readOnlyTasks.map((t) => t.repo));
        for (const repo of readOnlyRepos) {
            for (const arm of armsToRun) {
                resetRepoWorktree(repo, arm);
            }
        }
    }

    const readOnlyJobs = [];
    for (const t of readOnlyTasks) {
        for (const arm of armsToRun) {
            readOnlyJobs.push(() => runOne(t, arm));
        }
    }
    const editJobs = [];
    for (const t of editTasks) {
        for (const arm of armsToRun) {
            editJobs.push(() => runOne(t, arm));
        }
    }

    let allRuns;
    try {
        allRuns = [
            ...(await runWave(readOnlyJobs, concurrency)),
            ...(await runWave(editJobs, concurrency)),
        ];
    } finally {
        await shutdownBenchDaemon(benchDaemonSock);
    }

    const manifestPath = resolve(import.meta.dirname, `manifest-${modelArg}.json`);
    const resultsPath = resolve(import.meta.dirname, `results-${modelArg}.json`);
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
    for (const t of TASKS) {
        manifest[t.id] = manifest[t.id] || {};
    }
    const validRuns = allRuns.filter((r) => {
        const p = parseTranscript(r.transcriptPath);
        if (r.code !== 0 || p.cumulativeInputTokens === 0) {
            console.error(`[${modelArg}] SKIPPING failed/empty run ${r.taskId} (${r.arm}) exit=${r.code} cumIn=${p.cumulativeInputTokens}`);
            return false;
        }
        return true;
    });
    if (validRuns.length === 0) {
        console.error(`[${modelArg}] All runs failed or returned 0 tokens; preserving existing ${manifestPath} and ${resultsPath}.`);
        process.exit(1);
    }
    for (const r of validRuns) {
        manifest[r.taskId][r.arm] = {
            conversationId: r.transcriptPath,
            cloneDir: r.cloneDir,
        };
    }

    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const summary = gradeManifest(
        manifestPath,
        resultsPath,
        new Set(validRuns.map((r) => `${r.taskId}:${r.arm}`)),
        { modelName: resolvedModelId }
    );
    summary.trials = TRIALS;
    summary.unreplicated = TRIALS < 2;
    summary.stats = summarizePairedSuite(summary.tasks || []);
    writeFileSync(resultsPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
