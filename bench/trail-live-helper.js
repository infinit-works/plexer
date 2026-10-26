#!/usr/bin/env node
/**
 * Helper for running `@trailhq/trail-code@0.25.0` live agent benchmarks in
 * `run-claude-ab.js`, `run-agy-ab.js`, and `run-swebench-ab.js` under strict
 * cohort symmetry with `plexer` and `cold`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const TRAIL_EVAL_ROOT = "/tmp/trail-eval";
export const TRAIL_BIN_DIR = "/tmp/trail-eval/node_modules/.bin";
export const TRAIL_BIN = "/tmp/trail-eval/node_modules/.bin/trail";
export const TRAIL_HOME = "/tmp/trail-eval/home";
export const TRAIL_REPOS_DIR = "/tmp/trail-repos";
export const TRAIL_DIST_DIR = "/tmp/trail-eval/node_modules/@trailhq/trail-code/dist";
export const TRAIL_CLAUDE_DIST = join(TRAIL_DIST_DIR, "claude");

const HELPER_PATH = resolve(import.meta.dirname, "trail-live-helper.js");

export function ensureTrailBinShims() {
    const shimCode = [
        "#!/usr/bin/env node",
        'process.env.TRAIL_INVOKED_AS = "trail";',
        'process.env.DO_NOT_TRACK = "1";',
        'process.env.TRAIL_TELEMETRY = "0";',
        'process.env.GRAFT_TELEMETRY = "0";',
        'process.env.GRAFT_NO_STATUSLINE = "1";',
        'if (process.argv[2] === "stats") process.argv[2] = "status";',
        'if (process.argv[2] === "check") process.argv.splice(2, 1, "build", "--check");',
        'const QUERY_CMDS = new Set(["ask", "skeleton", "callers", "blast", "grep", "map"]);',
        'const firstSub = process.argv.slice(2).find((a) => !a.startsWith("-"));',
        'if (firstSub && QUERY_CMDS.has(firstSub) && !process.argv.includes("--no-refresh")) {',
        '    process.argv.push("--no-refresh");',
        "}",
        'await import("/tmp/trail-eval/node_modules/@trailhq/trail-code/dist/bin/trail.js");',
        "",
    ].join("\n");
    const localBin = join(homedir(), ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    for (const target of [
        join(localBin, "trail"),
        join(localBin, "graft"),
        join(TRAIL_BIN_DIR, "graft"),
    ]) {
        try {
            rmSync(target, { force: true });
            writeFileSync(target, shimCode, { encoding: "utf8", mode: 0o755 });
            chmodSync(target, 0o755);
        } catch {
            // ignore
        }
    }
}

export async function getTrailSkillBody() {
    ensureTrailBinShims();
    process.env.TRAIL_INVOKED_AS = "trail";
    const mod = await import(join(TRAIL_CLAUDE_DIST, "skill-template.js"));
    const { inBrand } = await import(join(TRAIL_DIST_DIR, "brand.js"));
    const raw = typeof mod.skillTemplate === "function" ? inBrand(mod.skillTemplate("graft"), "trail") : String(mod.skillTemplate || "");
    return raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
}

export function getTrailEnv(extra = {}) {
    const curPath = process.env.PATH || "";
    const env = {
        ...process.env,
        PATH: `${TRAIL_BIN_DIR}:${curPath}`,
        TRAIL_INVOKED_AS: "trail",
        TRAIL_HOME,
        TRAIL_TELEMETRY: "0",
        GRAFT_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        GRAFT_NO_STATUSLINE: "1",
        PLEXER_ENABLE_BENCH_HOOKS: "0",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "tag.gpgsign",
        GIT_CONFIG_VALUE_1: "false",
        ...extra,
    };
    delete env.PLEXER_DISABLE_HOOKS;
    delete env.PLEXER_DIR;
    return env;
}

export function ensureTrailIndexedRepo(idOrRepo, cleanSourceDir) {
    mkdirSync(TRAIL_HOME, { recursive: true });
    mkdirSync(TRAIL_REPOS_DIR, { recursive: true });
    const targetDir = join(TRAIL_REPOS_DIR, idOrRepo);
    if (!existsSync(join(targetDir, "graft", "INDEX.md"))) {
        rmSync(targetDir, { recursive: true, force: true });
        cpSync(cleanSourceDir, targetDir, { recursive: true });
        execFileSync(TRAIL_BIN, ["build", "."], {
            cwd: targetDir,
            env: getTrailEnv(),
            stdio: "ignore",
            timeout: 120000,
        });
    }
    return targetDir;
}

export function prepareTrailWorktreeDir(workDir, idOrRepo, cleanSourceDir) {
    ensureTrailBinShims();
    const trailIndexed = ensureTrailIndexedRepo(idOrRepo, cleanSourceDir);
    const graftSrc = join(trailIndexed, "graft");
    const graftDst = join(workDir, "graft");
    rmSync(graftDst, { recursive: true, force: true });
    if (existsSync(graftSrc)) {
        cpSync(graftSrc, graftDst, { recursive: true });
    }
    const cacheDir = join(graftDst, ".cache");
    if (existsSync(cacheDir)) {
        for (const f of readdirSync(cacheDir)) {
            if (f.startsWith("session-") || f.startsWith("agy-session-") || f.startsWith("extract.")) {
                rmSync(join(cacheDir, f), { force: true });
            }
        }
    }
    const excludePath = join(workDir, ".git", "info", "exclude");
    if (existsSync(excludePath)) {
        const cur = readFileSync(excludePath, "utf8");
        if (!cur.includes("graft/")) {
            writeFileSync(excludePath, `${cur.trimEnd()}\ngraft/\n.trail/\n.agents/\n`, "utf8");
        }
    }
}

export function buildTrailClaudeSettingsJson() {
    const cmd = (ev) => `${process.execPath} ${JSON.stringify(HELPER_PATH)} claude-hook ${ev} || exit 0`;
    return JSON.stringify(
        {
            hooks: {
                SessionStart: [{ hooks: [{ type: "command", command: cmd("session-start"), timeout: 10 }] }],
                UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("prompt"), timeout: 15 }] }],
                PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: cmd("pre-bash"), timeout: 5 }] }],
                PostToolUse: [
                    { matcher: "Write|Edit|MultiEdit", hooks: [{ type: "command", command: cmd("post-edit"), timeout: 10 }] },
                    { matcher: "Bash|Read|Grep|Glob", hooks: [{ type: "command", command: cmd("tool-savings"), timeout: 8 }] },
                ],
                Stop: [{ hooks: [{ type: "command", command: cmd("stop"), timeout: 10 }] }],
            },
        },
        null,
        2
    );
}

export function buildTrailAgyHooksJson() {
    return JSON.stringify(
        {
            "trail-hooks": {
                PreInvocation: [
                    {
                        type: "command",
                        command: `${process.execPath} ${JSON.stringify(HELPER_PATH)} agy-pre-invocation`,
                        timeout: 15,
                    },
                ],
                PostToolUse: [
                    {
                        matcher: "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file",
                        hooks: [
                            {
                                type: "command",
                                command: `${process.execPath} ${JSON.stringify(HELPER_PATH)} agy-post-edit`,
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
}

function readStdinJson() {
    try {
        const raw = process.env.GRAFT_TEST_STDIN !== undefined ? process.env.GRAFT_TEST_STDIN : readFileSync(0, "utf8");
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        return {};
    }
}

function extractAgyPromptFromTranscript(input) {
    if (typeof input?.prompt === "string" && input.prompt.trim()) {
        return input.prompt.trim();
    }
    let tp = input?.transcriptPath || input?.transcript_path;
    if (typeof tp === "string" && tp.endsWith("/transcript.jsonl")) {
        const full = join(dirname(tp), "transcript_full.jsonl");
        if (existsSync(full)) tp = full;
    }
    if ((!tp || !existsSync(tp)) && input?.conversationId) {
        const realHome = process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : homedir();
        for (const base of [realHome, "/home/kohl"]) {
            const cands = [
                join(base, ".gemini", "antigravity-cli", "brain", input.conversationId, ".system_generated", "logs", "transcript_full.jsonl"),
                join(base, ".gemini", "antigravity-cli", "brain", input.conversationId, ".system_generated", "logs", "transcript.jsonl"),
            ];
            const found = cands.find((p) => existsSync(p));
            if (found) {
                tp = found;
                break;
            }
        }
    }
    if (tp && existsSync(tp)) {
        try {
            const lines = readFileSync(tp, "utf8").split("\n").filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                const step = JSON.parse(lines[i]);
                if (step.type === "USER_INPUT" && typeof step.content === "string" && step.content.trim()) {
                    return step.content
                        .replace(/<USER_REQUEST>\s*/gi, "")
                        .replace(/\s*<\/USER_REQUEST>/gi, "")
                        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
                        .trim();
                }
            }
        } catch {
            // ignore
        }
    }
    return "";
}

