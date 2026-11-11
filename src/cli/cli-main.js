import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { contextDirFor } from "../context/node-file.js";
import { hasPlexerIndex, isAutoBuildableRepo, nearestPlexerRoot } from "../graph/root.js";
import { readCurrentVersion } from "../util/cli-meta.js";
import { normalizePathPrefix } from "../util/paths.js";

const DIR_ARG = ["[dir]", "repository root (default: nearest ancestor with a plexer/ index)"];
const NO_REFRESH_FLAG = ["--no-refresh", "skip the freshness check — answer from the graph as-is"];
const VIZ_TABS = ["context", "code", "modules", "symbols", "outline"];
const KNOWN_AGENT_LIST = "agents, adal, cursor, gemini, grok, hermes, antigravity, copilot, kiro, windsurf, claude";
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

async function warnUnsupportedExtensions(exts) {
    if (!exts?.length) return;
    const { unsupportedExtensions, supportedExtensions } = await import("../graph/source-files.js");
    const bad = unsupportedExtensions(exts);
    if (bad.length === 0) return;
    for (const e of bad) {
        const shown = e.trim().startsWith(".") ? e.trim() : `.${e.trim()}`;
        console.error(`⚠ -e "${shown}": no parser registered for this extension — ignoring it.`);
    }
    console.error(`  supported: ${supportedExtensions().join(" ")}`);
}

function parseTabs(raw) {
    if (raw === undefined) return undefined;
    const want = raw.split(",").map((t) => t.trim()).filter(Boolean);
    const bad = want.filter((t) => !VIZ_TABS.includes(t));
    if (bad.length > 0 || want.length === 0) {
        console.error(`✗ --tabs takes a comma-separated subset of ${VIZ_TABS.join(", ")}${bad.length ? ` — got "${bad.join('", "')}"` : ""}`);
        process.exit(1);
    }
    return want;
}

