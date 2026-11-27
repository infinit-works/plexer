import { Command } from "commander";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextDirFor } from "../context/node-file.js";
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from "../graph/root.js";
import { readCurrentVersion } from "../util/cli-meta.js";
import { normalizePathPrefix } from "../util/paths.js";

const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a plexer/ index)"];
const ROOT_LOOKUP_TTL_MS = 2000;
const ROOT_LOOKUP_CACHE_MAX = 64;
const rootLookupCache = new Map();

function cachedNearestPlexerRoot(dirPath, globalDir) {
    const key = `${resolve(dirPath)}\0${globalDir ?? ""}`;
    const now = Date.now();
    const hit = rootLookupCache.get(key);
    if (hit && now - hit.ts < ROOT_LOOKUP_TTL_MS) {
        if (!hit.verifyDir || existsSync(hit.verifyDir))
            return hit.val;
        rootLookupCache.delete(key);
    }
    const val = nearestPlexerRoot(dirPath, globalDir);
    const verifyDir = val.root ? contextDirFor(val.root, globalDir) : null;
    if (!verifyDir || existsSync(verifyDir)) {
        if (rootLookupCache.size >= ROOT_LOOKUP_CACHE_MAX) {
            rootLookupCache.delete(rootLookupCache.keys().next().value);
        }
        rootLookupCache.set(key, { ts: now, val, verifyDir });
    }
    return val;
}
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"];
const VIZ_TABS = ["context", "code", "modules", "symbols", "outline", "treemap"];
const KNOWN_AGENT_LIST = "agents, adal, cursor, gemini, grok, hermes, antigravity, copilot, kiro, windsurf, claude, opencode";
const CLI_BIN_PATH = fileURLToPath(new URL("../../bin/plexer.js", import.meta.url));
const VIEWER_DIR = fileURLToPath(new URL("../viewer/", import.meta.url));

const KNOWN_HEALTH_SUBCOMMANDS = new Set([
    "scan", "next", "backlog", "status", "show", "resolve", "suppress", "plan", "review",
    "autofix", "move", "tree", "viz", "detect", "zone", "exclude", "directives", "config", "prompt",
]);
const HEALTH_DIR_ACCEPTING_ACTIONS = new Set(["scan", "next", "backlog", "status", "tree", "viz", "detect"]);
const HEALTH_PURE_STATE_ACTIONS = new Set([
    "next", "backlog", "status", "show", "resolve", "suppress", "plan", "zone", "config", "exclude", "directives", "prompt",
]);

const HEALTH_OPTIONS = [
    ["--path <dir>", "target project or subdirectory path to scan"],
    ["--diff [base]", "restrict findings to files changed in git diff (working tree or vs base ref)"],
    ["--base <ref>", "git base ref for --diff"],
    ["--in <scope...>", "restrict findings to paths under this directory prefix"],
    ["--only <categories>", "comma-separated detector categories (duplicates,dead,coupling,cohesion,tests,catches,types,traps,slop,security)"],
    ["--skip <categories>", "comma-separated detector categories to skip"],
    ["--max <n>", "cap findings shown (default 10, or 'all')"],
    ["--count <n>", "number of queue items for `next` or `backlog`"],
    ["--cluster <name>", "drill into a specific cluster in `next`"],
    ["--depends-on <clusters>", "comma-separated cluster dependency names for `plan cluster create|update`"],
    ["--to <cluster>", "target cluster name for `plan cluster move`"],
    ["--status <st>", "filter `show` by status (open, fixed, wontfix, deferred, false_positive)"],
    ["--chronic", "filter `show` to recurring or reopened issues across multiple scans"],
    ["--no-budget", "bypass per-detector noise budget cap in `show`"],
    ["--code", "inline source code excerpts in `show`"],
    ["--group <mode>", "group `next` items by item (default), file, or detector"],
    ["--explain", "include ranking and score-impact rationale in `next`"],
    ["--include-skipped", "include deferred/wontfix issues in `next`"],
    ["--review-after <n>", "resurface deferred issue automatically after N scans (`plan skip`)"],
    ["-t, --offset <n>", "numeric step offset for `plan reorder ... up|down`"],
    ["--add-step <title>", "add an action step to a cluster (`plan cluster create|update`)"],
    ["--update-step <n>", "update action step index N on a cluster"],
    ["--done-step <n>", "mark action step index N done on a cluster"],
    ["--undone-step <n>", "mark action step index N undone on a cluster"],
    ["--steps-file <file>", "load cluster action steps from a file"],
    ["--effort <level>", "effort tag for a cluster step (trivial, small, medium, large)"],
    ["--issue-refs <ids>", "comma-separated issue IDs referenced by a cluster step"],
    ["--stage-prompt <stage>", "print dynamic prompt for a triage stage"],
    ["--confirm-existing", "fast-track re-confirm an existing triage plan"],
    ["--similarity <n>", "Jaccard similarity threshold for `review --merge` deduplication (default 0.8)"],
    ["--retrospective", "include historical resolution context in `review --prepare`"],
    ["--stall-kill-seconds <n>", "kill hung review/triage batch subprocess after N idle seconds (default 120)"],
    ["--max-retries <n>", "retry failed review/triage batch subprocesses N times (default 1)"],
    ["--note <text>", "resolution, skip, suppress, or commit-log note"],
    ["--reason <text>", "detailed reason for suppress or false-positive skip (>= 15 chars for --false-positive)"],
    ["--confirm", "confirm issue resolution"],
    ["--attest <text>", "explicit attestation for resolve, permanent skip, suppress, or review import"],
    ["--permanent", "mark skipped issue as permanent `wontfix`"],
    ["--false-positive", "mark skipped issue as permanent `false_positive` (requires `--attest`)"],
    ["--kind <kind>", "skip kind (`deferred`, `wontfix`, `false_positive`)"],
    ["--lanes", "compute graph-disjoint parallel subagent workstream lanes in `next`"],
    ["--verbose", "include full dimension tables in `next` / `backlog`"],
    ["--stateless", "run an ephemeral read-only scan without mutating .health/state.json"],
    ["--detector <name>", "filter scan/detect to specific detector(s)"],
    ["--rule <rule>", "policy rule for `plan policy add|remove`"],
    ["--description <text>", "custom description for `plan describe`"],
    ["--detail-text <text>", "step detail text for `plan cluster --add-step|--update-step`"],
    ["--title <text>", "step title for `plan cluster --update-step`"],
    ["--position <pos>", "target queue position (`top`, `bottom`, `before`, `after`, `up`, `down`)"],
    ["--target <id>", "anchor issue/cluster or path target"],
    ["--export-format <fmt>", "export format for `plan cluster export` (`json`, `yaml`, `markdown`)"],
    ["--skip-gate", "skip scan gate in `plan scan-gate` (requires `--note` >= 50 chars)"],
    ["--reset-gate", "reset scan gate in `plan scan-gate`"],
    ["--force", "bypass scan gate on resolve"],
    ["--force-resolve", "bypass suspect-disappearance guard on scan when a detector drops from >=3 to 0"],
    ["--stage <name>", "triage stage (strategize, observe, reflect, organize, enrich, sense-check, commit, complete)"],
    ["--report <text>", "triage stage report"],
    ["--complete", "complete triage and commit strategy"],
    ["--strategy <text>", "triage completion strategy"],
    ["--run-stages", "automate triage stages via CLI runner"],
    ["--prepare", "prepare blind subjective review packet (review_packet_blind.json)"],
    ["--run-batches", "run blind review batches in bounded waves, merge, and import"],
    ["--runner <name>", "CLI runner for --run-batches or --run-stages (claude, codex, gemini)"],
    ["--runner-cmd <cmd>", "custom shell command template for --run-batches or --run-stages"],
    ["--parallel", "execute review batches in parallel waves (default true)"],
    ["--no-parallel", "execute review batches serially"],
    ["--concurrency <n>", "max concurrent review batch processes per wave (default 3, max 5)"],
    ["--batches <list>", "comma-separated batch numbers (1-5) for review"],
    ["--dimensions <list>", "comma-separated subjective dimension IDs for review"],
    ["--stale-only", "scope review to unassessed or stale subjective dimensions"],
    ["--sha <sha>", "explicit commit SHA for `plan commit-log record`"],
    ["--branch <name>", "explicit branch name for `plan commit-log record`"],
    ["--merge [dir]", "merge batch-N.raw.txt files into a single review payload"],
    ["--import <file>", "import subjective review assessments and findings JSON"],
    ["--allow-partial", "allow partial review import"],
    ["--manual-override", "override target-anchoring check on review import"],
    ["--attested-external", "mark external review import as attested"],
    ["--strict-guard", "enforce strict import guard (scores < 85 require findings or rationale)"],
    ["--depth <n>", "max tree depth for `plexer health tree` (default 3)"],
    ["--focus <dir>", "focus `plexer health tree` on a subdirectory"],
    ["--min-loc <n>", "minimum LOC filter for `plexer health tree`"],
    ["--sort <by>", "sort `plexer health tree` by loc (default), issues, or coupling"],
    ["--detail", "include inline open findings per file in `plexer health tree`"],
    ["--output <file>", "output HTML path for `plexer health viz`"],
    ["--profile <name>", "scan profile (e.g. 'ci')"],
    ["--no-badge", "skip generating scorecard.svg on scan"],
    ["--reset-subjective", "reset subjective dimension scores to 0"],
    ["--dry-run", "preview autofix or move without modifying files"],
    ["--format <fmt>", "text (default) | markdown | json"],
    ["--markdown", "output as Markdown"],
    ["--json", "output as JSON"],
    NO_REFRESH_FLAG,
];

