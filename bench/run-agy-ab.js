#!/usr/bin/env node
/**
 * Reproducible A/B runner for Antigravity CLI (`agy`) across all 12 tasks (`T1`–`T12`)
 * in `bench/tasks.js` using `gemini-4-argon-low` (`low` effort) or `gemini-4-argon-medium` (`medium` effort).
 *
 * Enforces strict symmetry:
 *  - Clean isolated worktrees (`/tmp/plexer-ab-<modelAlias>-{cold,plexer}/<repo>`)
 *  - Identical custom agent definition (`bench-cold` vs `bench-plexer`) with
 *    `inheritCustomizations: false`, `inheritMcp: false`, and identical tool permissions
 *  - `--disable-slash-commands`, `--dangerously-skip-permissions`, `PLEXER_DISABLE_HOOKS=1`
 *  - Runs read-only tasks (`T1`–`T8`) before code-edit tasks (`T9`–`T12`).
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.js";
import { gradeManifest } from "./grade.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";

const modelAlias = process.argv[2] || "argon-low"; // "argon-low" | "argon-medium"
const concurrency = Number(process.argv[3] || 4);
const armFilter = process.argv[4] || "both"; // "both" | "cold" | "plexer"
const taskFilterArg = process.argv[5] || "all";
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun = armFilter === "cold" ? ["cold"] : armFilter === "plexer" ? ["plexer"] : ["cold", "plexer"];

const MODEL_MAP = {
    "argon-low": { model: "gemini-4-argon-low", effort: "low" },
    "argon-medium": { model: "gemini-4-argon-medium", effort: "medium" },
    "argon-high": { model: "gemini-4-argon-high", effort: "high" },
};
const modelCfg = MODEL_MAP[modelAlias] || { model: modelAlias, effort: process.argv[6] || "medium" };

const logDir = `/tmp/plexer-agy-logs/${modelAlias}`;
mkdirSync(logDir, { recursive: true });

const basePrompt = [
    "You are an expert software engineer solving a repository diagnosis, refactoring blast-radius, or code-editing task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "Be concise, accurate, and cite exact `file:Lx-Ly` line spans as requested.",
    "When running shell commands with `run_command`, always set `WaitMsBeforeAsync: 10000` so commands complete synchronously.",
].join("\n");

const skillMdRaw = readFileSync(resolve(import.meta.dirname, "../SKILL.md"), "utf8");
const skillBody = skillMdRaw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

function makeAgentMd(name, desc, body, hooksPath = null) {
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
        "",
    ].join("\n");
}

const coldAgentMd = makeAgentMd(
    "bench-cold",
    "Cold baseline software engineering agent for A/B benchmarking (no plexer skill).",
    basePrompt
);

const plexerBin = resolve(import.meta.dirname, "../bin/plexer.js");
const agyHooksJson = JSON.stringify(
    {
        "plexer-hooks": {
            PreInvocation: [
                {
                    type: "command",
                    command: `${process.execPath} ${JSON.stringify(plexerBin)} _hook agy-pre-invocation`,
                    timeout: 15,
                },
            ],
            PostToolUse: [
                {
                    matcher: "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file",
                    hooks: [
                        {
                            type: "command",
                            command: `${process.execPath} ${JSON.stringify(plexerBin)} _hook agy-post-edit`,
                            timeout: 10,
                        },
                    ],
                },
            ],
        },
    },
    null,
    2
);

function ensureWorktree(repo, arm) {
    const parentDir = `/tmp/plexer-ab-${modelAlias}-${arm}`;
    const cloneDir = join(parentDir, repo);
    const baseSource = arm === "plexer" ? `/tmp/plexer-ab-base/indexed/${repo}` : `/tmp/plexer-ab-base/clean/${repo}`;
    if (!existsSync(cloneDir)) {
        mkdirSync(parentDir, { recursive: true });
        cpSync(baseSource, cloneDir, { recursive: true });
    }
    const excludePath = join(cloneDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes(".agents")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\n`, "utf8");
        }
    }
    const agentsDir = join(cloneDir, ".agents", "agents");
    mkdirSync(agentsDir, { recursive: true });
    const hooksPath = join(cloneDir, ".agents", "hooks.json");
    writeFileSync(join(agentsDir, "bench-cold.md"), coldAgentMd, "utf8");
    writeFileSync(
        join(agentsDir, "bench-plexer.md"),
        makeAgentMd(
            "bench-plexer",
            "Plexer-equipped software engineering agent for A/B benchmarking (with plexer skill).",
            `${basePrompt}\n\n${skillBody}`,
            hooksPath
        ),
        "utf8"
    );
    if (arm === "plexer") {
        writeFileSync(hooksPath, `${agyHooksJson}\n`, "utf8");
    } else if (existsSync(hooksPath)) {
        rmSync(hooksPath, { force: true });
    }
    return cloneDir;
}

async function resetWorktree(repo, arm) {
    let cloneDir = ensureWorktree(repo, arm);
    const baseCleanDir = `/tmp/plexer-ab-base/clean/${repo}`;
    if (existsSync(baseCleanDir)) {
        const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: baseCleanDir, encoding: "utf8" }).trim();
        try {
            execFileSync("git", ["reset", "--hard", baseSha], { cwd: cloneDir, stdio: "ignore" });
        } catch {
            rmSync(cloneDir, { recursive: true, force: true });
            cloneDir = ensureWorktree(repo, arm);
        }
    }
    execFileSync("git", ["checkout", "--", "."], { cwd: cloneDir, stdio: "ignore" });
    execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents"], { cwd: cloneDir, stdio: "ignore" });
    if (arm === "plexer") {
        await ensureFreshGraph(cloneDir);
    } else if (existsSync(join(cloneDir, "plexer"))) {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
    }
    return cloneDir;
}

async function runOne(task, arm) {
    const cloneDir = ensureWorktree(task.repo, arm);
    if (task.category === "code-edit") {
        await resetWorktree(task.repo, arm);
    }
    return new Promise((resolveRun, rejectRun) => {
        const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
        const agentName = arm === "plexer" ? "bench-plexer" : "bench-cold";
        const promptText = task.prompt(cloneDir);

        const args = [
            "-p",
            promptText,
            "--agent",
            agentName,
            "--model",
            modelCfg.model,
            "--effort",
            modelCfg.effort,
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
            "--disable-slash-commands",
        ];

        const outStream = createWriteStream(outJsonl, { flags: "w" });
        const child = spawn("agy", args, {
            cwd: cloneDir,
            env: {
                ...process.env,
                PLEXER_DISABLE_HOOKS: arm === "plexer" ? "0" : "1",
                ...(arm === "plexer" ? { PLEXER_ENABLE_BENCH_HOOKS: "1" } : {}),
            },
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
                console.log(`[${modelAlias}] finished ${task.id} (${arm}) exit=${code}`);
                if (code !== 0) {
                    console.error(`[${modelAlias}] ${task.id} (${arm}) stderr: ${stderr.slice(0, 300)}`);
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

const selectedTasks = taskFilterSet ? TASKS.filter((t) => taskFilterSet.has(t.id)) : TASKS;
const readOnlyTasks = selectedTasks.filter((t) => t.category !== "code-edit");
const editTasks = selectedTasks.filter((t) => t.category === "code-edit");

console.log(
    `Starting Antigravity (${modelAlias}: ${modelCfg.model} @ effort=${modelCfg.effort}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
);

const allRepos = new Set(selectedTasks.map((t) => t.repo));
for (const repo of allRepos) {
    for (const arm of armsToRun) {
        await resetWorktree(repo, arm);
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

const allRuns = [
    ...(await runWave(readOnlyJobs, concurrency)),
    ...(await runWave(editJobs, concurrency)),
];

const manifestPath = resolve(import.meta.dirname, `manifest-${modelAlias}.json`);
const resultsPath = resolve(import.meta.dirname, `results-${modelAlias}.json`);
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
for (const t of TASKS) {
    manifest[t.id] = manifest[t.id] || {};
}
for (const r of allRuns) {
    manifest[r.taskId][r.arm] = {
        conversationId: r.transcriptPath,
        cloneDir: r.cloneDir,
    };
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
gradeManifest(
    manifestPath,
    resultsPath,
    new Set(allRuns.map((r) => `${r.taskId}:${r.arm}`))
);