function createCliContext(program, currentVersion) {
    const getGlobalDir = () => program.opts().dir;
    const cliConfig = () => ({ contextDir: getGlobalDir() });
    const splitTrailingDir = (arg, { requirePlexerDir = true } = {}) => {
        const rawList = Array.isArray(arg) ? [...arg] : [arg];
        let dirArg;
        if (rawList.length >= 2) {
            const candidateDir = rawList[rawList.length - 1];
            try {
                if (existsSync(candidateDir) && statSync(candidateDir).isDirectory()) {
                    const absCand = resolve(candidateDir);
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
            const resolved = resolve(dir);
            let isDir = false;
            try {
                isDir = statSync(resolved).isDirectory();
            } catch {
                isDir = false;
            }
            if (!isDir) {
                console.error(`✗ directory not found: ${dir}`);
                process.exit(1);
            }
            const { root, levels } = nearestPlexerRoot(resolved, getGlobalDir());
            if (levels > 0) console.error(`[plexer] no plexer/ in ${dir} — answering from ${root}/plexer`);
            return root;
        }
        const { root, levels } = nearestPlexerRoot(process.cwd(), getGlobalDir());
        if (levels > 0) console.error(`[plexer] no plexer/ here — answering from ${root}/plexer`);
        return root;
    };
    const isBlastRepoDir = (candidate) => {
        try {
            const abs = resolve(candidate);
            if (!statSync(abs).isDirectory()) return false;
            return Boolean(getGlobalDir()) || hasPlexerIndex(abs) || isAutoBuildableRepo(abs);
        } catch {
            return false;
        }
    };
    const refreshBefore = async (dir, opts) => {
        if (opts.refresh === false) return;
        const globalDir = getGlobalDir();
        const root = resolve(dir);
        const [{ readWorkspace }, { ensureFreshChildren, ensureFreshGraph, refreshNote }] = await Promise.all([
            import("../graph/workspace.js"),
            import("../graph/refresh.js"),
        ]);
        const ws = readWorkspace(root, globalDir);
        const r = ws
            ? await ensureFreshChildren(root, ws.children, { contextDir: globalDir, disabled: false })
            : await ensureFreshGraph(root, { contextDir: globalDir, disabled: false });
        const note = refreshNote(r);
        if (note) console.error(note);
    };
    return { program, currentVersion, getGlobalDir, cliConfig, splitTrailingDir, queryRoot, isBlastRepoDir, refreshBefore };
}

function parseBuildConfigOptions(opts, command) {
    const buildConfigPatch = {};
    if (opts.includeDir && opts.includeDir.length > 0) {
        for (const name of opts.includeDir) {
            if (name.startsWith(".")) {
                console.error(`✗ --include-dir "${name}": dot-directories are never overridable`);
                process.exit(1);
            }
            if (name.includes("/") || name.includes("\\")) {
                console.error(`✗ --include-dir "${name}": expected a bare directory name, not a path`);
                process.exit(1);
            }
        }
        buildConfigPatch.includeDirs = opts.includeDir;
    }
    let onlyDirs;
    if (opts.onlyDir && opts.onlyDir.length > 0) {
        const normalized = opts.onlyDir.map((p) => normalizePathPrefix(p)).filter((p) => p !== "");
        if (normalized.length === 0) {
            console.error("✗ --only-dir: expected a non-empty repo-relative path");
            process.exit(1);
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
    await warnUnsupportedExtensions(opts.extensions);
    const { buildConfigPatch, onlyDirs, followSubmodulesWasExplicit, followNestedReposWasExplicit } = parseBuildConfigOptions(opts, command);
    const buildRoot = resolve(dir);
    const buildGlobalDir = ctx.getGlobalDir();
    if (Object.keys(buildConfigPatch).length > 0) {
        const { patchBuildConfig } = await import("../util/state.js");
        patchBuildConfig(buildRoot, buildConfigPatch, buildGlobalDir);
    }
    const { isWorkspaceBuildRoot } = await import("../graph/workspace.js");
    if (isWorkspaceBuildRoot(buildRoot, buildGlobalDir)) {
        const { runWorkspaceBuild } = await import("../graph/workspace-cli.js");
        await runWorkspaceBuild(buildRoot, {
            extensions: opts.extensions,
            reuse: opts.reuse,
            childConfig: ctx.cliConfig(),
            override: buildGlobalDir,
            includeDirs: opts.includeDir,
            followSubmodules: followSubmodulesWasExplicit ? opts.followSubmodules : undefined,
            followNestedRepos: followNestedReposWasExplicit ? opts.followNestedRepos : undefined,
        });
        return;
    }
    const { Plexer } = await import("../index.js");
    const engine = new Plexer(ctx.cliConfig());
    const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(", ");
    const g = await engine.graph(dir, {
        extensions: opts.extensions,
        reuse: opts.reuse,
        onlyDirs,
        cards: Boolean(opts.cards),
        onProgress: ({ index, total, file }) =>
            process.stderr.write(`\rparsing ${index + 1}/${total}: ${file.slice(0, 50).padEnd(50)}`),
    });
    process.stderr.write("\n");
    console.log(`✓ wiring: ${g.nodes} nodes (${fmt(g.byKind)}), ${g.edges} edges, ${g.cards} cards [${g.languages.join(", ")}]`);
    console.log(`  parsed: ${g.parsed} of ${g.files} files (${g.reused} replayed from cache)`);
    if (g.seededFrom) console.log(`  seeded: copied a starting graph from ${g.seededFrom} (git worktree)`);
    console.log(`  → ${g.contextDir}`);
    for (const e of g.errors) console.error(`✗ ${e}`);
    const rel = relative(process.cwd(), g.contextDir) || "plexer";
    if (process.env.PLEXER_NO_GITIGNORE) {
        console.log(`  ${rel}/ is a local cache — add it to your gitignore if you want it untracked.`);
    } else {
        console.log(`  ${rel}/ is git-ignored (added automatically) — a local cache; teammates run \`plexer build\` to get their own.`);
    }
}

async function executeCheckCommand(ctx, dirArg, opts) {
    await warnUnsupportedExtensions(opts.extensions);
    const dir = ctx.queryRoot(dirArg);
    const checkGlobalDir = ctx.getGlobalDir();
    const { readWorkspace } = await import("../graph/workspace.js");
    if (readWorkspace(dir, checkGlobalDir)) {
        const { runWorkspaceCheck } = await import("../graph/workspace-cli.js");
        await runWorkspaceCheck(dir, checkGlobalDir, { json: opts.json, extensions: opts.extensions });
        return;
    }
    const { checkGraph, formatGraphCheckReport } = await import("../graph/check.js");
    const g = await checkGraph(dir, { extensions: opts.extensions, contextDir: checkGlobalDir });
    if (opts.json) {
        console.log(JSON.stringify({ graph: g.missing ? null : g }, null, 2));
    } else if (g.missing) {
        console.log("plexer check: NO GRAPH\n\nNo plexer/ graph found. Run `plexer build` first.");
    } else {
        console.log(formatGraphCheckReport(g));
    }
    if (g.missing || !g.ok) process.exit(1);
}

function registerBuildAndCheckCommands(program, ctx) {
    program
        .command("version")
        .description("Print the installed plexer version")
        .action(() => {
            console.log(`plexer ${ctx.currentVersion}`);
        });

    program
        .command("build")
        .description("Build plexer/ from your code — structural wiring graph + per-file cards ($0, offline)")
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

async function executeAskAction(ctx, queriesArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(queriesArg, { requirePlexerDir: false });
    const queries = splitAskQueries(rawList);
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts);
    const askGlobalDir = ctx.getGlobalDir();
    const limitOpt = opts.limit !== undefined ? Number(opts.limit) : undefined;
    if (limitOpt !== undefined && (!Number.isInteger(limitOpt) || limitOpt < 1)) {
        console.error(`✗ invalid --limit "${opts.limit}" — expected a positive integer`);
        process.exit(1);
    }
    const useSource = opts.full ? true : opts.source !== false;
    const { readWorkspace } = await import("../graph/workspace.js");
    if (readWorkspace(dir, askGlobalDir)) {
        const { runWorkspaceAsk } = await import("../graph/workspace-cli.js");
        try {
            for (const query of queries) {
                runWorkspaceAsk(dir, askGlobalDir, query, {
                    limit: limitOpt, source: useSource, full: opts.full, in: opts.in, graphRank: opts.graphRank, json: opts.json,
                });
            }
        } catch (err) {
            console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
        return;
    }
    const { ask, formatAsk } = await import("../ask/ask.js");
    const results = [];
    try {
        const perQueryLimit = limitOpt !== undefined ? limitOpt : queries.length > 1 ? 3 : undefined;
        const seenPointers = queries.length > 1 ? new Set() : undefined;
        for (let i = 0; i < queries.length; i++) {
            const maxHitsToInline = queries.length > 1 ? 1 : undefined;
            const maxSourceBytes = queries.length > 1 ? (opts.full ? 2800 : queries.length >= 3 ? 1700 : 2100) : undefined;
            results.push(ask(dir, queries[i], {
                limit: perQueryLimit, source: useSource, full: opts.full, in: opts.in, graphRank: opts.graphRank,
                seenPointers, maxSourceBytes, maxHitsToInline, contextDir: askGlobalDir,
            }));
        }
    } catch (err) {
        console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
        return;
    }
    if (opts.json) {
        console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
    } else {
        process.stdout.write(results.map((r) => formatAsk(r).trimEnd()).join("\n\n") + "\n");
    }
}

async function executeSkeletonAction(ctx, filesArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(filesArg);
    const files = rawList.flatMap((f) => String(f).split(",").map((x) => x.trim()).filter(Boolean));
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts);
    const [{ skeleton, formatSkeleton }, { federateSkeleton, readWorkspace }] = await Promise.all([
        import("../ask/ask.js"),
        import("../graph/workspace.js"),
    ]);
    const globalDir = ctx.getGlobalDir();
    const skelOpts = { allMatches: Boolean(opts.allMatches), contextDir: globalDir };
    const isWs = Boolean(readWorkspace(dir, globalDir));
    if (files.length === 1) {
        const r = isWs ? federateSkeleton(dir, globalDir, files[0], skelOpts) : skeleton(dir, files[0], skelOpts);
        if (opts.json) console.log(JSON.stringify(r, null, 2));
        else process.stdout.write(formatSkeleton(r));
        if (!r.entries?.length && (r.note || r.error)) process.exit(1);
        return;
    }
    const results = files.map((file) => (isWs ? federateSkeleton(dir, globalDir, file, skelOpts) : skeleton(dir, file, skelOpts)));
    if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        process.stdout.write(results.map((r) => formatSkeleton(r).trimEnd()).join("\n\n") + "\n");
    }
    if (results.every((r) => !r.entries?.length && (r.note || r.error))) process.exit(1);
}

async function executeReadAction(ctx, spansArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(spansArg);
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts);
    const [{ readSpans, formatReadSpans }, { federateRead, readWorkspace }] = await Promise.all([
        import("../ask/ask.js"),
        import("../graph/workspace.js"),
    ]);
    const globalDir = ctx.getGlobalDir();
    const r = readWorkspace(dir, globalDir)
        ? federateRead(dir, globalDir, rawList)
        : readSpans(dir, rawList, { contextDir: globalDir });
    if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
    } else {
        process.stdout.write(formatReadSpans(r));
    }
    if (r.blocks.every((b) => b.error)) process.exit(1);
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
        .option("--in <path>", "narrow to nodes under this path prefix, filtered before scoring")
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
        .option("--json", "output the result as JSON")
        .option(...NO_REFRESH_FLAG)
        .action((spansArg, opts) => executeReadAction(ctx, spansArg, opts));
}

async function runCallersAction(ctx, symbolsArg, opts, forcedDirection) {
    const { rawList, dirArg } = ctx.splitTrailingDir(symbolsArg);
    const symbols = rawList.flatMap((s) => String(s).split(",").map((x) => x.trim()).filter(Boolean));
    const symbolOrList = symbols.length === 1 ? symbols[0] : symbols;
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts);
    const globalDir = ctx.getGlobalDir();
    const [{ runCallersCommand, resolveDirection, resolveCliDepth }, { readWorkspace }] = await Promise.all([
        import("../graph/traverse-cli.js"),
        import("../graph/workspace.js"),
    ]);
    const direction = resolveDirection(forcedDirection ?? opts.direction);
    const depth = resolveCliDepth(opts.depth);
    const useSource = opts.full ? true : opts.source !== false;
    if (readWorkspace(dir, globalDir)) {
        const { runWorkspaceCallers } = await import("../graph/workspace-cli.js");
        runWorkspaceCallers(dir, globalDir, symbolOrList, {
            direction, depth, in: opts.in, source: useSource, full: opts.full, json: opts.json,
        });
        return;
    }
    runCallersCommand(symbolOrList, dir, {
        direction, depth: opts.depth, in: opts.in, source: useSource, full: opts.full, json: opts.json, globalDir,
    });
}

