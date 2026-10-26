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
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TASKS } from "./tasks.js";
import { gradeManifest, parseTranscript } from "./grade.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { ensureAbBaseRepos } from "./ensure-base.js";
import {
    buildTrailAgyHooksJson,
    getTrailEnv,
    getTrailSkillBody,
    prepareTrailWorktreeDir,
} from "./trail-live-helper.js";

const modelAlias = process.argv[2] || "argon-low"; // "argon-low" | "argon-medium" | "flash-medium"
const concurrency = Number(process.argv[3] || 4);
const armFilter = process.argv[4] || "both"; // "both" | "all" | "cold" | "plexer" | "trail" | comma-separated
const taskFilterArg = process.argv[5] || "all";
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both"
        ? ["cold", "plexer"]
        : armFilter === "all"
          ? ["cold", "plexer", "trail"]
          : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

const MODEL_MAP = {
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
const trailSkillBody = armsToRun.includes("trail") ? await getTrailSkillBody() : "";

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
    `${basePrompt}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` or \`trail\` commands; use standard repository tools only.`
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
const trailAgyHooksJson = buildTrailAgyHooksJson();

function ensureWorktree(repo, arm) {
    const parentDir = `/tmp/plexer-ab-${modelAlias}-${arm}`;
    const cloneDir = join(parentDir, repo);
    const baseCleanDir = `/tmp/plexer-ab-base/clean/${repo}`;
    const baseSource = arm === "plexer" ? `/tmp/plexer-ab-base/indexed/${repo}` : baseCleanDir;
    if (!existsSync(cloneDir)) {
        mkdirSync(parentDir, { recursive: true });
        cpSync(baseSource, cloneDir, { recursive: true });
    }
    const excludePath = join(cloneDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes(".agents")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\ngraft/\n.trail/\n`, "utf8");
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
    if (trailSkillBody) {
        writeFileSync(
            join(agentsDir, "bench-trail.md"),
            makeAgentMd(
                "bench-trail",
                "Trail-equipped software engineering agent for A/B benchmarking (with trail skill).",
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
    execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents", "-e", "graft", "-e", ".trail"], { cwd: cloneDir, stdio: "ignore" });
    if (arm === "plexer") {
        if (existsSync(`/tmp/plexer-ab-base/indexed/${repo}/plexer`)) {
            rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
            cpSync(`/tmp/plexer-ab-base/indexed/${repo}/plexer`, join(cloneDir, "plexer"), { recursive: true });
        } else {
            await ensureFreshGraph(cloneDir);
        }
    } else if (arm === "trail") {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
        prepareTrailWorktreeDir(cloneDir, repo, baseCleanDir);
    } else if (existsSync(join(cloneDir, "plexer"))) {
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
    }
    return cloneDir;
}

const repoLocks = new Map();
async function withRepoLock(key, fn) {
    const prev = repoLocks.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((r) => {
        release = r;
    });
    repoLocks.set(key, prev.then(() => next));
    await prev;
    try {
        return await fn();
    } finally {
        release();
    }
}

async function runOne(task, arm) {
    return withRepoLock(`${task.repo}:${arm}`, async () => {
    const cloneDir = ensureWorktree(task.repo, arm);
    if (task.category === "code-edit") {
        await resetWorktree(task.repo, arm);
    }
    return new Promise((resolveRun, rejectRun) => {
        const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
        const tmpJsonl = `${outJsonl}.tmp`;
        const agentName = arm === "plexer" ? "bench-plexer" : arm === "trail" ? "bench-trail" : "bench-cold";
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

        const outStream = createWriteStream(tmpJsonl, { flags: "w" });
        const env =
            arm === "trail"
                ? getTrailEnv()
                : {
                      ...process.env,
                      PLEXER_ENABLE_BENCH_HOOKS: arm === "plexer" ? "1" : "0",
                      GIT_CONFIG_COUNT: "2",
                      GIT_CONFIG_KEY_0: "commit.gpgsign",
                      GIT_CONFIG_VALUE_0: "false",
                      GIT_CONFIG_KEY_1: "tag.gpgsign",
                      GIT_CONFIG_VALUE_1: "false",
                  };
        delete env.PLEXER_DISABLE_HOOKS;
        delete env.PLEXER_DIR;
        const child = spawn("agy", args, {
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
                console.log(`[${modelAlias}] finished ${task.id} (${arm}) exit=${code}`);
                if (code === 0) {
                    renameSync(tmpJsonl, outJsonl);
                } else {
                    console.error(`[${modelAlias}] ${task.id} (${arm}) stderr: ${stderr.slice(0, 300)}`);
                }
                resolveRun({ taskId: task.id, arm, cloneDir, transcriptPath: code === 0 ? outJsonl : tmpJsonl, code });
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

const selectedTasks = taskFilterSet ? TASKS.filter((t) => taskFilterSet.has(t.id)) : TASKS;
const readOnlyTasks = selectedTasks.filter((t) => t.category !== "code-edit");
const editTasks = selectedTasks.filter((t) => t.category === "code-edit");

console.log(
    `Starting Antigravity (${modelAlias}: ${modelCfg.model} @ effort=${modelCfg.effort}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
);

const allRepos = new Set(selectedTasks.map((t) => t.repo));
await ensureAbBaseRepos(allRepos);
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
const validRuns = allRuns.filter((r) => {
    try {
        const p = parseTranscript(r.transcriptPath);
        if (r.code !== 0 || p.cumulativeInputTokens === 0) {
            console.error(`[${modelAlias}] SKIPPING failed/empty run ${r.taskId} (${r.arm}) exit=${r.code} cumIn=${p.cumulativeInputTokens}`);
            return false;
        }
        return true;
    } catch (err) {
        console.error(`[${modelAlias}] SKIPPING unreadable run ${r.taskId} (${r.arm}): ${err?.message || err}`);
        return false;
    }
});
if (validRuns.length === 0) {
    console.error(`[${modelAlias}] All runs failed or returned 0 tokens; preserving existing ${manifestPath} and ${resultsPath}.`);
    process.exit(1);
}
for (const r of validRuns) {
    manifest[r.taskId][r.arm] = {
        conversationId: r.transcriptPath,
        cloneDir: r.cloneDir,
    };
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
gradeManifest(
    manifestPath,
    resultsPath,
    new Set(validRuns.map((r) => `${r.taskId}:${r.arm}`))
);