async function handleAgyPreInvocation() {
    const input = readStdinJson();
    const prompt = extractAgyPromptFromTranscript(input);
    let dir = input?.workspacePaths?.[0] || input?.cwd || process.cwd();
    if (!existsSync(join(dir, "graft", "INDEX.md")) && prompt) {
        const m = prompt.match(/(?:Working directory:\s*|in the `)([/A-Za-z0-9._-]+)(?:` directory|\b)/);
        if (m && existsSync(join(m[1], "graft", "INDEX.md"))) dir = m[1];
    }
    const graftDir = join(dir, "graft");
    if (!existsSync(join(graftDir, "INDEX.md"))) {
        process.stdout.write("{}\n");
        return;
    }
    const sid =
        input?.sessionId ||
        input?.session_id ||
        input?.conversationId ||
        (input?.transcriptPath ? basename(String(input.transcriptPath), ".jsonl") : "default");
    const cacheDir = join(graftDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const statePath = join(cacheDir, `agy-session-${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    let state = { oriented: false, lastPrompt: "", pendingBlast: null, emittedBlastFiles: [], session: {} };
    if (existsSync(statePath)) {
        try {
            state = JSON.parse(readFileSync(statePath, "utf8"));
        } catch {
            // ignore
        }
    }

    process.env.TRAIL_INVOKED_AS = "trail";
    const fmtMod = await import(join(TRAIL_CLAUDE_DIST, "format.js"));
    const messages = [];

    if (!state.oriented) {
        try {
            const idxMd = readFileSync(join(graftDir, "INDEX.md"), "utf8");
            const orient = fmtMod.formatOrientation(idxMd, undefined, undefined, 0, false, "", "trail");
            if (orient) messages.push(orient);
            state.oriented = true;
        } catch {
            // ignore
        }
    }

    if (state.pendingBlast) {
        messages.push(state.pendingBlast);
        state.pendingBlast = null;
    }

    if (prompt.length >= 12 && prompt !== state.lastPrompt) {
        state.lastPrompt = prompt;
        try {
            const rawJson = execFileSync(TRAIL_BIN, ["ask", "-", ".", "--json", "-n", "3", "--no-refresh"], {
                cwd: dir,
                input: prompt,
                encoding: "utf8",
                env: getTrailEnv(),
                stdio: ["pipe", "pipe", "ignore"],
                timeout: 8000,
            });
            const askObj = JSON.parse(rawJson.slice(rawJson.indexOf("{")));
            const ret = fmtMod.relevantRetrieval(askObj, state.session || (state.session = {}));
            if (ret) messages.push(ret);
        } catch {
            // ignore
        }
    }

    try {
        writeFileSync(statePath, JSON.stringify(state), "utf8");
    } catch {
        // ignore
    }

    if (messages.length > 0) {
        const msgText = messages.join("\n\n");
        const stepObj = prompt && prompt !== state.prevInjectedPrompt
            ? { systemMessage: { systemMessage: msgText } }
            : { ephemeralMessage: msgText };
        state.prevInjectedPrompt = prompt || state.prevInjectedPrompt;
        writeFileSync(statePath, JSON.stringify(state), "utf8");
        process.stdout.write(`${JSON.stringify({ injectSteps: [stepObj] })}\n`);
    } else {
        process.stdout.write("{}\n");
    }
}

async function handleAgyPostEdit() {
    process.env.TRAIL_INVOKED_AS = "trail";
    const input = readStdinJson();
    let dir = input?.workspacePaths?.[0] || input?.cwd || process.cwd();
    const ti = input?.toolCall?.args || input?.toolArgs || input?.tool_input || {};
    let file = ti.Path || ti.TargetFile || ti.file_path || ti.path;
    if ((!file || typeof file !== "string") && input?.conversationId) {
        const realHome = process.env.SUDO_USER ? `/home/${process.env.SUDO_USER}` : homedir();
        for (const base of [realHome, "/home/kohl"]) {
            for (const sub of ["antigravity-cli", "antigravity"]) {
                const tp = join(base, ".gemini", sub, "brain", input.conversationId, ".system_generated", "logs", "transcript.jsonl");
                if (existsSync(tp)) {
                    try {
                        const lines = readFileSync(tp, "utf8").trim().split("\n");
                        for (let i = lines.length - 1; i >= 0; i--) {
                            const step = JSON.parse(lines[i]);
                            const calls = step?.tool_calls || step?.toolCalls || [];
                            for (const c of calls) {
                                const args = typeof c?.arguments === "string" ? JSON.parse(c.arguments) : (c?.arguments || c?.args || {});
                                const cand = args?.TargetFile || args?.Path;
                                if (typeof cand === "string" && cand) {
                                    file = cand;
                                    break;
                                }
                            }
                            if (file) break;
                        }
                    } catch {
                        // ignore
                    }
                }
                if (file) break;
            }
            if (file) break;
        }
    }
    if (!existsSync(join(dir, "graft")) && file && typeof file === "string" && isAbsolute(file)) {
        let cur = dirname(file);
        while (cur && cur !== "/") {
            if (existsSync(join(cur, "graft"))) {
                dir = cur;
                break;
            }
            cur = dirname(cur);
        }
    }
    const graftDir = join(dir, "graft");
    if (!existsSync(graftDir)) {
        process.stdout.write("{}\n");
        return;
    }
    if (!file || typeof file !== "string") {
        process.stdout.write("{}\n");
        return;
    }
    const sid =
        input?.sessionId ||
        input?.session_id ||
        input?.conversationId ||
        (input?.transcriptPath ? basename(String(input.transcriptPath), ".jsonl") : "default");
    const cacheDir = join(graftDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const statePath = join(cacheDir, `agy-session-${sid.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    let state = { oriented: false, lastPrompt: "", pendingBlast: null, emittedBlastFiles: [], session: {} };
    if (existsSync(statePath)) {
        try {
            state = JSON.parse(readFileSync(statePath, "utf8"));
        } catch {
            // ignore
        }
    }
    try {
        const statsMod = await import(join(TRAIL_CLAUDE_DIST, "stats.js"));
        const fmtMod = await import(join(TRAIL_CLAUDE_DIST, "format.js"));
        const w = statsMod.readWiring(dir);
        if (w) {
            const absFile = isAbsolute(file) ? file : join(dir, file);
            const base = basename(absFile);
            if (!Array.isArray(state.emittedBlastFiles)) state.emittedBlastFiles = [];
            if (!state.emittedBlastFiles.includes(base)) {
                const br = fmtMod.formatBlastRadius(w, absFile);
                if (br) {
                    state.emittedBlastFiles.push(base);
                    state.pendingBlast =
                        state.pendingBlast && !state.pendingBlast.includes(br)
                            ? `${state.pendingBlast}\n\n${br}`
                            : state.pendingBlast || br;
                    writeFileSync(statePath, JSON.stringify(state), "utf8");
                }
            }
        }
    } catch {
        // ignore
    }
    process.stdout.write("{}\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const mode = process.argv[2];
    for (const [k, v] of Object.entries(getTrailEnv())) {
        process.env[k] = v;
    }
    if (mode === "claude-hook") {
        const ev = process.argv[3];
        const target = ev === "pre-bash" ? "pre-bash.js" : "hooks.js";
        import(join(TRAIL_CLAUDE_DIST, target))
            .then((m) => m.main(ev))
            .catch(() => {});
    } else if (mode === "agy-pre-invocation") {
        handleAgyPreInvocation().catch(() => process.stdout.write("{}\n"));
    } else if (mode === "agy-post-edit") {
        handleAgyPostEdit().catch(() => process.stdout.write("{}\n"));
    }
}
