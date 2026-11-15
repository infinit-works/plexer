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
 * Supports model configurations across Antigravity (`agy`) and Claude Code (`claude`):
 *  - `carbon-low` / `carbon-medium` / `carbon-high` (`agy --model gemini-4-carbon-{low,medium,high}`)
 *  - `argon-low` (`agy --model gemini-4-argon-low --effort low`)
 *  - `argon-medium` (`agy --model gemini-4-argon-medium --effort medium`)
 *  - `sonnet` (`claude --model sonnet --effort medium`)
 *  - `opus` (`claude --model opus --effort medium`)
 *
 * Usage:
 *   node bench/run-swebench-ab.js <model> [concurrency=4] [arm=both] [taskFilter=all]
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseTranscript } from "./grade.js";
import { buildGraph } from "../src/graph/build.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import {
    buildTrailAgyHooksJson,
    buildTrailClaudeSettingsJson,
    buildTrailMcpConfigJson,
    getTrailEnv,
    getTrailSkillBody,
    prepareTrailWorktreeDir,
} from "./trail-live-helper.js";

const SWEBENCH_TASKS = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "swebench/tasks.json"), "utf8")
);

const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const rawModelArg = positionals[0] || "sonnet"; // "carbon-medium" | "argon-low" | "argon-medium" | "flash-medium" | "sonnet" | "opus"
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
const armFilter = positionals[2] || "both";
const taskFilterArg = positionals[3] || "all";
const REINDEX = process.argv.includes("--reindex");
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
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
const logDir = process.env.PLEXER_BENCH_LOG_DIR
    ? resolve(process.env.PLEXER_BENCH_LOG_DIR)
    : `/tmp/plexer-swebench-logs/${modelArg}`;
const benchDaemonSock = `/tmp/plexer-swe-bench-${process.pid}.sock`;

const basePrompt = [
    "You are an expert software engineer solving a multi-file repository engineering task.",
    "Work strictly inside the repository directory specified in the prompt.",
    "Implement the requested changes directly in the repository files.",
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
    "Cold baseline software engineering agent for SWE-bench Pro A/B benchmarking.",
    `${basePrompt}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` or \`trail\` commands; use standard repository tools only.`
);

/**
 * Ensure a clean base checkout and a plexer-indexed base checkout exist for `task`.
 */