async function warnUnsupportedExtensions(exts, ctx) {
    if (!exts?.length) return;
    const { unsupportedExtensions, supportedExtensions } = await import("../graph/source-files.js");
    const bad = unsupportedExtensions(exts);
    if (bad.length === 0) return;
    for (const e of bad) {
        const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
        ctx.errLine(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
    }
    ctx.errLine(`  supported: ${supportedExtensions().join(" ")}`);
}

function parseTabs(raw, ctx) {
    if (raw === undefined) return undefined;
    const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
    const bad = want.filter((t) => !VIZ_TABS.includes(t));
    if (bad.length > 0 || want.length === 0) {
        ctx.errLine(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? ` — got "${bad.join('", "')}"` : ""}`);
        ctx.exit(1);
    }
    return want;
}

function resolveSessionIdFromEnv(env = process.env) {
    return (
        env.PLEXER_SESSION_ID ||
        env.ANTIGRAVITY_CONVERSATION_ID ||
        env.CLAUDE_SESSION_ID ||
        env.CURSOR_TRACE_ID ||
        null
    );
}

function collectRepeatableIn(val, prev) {
    const list = Array.isArray(prev) ? [...prev] : (prev ? [prev] : []);
    for (const part of String(val).split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!list.includes(part)) list.push(part);
    }
    return list.length === 1 ? list[0] : list;
}

const DASH_POS_CMD_OPTS = {
    grep: {
        bools: new Set(["-i", "--ignore-case", "-F", "--fixed", "--source", "--no-source", "--full", "--json", "--no-refresh", "--refresh", "--no-daemon", "-h", "--help"]),
        values: new Set(["--dir", "--session", "--in", "-C", "--context"]),
    },
    ask: {
        bools: new Set(["--source", "--no-source", "--full", "--json", "--no-graph-rank", "--graph-rank", "--no-refresh", "--refresh", "--no-daemon", "-h", "--help"]),
        values: new Set(["--dir", "--session", "--in", "-n", "--limit"]),
    },
};

function normalizeLeadingDashPositionalArgs(argv) {
    if (!Array.isArray(argv) || argv.length <= 3) return argv;
    let cmdIdx = -1;
    for (let i = 2; i < argv.length; i++) {
        const a = String(argv[i]);
        if (a === "--no-daemon" || a === "-v" || a === "-V" || a === "--version" || a === "-h" || a === "--help" || a.startsWith("--dir=") || a.startsWith("--session=")) continue;
        if ((a === "--dir" || a === "--session") && i + 1 < argv.length) { i++; continue; }
        if (!a.startsWith("-")) cmdIdx = i;
        break;
    }
    if (cmdIdx === -1) return argv;
    const spec = DASH_POS_CMD_OPTS[String(argv[cmdIdx])];
    if (!spec) return argv;
    const rest = argv.slice(cmdIdx + 1);
    const optTokens = [];
    const posTokens = [];
    let tailAfterDash = null;
    for (let i = 0; i < rest.length; i++) {
        const tok = String(rest[i]);
        if (tok === "--") { tailAfterDash = rest.slice(i); break; }
        const eqIdx = tok.indexOf("=");
        const flagName = eqIdx > 0 ? tok.slice(0, eqIdx) : tok;
        const attachedVal = /^-(?:C\d+|n\d+)$/.test(tok) || (spec.values.has(flagName) && eqIdx > 0);
        if (spec.bools.has(tok) || attachedVal) { optTokens.push(tok); continue; }
        if (spec.values.has(tok)) {
            optTokens.push(tok);
            if (i + 1 < rest.length) optTokens.push(String(rest[++i]));
            continue;
        }
        posTokens.push(tok);
    }
    if (!posTokens.some((t) => t.startsWith("-"))) return argv;
    return [...argv.slice(0, cmdIdx + 1), ...optTokens, "--", ...posTokens, ...(tailAfterDash ? tailAfterDash.slice(1) : [])];
}

function createIoContext(ioCtx = null) {
    const isCaptured = Boolean(ioCtx?.isCaptured || ioCtx?.writeOut || ioCtx?.writeErr || ioCtx?.exit);
    const cwd = ioCtx?.cwd || process.cwd();
    const sessionId = ioCtx?.sessionId ?? null;
    const sessionCache = ioCtx?.sessionCache ?? null;
    const probeDrift = typeof ioCtx?.probeDrift === "function" ? ioCtx.probeDrift : null;
    const antigravityPipeCap = Boolean(ioCtx?.antigravityPipeCap);
    const skipIgnoredScan = Boolean(ioCtx?.skipIgnoredScan);
    const skipPeelScopes = Boolean(ioCtx?.skipPeelScopes);
    const writeOut = ioCtx?.writeOut || ((chunk) => process.stdout.write(String(chunk ?? "")));
    const writeErr = ioCtx?.writeErr || ((chunk) => process.stderr.write(String(chunk ?? "")));
    const exit = ioCtx?.exit || ((code = 0) => process.exit(code));
    const outLine = (line = "") => writeOut(`${line}\n`);
    const errLine = (line = "") => writeErr(`${line}\n`);
    return { isCaptured, cwd, sessionId, sessionCache, probeDrift, antigravityPipeCap, skipIgnoredScan, skipPeelScopes, writeOut, writeErr, exit, outLine, errLine };
}

class ExternalCliExitSignal extends Error {
    constructor(code = 0) {
        super(`external CLI exit ${code}`);
        this.code = code;
    }
}

const capturedIoStorage = new AsyncLocalStorage();
let capturedStdioBridgeInstalled = false;

function installCapturedStdioBridge() {
    if (capturedStdioBridgeInstalled)
        return;
    capturedStdioBridgeInstalled = true;
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const origExit = process.exit.bind(process);
    process.stdout.write = (chunk, enc, cb) => {
        const io = capturedIoStorage.getStore();
        if (!io)
            return origOut(chunk, enc, cb);
        const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof enc === "string" ? enc : "utf8") : String(chunk ?? "");
        io.writeOut(text);
        if (typeof enc === "function") enc();
        else if (typeof cb === "function") cb();
        return true;
    };
    process.stderr.write = (chunk, enc, cb) => {
        const io = capturedIoStorage.getStore();
        if (!io)
            return origErr(chunk, enc, cb);
        const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof enc === "string" ? enc : "utf8") : String(chunk ?? "");
        io.writeErr(text);
        if (typeof enc === "function") enc();
        else if (typeof cb === "function") cb();
        return true;
    };
    process.exit = (code = 0) => {
        if (capturedIoStorage.getStore())
            throw new ExternalCliExitSignal(Number(code) || 0);
        return origExit(code);
    };
}

/**
 * Adapter for CLI modules invoked inside captured daemon/batch `ioCtx`.
 * Isolates concurrent calls via AsyncLocalStorage without mutating `process.chdir` or env.
 */
async function withCapturedExternalCli(io, fn) {
    if (!io.isCaptured)
        return fn();
    installCapturedStdioBridge();
    try {
        return await capturedIoStorage.run(io, fn);
    }
    catch (err) {
        if (err instanceof ExternalCliExitSignal) {
            io.exit(err.code);
            return undefined;
        }
        throw err;
    }
}

function createCliContext(program, currentVersion, ioCtx = null) {
    const io = createIoContext(ioCtx);
    const getGlobalDir = () => program.opts().dir;
    const getSessionId = () => program.opts().session || io.sessionId || resolveSessionIdFromEnv() || null;
    const cliConfig = () => ({ contextDir: getGlobalDir() });
    const splitTrailingDir = (arg, { requirePlexerDir = true } = {}) => {
        const rawList = Array.isArray(arg) ? [...arg] : [arg];
        let dirArg;
        if (rawList.length >= 2) {
            const candidateDir = rawList[rawList.length - 1];
            try {
                const absCand = resolve(io.cwd, candidateDir);
                if (existsSync(absCand) && statSync(absCand).isDirectory()) {
                    const hasIndex = hasPlexerIndex(absCand) || existsSync(join(absCand, "plexer")) || Boolean(getGlobalDir());
                    if (hasIndex || (!requirePlexerDir && isAutoBuildableRepo(absCand))) {
                        dirArg = rawList.pop();
                    }
                }
            } catch {
                // treat as argument
            }
        }
        return { rawList, dirArg };
    };
    const queryRoot = (dir) => {
        if (dir !== undefined) {
            const resolved = resolve(io.cwd, dir);
            let isDir = false;
            try {
                isDir = statSync(resolved).isDirectory();
            } catch {
                isDir = false;
            }
            if (!isDir) {
                io.errLine(`✗ directory not found: ${dir}`);
                io.exit(1);
            }
            const { root, levels } = cachedNearestPlexerRoot(resolved, getGlobalDir());
            if (levels > 0) io.errLine(`[plexer] no plexer/ in ${dir} — answering from ${root}/plexer`);
            return root;
        }
        const { root, levels } = cachedNearestPlexerRoot(io.cwd, getGlobalDir());
        if (levels > 0) io.errLine(`[plexer] no plexer/ here — answering from ${root}/plexer`);
        return root;
    };
    const isBlastRepoDir = (candidate) => {
        try {
            const abs = resolve(io.cwd, candidate);
            if (!statSync(abs).isDirectory()) return false;
            return Boolean(getGlobalDir()) || hasPlexerIndex(abs) || isAutoBuildableRepo(abs);
        } catch {
            return false;
        }
    };
    const refreshBefore = async (dir, opts, { bounded = false } = {}) => {
        if (opts.refresh === false) return;
        const globalDir = getGlobalDir();
        const root = resolve(io.cwd, dir);
        const [{ readWorkspaceMeta }, { ensureFreshChildren, ensureFreshGraph, refreshNote }] = await Promise.all([
            import("../graph/workspace-path.js"),
            import("../graph/refresh.js"),
        ]);
        const ws = readWorkspaceMeta(root, globalDir);
        if (ws) {
            const r = await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled: false });
            const note = refreshNote(r);
            if (note) io.errLine(note);
            return;
        }
        if (bounded) {
            const outDir = contextDirFor(root, globalDir);
            const [{ wiringPath }, { sqliteHasGraph }, { probeDrift, isClean, driftCount }, { triggerBackgroundSync }] = await Promise.all([
                import("../context/node-file.js"),
                import("../storage/sqlite-store.js"),
                import("../graph/fingerprint.js"),
                import("../claude/edit-hooks.js"),
            ]);
            if (sqliteHasGraph(outDir) || existsSync(wiringPath(outDir))) {
                const drift = io.probeDrift ? io.probeDrift(root, outDir) : probeDrift(root, outDir);
                if (drift !== null && isClean(drift)) return;
                if (drift === null || driftCount(drift) > 3) {
                    if (!globalDir) triggerBackgroundSync(root);
                    return;
                }
                let timedOut = false;
                let timer = null;
                const timeoutPromise = new Promise((resolveTimeout) => {
                    timer = setTimeout(() => {
                        timedOut = true;
                        resolveTimeout({ timedOut: true });
                    }, 400);
                    if (typeof timer.unref === "function") timer.unref();
                });
                const refreshPromise = ensureFreshGraph(root, { contextDir: globalDir, disabled: false });
                refreshPromise.catch(() => {});
                const winner = await Promise.race([refreshPromise, timeoutPromise]);
                if (timer) clearTimeout(timer);
                if (winner?.timedOut || timedOut) {
                    if (!globalDir) triggerBackgroundSync(root);
                    return;
                }
                const note = refreshNote(winner);
                if (note) io.errLine(note);
                return;
            }
        }
        const r = await ensureFreshGraph(root, { contextDir: globalDir, disabled: false });
        const note = refreshNote(r);
        if (note) io.errLine(note);
    };
    return {
        program,
        currentVersion,
        io,
        cwd: io.cwd,
        writeOut: io.writeOut,
        writeErr: io.writeErr,
        outLine: io.outLine,
        errLine: io.errLine,
        exit: io.exit,
        runExternal: (fn) => withCapturedExternalCli(io, fn),
        getGlobalDir,
        getSessionId,
        cliConfig,
        splitTrailingDir,
        queryRoot,
        isBlastRepoDir,
        refreshBefore,
    };
}

function parseBuildConfigOptions(opts, command, ctx) {
    const buildConfigPatch = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
        const cleanIncludes = [];
        for (const rawName of opts.includeDir) {
            const norm = normalizePathPrefix(rawName);
            if (!norm || norm === "." || isAbsolute(rawName) || rawName.startsWith("/") || norm.split("/").some((seg) => seg === ".." || seg.startsWith("."))) {
                if (rawName.startsWith(".")) {
                    ctx.errLine(`✗ --include-dir "${rawName}": dot-directories are never overridable`);
                }
                else {
                    ctx.errLine(`✗ --include-dir "${rawName}": expected a clean repo-relative directory name or prefix`);
                }
                ctx.exit(1);
            }
            cleanIncludes.push(norm);
        }
        buildConfigPatch.includeDirs = cleanIncludes;
    }
    let onlyDirs;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
        const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
        if (normalized.length === 0) {
            ctx.errLine("✗ --only-dir: expected a non-empty repo-relative path");
            ctx.exit(1);
        }
        onlyDirs = normalized;
    }
    const followSubmodulesWasExplicit = command.getOptionValueSource("followSubmodules") === "cli";
    if (followSubmodulesWasExplicit && typeof opts.followSubmodules === "boolean") {
        buildConfigPatch.followSubmodules = opts.followSubmodules;
    }
    const followNestedReposWasExplicit = command.getOptionValueSource("followNestedRepos") === "cli";
    if (followNestedReposWasExplicit && typeof opts.followNestedRepos === "boolean") {
        buildConfigPatch.followNestedRepos = opts.followNestedRepos;
    }
    return { buildConfigPatch, onlyDirs, followSubmodulesWasExplicit, followNestedReposWasExplicit };
}

async function executeBuildCommand(ctx, dir, opts, command) {
    if (opts.gitignore === false) process.env.PLEXER_NO_GITIGNORE = "1";
    if (opts.ignore === false) process.env.PLEXER_NO_IGNORE = "1";
    await warnUnsupportedExtensions(opts.extensions, ctx);
    const { buildConfigPatch, onlyDirs, followSubmodulesWasExplicit, followNestedReposWasExplicit } = parseBuildConfigOptions(opts, command, ctx);
    const buildRoot = resolve(ctx.cwd, dir);
    const buildGlobalDir = ctx.getGlobalDir();
    if (Object.keys(buildConfigPatch).length > 0) {
        const { patchBuildConfig } = await import("../util/state.js");
        patchBuildConfig(buildRoot, buildConfigPatch, buildGlobalDir);
    }
    const { isWorkspaceBuildRoot } = await import("../graph/workspace.js");
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
        const { runWorkspaceBuild } = await import("../graph/workspace-cli.js");
        await ctx.runExternal(() => runWorkspaceBuild(buildRoot, {
            extensions: opts.extensions,
            reuse: opts.reuse,
            childConfig: ctx.cliConfig(),
            override: buildGlobalDir,
            includeDirs: opts.includeDir,
            followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
            followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
        }));
        return;
    }
    const { buildGraph } = await import("../graph/build.js");
    const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
    const g = await buildGraph(buildRoot, {
        contextDir: buildGlobalDir,
        extensions: opts.extensions,
        reuse: opts.reuse,
        onlyDirs,
        cards: Boolean(opts.cards),
        onProgress: ({ index, total, file }) =>
            ctx.writeErr(`\rparsing ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`),
    });
    ctx.writeErr("\n");
    ctx.outLine(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    ctx.outLine(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    if (g.seededFrom) ctx.outLine(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    ctx.outLine(`  → ${g.contextDir}`);
    for (const e of g.errors) ctx.errLine(`✗ ${e}`);
    const rel = relative(ctx.cwd, g.contextDir) || "plexer";
    if (process.env.PLEXER_NO_GITIGNORE) {
        ctx.outLine(`  ${rel}/ is a local cache — add it to your gitignore if you want it untracked.`);
    } else {
        ctx.outLine(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`plexer build\` to get their own.`);
    }
}

