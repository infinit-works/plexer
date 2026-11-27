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
 *  - `neon-low` / `neon-medium` / `neon-high` / `neon-xhigh` (`agy --model gemini-4-neon-{low,medium,high,xhigh}`)
 *  - `carbon-low` / `carbon-medium` / `carbon-high` (`agy --model gemini-4-carbon-{low,medium,high}`)
 *  - `hydrogen-low` / `hydrogen-medium` / `hydrogen-high` / `hydrogen-xhigh` (`agy --model gemini-4-hydrogen-{low,medium,high,xhigh}`)
 *  - `sonnet` (`claude --model sonnet --effort medium`)
 *  - `opus` (`claude --model opus --effort medium`)
 *
 * Usage:
 *   node bench/run-swebench-ab.js <model> [concurrency=4] [arm=both] [taskFilter=all]
 */
import { execFileSync, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { checkWorktreeIsolation, parseTranscript } from "./grade.js";
import { verifySweBenchDocker } from "./verify-exec.js";
import { computeApiCostUsd } from "./cost-model.js";
import { summarizePairedSuite } from "./stats.js";
import { buildGraph } from "../src/graph/build.js";
import { readFingerprint } from "../src/graph/fingerprint.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import {
    attachProcessTimeout,
    BASE_AGY_MODELS,
    buildAgyCliArgs,
    buildPlexerAgyHooksJson,
    buildPlexerClaudeSettingsJson,
    configureAgyWorktreeArm,
    createSterileBenchHome,
    isAgyModelAlias,
    mergeModelBreakdownTotals,
    normalizeAgyModelAlias,
    pickOrchResultMeta,
    resolveAgyModelConfig,
    shutdownBenchDaemon,
} from "./agy-bench-helper.js";

const SWEBENCH_TASKS = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "swebench/tasks.json"), "utf8")
);

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
const rawModelArg = positionals[0] || "sonnet"; // "neon-medium" | "carbon-medium" | "hydrogen-medium" | "orch-neon-high-hydrogen-high" | "orch-neon-xhigh-hydrogen-xhigh" | "sonnet" | "opus"
export const CLAUDE_MODELS = {
    sonnet: "claude-sonnet-5-5",
    "sonnet-5-5": "claude-sonnet-5-5",
    "claude-sonnet-5-5": "claude-sonnet-5-5",
    opus: "claude-opus-5-5",
    "opus-5-5": "claude-opus-5-5",
    "claude-opus-5-5": "claude-opus-5-5",
};
export function normalizeModelArg(raw = "sonnet") {
    return normalizeAgyModelAlias(raw);
}
const modelCfg = resolveAgyModelConfig(rawModelArg, "medium");
const modelArg = modelCfg.isOrchestrator ? modelCfg.canonicalAlias : normalizeModelArg(rawModelArg);
const resolvedClaudeModel = CLAUDE_MODELS[rawModelArg] || rawModelArg;
const concurrency = Number(positionals[1] || 4);
const armFilter = positionals[2] || "both";
const taskFilterArg = positionals[3] || "all";
const REINDEX = process.argv.includes("--reindex");
const taskFilterSet = taskFilterArg === "all" ? null : new Set(taskFilterArg.split(",").map((s) => s.trim()));
const armsToRun =
    armFilter === "both" || armFilter === "all"
        ? ["cold", "plexer"]
        : armFilter.split(",").map((s) => s.trim()).filter(Boolean);

export function resolveIsAgy(mArg, env = process.env) {
    return isAgyModelAlias(mArg, env);
}
const isAgy = resolveIsAgy(rawModelArg);
export const AGY_MODELS = BASE_AGY_MODELS;
let sterileHome = null;

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

const coldSysFile = join(logDir, "cold-system.txt");
const plexerSysFile = join(logDir, "plexer-system.txt");