async function ensureBaseTaskRepo(task, forceReindex = false) {
    const repoCacheSlug = task.repo.replace("/", "__");
    const bareMirror = join(BASE_CACHE_DIR, "mirrors", `${repoCacheSlug}.git`);
    const cleanDir = join(BASE_CACHE_DIR, "clean", task.id);
    const indexedDir = join(BASE_CACHE_DIR, "indexed", task.id);

    if (!existsSync(cleanDir) && !(forceReindex && existsSync(indexedDir))) {
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

    if (forceReindex || !existsSync(indexedDir)) {
        if (existsSync(cleanDir)) {
            rmSync(indexedDir, { recursive: true, force: true });
            mkdirSync(join(BASE_CACHE_DIR, "indexed"), { recursive: true });
            cpSync(cleanDir, indexedDir, { recursive: true });
        } else {
            rmSync(join(indexedDir, "plexer"), { recursive: true, force: true });
        }
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
        execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents", "-e", "graft", "-e", ".trail"], { cwd: workDir, stdio: "ignore" });
        if (arm === "plexer") {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
            cpSync(join(indexedDir, "plexer"), join(workDir, "plexer"), { recursive: true });
        } else if (existsSync(join(workDir, "plexer"))) {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        }
    }
    if (arm === "trail") {
        rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        prepareTrailWorktreeDir(workDir, task.id, cleanDir);
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
                "Plexer-equipped software engineering agent for SWE-bench Pro A/B benchmarking.",
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
                    "Trail-equipped software engineering agent for SWE-bench Pro A/B benchmarking.",
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
    const headerSyms = new Set();
    const addedSyms = new Set();
    const lines = patchText.split("\n");
    for (const line of lines) {
        const hh = line.match(/^@@[^@]+@@\s*(.+)$/);
        if (hh) {
            const m = hh[1].match(/(?:function|def|func|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (m) headerSyms.add(m[1]);
        }
        if (/^\+/.test(line) && !/^\+{3}/.test(line)) {
            const m = line.match(/(?:function\s+|def\s+|func\s+(?:\([^)]+\)\s*)?|export\s+(?:async\s+)?function\s+|\.\s*)([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
            if (m && m[1].length > 2) addedSyms.add(m[1]);
        }
    }
    return { all: [...new Set([...headerSyms, ...addedSyms])], headerSyms };
}

/**
 * Grade an agent's working tree diff against:
 *  1. Gold modified files (recall & precision)
 *  2. Gold modified symbols / hunks
 *  3. Official Docker container verifier (`ghcr.io/scaleapi/swe-bench_pro-v2:<instance_id>`) when Docker image is available or `--docker` is enabled.
 */
function resolveModifiedContentsFromPatch(matchedFiles, relevantAgentPatch, opts = {}) {
    if (typeof opts.modifiedContents === "string")
        return opts.modifiedContents;
    if (opts.workDir && existsSync(opts.workDir)) {
        return matchedFiles
            .filter((f) => existsSync(join(opts.workDir, f)))
            .map((f) => readFileSync(join(opts.workDir, f), "utf8"))
            .join("\n");
    }
    if (opts.baseDir && existsSync(opts.baseDir) && relevantAgentPatch.trim().length > 0) {
        const scratch = mkdtempSync(join(tmpdir(), "plexer-regrade-"));
        try {
            const copied = [];
            for (const rel of matchedFiles) {
                const src = join(opts.baseDir, rel);
                if (!existsSync(src)) continue;
                const dst = join(scratch, rel);
                mkdirSync(dirname(dst), { recursive: true });
                cpSync(src, dst);
                copied.push(rel);
            }
            if (copied.length > 0) {
                execFileSync("git", ["apply", "-p0", "--whitespace=nowarn", "-"], {
                    cwd: scratch,
                    input: relevantAgentPatch,
                    stdio: ["pipe", "ignore", "pipe"],
                });
                return copied.map((rel) => readFileSync(join(scratch, rel), "utf8")).join("\n");
            }
        } catch {
            // Fall back to hunk context/added lines if clean base snapshot is absent or patch doesn't apply cleanly.
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }
    const lines = [];
    for (const line of relevantAgentPatch.split("\n")) {
        const hh = line.match(/^@@[^@]+@@\s*(.+)$/);
        if (hh) {
            lines.push(hh[1]);
        } else if ((line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" ")) {
            lines.push(line.slice(1));
        }
    }
    return lines.join("\n");
}

export function gradeSwePatch(task, agentPatch = "", opts = {}) {
    const parsed = opts.parsed || {};
    const useDocker = Boolean(opts.useDocker);
    const modifiedFiles = [...agentPatch.matchAll(/^diff --git (\S+) (\S+)/gm)]
        .map((m) => m[2].replace(/^[abciw]\//, ""))
        .filter(
            (f) =>
                f !== ".gitignore" &&
                !f.startsWith("graft/") &&
                !f.startsWith(".trail/") &&
                !f.startsWith(".agents/") &&
                f !== "app-android/app/src/main/assets/tutanota" &&
                f !== "app-ios/tutanota/tutanota-web" &&
                f !== "fdroid-metadata-workaround"
        );
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
    const modifiedSourceFiles = modifiedFiles.filter((f) => !f.startsWith("test/") && !f.startsWith("tests/"));
    const fileRecall = goldSourceFiles.length > 0 ? matchedFiles.length / goldSourceFiles.length : 1;
    const filePrecision = modifiedSourceFiles.length > 0 ? matchedFiles.length / modifiedSourceFiles.length : 0;

    // Filter task.patch and agentPatch to hunks belonging to goldSourceFiles so unrelated files don't skew symbol/token recall
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
    const relevantAgentPatch =
        agentPatch
            .split(/(?=^diff --git )/m)
            .filter((sec) => {
                const m = sec.match(/^diff --git \S+ (\S+)/);
                if (!m) return false;
                const f = m[1].replace(/^[abciw]\//, "");
                return goldSet.has(f);
            })
            .join("\n");
    const modifiedContents = resolveModifiedContentsFromPatch(matchedFiles, relevantAgentPatch, opts);

    const { all: goldSyms, headerSyms } = extractPatchSymbols(relevantPatch);
    const matchedSyms = goldSyms.filter(
        (s) => relevantAgentPatch.includes(s) || (headerSyms.has(s) && modifiedContents.includes(s))
    );
    const symRecall = goldSyms.length > 0 ? matchedSyms.length / goldSyms.length : 1;

    // Deterministic requirement checks on the generated patch (0..8 rubric scale matching T1..T12)
    const removedTokens = new Set();
    const goldAddedTokens = new Set();
    for (const line of relevantPatch.split("\n")) {
        if (line.startsWith("-") && !line.startsWith("---")) {
            for (const tok of line.slice(1).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []) {
                removedTokens.add(tok);
            }
        }
        if (line.startsWith("+") && !line.startsWith("+++")) {
            const raw = line.slice(1);
            if (/^\s*(\/\/|\/\*|\*|\*\/|#|--)/.test(raw)) continue;
            const codeOnly = raw
                .replace(/\/\*[\s\S]*?\*\//g, " ")
                .replace(/(^|\s)\/\/.*$/, "$1")
                .replace(/(^|\s)#.*$/, "$1");
            for (const tok of codeOnly.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []) {
                goldAddedTokens.add(tok);
            }
        }
    }
    let matchedAddedTokens = 0;
    for (const tok of goldAddedTokens) {
        if (relevantAgentPatch.includes(tok) || (removedTokens.has(tok) && modifiedContents.includes(tok))) {
            matchedAddedTokens += 1;
        }
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
    //  - 4 pts: file localization recall (strictly floored so missing 1 of 2 sibling files cannot round up)
    //  - 2 pts: symbol / interface recall
    //  - 2 pts: key patch identifier / requirement token recall (or Docker verifier pass)
    const fileScore = Math.floor(fileRecall * 4);
    const symScore = symRecall >= 0.75 ? 2 : symRecall >= 0.4 ? 1 : 0;
    const implScore =
        dockerPassed === true
            ? 2
            : tokenRecall >= 0.7
              ? 2
              : tokenRecall >= 0.45
                ? 1
                : 0;
    const hasEdits = Boolean(parsed.didModifyFile || modifiedFiles.length > 0);
    const score = hasEdits ? fileScore + symScore + implScore : 0;
    const resolved = Boolean(
        hasEdits &&
            fileRecall === 1 &&
            symRecall >= 0.75 &&
            (dockerPassed === true || tokenRecall >= 0.7)
    );

    return {
        score,
        maxScore: 8,
        resolved,
        fileRecall: Number(fileRecall.toFixed(3)),
        filePrecision: Number(filePrecision.toFixed(3)),
        symRecall: Number(symRecall.toFixed(3)),
        tokenRecall: Number(tokenRecall.toFixed(3)),
        modifiedFiles,
        goldSourceFiles,
        patch: agentPatch,
        dockerPassed,
        ...(dockerDetail ? { dockerDetail } : {}),
    };
}

export function gradeSweTask(task, workDir, parsed, useDocker = false) {
    const agentPatch = execFileSync(
        "git",
        ["diff", "--no-prefix", "--ignore-submodules", "HEAD", "--", ".", ":(exclude).gitignore"],
        {
            cwd: workDir,
            encoding: "utf8",
        }
    );
    return gradeSwePatch(task, agentPatch, { workDir, parsed, useDocker });
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
                const grade = gradeSweTask(task, workDir, parsed, process.env.SWEBENCH_DOCKER === "1");
                console.log(
                    `[${modelArg}] ${task.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 fileRecall=${grade.fileRecall}`
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

    const selectedTasks = taskFilterSet ? SWEBENCH_TASKS.filter((t) => taskFilterSet.has(t.id)) : SWEBENCH_TASKS;
    const regradeOnly = process.argv.includes("--regrade");
    console.log(
        `${regradeOnly ? "Regrading" : "Starting"} SWE-bench Pro V2 (${modelArg}) A/B benchmark: ${selectedTasks.length} tasks × [${armsToRun.join(",")}] (concurrency=${concurrency})...`
    );

    const resultsPath = process.env.PLEXER_BENCH_OUT
        ? resolve(process.env.PLEXER_BENCH_OUT)
        : resolve(import.meta.dirname, `results-swebench-${modelArg}.json`);
    const prev = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : { tasks: [] };
    const byId = new Map((prev.tasks || []).map((t) => [t.id, t]));

    let runs = [];
    if (regradeOnly) {
        const regradeArms = positionals.length >= 3
            ? armsToRun
            : ["cold", "plexer", "trail"];
        for (const t of selectedTasks) {
            const prevRow = byId.get(t.id);
            for (const arm of regradeArms) {
                const workDir = `/tmp/plexer-swebench-${modelArg}-${arm}/${t.id}`;
                const outJsonl = join(logDir, `${t.id}-${arm}.jsonl`);
                if (existsSync(outJsonl) && existsSync(workDir)) {
                    const parsed = parseTranscript(outJsonl, arm);
                    const grade = gradeSweTask(t, workDir, parsed, process.env.SWEBENCH_DOCKER === "1");
                    console.log(
                        `[${modelArg}] ${t.id} (${arm}) calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 fileRecall=${grade.fileRecall}`
                    );
                    runs.push({ taskId: t.id, arm, workDir, transcriptPath: outJsonl, parsed, grade, code: 0 });
                    continue;
                }
                const savedArm = prevRow?.[arm];
                if (savedArm && typeof savedArm.patch === "string") {
                    const cleanDir = join(BASE_CACHE_DIR, "clean", t.id);
                    const grade = gradeSwePatch(t, savedArm.patch, {
                        baseDir: existsSync(cleanDir) ? cleanDir : null,
                        parsed: { didModifyFile: Boolean(savedArm.patch.trim() || savedArm.modifiedFiles?.length) },
                        useDocker: false,
                    });
                    console.log(
                        `[${modelArg}] ${t.id} (${arm}) [offline-patch] score=${grade.score}/8 (was ${savedArm.score}/8) resolved=${grade.resolved} fileRecall=${grade.fileRecall}`
                    );
                    runs.push({ taskId: t.id, arm, savedArm, grade, code: 0 });
                }
            }
        }
    } else {
        for (const t of selectedTasks) {
            await ensureBaseTaskRepo(t, REINDEX);
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

    for (const t of SWEBENCH_TASKS) {
        const existing = byId.get(t.id) || {
            id: t.id,
            instance_id: t.instance_id,
            repo: t.repo,
            language: t.repo_language,
            gold_files: t.gold_files,
        };
        for (const r of runs.filter((x) => x.taskId === t.id)) {
            const baseMetrics = r.parsed
                ? {
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
                  }
                : { ...r.savedArm };
            const prevDocker = existing[r.arm]?.dockerPassed;
            const prevDockerDetail = existing[r.arm]?.dockerDetail;
            existing[r.arm] = {
                ...baseMetrics,
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
    console.log(`Saved SWE-bench Pro results to ${resultsPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