async function executeCheckCommand(ctx, dirArg, opts) {
    await warnUnsupportedExtensions(opts.extensions, ctx);
    const dir = ctx.queryRoot(dirArg);
    const checkGlobalDir = ctx.getGlobalDir();
    const { readWorkspaceMeta } = await import("../graph/workspace-path.js");
    if (readWorkspaceMeta(dir, checkGlobalDir)) {
        const { runWorkspaceCheck } = await import("../graph/workspace-cli.js");
        await ctx.runExternal(() => runWorkspaceCheck(dir, checkGlobalDir, { json: opts.json, extensions: opts.extensions }));
        return;
    }
    const { checkGraph, formatGraphCheckReport } = await import("../graph/check.js");
    const g = await checkGraph(dir, { extensions: opts.extensions, contextDir: checkGlobalDir });
    if (opts.json) {
        ctx.outLine(JSON.stringify({ graph: g.missing ? null : g }, null, 2));
    } else if (g.missing) {
        ctx.outLine("plexer check: NO GRAPH\n\nNo plexer/ graph found. Run `plexer build` first.");
    } else {
        ctx.outLine(formatGraphCheckReport(g));
    }
    if (g.missing || !g.ok) ctx.exit(1);
}

function registerBuildAndCheckCommands(program, ctx) {
    program
        .command("version")
        .description("Print the installed plexer version")
        .action(() => {
            ctx.outLine(`plexer ${ctx.currentVersion}`);
        });

    program
        .command("build")
        .description("Build plexer/ from your code — structural wiring graph + SQLite index; pass --cards for optional markdown ($0, offline)")
        .argument("[dir]", "repository root", ".")
        .option("-e, --extensions <exts...>", 'code extensions to include (e.g. ".luau" ".ts" ".py")')
        .option("--no-reuse", "re-parse every file instead of replaying unchanged ones from the extraction cache")
        .option("--follow-submodules", "include initialized Git submodules recursively; persisted for later builds")
        .option("--no-follow-submodules", "exclude Git submodules (default)")
        .option("--follow-nested-repos", "include nested Git clones as ONE graph; persisted for later builds")
        .option("--no-follow-nested-repos", "exclude untracked nested Git clones (default)")
        .option("--include-dir <name>", "override SKIP_DIRS for this repo's walks — repeatable", (val, prev) => [...prev, val], [])
        .option("--only-dir <path>", "only index files under this repo-relative path — repeatable", (val, prev) => [...prev, val], [])
        .option("--cards", "also write passive per-file markdown cards (plexer/<dir>/<file>.md and INDEX.md)")
        .option("--no-gitignore", "skip writing plexer/ into .gitignore (same as PLEXER_NO_GITIGNORE=1)")
        .option("--no-ignore", "skip writing .ignore for ripgrep re-admit (same as PLEXER_NO_IGNORE=1)")
        .action((dir, opts, command) => executeBuildCommand(ctx, dir, opts, command));

    program
        .command("check")
        .description("Fail if plexer/ is stale relative to the code (for CI)")
        .argument(...DIR_ARG)
        .option("-e, --extensions <exts...>", "code extensions to include")
        .option("--json", "output the drift as JSON")
        .action((dirArg, opts) => executeCheckCommand(ctx, dirArg, opts));
}

function splitAskQueries(rawList) {
    return rawList.flatMap((q) => {
        const str = String(q).trim();
        if (!str.includes(";")) return [str];
        const parts = str.split(";").map((s) => s.trim()).filter(Boolean);
        return parts.length >= 2 && parts.every((p) => p.split(/\s+/).length >= 2) ? parts : [str];
    });
}

async function executeWorkspaceAsk(ctx, dir, askGlobalDir, queries, limitOpt, useSource, opts) {
    const { runWorkspaceAsk } = await import("../graph/workspace-cli.js");
    const sessionId = ctx.getSessionId();
    let agyState = null;
    if (!opts.full && sessionId && !opts.json) {
        const { readEngineSession } = await import("../hosts/engine/agy-context.js");
        agyState = readEngineSession(sessionId, { sessionCache: ctx.io.sessionCache });
    }
    try {
        await ctx.runExternal(() => {
            for (const query of queries) {
                runWorkspaceAsk(dir, askGlobalDir, query, {
                    limit: limitOpt, source: useSource, full: opts.full, in: opts.in, graphRank: opts.graphRank, json: opts.json,
                    seenSpans: agyState?.seenSpans ?? null,
                });
            }
        });
        if (agyState && sessionId) {
            const { saveAgyContext } = await import("../hosts/engine/agy-context.js");
            saveAgyContext(sessionId, agyState, { sessionCache: ctx.io.sessionCache });
        }
    } catch (err) {
        ctx.errLine(`✗ ${err instanceof Error ? err.message : String(err)}`);
        ctx.exit(1);
    }
}

function collectLocalAskResults(ctx, dir, askGlobalDir, askFn, queries, limitOpt, useSource, opts) {
    const results = [];
    const perQueryLimit = limitOpt !== undefined ? limitOpt : queries.length > 1 ? 3 : undefined;
    const seenPointers = queries.length > 1 ? new Set() : undefined;
    try {
        for (let i = 0; i < queries.length; i++) {
            const maxHitsToInline = queries.length > 1 ? 1 : undefined;
            const maxSourceBytes = queries.length > 1
                ? (opts.full ? 2800 : Math.max(950, Math.min(2100, Math.floor(7200 / queries.length))))
                : undefined;
            results.push(askFn(dir, queries[i], {
                limit: perQueryLimit, source: useSource, full: opts.full, in: opts.in, graphRank: opts.graphRank,
                seenPointers, maxSourceBytes, maxHitsToInline, contextDir: askGlobalDir,
            }));
        }
        return results;
    } catch (err) {
        ctx.errLine(`✗ ${err instanceof Error ? err.message : String(err)}`);
        ctx.exit(1);
        return null;
    }
}

async function renderLocalAskOutput(ctx, results, queries, opts, formatAsk) {
    if (opts.json) {
        ctx.outLine(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
        return;
    }
    const sessionId = ctx.getSessionId();
    let renderResults = results;
    if (sessionId) {
        const [{ readEngineSession, saveAgyContext }, { applySeenSpansFilter, recordRetrievalSpans }] = await Promise.all([
            import("../hosts/engine/agy-context.js"),
            import("../agy/spans.js"),
        ]);
        const agyState = readEngineSession(sessionId, { sessionCache: ctx.io.sessionCache });
        if (!agyState.seenSpans || typeof agyState.seenSpans !== "object") agyState.seenSpans = {};
        renderResults = results.map((r) => {
            const { ask: filtered } = !opts.full ? applySeenSpansFilter(r, agyState.seenSpans) : { ask: r };
            recordRetrievalSpans(agyState.seenSpans, r);
            return filtered;
        });
        saveAgyContext(sessionId, agyState, { sessionCache: ctx.io.sessionCache });
    }
    if (queries.length > 1 && !opts.full) {
        const rendered = renderResults.map((r) => formatAsk(r).trimEnd());
        for (let i = renderResults.length - 1; i >= 1 && Buffer.byteLength(rendered.join("\n\n"), "utf8") > 7800; i--) {
            for (const h of renderResults[i].hits ?? []) delete h.code;
            rendered[i] = formatAsk(renderResults[i]).trimEnd();
        }
        ctx.writeOut(rendered.join("\n\n") + "\n");
        return;
    }
    ctx.writeOut(renderResults.map((r) => formatAsk(r).trimEnd()).join("\n\n") + "\n");
}

async function executeAskAction(ctx, queriesArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(queriesArg, { requirePlexerDir: false });
    const queries = splitAskQueries(rawList);
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts, { bounded: true });
    const askGlobalDir = ctx.getGlobalDir();
    const limitOpt = opts.limit !== undefined ? Number(opts.limit) : undefined;
    if (limitOpt !== undefined && (!Number.isInteger(limitOpt) || limitOpt < 1)) {
        ctx.errLine(`✗ invalid --limit "${opts.limit}" — expected a positive integer`);
        ctx.exit(1);
    }
    const useSource = opts.full ? true : opts.source !== false;
    const { readWorkspaceMeta } = await import("../graph/workspace-path.js");
    if (readWorkspaceMeta(dir, askGlobalDir)) {
        await executeWorkspaceAsk(ctx, dir, askGlobalDir, queries, limitOpt, useSource, opts);
        return;
    }
    const { ask, formatAsk } = await import("../ask/ask.js");
    const results = collectLocalAskResults(ctx, dir, askGlobalDir, ask, queries, limitOpt, useSource, opts);
    if (results) await renderLocalAskOutput(ctx, results, queries, opts, formatAsk);
}

