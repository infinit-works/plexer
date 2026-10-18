#!/usr/bin/env node
/**
 * SWE-bench Pro V2 multi-language A/B benchmark runner & official Docker verifier.
 *
 * Evaluates `plexer` vs `cold` (no skill) across 8 multi-file tasks (`S1`–`S8`)
 * from `ScaleAI/SWE-bench_Pro` V2 spanning 4 repositories and 3 languages:
 *  - Python (`qutebrowser/qutebrowser`): `S1`, `S2`
 *  - Go (`flipt-io/flipt`): `S3`, `S4`
 *  - JavaScript (`NodeBB/NodeBB`): `S5`, `S6`
 *  - TypeScript (`tutao/tutanota`): `S7`, `S8`
 *
 * Supports all 4 model configurations:
 *  - `argon-low` (`agy --model gemini-4-argon-low --effort low`)
 *  - `argon-medium` (`agy --model gemini-4-argon-medium --effort medium`)
 *  - `sonnet` (`claude --model sonnet --effort medium`)
 *  - `opus` (`claude --model opus --effort medium`)
 *
 * Usage:
 *   node bench/run-swebench-ab.js <model> [concurrency=4] [arm=both] [taskFilter=all]
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTranscript } from "./grade.js";
import { buildGraph } from "../src/graph/build.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";

const SWEBENCH_TASKS = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "swebench/tasks.json"), "utf8")
);

const rawModelArg = process.argv[2] || "sonnet"; // "argon-low" | "argon-medium" | "sonnet" | "opus"
const CLAUDE_MODELS = {
    sonnet: "claude-sonnet-5-5",
    "sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    "opus-5-5": "claude-opus-5-5",
    "claude-opus-5-5": "claude-opus-5-5",
};
const modelArg = rawModelArg.startsWith("argon")
    ? rawModelArg
    : rawModelArg.replace(/^claude-/, "").replace(/-5-5$/, "");
const resolvedClaudeModel = CLAUDE_MODELS[rawModelArg] || rawModelArg;
const concurrency = Number(process.argv[3] || 4);
const armFilter = process.argv[4] || "both";
const taskFilterArg = process.argv[5] || "all";
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun = armFilter === "cold" ? ["cold"] : armFilter === "plexer" ? ["plexer"] : ["cold", "plexer"];

const isAgy = modelArg.startsWith("argon");
const AGY_MODELS = {
    "argon-low": { model: "gemini-4-argon-low", effort: "low" },
    "argon-medium": { model: "gemini-4-argon-medium", effort: "medium" },
    "argon-high": { model: "gemini-4-argon-high", effort: "high" },
};

const BASE_CACHE_DIR = "/tmp/plexer-swebench-base";
const logDir = `/tmp/plexer-swebench-logs/${modelArg}`;
mkdirSync(logDir, { recursive: true });

const basePrompt = [
    "You are an expert software engineer solving a multi-file repository engineering task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "Implement the requested changes directly in the repository files.",
    "Do NOT run slow full-repository test suites, Docker builds, or package installs — focus on accurate code localization and surgical edits.",
].join("\n");

const skillMdRaw = readFileSync(resolve(import.meta.dirname, "../SKILL.md"), "utf8");
const skillBody = skillMdRaw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

const coldSysFile = join(logDir, "cold-system.txt");
const plexerSysFile = join(logDir, "plexer-system.txt");
writeFileSync(coldSysFile, `${basePrompt}\n`, "utf8");
writeFileSync(plexerSysFile, `${basePrompt}\n\n${skillBody}\n`, "utf8");

const plexerBin = resolve(import.meta.dirname, "../bin/plexer.js");
const plexerHooksSettingsFile = join(logDir, "plexer-hooks-settings.json");
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
                                timeout: 15000,
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
                                timeout: 10000,
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
    "Cold baseline software engineering agent for SWE-bench Pro A/B benchmarking.",
    basePrompt
);

/**
 * Ensure a clean base checkout and a plexer-indexed base checkout exist for `task`.
 */
