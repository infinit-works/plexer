import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const BASE_AGY_MODELS = {
    "neon-low": { model: "gemini-4-neon-low", effort: "low" },
    "neon-medium": { model: "gemini-4-neon-medium", effort: "medium" },
    "neon-high": { model: "gemini-4-neon-high", effort: "high" },
    "neon-xhigh": { model: "gemini-4-neon-xhigh", effort: "xhigh" },
    "gemini-4-neon-low": { model: "gemini-4-neon-low", effort: "low" },
    "gemini-4-neon-medium": { model: "gemini-4-neon-medium", effort: "medium" },
    "gemini-4-neon-high": { model: "gemini-4-neon-high", effort: "high" },
    "gemini-4-neon-xhigh": { model: "gemini-4-neon-xhigh", effort: "xhigh" },
    "carbon-low": { model: "gemini-4-carbon-low", effort: "low" },
    "carbon-medium": { model: "gemini-4-carbon-medium", effort: "medium" },
    "carbon-high": { model: "gemini-4-carbon-high", effort: "high" },
    "gemini-4-carbon-low": { model: "gemini-4-carbon-low", effort: "low" },
    "gemini-4-carbon-medium": { model: "gemini-4-carbon-medium", effort: "medium" },
    "gemini-4-carbon-high": { model: "gemini-4-carbon-high", effort: "high" },
    "hydrogen-low": { model: "gemini-4-hydrogen-low", effort: "low" },
    "hydrogen-medium": { model: "gemini-4-hydrogen-medium", effort: "medium" },
    "hydrogen-high": { model: "gemini-4-hydrogen-high", effort: "high" },
    "hydrogen-xhigh": { model: "gemini-4-hydrogen-xhigh", effort: "xhigh" },
    "gemini-4-hydrogen-low": { model: "gemini-4-hydrogen-low", effort: "low" },
    "gemini-4-hydrogen-medium": { model: "gemini-4-hydrogen-medium", effort: "medium" },
    "gemini-4-hydrogen-high": { model: "gemini-4-hydrogen-high", effort: "high" },
    "gemini-4-hydrogen-xhigh": { model: "gemini-4-hydrogen-xhigh", effort: "xhigh" },
    sonnet: { model: "claude-sonnet-5-5-medium", effort: "medium" },
    "sonnet-agy": { model: "claude-sonnet-5-5-medium", effort: "medium" },
    opus: { model: "claude-opus-5-5-medium", effort: "medium" },
    "opus-agy": { model: "claude-opus-5-5-medium", effort: "medium" },
    "orch-neon-high-hydrogen-high": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-high",
            executor: "gemini-4-hydrogen-high",
        },
    },
    "orch-neon-high": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-high",
            executor: "gemini-4-hydrogen-high",
        },
    },
    "orch-neon": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-high",
            executor: "gemini-4-hydrogen-high",
        },
    },
    "orch-neon-high-hydrogen-xhigh": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-high",
            executor: "gemini-4-hydrogen-xhigh",
        },
    },
    "orch-neon-h-xh": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-high",
            executor: "gemini-4-hydrogen-xhigh",
        },
    },
    "orch-neon-xhigh-hydrogen-xhigh": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-xhigh",
            executor: "gemini-4-hydrogen-xhigh",
        },
    },
    "orch-neon-xhigh": {
        model: "gemini-pro-orchestrator-neon",
        effort: null,
        isOrchestrator: true,
        orchestrator: {
            planner: "gemini-4-neon-xhigh",
            executor: "gemini-4-hydrogen-xhigh",
        },
    },
};