function formatBatchedSkeletons(rawResults, formatSkeleton) {
    const results = rawResults.flatMap((r) =>
        Array.isArray(r.files) && r.files.length > 1
            ? r.files.map((f) => ({ file: f, entries: (r.entries ?? []).filter((e) => e.file === f), isDirExpanded: true }))
            : [{ ...r, isDirExpanded: false }],
    );
    let blocks = results.map((r) => formatSkeleton(r).trimEnd());
    if (Buffer.byteLength(blocks.join("\n\n"), "utf8") <= 7800)
        return blocks.join("\n\n") + "\n";
    blocks = results.map((r) => formatSkeleton(r, { compact: true }).trimEnd());
    if (Buffer.byteLength(blocks.join("\n\n"), "utf8") <= 7800)
        return blocks.join("\n\n") + "\n";
    const downgradeIndices = [
        ...results.map((r, i) => (r.isDirExpanded ? i : -1)).filter((i) => i >= 0).reverse(),
        ...results.map((r, i) => (!r.isDirExpanded ? i : -1)).filter((i) => i >= 1).reverse(),
    ];
    for (const i of downgradeIndices) {
        if (Buffer.byteLength(blocks.join("\n\n"), "utf8") <= 7800)
            break;
        blocks[i] = formatSkeleton(results[i], { summaryOnly: true }).trimEnd();
    }
    if (Buffer.byteLength(blocks.join("\n\n"), "utf8") > 7800) {
        let dropped = 0;
        const dirIndices = results.map((r, i) => (r.isDirExpanded ? i : -1)).filter((i) => i >= 0).reverse();
        for (const i of dirIndices) {
            if (Buffer.byteLength(blocks.filter(Boolean).join("\n\n"), "utf8") <= 7600)
                break;
            blocks[i] = null;
            dropped++;
        }
        const kept = blocks.filter(Boolean);
        if (dropped > 0)
            kept.push(`… (+${dropped} more files — narrow directory or run \`plexer skeleton <file>\`)`);
        return `${kept.join("\n\n")}\n`;
    }
    return blocks.join("\n\n") + "\n";
}

async function executeSkeletonAction(ctx, filesArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(filesArg);
    const files = rawList.flatMap((f) => String(f).split(",").map((x) => x.trim()).filter(Boolean));
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts, { bounded: true });
    const [{ skeleton, formatSkeleton }, { readWorkspaceMeta }] = await Promise.all([
        import("../ask/skeleton.js"),
        import("../graph/workspace-path.js"),
    ]);
    const globalDir = ctx.getGlobalDir();
    const skelOpts = { allMatches: Boolean(opts.allMatches), contextDir: globalDir };
    const isWs = Boolean(readWorkspaceMeta(dir, globalDir));
    const federateSkeleton = isWs ? (await import("../graph/workspace.js")).federateSkeleton : null;
    if (files.length === 1) {
        const r = isWs ? federateSkeleton(dir, globalDir, files[0], skelOpts) : skeleton(dir, files[0], skelOpts);
        if (opts.json) ctx.outLine(JSON.stringify(r, null, 2));
        else if (Array.isArray(r.files) && r.files.length > 1 && !opts.allMatches) ctx.writeOut(formatBatchedSkeletons([r], formatSkeleton));
        else ctx.writeOut(formatSkeleton(r));
        if (!r.entries?.length && (r.note || r.error)) ctx.exit(1);
        return;
    }
    const results = files.map((file) => (isWs ? federateSkeleton(dir, globalDir, file, skelOpts) : skeleton(dir, file, skelOpts)));
    if (opts.json) {
        ctx.outLine(JSON.stringify(results, null, 2));
    } else {
        ctx.writeOut(formatBatchedSkeletons(results, formatSkeleton));
    }
    if (results.every((r) => !r.entries?.length && (r.note || r.error))) ctx.exit(1);
}

async function executeReadAction(ctx, spansArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(spansArg);
    const dir = ctx.queryRoot(dirArg);
    const globalDir = ctx.getGlobalDir();
    const [{ canFastSliceExplicitSpans, readSpans, formatReadSpans }, { readWorkspaceMeta }] = await Promise.all([
        import("../ask/read-spans.js"),
        import("../graph/workspace-path.js"),
    ]);
    const isWs = Boolean(readWorkspaceMeta(dir, globalDir));
    const federateRead = isWs ? (await import("../graph/workspace.js")).federateRead : null;
    if (isWs || opts.callers || !canFastSliceExplicitSpans(dir, rawList)) {
        await ctx.refreshBefore(dir, opts, { bounded: true });
    }
    const full = Boolean(opts.full);
    const callers = Boolean(opts.callers);
    const agyPipeCap = Boolean(ctx.io.antigravityPipeCap);
    const sessionId = ctx.getSessionId();
    let agyState = null;
    if (!full && sessionId) {
        const { readEngineSession } = await import("../hosts/engine/agy-context.js");
        agyState = readEngineSession(sessionId, { sessionCache: ctx.io.sessionCache });
    }
    const r = isWs
        ? federateRead(dir, globalDir, rawList, { full, callers, seenSpans: agyState?.seenSpans, antigravityPipeCap: agyPipeCap })
        : readSpans(dir, rawList, { contextDir: globalDir, full, callers, seenSpans: agyState?.seenSpans, antigravityPipeCap: agyPipeCap });
    const rendered = opts.json ? "" : formatReadSpans(r);
    if (sessionId && Array.isArray(r?.blocks)) {
        const [{ readEngineSession, saveAgyContext }, { mergeSpan }] = await Promise.all([
            import("../hosts/engine/agy-context.js"),
            import("../agy/spans.js"),
        ]);
        const targetState = agyState ?? readEngineSession(sessionId, { sessionCache: ctx.io.sessionCache });
        if (!targetState.seenSpans || typeof targetState.seenSpans !== "object")
            targetState.seenSpans = {};
        const overAgyPipe = (agyPipeCap || process.env.ANTIGRAVITY_AGENT === "1") && rendered && Buffer.byteLength(rendered, "utf8") > 9500;
        let touched = false;
        if (!overAgyPipe) {
            for (const blk of r.blocks) {
                if (!blk?.error && !blk.alreadySeen && blk.file && blk.startLine && blk.endLine) {
                    mergeSpan(targetState.seenSpans, blk.file, blk.startLine, blk.endLine);
                    touched = true;
                }
            }
        } else {
            const first = r.blocks.find((b) => b && !b.error && !b.alreadySeen && b.file && b.code);
            if (first) {
                let bytes = Buffer.byteLength(`${first.file}:${first.span} (of ${first.totalLines} lines)\n\`\`\`\n`, "utf8");
                let safeEnd = first.startLine - 1;
                for (const ln of String(first.code).split("\n")) {
                    const lb = Buffer.byteLength(ln, "utf8") + 1;
                    if (bytes + lb > 4200) break;
                    const m = /^L?(\d+):/.exec(ln);
                    if (m) safeEnd = Number(m[1]);
                    bytes += lb;
                }
                if (safeEnd >= first.startLine) {
                    mergeSpan(targetState.seenSpans, first.file, first.startLine, safeEnd);
                    touched = true;
                }
            }
        }
        if (touched) saveAgyContext(sessionId, targetState, { sessionCache: ctx.io.sessionCache });
    }
    if (opts.json) {
        ctx.outLine(JSON.stringify(r, null, 2));
    } else {
        ctx.writeOut(rendered);
    }
    if (r.blocks.every((b) => b.error)) ctx.exit(1);
}

class BatchExitSignal extends Error {
    constructor(code = 0) {
        super(`batch subcommand exit ${code}`);
        this.code = code;
    }
}

async function runBatchSubcommandCaptured(ctx, subArgv, extraIo = {}) {
    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    try {
        await runCli(["node", "plexer", ...subArgv], {
            isCaptured: true,
            cwd: ctx.cwd,
            sessionId: ctx.getSessionId(),
            sessionCache: ctx.io.sessionCache,
            antigravityPipeCap: ctx.io.antigravityPipeCap,
            skipIgnoredScan: Boolean(extraIo.skipIgnoredScan),
            skipPeelScopes: Boolean(extraIo.skipPeelScopes),
            writeOut: (chunk, enc) => {
                stdout += Buffer.isBuffer(chunk) ? chunk.toString(typeof enc === "string" ? enc : "utf8") : String(chunk ?? "");
            },
            writeErr: (chunk, enc) => {
                stderr += Buffer.isBuffer(chunk) ? chunk.toString(typeof enc === "string" ? enc : "utf8") : String(chunk ?? "");
            },
            exit: (code = 0) => {
                throw new BatchExitSignal(Number(code) || 0);
            },
        });
    } catch (err) {
        if (err instanceof BatchExitSignal) {
            exitCode = err.code;
        } else {
            exitCode = 1;
            stderr += `${err instanceof Error ? err.message : String(err)}\n`;
        }
    }
    return { stdout, stderr, exitCode };
}

function parseBatchCoalescibleGrep(argv) {
    if (!Array.isArray(argv) || argv[0] !== "grep")
        return null;
    let fixed = false;
    let ignoreCase = false;
    let context = null;
    let source = null;
    let full = false;
    let noRefresh = false;
    let forceRefresh = false;
    let dir = null;
    let session = null;
    const inScopes = [];
    const positionals = [];
    const readVal = (tok, i) => {
        const eq = tok.indexOf("=");
        if (eq > 0) return { val: tok.slice(eq + 1), nextIdx: i };
        if (i + 1 >= argv.length) return null;
        return { val: String(argv[i + 1]), nextIdx: i + 1 };
    };
    for (let i = 1; i < argv.length; i++) {
        const tok = String(argv[i] ?? "");
        if (!tok) continue;
        if (tok === "--") return null;
        if (tok === "-F" || tok === "--fixed") { fixed = true; continue; }
        if (tok === "-i" || tok === "--ignore-case") { ignoreCase = true; continue; }
        if (/^-[iF]{2,}$/.test(tok)) {
            if (tok.includes("F")) fixed = true;
            if (tok.includes("i")) ignoreCase = true;
            continue;
        }
        if (tok === "--source") { source = true; continue; }
        if (tok === "--no-source") { source = false; continue; }
        if (tok === "--full") { full = true; continue; }
        if (tok === "--no-refresh") { noRefresh = true; continue; }
        if (tok === "--refresh") { forceRefresh = true; continue; }
        if (tok === "--in" || tok.startsWith("--in=")) {
            const r = readVal(tok, i);
            if (!r) return null;
            inScopes.push(...r.val.split(",").map((s) => s.trim()).filter(Boolean));
            i = r.nextIdx;
            continue;
        }
        if (tok === "-C" || tok === "--context" || tok.startsWith("--context=")) {
            const r = readVal(tok, i);
            if (!r) return null;
            context = r.val;
            i = r.nextIdx;
            continue;
        }
        if (tok === "--dir" || tok.startsWith("--dir=")) {
            const r = readVal(tok, i);
            if (!r) return null;
            dir = r.val;
            i = r.nextIdx;
            continue;
        }
        if (tok === "--session" || tok.startsWith("--session=")) {
            const r = readVal(tok, i);
            if (!r) return null;
            session = r.val;
            i = r.nextIdx;
            continue;
        }
        if (tok.startsWith("-")) return null;
        positionals.push(tok);
    }
    if (positionals.length !== 1 || positionals[0].startsWith("-"))
        return null;
    const normIn = [...new Set(inScopes)].sort();
    const key = JSON.stringify({ fixed, ignoreCase, context, source, full, dir, session, in: normIn });
    return { key, fixed, ignoreCase, context, source, full, noRefresh, forceRefresh, dir, session, inScopes: normIn, pattern: positionals[0] };
}