async function ensureBaseTaskRepo(task) {
    const repoCacheSlug = task.repo.replace("/", "__");
    const bareMirror = join(BASE_CACHE_DIR, "mirrors", `${repoCacheSlug}.git`);
    const cleanDir = join(BASE_CACHE_DIR, "clean", task.id);
    const indexedDir = join(BASE_CACHE_DIR, "indexed", task.id);

    if (!existsSync(cleanDir)) {
        mkdirSync(join(BASE_CACHE_DIR, "mirrors"), { recursive: true });
        mkdirSync(cleanDir, { recursive: true });
        console.log(`[swebench] cloning ${task.repo} @ ${task.base_commit.slice(0, 8)} for ${task.id}...`);
        execFileSync("git", ["init", "-q"], { cwd: cleanDir });
        execFileSync("git", ["remote", "add", "origin", `https://github.com/${task.repo}.git`], { cwd: cleanDir });
        execFileSync("git", ["fetch", "--depth", "1", "origin", task.base_commit], {
            cwd: cleanDir,
            stdio: "inherit",
        });
        execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: cleanDir });
    }

    if (!existsSync(indexedDir)) {
        mkdirSync(join(BASE_CACHE_DIR, "indexed"), { recursive: true });
        cpSync(cleanDir, indexedDir, { recursive: true });
        console.log(`[swebench] building plexer index for ${task.id} (${task.repo})...`);
        await buildGraph(indexedDir, { force: true });
    }

    return { cleanDir, indexedDir };
}