function sanitizeSlug(s) {
    return String(s || "")
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function resolveOrchestratorWrapper(planner) {
    const p = String(planner || "").toLowerCase();
    if (p.includes("carbon")) return "gemini-pro-orchestrator";
    return "gemini-pro-orchestrator-neon";
}

export function normalizeAgyModelAlias(raw = "sonnet") {
    const s = String(raw || "sonnet").trim();
    if (s === "orch-neon" || s === "orch-neon-high" || s === "orch-neon-high-hydrogen-high") {
        return "orch-neon-high-hydrogen-high";
    }
    if (s === "orch-neon-h-xh" || s === "orch-neon-high-hydrogen-xhigh") {
        return "orch-neon-high-hydrogen-xhigh";
    }
    if (s === "orch-neon-xhigh" || s === "orch-neon-xhigh-hydrogen-xhigh") {
        return "orch-neon-xhigh-hydrogen-xhigh";
    }
    if (s.startsWith("orch:")) {
        const [, planner, executor] = s.split(":");
        return `orch-${sanitizeSlug(planner || "planner")}-${sanitizeSlug(executor || "executor")}`;
    }
    return s.startsWith("orch-") ||
        s.startsWith("neon") ||
        s.startsWith("hydrogen") ||
        s.startsWith("carbon") ||
        s.startsWith("gemini-") ||
        s.endsWith("-agy")
        ? s
        : s.replace(/^claude-/, "").replace(/-5-5$/, "");
}

export function isAgyModelAlias(mArg, env = process.env) {
    if (env?.FORCE_CLAUDE_CLI === "1") return false;
    const s = String(mArg || "");
    return Boolean(
        env?.FORCE_AGY_CLI === "1" ||
            s.startsWith("orch-") ||
            s.startsWith("orch:") ||
            s.startsWith("neon") ||
            s.startsWith("hydrogen") ||
            s.startsWith("carbon") ||
            s.startsWith("gemini-") ||
            s.endsWith("-agy")
    );
}

export function resolveAgyModelConfig(rawAlias = "hydrogen-medium", defaultEffort = "medium") {
    const raw = String(rawAlias || "hydrogen-medium").trim();
    if (raw.startsWith("orch:")) {
        const parts = raw.split(":");
        const planner = (parts[1] || "gemini-4-neon-high").trim();
        const executor = (parts[2] || "gemini-4-hydrogen-high").trim();
        const resolvedPlanner = BASE_AGY_MODELS[planner]?.model || planner;
        const resolvedExecutor = BASE_AGY_MODELS[executor]?.model || executor;
        return {
            canonicalAlias: normalizeAgyModelAlias(raw),
            model: resolveOrchestratorWrapper(resolvedPlanner),
            effort: null,
            isOrchestrator: true,
            orchestrator: {
                planner: resolvedPlanner,
                executor: resolvedExecutor,
            },
        };
    }
    const canonicalAlias = normalizeAgyModelAlias(raw);
    const hit = BASE_AGY_MODELS[raw] || BASE_AGY_MODELS[canonicalAlias];
    if (hit) {
        return {
            canonicalAlias,
            model: hit.model,
            effort: hit.effort ?? null,
            isOrchestrator: Boolean(hit.isOrchestrator),
            orchestrator: hit.orchestrator ? { ...hit.orchestrator } : null,
        };
    }
    if (raw.startsWith("gemini-pro-orchestrator")) {
        return {
            canonicalAlias,
            model: raw,
            effort: null,
            isOrchestrator: true,
            orchestrator: null,
        };
    }
    return {
        canonicalAlias,
        model: raw,
        effort: defaultEffort,
        isOrchestrator: false,
        orchestrator: null,
    };
}

/**
 * Create an isolated temporary HOME for Orchestrator benchmark runs (where `--agent` cannot
 * be passed without disabling dual-model Orchestrator mode). Only auth & CLI transcript storage
 * are symlinked; `.gemini/config` and `.gemini/skills` stay empty so zero personal plugins,
 * rules, skills, or MCP servers load.
 */
export function createSterileBenchHome(prefix = "agy") {
    const realHome = homedir();
    const homeDir = `/tmp/plexer-agy-bench-home-${sanitizeSlug(prefix)}-${process.pid}`;
    rmSync(homeDir, { recursive: true, force: true });
    mkdirSync(join(homeDir, ".config"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini", "config", "plugins"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini", "config", "rules"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini", "config", "skills"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini", "config", "agents"), { recursive: true });
    mkdirSync(join(homeDir, ".gemini", "skills"), { recursive: true });

    const linkIfExists = (srcRel, dstRel = srcRel) => {
        const src = join(realHome, srcRel);
        const dst = join(homeDir, dstRel);
        if (existsSync(src)) {
            mkdirSync(dirname(dst), { recursive: true });
            symlinkSync(src, dst);
        }
    };
    linkIfExists(join(".config", "antigravity"));
    linkIfExists(join(".gemini", "antigravity-cli"));
    linkIfExists(join(".gemini", "jetski-standalone-oauth-token"));
    linkIfExists(".gitconfig");
    // Host developer toolchains & build caches (never .gemini/config, .gemini/skills, .agents, .claude)
    for (const rel of [
        ".rokit",
        ".cargo",
        ".rustup",
        "go",
        ".nvm",
        ".pyenv",
        ".volta",
        ".bun",
        ".deno",
        ".rbenv",
        ".npm",
        ".pnpm-store",
        join(".local", "bin"),
        join(".cache", "go-build"),
        join(".cache", "pip"),
        join(".cache", ".bun"),
        join(".cache", "uv"),
    ]) {
        linkIfExists(rel);
    }

    const extraToolEnv = {};
    const rokitDir = join(realHome, ".rokit");
    if (existsSync(rokitDir)) extraToolEnv.ROKIT_ROOT = rokitDir;
    const cargoDir = join(realHome, ".cargo");
    if (existsSync(cargoDir)) extraToolEnv.CARGO_HOME = cargoDir;
    const rustupDir = join(realHome, ".rustup");
    if (existsSync(rustupDir)) extraToolEnv.RUSTUP_HOME = rustupDir;
    const goDir = join(realHome, "go");
    if (existsSync(goDir)) extraToolEnv.GOPATH = goDir;
    const goCacheDir = join(realHome, ".cache", "go-build");
    if (existsSync(goCacheDir)) extraToolEnv.GOCACHE = goCacheDir;

    return {
        homeDir,
        envOverlay: {
            HOME: homeDir,
            XDG_CONFIG_HOME: join(homeDir, ".config"),
            ...extraToolEnv,
        },
        cleanup: () => rmSync(homeDir, { recursive: true, force: true }),
    };
}

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

function ensureExcludeEntries(workDir) {
    const excludePath = join(workDir, ".git", "info", "exclude");
    if (!existsSync(excludePath)) return;
    const cur = readFileSync(excludePath, "utf8");
    const additions = [];
    for (const pat of [".agents/", "plexer/"]) {
        if (!cur.includes(pat)) additions.push(pat);
    }
    if (additions.length > 0) {
        writeFileSync(excludePath, `${cur.trimEnd()}\n${additions.join("\n")}\n`, "utf8");
    }
}

export function configureAgyWorktreeArm({
    workDir,
    arm,
    modelCfg,
    basePrompt,
    agyRuleBody,
    agyHooksJson,
    suiteDesc = "A/B benchmarking",
    includeWaitHint = true,
}) {
    ensureExcludeEntries(workDir);
    const agentsRoot = join(workDir, ".agents");
    const agentsDir = join(agentsRoot, "agents");
    const rulesDir = join(agentsRoot, "rules");
    const hooksPath = join(agentsRoot, "hooks.json");

    const waitSuffix = includeWaitHint && !basePrompt.includes("WaitMsBeforeAsync")
        ? "\nWhen running shell commands with `run_command`, always set `WaitMsBeforeAsync: 10000` so commands complete synchronously."
        : "";
    const coldBody = `${basePrompt}${waitSuffix}\n\nIMPORTANT: Do NOT read or use any external skill files under ~/.gemini/ or ~/.agents/ or run \`plexer\` commands; use standard repository tools only.`;
    const plexerBody = `${basePrompt}${waitSuffix}\n\nIMPORTANT: Do NOT read external skill files under ~/.gemini/ or ~/.agents/; your plexer instructions are already loaded below.\n\n${agyRuleBody}`;

    if (modelCfg?.isOrchestrator) {
        rmSync(agentsDir, { recursive: true, force: true });
        mkdirSync(rulesDir, { recursive: true });
        for (const f of readdirSync(rulesDir)) {
            if (f !== "bench-arm.md") rmSync(join(rulesDir, f), { recursive: true, force: true });
        }
        const selectedBody = arm === "plexer" ? plexerBody : coldBody;
        writeFileSync(
            join(rulesDir, "bench-arm.md"),
            `---\ntrigger: always_on\n---\n\n# Benchmark Arm Instructions (${arm})\n\n${selectedBody}\n`,
            "utf8"
        );
    } else {
        rmSync(rulesDir, { recursive: true, force: true });
        mkdirSync(agentsDir, { recursive: true });
        writeFileSync(
            join(agentsDir, "bench-cold.md"),
            makeAgentMd("bench-cold", `Cold baseline software engineering agent for ${suiteDesc}.`, coldBody),
            "utf8"
        );
        writeFileSync(
            join(agentsDir, "bench-plexer.md"),
            makeAgentMd("bench-plexer", `Plexer-equipped software engineering agent for ${suiteDesc}.`, plexerBody, hooksPath),
            "utf8"
        );
    }

    if (arm === "plexer") {
        writeFileSync(hooksPath, `${agyHooksJson}\n`, "utf8");
    } else if (existsSync(hooksPath)) {
        rmSync(hooksPath, { force: true });
    }
}

export function buildAgyCliArgs({ promptText, arm, modelCfg }) {
    if (modelCfg?.isOrchestrator) {
        const args = [
            "-p",
            promptText,
            "--model",
            modelCfg.model,
        ];
        if (modelCfg.orchestrator) {
            args.push("--settings", JSON.stringify({ orchestrator: modelCfg.orchestrator }));
        }
        args.push(
            "--output-format",
            "stream-json",
            "--dangerously-skip-permissions",
            "--disable-slash-commands"
        );
        return args;
    }
    return [
        "-p",
        promptText,
        "--agent",
        arm === "plexer" ? "bench-plexer" : "bench-cold",
        "--model",
        modelCfg.model,
        "--effort",
        modelCfg.effort || "medium",
        "--output-format",
        "stream-json",
        "--dangerously-skip-permissions",
        "--disable-slash-commands",
    ];
}

export function pickOrchResultMeta(parsed) {
    if (!parsed || !((parsed.modelsUsed?.length ?? 0) > 1 || (parsed.planHandoffs ?? 0) > 0 || (parsed.planReviews ?? 0) > 0)) {
        return {};
    }
    return {
        modelsUsed: parsed.modelsUsed || [],
        modelBreakdown: parsed.modelBreakdown || {},
        planHandoffs: parsed.planHandoffs || 0,
        planReviews: parsed.planReviews || 0,
    };
}

export function mergeModelBreakdownTotals(dstArm, srcArm) {
    if (!srcArm || (!srcArm.planHandoffs && !srcArm.planReviews && !srcArm.modelBreakdown)) return;
    dstArm.planHandoffs = (dstArm.planHandoffs || 0) + (srcArm.planHandoffs || 0);
    dstArm.planReviews = (dstArm.planReviews || 0) + (srcArm.planReviews || 0);
    if (!srcArm.modelBreakdown) return;
    dstArm.modelBreakdown = dstArm.modelBreakdown || {};
    for (const [m, stats] of Object.entries(srcArm.modelBreakdown)) {
        const dst = (dstArm.modelBreakdown[m] = dstArm.modelBreakdown[m] || {
            turns: 0,
            calls: 0,
            uncachedInputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            cachedInputTokens: 0,
            cumulativeInputTokens: 0,
            totalModelOutputTokens: 0,
        });
        dst.turns += stats.turns || 0;
        dst.calls += stats.calls || 0;
        dst.uncachedInputTokens += stats.uncachedInputTokens || 0;
        dst.cacheWriteTokens += stats.cacheWriteTokens || 0;
        dst.cacheReadTokens += stats.cacheReadTokens || 0;
        dst.cachedInputTokens += stats.cachedInputTokens || 0;
        dst.cumulativeInputTokens += stats.cumulativeInputTokens || 0;
        dst.totalModelOutputTokens += stats.totalModelOutputTokens || 0;
    }
}

export function attachProcessTimeout(
    child,
    {
        timeoutMs = Number(process.env.PLEXER_BENCH_TIMEOUT_MS) || 25 * 60_000,
        label = "bench child",
        onTimeout,
    } = {}
) {
    if (!child || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return () => {};
    }
    let killTimer = null;
    const timer = setTimeout(() => {
        console.error(`[timeout] ${label} exceeded ${Math.round(timeoutMs / 1000)}s — killing`);
        try {
            onTimeout?.();
        } catch {
            // ignore
        }
        try {
            child.kill("SIGTERM");
        } catch {
            // ignore
        }
        killTimer = setTimeout(() => {
            try {
                child.kill("SIGKILL");
            } catch {
                // ignore
            }
        }, 5000);
        killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    return () => {
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
    };
}

export async function shutdownBenchDaemon(sockPath) {
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

export function buildPlexerClaudeSettingsJson(plexerHookClient) {
    const cmd = (ev) => `env PLEXER_DISABLE_HOOKS=0 PLEXER_ENABLE_BENCH_HOOKS=1 ${process.execPath} ${JSON.stringify(plexerHookClient)} ${ev}`;
    return JSON.stringify(
        {
            hooks: {
                UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("prompt"), timeout: 15 }] }],
                PreToolUse: [
                    { matcher: "Read|Bash|Grep|Glob", hooks: [{ type: "command", command: cmd("pre-tool-use"), timeout: 10 }] },
                ],
                PostToolUse: [
                    { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: cmd("post-edit"), timeout: 10 }] },
                    { matcher: "Read|ExitPlanMode", hooks: [{ type: "command", command: cmd("post-tool-use"), timeout: 8 }] },
                ],
            },
        },
        null,
        2
    );
}

export function buildPlexerAgyHooksJson(plexerHookClient) {
    const cmd = (ev) => `env PLEXER_ENABLE_BENCH_HOOKS=1 ${process.execPath} ${JSON.stringify(plexerHookClient)} ${ev}`;
    return JSON.stringify(
        {
            "plexer-hooks": {
                PreInvocation: [{ type: "command", command: cmd("agy-pre-invocation"), timeout: 15 }],
                PreToolUse: [
                    {
                        matcher: "read_file|view_file|run_command|grep_search|find_by_name",
                        hooks: [{ type: "command", command: cmd("agy-pre-tool"), timeout: 10 }],
                    },
                ],
                PostToolUse: [
                    {
                        matcher: "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|read_file|view_file|exit_plan_mode|enter_plan_mode",
                        hooks: [{ type: "command", command: cmd("agy-post-tool"), timeout: 10 }],
                    },
                ],
                Stop: [{ type: "command", command: cmd("agy-stop"), timeout: 10 }],
            },
        },
        null,
        2
    );
}