const plexerHookClient = resolve(import.meta.dirname, "../bin/plexer-hook-client.cjs");
const plexerHooksSettingsFile = join(logDir, "plexer-hooks-settings.json");
function initRuntimeFiles() {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(coldSysFile, `${basePrompt}\n`, "utf8");
    writeFileSync(plexerSysFile, `${basePrompt}\n\n${skillBody}\n`, "utf8");
    writeFileSync(plexerHooksSettingsFile, buildPlexerClaudeSettingsJson(plexerHookClient), "utf8");
}
const agyHooksJson = buildPlexerAgyHooksJson(plexerHookClient);

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

    if (forceReindex || !existsSync(join(indexedDir, "plexer", ".graph", "wiring.json")) || !readFingerprint(join(indexedDir, "plexer"))) {
        if (existsSync(cleanDir)) {
            rmSync(indexedDir, { recursive: true, force: true });
            mkdirSync(join(BASE_CACHE_DIR, "indexed"), { recursive: true });
            execFileSync("cp", ["-a", cleanDir, indexedDir]);
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
        execFileSync("cp", ["-a", srcDir, workDir]);
    } else {
        execFileSync("git", ["reset", "--hard", task.base_commit], { cwd: workDir, stdio: "ignore" });
        execFileSync("git", ["checkout", "--", "."], { cwd: workDir, stdio: "ignore" });
        execFileSync("git", ["clean", "-fd", "-e", "plexer", "-e", ".agents"], { cwd: workDir, stdio: "ignore" });
        if (arm === "plexer") {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
            execFileSync("cp", ["-a", join(indexedDir, "plexer"), join(workDir, "plexer")]);
        } else if (existsSync(join(workDir, "plexer"))) {
            rmSync(join(workDir, "plexer"), { recursive: true, force: true });
        }
    }
    const cacheDir = join(workDir, "plexer", ".cache");
    if (existsSync(cacheDir)) {
        for (const f of readdirSync(cacheDir)) {
            if (f.startsWith("session-")) rmSync(join(cacheDir, f), { force: true });
        }
    }

    const excludePath = join(workDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes("plexer/")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\n.agents/\nplexer/\n`, "utf8");
        }
    }

    if (isAgy) {
        configureAgyWorktreeArm({
            workDir,
            arm,
            modelCfg,
            basePrompt,
            agyRuleBody,
            agyHooksJson,
            suiteDesc: "SWE-bench Pro A/B benchmarking",
            includeWaitHint: true,
        });
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

const PATCH_NON_DECL_WORDS = new Set([
    "if", "else", "for", "while", "switch", "catch", "return", "new",
    "await", "typeof", "throw", "sizeof", "function", "def", "func", "class",
]);

export function extractPatchSymbols(patchText) {
    const headerSyms = new Set();
    const addedSyms = new Set();
    const lines = String(patchText || "").split("\n");
    for (const line of lines) {
        const hh = line.match(/^@@[^@]+@@\s*(.+)$/);
        if (hh) {
            const m = hh[1].match(/(?:async\s+)?(?:function\*?|def|func(?:\s*\([^)]+\))?|class|fn|pub\s+fn)\s+([A-Za-z_][A-Za-z0-9_]*)/);
            if (m) {
                headerSyms.add(m[1]);
            } else {
                const meth = hh[1].match(/^(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
                if (meth && !PATCH_NON_DECL_WORDS.has(meth[1]) && meth[1].length > 2) {
                    headerSyms.add(meth[1]);
                }
            }
        }
        if (/^\+/.test(line) && !/^\+{3}/.test(line)) {
            const added = line.slice(1);
            const patterns = [
                /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
                /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
                /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
                /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/,
                /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/,
                /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_][A-Za-z0-9_]*\s*=>)/,
                /^\s*(?:[A-Za-z_$][A-Za-z0-9_$.]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:async\s*)?function\b/,
                /^\s*(?:(?:public|private|protected|static|async|override|readonly)\s+)+([A-Za-z_][A-Za-z0-9_]*)\s*\(/,
                /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^;)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
            ];
            for (const re of patterns) {
                const m = added.match(re);
                if (m && m[1].length > 2 && !PATCH_NON_DECL_WORDS.has(m[1])) {
                    addedSyms.add(m[1]);
                    break;
                }
            }
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
    const matchedSyms = goldSyms.filter((s) => {
        const symRe = new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        return symRe.test(relevantAgentPatch) || (headerSyms.has(s) && symRe.test(modifiedContents));
    });
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

    const execRes = useDocker
        ? verifySweBenchDocker(task, agentPatch, { useDocker: true })
        : { verificationMode: "unverified-heuristic", resolved: null, passed: null, stdoutTail: "Docker verification disabled (--no-docker)" };
    const dockerPassed = execRes.passed;
    const dockerDetail = execRes.stdoutTail || "";
    const verificationMode = execRes.verificationMode;

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
    const heuristicResolved = Boolean(
        hasEdits &&
            fileRecall === 1 &&
            symRecall >= 0.75 &&
            tokenRecall >= 0.7
    );
    const resolved = useDocker ? Boolean(hasEdits && dockerPassed === true) : null;

    return {
        score,
        maxScore: 8,
        resolved,
        heuristicResolved,
        verificationMode,
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

export function gradeSweTask(task, workDir, parsed, useDocker = true) {
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
            cmd = "agy";
            args = buildAgyCliArgs({ promptText, arm, modelCfg });
        } else {
            cmd = "claude";
            const settingsFile = arm === "plexer" ? plexerHooksSettingsFile : null;
            const sysFile = arm === "plexer" ? plexerSysFile : coldSysFile;
            args = [
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
        const sterileOverlay = isAgy && modelCfg.isOrchestrator ? (sterileHome?.envOverlay ?? {}) : {};
        const env = {
            ...process.env,
            ...sterileOverlay,
            ...(arm === "plexer" ? { PLEXER_DAEMON_SOCK: benchDaemonSock } : {}),
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
        let timedOut = false;
        const clearRunTimeout = attachProcessTimeout(child, {
            label: `[${modelArg}] ${task.id} (${arm})`,
            onTimeout: () => {
                timedOut = true;
            },
        });

        child.on("error", (err) => {
            clearRunTimeout();
            outStream.end();
            rejectRun(err);
        });
        child.on("close", (code) => {
            clearRunTimeout();
            const exitCode = timedOut ? 124 : (code ?? 1);
            outStream.end(() => {
                if (exitCode === 0) {
                    renameSync(tmpJsonl, outJsonl);
                }
                const targetJsonl = exitCode === 0 ? outJsonl : tmpJsonl;
                const parsed = parseTranscript(targetJsonl, arm);
                const useDocker = !process.argv.includes("--no-docker") && process.env.SWEBENCH_DOCKER !== "0";
                const grade = gradeSweTask(task, workDir, parsed, useDocker);
                const isolationViolations = checkWorktreeIsolation(workDir, arm);
                if (isolationViolations.length > 0) {
                    parsed.symmetryViolations = [...(parsed.symmetryViolations || []), ...isolationViolations];
                }
                console.log(
                    `[${modelArg}] ${task.id} (${arm}) exit=${exitCode}${timedOut ? " (timeout)" : ""} calls=${parsed.calls} (${parsed.turns}t) toolTok=${parsed.toolOutputTokens} search=${(parsed.searchMs / 1000).toFixed(1)}s score=${grade.score}/8 fileRecall=${grade.fileRecall}`
                );
                resolveRun({
                    taskId: task.id,
                    arm,
                    workDir,
                    transcriptPath: targetJsonl,
                    parsed,
                    grade,
                    code: exitCode,
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

async function main() {
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
            : ["cold", "plexer"];
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
        if (isAgy && modelCfg.isOrchestrator) {
            sterileHome = createSterileBenchHome(`swe-${modelArg}`);
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
            await shutdownBenchDaemon(benchDaemonSock);
            sterileHome?.cleanup();
            sterileHome = null;
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
                      cacheWriteTokens: r.parsed.cacheWriteTokens ?? 0,
                      cacheReadTokens: r.parsed.cacheReadTokens ?? (r.parsed.cachedInputTokens || 0),
                      cachedInputTokens: r.parsed.cachedInputTokens,
                      cumulativeInputTokens: r.parsed.cumulativeInputTokens,
                      turn1ContextTokens: r.parsed.turn1ContextTokens || 0,
                      turn1UncachedTokens: r.parsed.turn1UncachedTokens || 0,
                      postTurn1UncachedTokens: r.parsed.postTurn1UncachedTokens || 0,
                      netContextGrowthTokens: r.parsed.netContextGrowthTokens || 0,
                      cacheMissTurns: r.parsed.cacheMissTurns || 0,
                      finalContextTokens: r.parsed.finalContextTokens,
                      totalModelOutputTokens: r.parsed.totalModelOutputTokens,
                      apiCostUsd: computeApiCostUsd(r.parsed, isAgy ? modelCfg.model : resolvedClaudeModel).totalUsd,
                      searchMs: r.parsed.searchMs,
                      totalMs: r.parsed.totalMs,
                      ...pickOrchResultMeta(r.parsed),
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
    const totals = taskRows.reduce(
        (acc, r) => {
            for (const arm of ["cold", "plexer"]) {
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
                mergeModelBreakdownTotals(acc[arm], r[arm]);
            }
            return acc;
        },
        {
            cold: emptyArmTotals(),
            plexer: emptyArmTotals(),
        }
    );

    const stats = summarizePairedSuite(taskRows);
    writeFileSync(
        resultsPath,
        `${JSON.stringify({ generatedAt: new Date().toISOString(), model: modelArg, trials: TRIALS, unreplicated: TRIALS < 2, useDocker: !process.argv.includes("--no-docker") && process.env.SWEBENCH_DOCKER !== "0", totals, stats, tasks: taskRows }, null, 2)}\n`,
        "utf8"
    );
    console.log(`Saved SWE-bench Pro results to ${resultsPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    await main();
}