function buildCoalescedBatchQueue(commands, parentSessionId, parentDir) {
    const groupsByKey = new Map();
    const entries = [];
    for (let i = 0; i < commands.length; i++) {
        const parsed = parseBatchCoalescibleGrep(commands[i]);
        if (!parsed) {
            entries.push({ firstIdx: i, argv: [...commands[i]], coalescedMultiGrep: false });
            continue;
        }
        const existing = groupsByKey.get(parsed.key);
        if (existing) {
            existing.patterns.push(parsed.pattern);
            if (parsed.forceRefresh) existing.forceRefresh = true;
            if (!parsed.noRefresh) existing.noRefresh = false;
        } else {
            const group = { ...parsed, firstIdx: i, patterns: [parsed.pattern], isGroup: true };
            groupsByKey.set(parsed.key, group);
            entries.push(group);
        }
    }
    return entries.map((e) => {
        if (!e.isGroup || e.patterns.length < 2) {
            const subArgv = [];
            const raw = e.isGroup ? commands[e.firstIdx] : e.argv;
            const hasSession = raw.some((a) => a === "--session" || a.startsWith("--session="));
            const hasDir = raw.some((a) => a === "--dir" || a.startsWith("--dir="));
            if (parentSessionId && !hasSession) subArgv.push("--session", parentSessionId);
            if (parentDir && !hasDir) subArgv.push("--dir", parentDir);
            subArgv.push(...raw);
            if (e.firstIdx > 0 && !subArgv.includes("--no-refresh") && !subArgv.includes("--refresh")) {
                subArgv.push("--no-refresh");
            }
            return { subArgv, skipPeelScopes: false };
        }
        const subArgv = ["grep"];
        if (e.session || parentSessionId) subArgv.push("--session", e.session || parentSessionId);
        if (e.dir || parentDir) subArgv.push("--dir", e.dir || parentDir);
        if (e.fixed) subArgv.push("-F");
        if (e.ignoreCase) subArgv.push("-i");
        if (e.context !== null) subArgv.push("-C", String(e.context));
        if (e.source === true) subArgv.push("--source");
        else if (e.source === false) subArgv.push("--no-source");
        if (e.full) subArgv.push("--full");
        for (const sc of e.inScopes) subArgv.push("--in", sc);
        if (e.noRefresh || (e.firstIdx > 0 && !e.forceRefresh)) subArgv.push("--no-refresh");
        else if (e.forceRefresh) subArgv.push("--refresh");
        subArgv.push(...e.patterns);
        return { subArgv, skipPeelScopes: true };
    });
}

async function executeBatchAction(ctx, payloadArgs) {
    const { decodeBatchPayload, poolBatchOutputs } = await import("./batch.js");
    const commands = decodeBatchPayload(payloadArgs);
    if (commands.length === 0) {
        ctx.errLine("✗ _batch: no valid read-only commands supplied");
        ctx.exit(1);
        return;
    }
    const parentSessionId = ctx.getSessionId();
    const parentDir = ctx.getGlobalDir();
    const queue = buildCoalescedBatchQueue(commands, parentSessionId, parentDir);
    const blocks = [];
    const errors = [];
    let anySuccess = false;
    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        const res = await runBatchSubcommandCaptured(ctx, item.subArgv, {
            skipIgnoredScan: blocks.length > 0,
            skipPeelScopes: item.skipPeelScopes,
        });
        if (res.stdout.trim())
            blocks.push(res.stdout.trimEnd());
        if (res.stderr.trim())
            errors.push(res.stderr.trimEnd());
        if (res.exitCode === 0)
            anySuccess = true;
    }
    if (errors.length > 0)
        ctx.writeErr(`${errors.join("\n")}\n`);
    const pooled = poolBatchOutputs(blocks);
    if (pooled)
        ctx.writeOut(pooled);
    if (!anySuccess)
        ctx.exit(1);
}

function registerQueryCommands(program, ctx) {
    program
        .command("ask")
        .description("Query the plexer/ graph — returns ranked nodes + exact file:line with source excerpts ($0, offline)")
        .argument("<queries...>", "one or more plain-word queries (or semicolon-separated sub-queries)")
        .option("-n, --limit <n>", "max results (default: 5 with source, 8 with --no-source)")
        .option("--source", "inline the source at each file:line hit (default: true)")
        .option("--no-source", "return file:line pointers only without inlined source")
        .option("--full", "inline whole definition spans instead of compact crux excerpts")
        .option("--in <path>", "narrow to nodes under this path prefix — repeatable", collectRepeatableIn)
        .option("--json", "output the result as JSON")
        .option("--no-graph-rank", "rank by lexical relevance only, without the graph-connectivity re-rank")
        .option(...NO_REFRESH_FLAG)
        .action((queriesArg, opts) => executeAskAction(ctx, queriesArg, opts));

    program
        .command("skeleton")
        .description("Signatures-only view of one or more files from the wiring graph — the cheapest way to see a file's API surface")
        .argument("<files...>", "one or more repo-relative paths (or unique basenames) of files")
        .option("--all-matches", "return skeletons for all matching files when the path is ambiguous")
        .option("--json", "output the result as JSON")
        .option(...NO_REFRESH_FLAG)
        .action((filesArg, opts) => executeSkeletonAction(ctx, filesArg, opts));

    program
        .command("read")
        .description("Read one or more exact file:Lx-Ly line spans or file:symbol spans (or unique basenames) with L<n>: line numbers ($0, offline)")
        .argument("<spans...>", "one or more file:Lx-Ly, file:Lx, file:symbol, or file spans")
        .option("--full", "return full requested spans without the 9 KB batch cap")
        .option("--callers", "append top cross-file callers for symbols inside each read span")
        .option("--json", "output the result as JSON")
        .option(...NO_REFRESH_FLAG)
        .action((spansArg, opts) => executeReadAction(ctx, spansArg, opts));

    program
        .command("_batch", { hidden: true })
        .description("Internal batched read-only runner bounded under 9 KB stdout")
        .argument("<payload...>", "base64url JSON argv list or ';;'-separated commands")
        .action((payloadArgs) => executeBatchAction(ctx, payloadArgs));
}

async function runCallersAction(ctx, symbolsArg, opts, forcedDirection) {
    const { rawList, dirArg } = ctx.splitTrailingDir(symbolsArg);
    const symbols = rawList.flatMap((s) => String(s).split(",").map((x) => x.trim()).filter(Boolean));
    const symbolOrList = symbols.length === 1 ? symbols[0] : symbols;
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts, { bounded: true });
    const globalDir = ctx.getGlobalDir();
    const [{ runCallersCommand, resolveDirection, resolveCliDepth }, { readWorkspaceMeta }] = await Promise.all([
        import("../graph/traverse-cli.js"),
        import("../graph/workspace-path.js"),
    ]);
    const direction = resolveDirection(forcedDirection ?? opts.direction);
    const depth = resolveCliDepth(opts.depth);
    const useSource = opts.full ? true : opts.source !== false;
    if (readWorkspaceMeta(dir, globalDir)) {
        const { runWorkspaceCallers } = await import("../graph/workspace-cli.js");
        const sessionId = ctx.getSessionId();
        let agyState = null;
        if (!opts.full && sessionId && !opts.json) {
            const { readEngineSession } = await import("../hosts/engine/agy-context.js");
            agyState = readEngineSession(sessionId, { sessionCache: ctx.io.sessionCache });
        }
        await ctx.runExternal(() => runWorkspaceCallers(dir, globalDir, symbolOrList, {
            direction, depth, in: opts.in, source: useSource, full: opts.full, json: opts.json,
            seenSpans: agyState?.seenSpans ?? null,
        }));
        if (agyState && sessionId) {
            const { saveAgyContext } = await import("../hosts/engine/agy-context.js");
            saveAgyContext(sessionId, agyState, { sessionCache: ctx.io.sessionCache });
        }
        return;
    }
    await ctx.runExternal(() => runCallersCommand(symbolOrList, dir, {
        direction, depth: opts.depth, in: opts.in, source: useSource, full: opts.full, json: opts.json, globalDir, sessionId: ctx.getSessionId(),
    }));
}

async function executeBlastAction(ctx, firstArg, secondArg, opts) {
    let base = opts.base;
    let dirArg;
    if (secondArg !== undefined) {
        if (opts.base !== undefined) {
            ctx.errLine(`✗ cannot pass both --base "${opts.base}" and a positional base ref "${firstArg}"`);
            ctx.exit(1);
        }
        base = firstArg;
        dirArg = secondArg;
    } else if (firstArg !== undefined) {
        if (opts.base !== undefined || ctx.isBlastRepoDir(firstArg)) {
            dirArg = firstArg;
        } else {
            base = firstArg;
        }
    }
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts);
    const format = opts.format ?? (opts.json ? "json" : opts.markdown ? "markdown" : opts.mermaid ? "mermaid" : undefined);
    const { runBlastCommand } = await import("../blast/blast-cli.js");
    await ctx.runExternal(() => runBlastCommand(dir, {
        base, depth: opts.depth, format, exportViz: opts.exportViz, title: opts.title,
        owners: opts.owners, prAuthor: opts.prAuthor, globalDir: ctx.getGlobalDir(),
    }));
}

function registerCallersAndBlastCommands(program, ctx) {
    program
        .command("callers")
        .description("Who calls/references a symbol ($0, offline). --direction out gives callees; --depth N (or all) walks transitively")
        .argument("<symbols...>", "one or more symbol names: bare, qualified (Class.method), or file path")
        .option("--direction <in|out>", 'edge direction: "in" = callers (default), "out" = callees')
        .option("-d, --depth <n>", 'walk transitively up to N hops for blast radius, or "all" for the full connected closure (default 1)')
        .option("--source", "inline definition and call-site source excerpts for the target and top callers (default: true)")
        .option("--no-source", "return symbol headers and 1-line call quotes only without full source blocks")
        .option("--full", "inline extended source excerpts")
        .option("--in <path>", "narrow matches to nodes at or under this path prefix — repeatable", collectRepeatableIn)
        .option("--json", "output as JSON")
        .option(...NO_REFRESH_FLAG)
        .action((symbols, opts) => runCallersAction(ctx, symbols, opts));

    const registerAlias = (cmdName, description, defaultDepth, direction) => {
        const cmd = program
            .command(cmdName)
            .description(description)
            .argument("<symbols...>", "one or more symbol names: bare, qualified (Class.method), or file path");
        if (defaultDepth !== undefined) {
            cmd.option("-d, --depth <n>", `walk transitively up to N hops, or "all" for the full connected closure (default ${defaultDepth})`, defaultDepth);
        } else {
            cmd.option("-d, --depth <n>", 'walk transitively up to N hops, or "all" for the full connected closure (default 1)');
        }
        cmd.option("--source", "inline definition and call-site source excerpts (default: true)")
            .option("--no-source", "return symbol headers and 1-line call quotes only")
            .option("--full", "inline extended source excerpts")
            .option("--in <path>", "narrow matches to nodes at or under this path prefix — repeatable", collectRepeatableIn)
            .option("--json", "output as JSON")
            .option(...NO_REFRESH_FLAG)
            .action((symbols, opts) => runCallersAction(ctx, symbols, opts, direction));
    };

    registerAlias("callees", "What a symbol calls/references ($0, offline) — alias for `plexer callers <symbol> --direction out`", undefined, "out");
    registerAlias("impact", "Transitive callers of a symbol ($0, offline) — alias for `plexer callers <symbol> --depth 2`", "2", "in");

    program
        .command("blast")
        .description("Blast radius of a diff: what depends on the lines this change touched ($0, offline)")
        .argument("[baseOrDir]", "base git ref (e.g. origin/main) or repository root")
        .argument("[dir]", "repository root (when a base ref is passed first)")
        .option("--base <ref>", "diff against this ref's merge base with HEAD (e.g. origin/main); default: working tree vs HEAD")
        .option("-d, --depth <n>", 'hops to walk over incoming edges, or "all" for the full closure (default 2)')
        .option("--format <fmt>", "text (default) | markdown | mermaid | json")
        .option("--markdown", "output as PR-ready Markdown (shorthand for --format markdown)")
        .option("--mermaid", "output as a Mermaid diagram (shorthand for --format mermaid)")
        .option("--json", "output as JSON (shorthand for --format json)")
        .option("--export-viz <dir>", "also write the interactive page for this radius (one self-contained index.html)")
        .option("--title <text>", "subtitle beside the repo name on the exported page")
        .option("--no-owners", "do not suggest who to tag from git history")
        .option("--pr-author <who...>", "GitHub login, git name or email of the PR author to exclude from owner suggestions")
        .option(...NO_REFRESH_FLAG)
        .action((firstArg, secondArg, opts) => executeBlastAction(ctx, firstArg, secondArg, opts));
}