async function prepareWorktree(task, arm) {
    const { cleanDir, indexedDir } = await ensureBaseTaskRepo(task);
    const workDir = `/tmp/plexer-swebench-${modelArg}-${arm}/${task.id}`;
    const srcDir = arm === "plexer" ? indexedDir : cleanDir;
    if (!existsSync(workDir)) {
        mkdirSync(`/tmp/plexer-swebench-${modelArg}-${arm}`, { recursive: true });
        cpSync(srcDir, workDir, { recursive: true });
    } else {
        execFileSync("git", ["reset", "--hard", task.base_commit], { cwd: workDir, stdio: "ignore" });
        execFileSync("git", ["checkout", "--", "."], { cwd: workDir, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents"], { cwd: workDir, stdio: "ignore" });
        if (arm === "plexer") {
            await ensureFreshGraph(workDir);
        } else if (existsSync(join(workDir, "plexer"))) {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        }
    }

    const excludePath = join(workDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes(".agents")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\npLexer/\nplexer/\n`, "utf8");
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
                "Plexer-equipped software engineering agent for SWE-bench Pro A/B benchmarking.",
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
    }

    return workDir;
}

function buildTaskPrompt(task, workDir) {
    const instr = task.instruction_md
        .replace(/\/app\b/g, workDir)
        .replace(/\/testbed\b/g, workDir)
        .trim();
    return [
        `Working directory: ${workDir}`,
        "",
        instr,
        "",
        "Important:",
        `- Edit the source files directly inside \`${workDir}\`.`,
        "- Do NOT run full test suites, package installations, or container builds; stop as soon as you have applied the clean code changes.",
    ].join("\n");
}

function extractPatchSymbols(patchText) {
    const syms = new Set();
    const lines = patchText.split("\n");
    for (const line of lines) {
        const hh = line.match(/^@@[^@]+@@\s*(.+)$/);
        if (hh) {
            const m = hh[1].match(/(?:function|def|func|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (m) syms.add(m[1]);
        }
        if (/^[+-]/.test(line) && !/^[+-]{3}/.test(line)) {
            const m = line.match(/(?:function\s+|def\s+|func\s+(?:\([^)]+\)\s*)?|export\s+(?:async\s+)?function\s+|\.\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
            if (m && m[1].length > 2) syms.add(m[1]);
        }
    }
    return [...syms];
}

/**
 * Grade an agent's working tree diff against:
 *  1. Gold modified files (recall & precision)
 *  2. Gold modified symbols / hunks
 *  3. Official Docker container verifier (`ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>`) when Docker image is available or `--docker` is enabled.
 */
function gradeSweTask(task, workDir, parsed, useDocker = false) {
    const agentPatch = execFileSync(
        "git",
        ["diff", "--no-prefix", "--ignore-submodules", "HEAD", "--", ".", ":(exclude).gitignore"],
        {
            cwd: workDir,
            encoding: "utf8",
        }
    );
    const modifiedFiles = [...agentPatch.matchAll(/^diff --git (\S+) (\S+)/gm)]
        .map((m) => m[2].replace(/^[abciw]\//, ""))
        .filter((f) => f !== ".gitignore");
    const goldOverride = {
        S1: ["qutebrowser/browser/webkit/network/networkreply.py"],
        S4: ["internal/storage/cache/cache.go", "internal/storage/storage.go"],
        S6: ["src/posts/queue.js", "src/topics/merge.js"],
    };
    const goldSourceFiles = (goldOverride[task.id] || task.gold_files).filter(
        (f) => !f.startsWith("changelogs/") && !f.endsWith(".md") && !f.endsWith(".yml")
    );
    const goldSet = new Set(goldSourceFiles);
    const matchedFiles = goldSourceFiles.filter((f) => modifiedFiles.includes(f));
    const fileRecall = goldSourceFiles.length > 0 ? matchedFiles.length / goldSourceFiles.length : 1;
    const filePrecision = modifiedFiles.length > 0 ? matchedFiles.length / modifiedFiles.length : 0;

    // Filter task.patch to hunks belonging to goldSourceFiles so multi-commit PRs with unrelated files don't skew symbol/token recall
    const patchSections = task.patch.split(/(?=^diff --git )/m);
    const relevantPatch =
        patchSections
            .filter((sec) => {
                const m = sec.match(/^diff --git \S+ (\S+)/);
                if (!m) return false;
                const f = m[1].replace(/^[abciw]\//, "");
                return goldSet.has(f);
            })
            .join("\n") || task.patch;

    const goldSyms = extractPatchSymbols(relevantPatch);
    const matchedSyms = goldSyms.filter((s) => agentPatch.includes(s));
    const symRecall = goldSyms.length > 0 ? matchedSyms.length / goldSyms.length : 1;

    // Deterministic requirement checks on the generated patch (0..8 rubric scale matching T1..T12)
    const goldAddedTokens = new Set();
    for (const line of relevantPatch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
            for (const tok of line.slice(1).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []) {
                goldAddedTokens.add(tok);
            }
        }
    }
    let matchedAddedTokens = 0;
    for (const tok of goldAddedTokens) {
        if (agentPatch.includes(tok)) matchedAddedTokens += 1;
    }
    const tokenRecall = goldAddedTokens.size > 0 ? matchedAddedTokens / goldAddedTokens.size : 1;

    let dockerPassed = null;
    let dockerDetail = "";
    if (useDocker && agentPatch.trim().length > 0) {
        try {
            const vDir = join(logDir, `verifier-${task.id}-${Date.now()}`);
            mkdirSync(vDir, { recursive: true });
            writeFileSync(join(vDir, "agent.patch"), agentPatch, "utf8");
            writeFileSync(join(vDir, "test_patch.patch"), task.test_patch, "utf8");
            writeFileSync(join(vDir, "test.sh"), task.verifier.test_sh, { mode: 0o755 });
            writeFileSync(join(vDir, "run_script.sh"), task.verifier.run_script_sh, { mode: 0o755 });
            writeFileSync(join(vDir, "parser.py"), task.verifier.parser_py, "utf8");
            writeFileSync(join(vDir, "config.json"), task.verifier.config_json, "utf8");

            const containerCmd = [
                "cd /app 2>/dev/null || cd /testbed",
                `git reset --hard ${task.base_commit}`,
                "git clean -fd",
                "git apply /tests/agent.patch",
                "bash /tests/test.sh",
            ].join(" && ");

            const out = execFileSync(
                "docker",
                [
                    "run",
                    "--rm",
                    "-v",
                    `${vDir}:/tests`,
                    task.docker_image,
                    "bash",
                    "-c",
                    containerCmd,
                ],
                { encoding: "utf8", timeout: 300000 }
            );
            dockerPassed = out.includes("RESULT: PASSED");
            dockerDetail = out.slice(-400);
        } catch (err) {
            dockerPassed = false;
            dockerDetail = String(err?.stdout || err?.stderr || err?.message || err).slice(-400);
        }
    }

    // Score out of 8:
    //  - 4 pts: file localization recall (proportional to gold source files edited)
    //  - 2 pts: symbol / interface recall
    //  - 2 pts: key patch identifier / requirement token recall (or Docker verifier pass)
    const fileScore = Math.round(fileRecall * 4);
    const symScore = symRecall >= 0.75 ? 2 : symRecall >= 0.4 ? 1 : 0;
    const implScore =
        dockerPassed === true
            ? 2
            : tokenRecall >= 0.7
              ? 2
              : tokenRecall >= 0.45
                ? 1
                : 0;
    const score = (parsed.didModifyFile || modifiedFiles.length > 0) ? fileScore + symScore + implScore : 0;

    return {
        score,
        maxScore: 8,
        fileRecall: Number(fileRecall.toFixed(3)),
        filePrecision: Number(filePrecision.toFixed(3)),
        symRecall: Number(symRecall.toFixed(3)),
        tokenRecall: Number(tokenRecall.toFixed(3)),
        modifiedFiles,
        goldSourceFiles,
        dockerPassed,
        ...(dockerDetail ? { dockerDetail } : {}),
    };
}

async function runOne(task, arm) {
    const workDir = await prepareWorktree(task, arm);
    const outJsonl = join(logDir, `${task.id}-${arm}.jsonl`);
    const promptText = buildTaskPrompt(task, workDir);

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
                arm === "plexer" ? "bench-plexer" : "bench-cold",
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
            args = [
                "--setting-sources",
                "",
                ...(arm === "plexer" ? ["--settings", plexerHooksSettingsFile] : []),
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--dangerously-skip-permissions",
                "--tools",
                "Bash,Read,Edit,Write,Grep,Glob",
                "--append-system-prompt-file",
                arm === "plexer" ? plexerSysFile : coldSysFile,
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

        const outStream = createWriteStream(outJsonl, { flags: "w" });
        const child = spawn(cmd, args, {
            cwd: workDir,
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
                const parsed = parseTranscript(outJsonl, arm);
                const grade = gradeSweTask(task, workDir, parsed, process.env.SWEBENCH_DOCKER === "1");
                console.log(
                    `[${modelArg}] ${task.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 fileRecall=${grade.fileRecall}`
                );
                resolveRun({
                    taskId: task.id,
                    arm,
                    workDir,
                    transcriptPath: outJsonl,
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

const selectedTasks = taskFilterSet ? SWEBENCH_TASKS.filter((t) => taskFilterSet.has(t.id)) : SWEBENCH_TASKS;
const regradeOnly = process.argv.includes("--regrade");
console.log(
    `${regradeOnly ? "Regrading" : "Starting"} SWE-bench Pro V2 (${modelArg}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
);

let runs = [];
if (regradeOnly) {
    for (const t of selectedTasks) {
        for (const arm of armsToRun) {
            const workDir = `/tmp/plexer-swebench-${modelArg}-${arm}/${t.id}`;
            const outJsonl = join(logDir, `${t.id}-${arm}.jsonl`);
            if (!existsSync(outJsonl) || !existsSync(workDir)) continue;
            const parsed = parseTranscript(outJsonl, arm);
            const grade = gradeSweTask(t, workDir, parsed, process.env.SWEBENCH_DOCKER === "1");
            console.log(
                `[${modelArg}] ${t.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 fileRecall=${grade.fileRecall}`
            );
            runs.push({ taskId: t.id, arm, workDir, transcriptPath: outJsonl, parsed, grade, code: 0 });
        }
    }
} else {
    for (const t of selectedTasks) {
        await ensureBaseTaskRepo(t);
    }

    const jobs = [];
    for (const t of selectedTasks) {
        for (const arm of armsToRun) {
            jobs.push(() => runOne(t, arm));
        }
    }

    runs = await runWave(jobs, concurrency);
}

const resultsPath = resolve(import.meta.dirname, `results-swebench-${modelArg}.json`);
const prev = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : { tasks: [] };
const byId = new Map((prev.tasks || []).map((t) => [t.id, t]));

for (const t of SWEBENCH_TASKS) {
    const existing = byId.get(t.id) || {
        id: t.id,
        instance_id: t.instance_id,
        repo: t.repo,
        language: t.repo_language,
        gold_files: t.gold_files,
    };
    for (const r of runs.filter((x) => x.taskId === t.id)) {
        const prevDocker = existing[r.arm]?.dockerPassed;
        const prevDockerDetail = existing[r.arm]?.dockerDetail;
        existing[r.arm] = {
            conversationId: r.parsed.conversationId,
            calls: r.parsed.calls,
            turns: r.parsed.turns,
            toolOutputTokens: r.parsed.toolOutputTokens,
            uncachedInputTokens: r.parsed.uncachedInputTokens,
            cachedInputTokens: r.parsed.cachedInputTokens,
            cumulativeInputTokens: r.parsed.cumulativeInputTokens,
            finalContextTokens: r.parsed.finalContextTokens,
            totalModelOutputTokens: r.parsed.totalModelOutputTokens,
            searchMs: r.parsed.searchMs,
            totalMs: r.parsed.totalMs,
            ...r.grade,
            ...(r.grade.dockerPassed === null && prevDocker !== undefined && prevDocker !== null
                ? { dockerPassed: prevDocker, ...(prevDockerDetail ? { dockerDetail: prevDockerDetail } : {}) }
                : {}),
        };
    }
    if (existing.cold || existing.plexer) {
        byId.set(t.id, existing);
    }
}

const taskRows = [...byId.values()].filter((r) => r.cold && r.plexer);
const totals = taskRows.reduce(
    (acc, r) => {
        for (const arm of ["cold", "plexer"]) {
            acc[arm].calls += r[arm].calls;
            acc[arm].turns += r[arm].turns;
            acc[arm].toolOutputTokens += r[arm].toolOutputTokens;
            acc[arm].uncachedInputTokens += r[arm].uncachedInputTokens;
            acc[arm].cachedInputTokens += r[arm].cachedInputTokens;
            acc[arm].cumulativeInputTokens += r[arm].cumulativeInputTokens;
            acc[arm].finalContextTokens += r[arm].finalContextTokens;
            acc[arm].totalModelOutputTokens += r[arm].totalModelOutputTokens;
            acc[arm].searchMs += r[arm].searchMs;
            acc[arm].totalMs += r[arm].totalMs;
            acc[arm].score += r[arm].score;
            acc[arm].maxScore += r[arm].maxScore;
        }
        return acc;
    },
    {
        cold: {
            calls: 0,
            turns: 0,
            toolOutputTokens: 0,
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cumulativeInputTokens: 0,
            finalContextTokens: 0,
            totalModelOutputTokens: 0,
            searchMs: 0,
            totalMs: 0,
            score: 0,
            maxScore: 0,
        },
        plexer: {
            calls: 0,
            turns: 0,
            toolOutputTokens: 0,
            uncachedInputTokens: 0,
            cachedInputTokens: 0,
            cumulativeInputTokens: 0,
            finalContextTokens: 0,
            totalModelOutputTokens: 0,
            searchMs: 0,
            totalMs: 0,
            score: 0,
            maxScore: 0,
        },
    }
);

writeFileSync(
    resultsPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), model: modelArg, totals, tasks: taskRows }, null, 2)}\n`,
    "utf8"
);
console.log(`Saved SWE-bench Pro results to ${resultsPath}`);