async function executeBlastAction(ctx, firstArg, secondArg, opts) {
    let base = opts.base;
    let dirArg;
    if (secondArg !== undefined) {
        if (opts.base !== undefined) {
            console.error(`✗ cannot pass both --base "${opts.base}" and a positional base ref "${firstArg}"`);
            process.exit(1);
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
    await runBlastCommand(dir, {
        base, depth: opts.depth, format, exportViz: opts.exportViz, title: opts.title,
        owners: opts.owners, prAuthor: opts.prAuthor, globalDir: ctx.getGlobalDir(),
    });
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
        .option("--in <path>", "narrow matches to nodes at or under this path prefix")
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
            .option("--in <path>", "narrow matches to nodes at or under this path prefix")
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

async function executeGrepAction(ctx, patternsArg, opts) {
    const { rawList, dirArg } = ctx.splitTrailingDir(patternsArg);
    const patterns = rawList.map((p) => String(p)).filter(Boolean);
    const patternOrList = patterns.length === 1 ? patterns[0] : patterns;
    const dir = ctx.queryRoot(dirArg);
    await ctx.refreshBefore(dir, opts);
    const globalDir = ctx.getGlobalDir();
    let parsedContext;
    if (opts.context !== undefined) {
        parsedContext = Number(opts.context);
        if (!Number.isInteger(parsedContext) || parsedContext < 0) {
            console.error(`✗ invalid --context "${opts.context}" — expected a non-negative integer`);
            process.exit(1);
        }
    }
    const contextLines = parsedContext !== undefined ? parsedContext : opts.source === false ? 0 : opts.full ? 4 : undefined;
    const sourceEnabled = opts.source !== false && (contextLines === undefined || contextLines > 0);
    const { readWorkspace } = await import("../graph/workspace.js");
    if (readWorkspace(dir, globalDir)) {
        const { runWorkspaceGrep } = await import("../graph/workspace-cli.js");
        try {
            for (const pat of patterns) {
                runWorkspaceGrep(dir, globalDir, pat, {
                    ignoreCase: opts.ignoreCase, fixed: opts.fixed, context: contextLines, source: sourceEnabled, in: opts.in, json: opts.json,
                });
            }
        } catch (err) {
            console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
            process.exit(1);
        }
        return;
    }
    const { runGrepCommand } = await import("../search/grep-cli.js");
    runGrepCommand(patternOrList, dir, {
        ignoreCase: opts.ignoreCase, fixed: opts.fixed, context: contextLines, source: sourceEnabled, in: opts.in, json: opts.json, globalDir,
    });
}

async function executeMapAction(ctx, dirArg, opts) {
    const dir = ctx.queryRoot(dirArg);
    const root = resolve(dir);
    const globalDir = ctx.getGlobalDir();
    let maxDirsW;
    if (opts.maxDirs !== undefined) {
        const n = parseInt(opts.maxDirs, 10);
        if (!Number.isFinite(n) || n <= 0) {
            console.error(`✗ --max-dirs must be a positive integer, got "${opts.maxDirs}"`);
            process.exit(1);
            return;
        }
        maxDirsW = n;
    }
    await ctx.refreshBefore(dir, opts);
    const { readWorkspace } = await import("../graph/workspace.js");
    if (readWorkspace(root, globalDir)) {
        const [{ runWorkspaceMap }, histMod] = await Promise.all([
            import("../graph/workspace-cli.js"),
            opts.churn ? import("../blast/history.js") : Promise.resolve({}),
        ]);
        runWorkspaceMap(root, globalDir, {
            maxDirs: maxDirsW, json: Boolean(opts.json), churn: Boolean(opts.churn), since: opts.since,
            analyzeGitHistory: histMod.analyzeGitHistory,
        });
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
        console.error(`✗ no graph found at ${contextDir} — run \`plexer build\` first`);
        process.exit(1);
        return;
    }
    const map = buildRepoMap(graph, { maxDirs: maxDirsW, ...(gitHistory ? { gitHistory } : {}) });
    if (opts.json) {
        console.log(JSON.stringify(map, null, 2));
        return;
    }
    process.stdout.write(formatRepoMap(map));
}

function registerSearchAndMapCommands(program, ctx) {
    program
        .command("grep")
        .description("Regex search over indexed files, hits grouped by enclosing symbol and ranked by coupling ($0, offline)")
        .argument("<patterns...>", "one or more regex patterns (or literal strings with --fixed)")
        .option("-i, --ignore-case", "case-insensitive match")
        .option("--fixed", "treat pattern as a literal string, not a regex")
        .option("-C, --context <lines>", "lines of surrounding context to show around each hit (default: 2)")
        .option("--source", "show surrounding source context around each hit (default: true)")
        .option("--no-source", "show 1-line matches only without surrounding context")
        .option("--full", "show extended surrounding source context around each hit")
        .option("--in <path>", "narrow to files at or under this path prefix")
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
    const tabs = parseTabs(opts.tabs);
    const dir = ctx.queryRoot(dirArg);
    const root = resolve(dir);
    const contextDir = contextDirFor(root, ctx.getGlobalDir());
    if (!existsSync(contextDir)) {
        console.error(`✗ no context graph at ${contextDir} — run \`plexer build\` first`);
        process.exit(1);
    }
    if (opts.export) {
        const { exportViz } = await import("../viz/export.js");
        const out = exportViz({
            contextDir, viewerDir: VIEWER_DIR, outDir: resolve(opts.export), repoName: basename(root), subtitle: opts.title, tabs,
        });
        const kb = Math.round(out.bytes / 1024);
        const counts = out.contextNodes > 0 ? `${out.contextNodes} areas, ${out.codeNodes} code nodes` : `${out.codeNodes} code nodes`;
        console.log(`plexer viz → ${out.file} (${kb} kB, ${counts})`);
        return;
    }
    const { startVizServer } = await import("../viz/serve.js");
    const srv = await startVizServer({
        root, contextDir, viewerDir: VIEWER_DIR, port: Number(opts.port), repoName: basename(root),
    });
    console.log(`plexer viz → ${srv.url}  (ctrl-c to stop)`);
    const stopViz = () => {
        srv.close().finally(() => process.exit(0));
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
        .option("--tabs <list>", "tabs the exported page offers, comma separated: context,code,modules,symbols,outline")
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
                  (a) => !KNOWN_HEALTH_SUBCOMMANDS.has(String(a).toLowerCase()) && existsSync(a) && statSync(a).isDirectory(),
              )
            : undefined);
    const dir = ctx.queryRoot(rawTargetPath);
    if (rawTargetPath) {
        const relSub = relative(dir, resolve(rawTargetPath)).replace(/\\/g, "/");
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
    await runHealthCommand(dir, positionalArgs || [], {
        ...opts,
        contextDir: globalDir,
        noBadge: opts.badge === false,
        noBudget: opts.budget === false,
    });
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

async function runGlobalOnlyInit(home, opts, explicitMcp) {
    const { globalSetupTargets, runGlobalSetup } = await import("../hosts/setup.js");
    const globalAgents = Array.isArray(opts.agents) ? opts.agents : opts.agents === false ? ["claude"] : undefined;
    if (opts.dryRun) {
        for (const w of globalSetupTargets({ home, agents: globalAgents, bin: opts.bin, skills: opts.skills })) {
            console.log(`${w.hostId}: ${w.path} (${w.what})`);
        }
        return;
    }
    const res = runGlobalSetup({
        home, agents: globalAgents, bin: opts.bin, skills: opts.skills, hooks: opts.hooks, mcp: explicitMcp,
    });
    for (const group of [res.bin, res.skills, res.hooks, res.mcp]) {
        for (const item of group) {
            console.log(`${item.action}: ${item.path}`);
        }
    }
    console.error("✓ global plexer binary, skill links, and hooks wired");
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
    console.error(`✓ wired ${ids.join(", ")} in ${repo}`);
}

async function executeInitCommand(ctx, dir, opts, command) {
    if (opts.listAgents) {
        const { allHostIds } = await import("../hosts/registry.js");
        for (const id of allHostIds()) console.log(id);
        return;
    }
    const globalOnly = command.getOptionValueSource("global") === "cli" && opts.global === true;
    const allowGlobal = opts.global !== false;
    const explicitMcp = command.getOptionValueSource("mcp") === "cli" ? opts.mcp : undefined;
    const home = homedir();
    if (globalOnly) {
        await runGlobalOnlyInit(home, opts, explicitMcp);
        return;
    }
    const [{ planInit, selectedWrites }, { globalSetupTargets, runGlobalSetup }] = await Promise.all([
        import("../hosts/plan.js"),
        import("../hosts/setup.js"),
    ]);
    const repo = resolve(dir);
    const plan = planInit(repo, { home });
    const detectedIds = plan.filter((p) => p.detected).map((p) => p.id);
    const ids = Array.isArray(opts.agents) ? opts.agents : opts.allAgents ? plan.map((p) => p.id) : opts.agents === false ? ["claude"] : detectedIds;
    if (opts.dryRun) {
        const seen = new Set();
        if (allowGlobal && ids.length > 0) {
            for (const w of globalSetupTargets({ home, agents: ids, bin: opts.bin, skills: opts.skills })) {
                seen.add(w.path);
                console.log(`${w.hostId}: ${w.path} (${w.what})`);
            }
        }
        for (const w of selectedWrites(plan, ids, { global: allowGlobal, mcp: explicitMcp, hooks: opts.hooks, skills: opts.skills })) {
            if (seen.has(w.path)) continue;
            seen.add(w.path);
            console.log(`${w.hostId}: ${w.path} (${w.what})`);
        }
        return;
    }
    if (ids.length === 0) {
        console.error("· no agents selected — nothing written");
        return;
    }
    if (allowGlobal) {
        runGlobalSetup({ home, agents: ids, bin: opts.bin, skills: opts.skills, hooks: opts.hooks, mcp: explicitMcp });
    }
    await wireInitRepoTargets(ctx, repo, ids, home, explicitMcp, opts);
}

async function executeRetractCommand(dir, opts) {
    const { planRetract, runRetract, changed } = await import("../hosts/retract.js");
    const repo = resolve(dir);
    const home = homedir();
    const common = { home, global: opts.global, cache: !opts.keepCache };
    if (!opts.yes || opts.dryRun) {
        const rs = changed(planRetract(repo, common));
        if (opts.json) {
            console.log(JSON.stringify({ dryRun: true, entries: rs }, null, 2));
            return;
        }
        for (const r of rs) console.error(`would remove: ${r.path} (${r.what})`);
        console.error("\nDry run — nothing was touched. Re-run with -y to remove.");
        return;
    }
    const done = changed(runRetract(repo, { ...common, apply: true }));
    if (opts.json) {
        console.log(JSON.stringify({ dryRun: false, entries: done }, null, 2));
        return;
    }
    for (const r of done) console.error(`removed: ${r.path} (${r.what})`);
    console.error("\n✓ plexer wiring removed.");
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
            return runGlobalOnlyInit(homedir(), opts, explicitMcp);
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
        .action((dir, opts) => executeRetractCommand(dir, opts));
}

export async function runCli(argv = process.argv) {
    const program = new Command();
    const currentVersion = readCurrentVersion(import.meta.url);
    program
        .name("plexer")
        .description("Build a repo's structural context graph as linked markdown + graph.json ($0, offline).")
        .version(currentVersion, "-v, --version")
        .option("--dir <path>", "context graph directory (default: <repo>/plexer)");
    const ctx = createCliContext(program, currentVersion);
    registerBuildAndCheckCommands(program, ctx);
    registerQueryCommands(program, ctx);
    registerCallersAndBlastCommands(program, ctx);
    registerSearchAndMapCommands(program, ctx);
    registerVizAndMcpCommands(program, ctx);
    registerHealthCommand(program, ctx);
    registerHostLifecycleCommands(program, ctx);
    await program.parseAsync(argv);
}