function resolveGrepArgsAndDir(ctx, patternsArg) {
    const globalDir = ctx.getGlobalDir();
    let cwdRoot = null;
    try {
        const nearest = cachedNearestPlexerRoot(ctx.cwd, globalDir);
        if (nearest?.root && (hasPlexerIndex(nearest.root) || existsSync(contextDirFor(nearest.root, globalDir)))) {
            cwdRoot = nearest.root;
        }
    } catch { cwdRoot = null; }
    if (cwdRoot && Array.isArray(patternsArg) && patternsArg.length >= 2) {
        const tail = patternsArg[patternsArg.length - 1];
        try {
            const absTail = resolve(ctx.cwd, tail);
            const relToCwd = relative(cwdRoot, absTail).replace(/\\/g, "/");
            const hasOwnIndex = existsSync(join(absTail, "plexer")) || existsSync(join(absTail, ".git"));
            if (relToCwd && !relToCwd.startsWith("..") && !isAbsolute(relToCwd) && !hasOwnIndex) {
                return { rawList: [...patternsArg], dirArg: undefined };
            }
        } catch { /* fall back to splitTrailingDir */ }
    }
    return ctx.splitTrailingDir(patternsArg);
}

async function executeGrepAction(ctx, patternsArg, opts) {
    const { rawList, dirArg } = ctx.io.skipPeelScopes
        ? { rawList: patternsArg, dirArg: undefined }
        : resolveGrepArgsAndDir(ctx, patternsArg);
    const patterns = rawList.map((p) => String(p)).filter(Boolean);
    const dir = ctx.queryRoot(dirArg);
    const peeledScopes = [];
    const absDir = resolve(dir);
    while (!ctx.io.skipPeelScopes && patterns.length >= 2) {
        const tail = patterns[patterns.length - 1];
        if (/[*?^${}()|[\]\\]/.test(tail)) break;
        const absTail = resolve(absDir, tail);
        const relCheck = relative(absDir, absTail).replace(/\\/g, "/");
        if (!relCheck || relCheck.startsWith("..") || relCheck.startsWith("/") || !existsSync(absTail)) break;
        let isDir = false;
        try { isDir = statSync(absTail).isDirectory(); } catch { isDir = false; }
        if (!isDir && !/[\\/]/.test(tail) && !/\.[a-z0-9]{1,8}$/i.test(tail)) break;
        patterns.pop();
        peeledScopes.unshift(relCheck);
    }
    const optScopes = Array.isArray(opts.in)
        ? opts.in.map((s) => String(s).trim()).filter(Boolean)
        : (opts.in ? String(opts.in).split(",").map((s) => s.trim()).filter(Boolean) : []);
    const combinedScopes = [...new Set([...optScopes, ...peeledScopes])];
    const inScope = combinedScopes.length === 0 ? undefined : (combinedScopes.length === 1 ? combinedScopes[0] : combinedScopes);
    const patternOrList = patterns.length === 1 ? patterns[0] : patterns;
    await ctx.refreshBefore(dir, opts, { bounded: true });
    const globalDir = ctx.getGlobalDir();
    let parsedContext;
    if (opts.context !== undefined) {
        parsedContext = Number(opts.context);
        if (!Number.isInteger(parsedContext) || parsedContext < 0) {
            ctx.errLine(`✗ invalid --context "${opts.context}" — expected a non-negative integer`);
            ctx.exit(1);
        }
    }
    const explicitContext = parsedContext !== undefined || Boolean(opts.full);
    const contextLines = parsedContext !== undefined ? parsedContext : opts.source === false ? 0 : opts.full ? 4 : undefined;
    const sourceEnabled = opts.source !== false && (contextLines === undefined || contextLines > 0);
    const { readWorkspaceMeta } = await import("../graph/workspace-path.js");
    if (readWorkspaceMeta(dir, globalDir)) {
        const { runWorkspaceGrep } = await import("../graph/workspace-cli.js");
        const sessionId = ctx.getSessionId();
        let agyState = null;
        if (!explicitContext && sessionId && !opts.json) {
            const { readEngineSession } = await import("../hosts/engine/agy-context.js");
            agyState = readEngineSession(sessionId, { sessionCache: ctx.io.sessionCache });
        }
        try {
            await ctx.runExternal(() => {
                for (const pat of patterns) {
                    runWorkspaceGrep(dir, globalDir, pat, {
                        ignoreCase: opts.ignoreCase, fixed: opts.fixed, context: contextLines, source: sourceEnabled, explicitContext, in: inScope, json: opts.json,
                        seenSpans: agyState?.seenSpans ?? null,
                    });
                }
            });
        } catch (err) {
            ctx.errLine(`✗ ${err instanceof Error ? err.message : String(err)}`);
            ctx.exit(1);
        }
        return;
    }
    const { runGrepCommand } = await import("../search/grep-cli.js");
    await ctx.runExternal(() => runGrepCommand(patternOrList, dir, {
        ignoreCase: opts.ignoreCase, fixed: opts.fixed, context: contextLines, source: sourceEnabled, explicitContext, in: inScope, json: opts.json, globalDir, sessionId: ctx.getSessionId(), skipIgnoredScan: Boolean(ctx.io?.skipIgnoredScan),
    }));
}

async function executeMapAction(ctx, dirArg, opts) {
    const dir = ctx.queryRoot(dirArg);
    const root = resolve(ctx.cwd, dir);
    const globalDir = ctx.getGlobalDir();
    let maxDirsW;
    if (opts.maxDirs !== undefined) {
        const n = parseInt(opts.maxDirs, 10);
        if (!Number.isFinite(n) || n <= 0) {
            ctx.errLine(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
            ctx.exit(1);
            return;
        }
        maxDirsW = n;
    }
    await ctx.refreshBefore(dir, opts, { bounded: true });
    const { readWorkspaceMeta } = await import("../graph/workspace-path.js");
    if (readWorkspaceMeta(root, globalDir)) {
        const [{ runWorkspaceMap }, histMod] = await Promise.all([
            import("../graph/workspace-cli.js"),
            opts.churn ? import("../blast/history.js") : Promise.resolve({}),
        ]);
        await ctx.runExternal(() => runWorkspaceMap(root, globalDir, {
            maxDirs: maxDirsW, json: Boolean(opts.json), churn: Boolean(opts.churn), since: opts.since,
            analyzeGitHistory: histMod.analyzeGitHistory,
        }));
        return;
    }
    const [{ buildRepoMap, formatRepoMap }, { loadGraphCached }] = await Promise.all([
        import("../graph/map.js"),
        import("../context/graph-store.js"),
    ]);
    const contextDir = contextDirFor(root, globalDir);
    let gitHistory = null;
    if (opts.churn) {
        const { analyzeGitHistory } = await import("../blast/history.js");
        gitHistory = analyzeGitHistory(root, contextDir);
    }
    const graph = loadGraphCached(contextDir);
    if (!graph) {
        ctx.errLine(`✗ no graph found at ${contextDir} — run \`plexer build\` first`);
        ctx.exit(1);
        return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW, ...(gitHistory ? { gitHistory } : {}) });
    if (opts.json) {
        ctx.outLine(JSON.stringify(map, null, 2));
        return;
    }
    ctx.writeOut(formatRepoMap(map));
}

function registerSearchAndMapCommands(program, ctx) {
    program
        .command("grep")
        .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, offline)")
        .argument("<patterns...>", "one or more regex patterns (or literal strings with --fixed)")
        .option("-i, --ignore-case", "case-insensitive match")
        .option("-F, --fixed", "treat pattern as a literal string, not a regex")
        .option("-C, --context <lines>", "lines of surrounding context to show around each hit (default: 2)")
        .option("--source", "show surrounding source context around each hit (default: true)")
        .option("--no-source", "show 1-line matches only without surrounding context")
        .option("--full", "show extended surrounding source context around each hit")
        .option("--in <path>", "narrow to files at or under this path prefix — repeatable", collectRepeatableIn)
        .option("--json", "output as JSON")
        .option(...NO_REFRESH_FLAG)
        .action((patternsArg, opts) => executeGrepAction(ctx, patternsArg, opts));

    program
        .command("map")
        .description("Token-budgeted repo orientation — directory clusters, per-directory hubs, and global hotspots from the wiring graph ($0, offline)")
        .argument(...DIR_ARG)
        .option("--max-dirs <n>", "max directory entries shown, rest counted into dropped (default 16)")
        .option("--churn", "include git commit churn × complexity hotspots")
        .option("--json", "output as JSON")
        .option(...NO_REFRESH_FLAG)
        .action((dirArg, opts) => executeMapAction(ctx, dirArg, opts));
}

async function executeVizAction(ctx, dirArg, opts) {
    const tabs = parseTabs(opts.tabs, ctx);
    const dir = ctx.queryRoot(dirArg);
    const root = resolve(ctx.cwd, dir);
    const contextDir = contextDirFor(root, ctx.getGlobalDir());
    if (!existsSync(contextDir)) {
        ctx.errLine(`✗ no context graph at ${contextDir} — run \`plexer build\` first`);
        ctx.exit(1);
    }
    if (opts.export) {
        const { exportViz } = await import("../viz/export.js");
        const out = exportViz({
            contextDir, viewerDir: VIEWER_DIR, outDir: resolve(ctx.cwd, opts.export), repoName: basename(root), subtitle: opts.title, tabs,
        });
        const kb = Math.round(out.bytes / 1024);
        const counts = out.contextNodes > 0 ? `${out.contextNodes} areas, ${out.codeNodes} code nodes` : `${out.codeNodes} code nodes`;
        ctx.outLine(`plexer viz → ${out.file} (${kb} kB, ${counts})`);
        return;
    }
    const { startVizServer } = await import("../viz/serve.js");
    const srv = await startVizServer({
        root, contextDir, viewerDir: VIEWER_DIR, port: Number(opts.port), repoName: basename(root),
    });
    ctx.outLine(`plexer viz → ${srv.url}  (ctrl-c to stop)`);
    const stopViz = () => {
        srv.close().finally(() => ctx.exit(0));
    };
    process.once("SIGINT", stopViz);
    process.once("SIGTERM", stopViz);
    if (opts.open) {
        const { spawn } = await import("node:child_process");
        const isWin = process.platform === "win32";
        const opener = process.platform === "darwin" ? "open" : isWin ? "rundll32" : "xdg-open";
        const openArgs = isWin ? ["url.dll,FileProtocolHandler", srv.url] : [srv.url];
        const child = spawn(opener, openArgs, { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref();
    }
}

function registerVizAndMcpCommands(program, ctx) {
    program
        .command("viz")
        .description("Serve an interactive 60fps HTML5 canvas visualization of the codebase graph")
        .argument(...DIR_ARG)
        .option("-p, --port <port>", "port to serve on", "4400")
        .option("--no-open", "don't open the browser")
        .option("--export <dir>", "write one self-contained index.html instead of serving")
        .option("--title <text>", "subtitle shown beside the repo name in an exported page")
        .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,modules,symbols,outline,treemap")
        .action((dirArg, opts) => executeVizAction(ctx, dirArg, opts));

    program
        .command("mcp")
        .description("Serve the graph over MCP (stdio) — exposes plexer_find_code, plexer_read, plexer_trace_calls, plexer_find_all, plexer_file_api, plexer_repo_map, plexer_blast, plexer_health and plexer_check_freshness")
        .argument(...DIR_ARG)
        .action(async (dirArg) => {
            const dir = ctx.queryRoot(dirArg);
            const { startMcpServer } = await import("../mcp/server.js");
            startMcpServer(dir, ctx.getGlobalDir(), ctx.currentVersion);
        });
}

async function executeHealthAction(ctx, positionalArgs, opts) {
    const actionArg = positionalArgs?.[0]?.toLowerCase();
    const canHavePositionalDir = !actionArg || !KNOWN_HEALTH_SUBCOMMANDS.has(actionArg) || HEALTH_DIR_ACCEPTING_ACTIONS.has(actionArg);
    const rawTargetPath =
        opts.path ||
        (canHavePositionalDir
            ? (positionalArgs || []).find(
                  (a) => !KNOWN_HEALTH_SUBCOMMANDS.has(String(a).toLowerCase()) && existsSync(resolve(ctx.cwd, a)) && statSync(resolve(ctx.cwd, a)).isDirectory(),
              )
            : undefined);
    const dir = ctx.queryRoot(rawTargetPath);
    if (rawTargetPath) {
        const relSub = relative(dir, resolve(ctx.cwd, rawTargetPath)).replace(/\\/g, "/");
        if (relSub && !relSub.startsWith("..")) {
            opts.in = opts.in || [relSub];
            opts.scanPath = relSub;
        }
    }
    const globalDir = ctx.getGlobalDir();
    const ctxDir = contextDirFor(dir, globalDir);
    const hasGraphAndState = hasPlexerIndex(dir) && existsSync(join(ctxDir, ".health", "state.json"));
    const skipAutoRefresh =
        actionArg === "prompt" ||
        actionArg === "config" ||
        actionArg === "exclude" ||
        actionArg === "directives" ||
        (hasGraphAndState && HEALTH_PURE_STATE_ACTIONS.has(actionArg));
    if (!skipAutoRefresh) {
        await ctx.refreshBefore(dir, opts);
    }
    const { runHealthCommand } = await import("../health/health-cli.js");
    await ctx.runExternal(() => runHealthCommand(dir, positionalArgs || [], {
        ...opts,
        contextDir: globalDir,
        noBadge: opts.badge === false,
        noBudget: opts.budget === false,
    }));
}

function registerHealthCommand(program, ctx) {
    const cmd = program
        .command("health")
        .description("Codebase health scanner, living execution queue (scan/next/resolve/suppress/plan/review/autofix/move/tree/viz/detect), and anti-gaming scorecard ($0, offline)")
        .argument("[args...]", "subcommand (scan, next, backlog, status, show, resolve, suppress, plan, review, autofix, move, tree, viz, detect, zone, exclude, directives, config, prompt) and arguments");
    for (const [flags, desc] of HEALTH_OPTIONS) {
        cmd.option(flags, desc);
    }
    cmd.action((positionalArgs, opts) => executeHealthAction(ctx, positionalArgs, opts));
}

async function runGlobalOnlyInit(ctx, home, opts, explicitMcp) {
    const { globalSetupTargets, runGlobalSetup } = await import("../hosts/setup.js");
    const globalAgents = Array.isArray(opts.agents) ? opts.agents : opts.agents === false ? ["claude"] : undefined;
    if (opts.dryRun) {
        for (const w of globalSetupTargets({ home, agents: globalAgents, bin: opts.bin, skills: opts.skills, hooks: opts.hooks, mcp: explicitMcp })) {
            ctx.outLine(`${w.hostId}: ${w.path} (${w.what})`);
        }
        return;
    }
    const res = runGlobalSetup({
        home, agents: globalAgents, bin: opts.bin, skills: opts.skills, hooks: opts.hooks, mcp: explicitMcp,
    });
    for (const group of [res.bin, res.skills, res.hooks, res.mcp]) {
        for (const item of group) {
            ctx.outLine(`${item.action}: ${item.path}`);
        }
    }
    ctx.errLine("✓ global plexer binary, skill links, and hooks wired");
}

async function wireInitRepoTargets(ctx, repo, ids, home, explicitMcp, opts) {
    const [
        { isWorkspaceBuildRoot },
        { discoverWorkspaceChildren },
        { buildGraphIfMissing, runInit },
        { statuslineWanted },
        { runHostsInit },
        { runRetract },
    ] = await Promise.all([
        import("../graph/workspace.js"),
        import("../graph/scope-discovery.js"),
        import("../claude/init.js"),
        import("../claude/settings-merge.js"),
        import("../hosts/init.js"),
        import("../hosts/retract.js"),
    ]);
    const children = isWorkspaceBuildRoot(repo, ctx.getGlobalDir()) ? discoverWorkspaceChildren(repo) : [];
    const targets = [repo, ...children.map((c) => join(repo, c))];
    const wantClaude = ids.includes("claude");
    const wantStatusline = statuslineWanted({ statusline: opts.statusline });
    for (const target of targets) {
        runRetract(target, { home, apply: true, global: false, cache: false, exclude: ids });
        if (wantClaude) {
            runInit(target, {
                build: opts.build, cliPath: CLI_BIN_PATH, statusline: wantStatusline, mcp: explicitMcp, hooks: opts.hooks, global: false, home,
            });
        }
        const others = ids.filter((id) => id !== "claude");
        if (others.length > 0) {
            runHostsInit(target, {
                agents: others, home, mcp: explicitMcp, hooks: opts.hooks, skills: opts.skills, global: false,
            });
        }
        if (!wantClaude) {
            buildGraphIfMissing(target, { build: opts.build, cliPath: CLI_BIN_PATH });
        }
    }
    ctx.errLine(`✓ wired ${ids.join(", ")} in ${repo}`);
}

async function executeInitCommand(ctx, dir, opts, command) {
    if (opts.listAgents) {
        const { allHostIds } = await import("../hosts/registry.js");
        for (const id of allHostIds()) ctx.outLine(id);
        return;
    }
    const globalOnly = command.getOptionValueSource("global") === "cli" && opts.global === true;
    const allowGlobal = opts.global !== false;
    const explicitMcp = command.getOptionValueSource("mcp") === "cli" ? opts.mcp : undefined;
    const home = homedir();
    if (globalOnly) {
        await runGlobalOnlyInit(ctx, home, opts, explicitMcp);
        return;
    }
    const [{ planInit, selectedWrites }, { globalSetupTargets, runGlobalSetup }] = await Promise.all([
        import("../hosts/plan.js"),
        import("../hosts/setup.js"),
    ]);
    const repo = resolve(ctx.cwd, dir);
    const plan = planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const ids = Array.isArray(opts.agents) ? opts.agents : opts.allAgents ? plan.map((p) => p.id) : opts.agents === false ? ["claude"] : detectedIds;
    if (opts.dryRun) {
        const seen = new Set();
        if (allowGlobal && ids.length > 0) {
            for (const w of globalSetupTargets({ home, agents: ids, bin: opts.bin, skills: opts.skills, hooks: opts.hooks, mcp: explicitMcp })) {
                seen.add(w.path);
                ctx.outLine(`${w.hostId}: ${w.path} (${w.what})`);
            }
        }
        for (const w of selectedWrites(plan, ids, { global: allowGlobal, mcp: explicitMcp, hooks: opts.hooks, skills: opts.skills })) {
            if (seen.has(w.path)) continue;
            seen.add(w.path);
            ctx.outLine(`${w.hostId}: ${w.path} (${w.what})`);
        }
        return;
    }
    if (ids.length === 0) {
        ctx.errLine("· no agents selected — nothing written");
        return;
    }
    if (allowGlobal) {
        runGlobalSetup({ home, agents: ids, bin: opts.bin, skills: opts.skills, hooks: opts.hooks, mcp: explicitMcp });
    }
    await wireInitRepoTargets(ctx, repo, ids, home, explicitMcp, opts);
}

async function executeRetractCommand(ctx, dir, opts) {
    const { planRetract, runRetract, changed } = await import("../hosts/retract.js");
    const repo = resolve(ctx.cwd, dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: !opts.keepCache };
    if (!opts.yes || opts.dryRun) {
        const rs = changed(planRetract(repo, common));
        if (opts.json) {
            ctx.outLine(JSON.stringify({ dryRun: true, entries: rs }, null, 2));
            return;
        }
        for (const r of rs) ctx.errLine(`would remove: ${r.path} (${r.what})`);
        ctx.errLine("\nDry run — nothing was touched. Re-run with -y to remove.");
        return;
    }
    const done = changed(runRetract(repo, { ...common, apply: true }));
    if (opts.json) {
        ctx.outLine(JSON.stringify({ dryRun: false, entries: done }, null, 2));
        return;
    }
    for (const r of done) ctx.errLine(`removed: ${r.path} (${r.what})`);
    ctx.errLine("\n✓ plexer wiring removed.");
}

function registerHostLifecycleCommands(program, ctx) {
    program
        .command("init")
        .description("Wire Plexer globally (PATH binary, skills, hooks) and into a target repository")
        .argument("[dir]", "target repo directory", ".")
        .option("-g, --global", "install global binary symlink, skill symlinks, and hooks only (skip repo wiring)")
        .option("--no-global", "skip writes outside this repo (~/.local/bin, ~/.agents, ~/.claude, ~/.codex, ~/.gemini)")
        .option("--no-bin", "skip linking ~/.local/bin/plexer")
        .option("--no-skills", "skip linking ~/.agents/skills/plexer, ~/.claude/skills/plexer, ~/.gemini/skills/plexer")
        .option("--no-build", "skip building the graph (wire files only)")
        .option("--agents <ids...>", `only these agents (${KNOWN_AGENT_LIST})`)
        .option("--all-agents", "write instruction files for every known agent, detected or not")
        .option("--no-agents", "Claude Code wiring only; skip other agents")
        .option("--list-agents", "list known agent ids and exit")
        .option("--mcp", "register the plexer MCP server (opt-in on CLI/skill hosts)")
        .option("--no-mcp", "skip MCP server registration")
        .option("--no-hooks", "skip hook installation")
        .option("--no-statusline", "skip writing Claude Code statusLine")
        .option("--dry-run", "print every file init would touch, then exit without writing")
        .option("-y, --yes", "accept defaults without prompting (non-interactive compatibility)")
        .action((dir, opts, command) => executeInitCommand(ctx, dir, opts, command));

    program
        .command("setup")
        .description("Install global plexer binary symlink, skill links, and hooks — alias for `plexer init --global`")
        .option("--agents <ids...>", `only these agents (${KNOWN_AGENT_LIST})`)
        .option("--no-bin", "skip linking ~/.local/bin/plexer")
        .option("--no-skills", "skip linking ~/.agents/skills/plexer, ~/.claude/skills/plexer, ~/.gemini/skills/plexer")
        .option("--mcp", "register the plexer MCP server (opt-in on CLI/skill hosts)")
        .option("--no-mcp", "skip MCP server registration")
        .option("--no-hooks", "skip hook installation")
        .option("--dry-run", "print every file setup would touch, then exit without writing")
        .action((opts, command) => {
            const explicitMcp = command.getOptionValueSource("mcp") === "cli" ? opts.mcp : undefined;
            return runGlobalOnlyInit(ctx, homedir(), opts, explicitMcp);
        });

    program
        .command("uninstall")
        .alias("retract")
        .description("Remove every file and config entry plexer has written to this repo")
        .argument("[dir]", "target repo directory", ".")
        .option("-y, --yes", "actually remove (without this, prints what it would remove and exits)")
        .option("--dry-run", "print every file uninstall would remove, then exit")
        .option("--keep-cache", "keep plexer/ and the .gitignore entries — wiring only")
        .option("--no-global", "leave out-of-repo files alone (~/.local/bin, ~/.agents, ~/.claude, ~/.codex, ~/.gemini)")
        .option("--json", "output removed/planned entries as JSON")
        .action((dir, opts) => executeRetractCommand(ctx, dir, opts));
}

const COMMAND_GROUP_MAP = new Map([
    ["version", "build"],
    ["build", "build"],
    ["check", "build"],
    ["ask", "query"],
    ["skeleton", "query"],
    ["read", "query"],
    ["_batch", "query"],
    ["callers", "callers"],
    ["callees", "callers"],
    ["impact", "callers"],
    ["blast", "callers"],
    ["grep", "search"],
    ["map", "search"],
    ["viz", "viz"],
    ["mcp", "viz"],
    ["health", "health"],
    ["init", "host"],
    ["setup", "host"],
    ["uninstall", "host"],
    ["retract", "host"],
]);

function detectCliSubcommandGroup(argv) {
    if (!Array.isArray(argv) || argv.length <= 2) return null;
    for (let i = 2; i < argv.length; i++) {
        const a = String(argv[i]);
        if (a === "--") break;
        if (a === "-h" || a === "--help" || a === "-v" || a === "-V" || a === "--version") return null;
    }
    for (let i = 2; i < argv.length; i++) {
        const a = String(argv[i]);
        if (a === "--no-daemon" || a.startsWith("--dir=") || a.startsWith("--session=")) continue;
        if ((a === "--dir" || a === "--session") && i + 1 < argv.length) {
            i++;
            continue;
        }
        if (a.startsWith("-")) return null;
        return COMMAND_GROUP_MAP.get(a) ?? null;
    }
    return null;
}

const FAST_READ_COMMANDS = new Set(["ask", "read", "skeleton", "callers", "callees", "grep"]);

function consumeFlagValue(args, idx, tok) {
    const eqIdx = tok.indexOf("=");
    if (eqIdx >= 0)
        return { value: tok.slice(eqIdx + 1), nextIdx: idx };
    if (idx + 1 >= args.length)
        return null;
    return { value: args[idx + 1], nextIdx: idx + 1 };
}

function parseFastReadInvocation(normalizedArgv) {
    if (!Array.isArray(normalizedArgv) || normalizedArgv.length <= 2)
        return null;
    const args = normalizedArgv.slice(2).map(String);
    const globalOpts = { dir: undefined, session: undefined, daemon: true };
    let cmdIdx = -1;
    for (let i = 0; i < args.length; i++) {
        const tok = args[i];
        if (tok === "--")
            return null;
        if (tok === "-h" || tok === "--help" || tok === "-v" || tok === "-V" || tok === "--version")
            return null;
        if (tok === "--no-daemon") {
            globalOpts.daemon = false;
            continue;
        }
        if (tok === "--dir" || tok.startsWith("--dir=")) {
            const parsed = consumeFlagValue(args, i, tok);
            if (!parsed) return null;
            globalOpts.dir = parsed.value;
            i = parsed.nextIdx;
            continue;
        }
        if (tok === "--session" || tok.startsWith("--session=")) {
            const parsed = consumeFlagValue(args, i, tok);
            if (!parsed) return null;
            globalOpts.session = parsed.value;
            i = parsed.nextIdx;
            continue;
        }
        if (tok.startsWith("-"))
            return null;
        cmdIdx = i;
        break;
    }
    if (cmdIdx < 0)
        return null;
    const cmd = args[cmdIdx];
    if (!FAST_READ_COMMANDS.has(cmd))
        return null;
    const opts = {};
    if (cmd === "ask") {
        opts.source = true;
        opts.graphRank = true;
        opts.in = [];
    }
    else if (cmd === "callers") {
        opts.source = true;
        opts.in = [];
    }
    else if (cmd === "callees") {
        opts.depth = 1;
        opts.source = true;
        opts.in = [];
    }
    else if (cmd === "grep") {
        opts.source = true;
        opts.in = [];
    }
    const positionals = [];
    let afterDashDash = false;
    for (let i = cmdIdx + 1; i < args.length; i++) {
        const tok = args[i];
        if (!afterDashDash && tok === "--") {
            afterDashDash = true;
            continue;
        }
        if (!afterDashDash && tok.startsWith("-")) {
            if (tok === "-h" || tok === "--help" || tok === "-v" || tok === "-V" || tok === "--version")
                return null;
            if (tok === "--no-daemon") {
                globalOpts.daemon = false;
                continue;
            }
            if (tok === "--dir" || tok.startsWith("--dir=")) {
                const parsed = consumeFlagValue(args, i, tok);
                if (!parsed) return null;
                globalOpts.dir = parsed.value;
                i = parsed.nextIdx;
                continue;
            }
            if (tok === "--session" || tok.startsWith("--session=")) {
                const parsed = consumeFlagValue(args, i, tok);
                if (!parsed) return null;
                globalOpts.session = parsed.value;
                i = parsed.nextIdx;
                continue;
            }
            if (tok === "--json") {
                opts.json = true;
                continue;
            }
            if (tok === "--no-refresh") {
                opts.refresh = false;
                continue;
            }
            if (tok === "--full" && cmd !== "skeleton") {
                opts.full = true;
                continue;
            }
            if (tok === "--callers" && cmd === "read") {
                opts.callers = true;
                continue;
            }
            if (tok === "--source" && (cmd === "ask" || cmd === "callers" || cmd === "callees" || cmd === "grep")) {
                opts.source = true;
                continue;
            }
            if (tok === "--no-source" && (cmd === "ask" || cmd === "callers" || cmd === "callees" || cmd === "grep")) {
                opts.source = false;
                continue;
            }
            if ((tok === "--in" || tok.startsWith("--in=")) && (cmd === "ask" || cmd === "callers" || cmd === "callees" || cmd === "grep")) {
                const parsed = consumeFlagValue(args, i, tok);
                if (!parsed) return null;
                opts.in = collectRepeatableIn(parsed.value, opts.in);
                i = parsed.nextIdx;
                continue;
            }
            if (cmd === "ask") {
                if (tok === "-n" || tok === "--limit" || tok.startsWith("--limit=")) {
                    const parsed = consumeFlagValue(args, i, tok);
                    if (!parsed) return null;
                    opts.limit = parsed.value;
                    i = parsed.nextIdx;
                    continue;
                }
                if (tok === "--no-graph-rank") {
                    opts.graphRank = false;
                    continue;
                }
            }
            else if (cmd === "skeleton") {
                if (tok === "--all-matches") {
                    opts.allMatches = true;
                    continue;
                }
            }
            else if (cmd === "callers" || cmd === "callees") {
                if (tok === "-d" || tok === "--depth" || tok.startsWith("--depth=")) {
                    const parsed = consumeFlagValue(args, i, tok);
                    if (!parsed) return null;
                    opts.depth = parsed.value;
                    i = parsed.nextIdx;
                    continue;
                }
                if (cmd === "callers" && (tok === "--direction" || tok.startsWith("--direction="))) {
                    const parsed = consumeFlagValue(args, i, tok);
                    if (!parsed) return null;
                    opts.direction = parsed.value;
                    i = parsed.nextIdx;
                    continue;
                }
            }
            else if (cmd === "grep") {
                if (tok === "-i" || tok === "--ignore-case") {
                    opts.ignoreCase = true;
                    continue;
                }
                if (tok === "-F" || tok === "--fixed") {
                    opts.fixed = true;
                    continue;
                }
                if (tok === "-C" || tok === "--context" || tok.startsWith("--context=")) {
                    const parsed = consumeFlagValue(args, i, tok);
                    if (!parsed) return null;
                    opts.context = parsed.value;
                    i = parsed.nextIdx;
                    continue;
                }
            }
            return null;
        }
        positionals.push(tok);
    }
    if (positionals.length === 0)
        return null;
    return { cmd, globalOpts, opts, positionals };
}

async function tryRunFastReadSubcommand(normalizedArgv, currentVersion, ioCtx = null) {
    const parsed = parseFastReadInvocation(normalizedArgv);
    if (!parsed)
        return false;
    const fastProgram = { opts: () => parsed.globalOpts };
    const ctx = createCliContext(fastProgram, currentVersion, ioCtx);
    const { cmd, opts, positionals } = parsed;
    if (cmd === "ask")
        await executeAskAction(ctx, positionals, opts);
    else if (cmd === "read")
        await executeReadAction(ctx, positionals, opts);
    else if (cmd === "skeleton")
        await executeSkeletonAction(ctx, positionals, opts);
    else if (cmd === "callers")
        await runCallersAction(ctx, positionals, opts);
    else if (cmd === "callees")
        await runCallersAction(ctx, positionals, opts, "out");
    else if (cmd === "grep")
        await executeGrepAction(ctx, positionals, opts);
    else
        return false;
    return true;
}

export async function runCli(argv = process.argv, ioCtx = null) {
    const currentVersion = readCurrentVersion(import.meta.url);
    const normalizedArgv = normalizeLeadingDashPositionalArgs(argv);
    if (await tryRunFastReadSubcommand(normalizedArgv, currentVersion, ioCtx))
        return;
    const program = new Command();
    const ctx = createCliContext(program, currentVersion, ioCtx);
    if (ctx.io.isCaptured) {
        program.configureOutput({
            writeOut: (s) => ctx.writeOut(s),
            writeErr: (s) => ctx.writeErr(s),
            outputError: (s, write) => write(s),
        });
        program.exitOverride((err) => {
            ctx.exit(err.exitCode ?? 0);
        });
    }
    program
        .name("plexer")
        .description("Build a repo's structural context graph (.graph/wiring.json + SQLite index; $0, offline).")
        .version(currentVersion, "-v, --version")
        .option("--dir <path>", "context graph directory (default: <repo>/plexer)")
        .option("--session <id>", "optional session id for seen-span deduplication")
        .option("--no-daemon", "skip the local plexerd socket fast-path");
    const group = detectCliSubcommandGroup(normalizedArgv);
    if (!group || group === "build") registerBuildAndCheckCommands(program, ctx);
    if (!group || group === "query") registerQueryCommands(program, ctx);
    if (!group || group === "callers") registerCallersAndBlastCommands(program, ctx);
    if (!group || group === "search") registerSearchAndMapCommands(program, ctx);
    if (!group || group === "viz") registerVizAndMcpCommands(program, ctx);
    if (!group || group === "health") registerHealthCommand(program, ctx);
    if (!group || group === "host") registerHostLifecycleCommands(program, ctx);
    await program.parseAsync(normalizedArgv);
}
