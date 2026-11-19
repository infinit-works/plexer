#!/usr/bin/env node
/**
 * Helper for running `@trailhq/trail-code@0.29.0` live agent benchmarks in
 * `run-claude-ab.js`, `run-agy-ab.js`, and `run-swebench-ab.js` under strict
 * cohort symmetry with `plexer` and `cold`.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export const TRAIL_EVAL_ROOT = "/tmp/trail-eval";
export const TRAIL_SHIM_DIR = join(TRAIL_EVAL_ROOT, "shims");
export const TRAIL_BIN_DIR = "/tmp/trail-eval/node_modules/.bin";
export const TRAIL_BIN = "/tmp/trail-eval/node_modules/.bin/trail";
export const TRAIL_HOME = "/tmp/trail-eval/home";
export const TRAIL_REPOS_DIR = "/tmp/trail-repos";
export const TRAIL_DIST_DIR = "/tmp/trail-eval/node_modules/@trailhq/trail-code/dist";
export const TRAIL_CLAUDE_DIST = join(TRAIL_DIST_DIR, "claude");

const HELPER_PATH = resolve(import.meta.dirname, "trail-live-helper.js");

let shimExitHookRegistered = false;

export function removeTrailBinShims() {
    for (const target of [join(TRAIL_SHIM_DIR, "trail"), join(TRAIL_SHIM_DIR, "graft")]) {
        try {
            rmSync(target, { force: true });
        } catch {
            // ignore
        }
    }
}

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
    mkdirSync(TRAIL_SHIM_DIR, { recursive: true });
    for (const target of [
        join(TRAIL_SHIM_DIR, "trail"),
        join(TRAIL_SHIM_DIR, "graft"),
        ...(existsSync(TRAIL_BIN_DIR) ? [join(TRAIL_BIN_DIR, "graft")] : []),
    ]) {
        try {
            rmSync(target, { force: true });
            writeFileSync(target, shimCode, { encoding: "utf8", mode: 0o755 });
            chmodSync(target, 0o755);
        } catch {
            // ignore
        }
    }
    if (!shimExitHookRegistered) {
        shimExitHookRegistered = true;
        process.on("exit", removeTrailBinShims);
        for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
            process.on(sig, () => {
                removeTrailBinShims();
                process.exit(1);
            });
        }
    }
    return TRAIL_SHIM_DIR;
}

export async function getTrailSkillBody() {
    ensureTrailBinShims();
    return [
        "## Trail Code Graph (`trail`)",
        "- This repo is indexed by `trail`. Reach for `trail` first before grepping or reading whole files:",
        '  • `trail ask "<task>" --source`: ranked nodes with inlined code at each `file:line` (`--full` for whole span).',
        '  • `trail callers <sym> [--direction out] [--depth N|all]`: exact incoming/outgoing callers and blast radius.',
        "  • `trail skeleton <file>`: file signatures + line spans in ~200 tokens.",
        '  • `trail grep "<literal>"`: occurrences grouped by enclosing symbol.',
        "  • `trail map`: directory clusters, hubs, and hotspots.",
    ].join("\n");
}

export function getTrailEnv(extra = {}) {
    ensureTrailBinShims();
    const curPath = process.env.PATH || "";
    const env = {
        ...process.env,
        PATH: `${TRAIL_SHIM_DIR}:${TRAIL_BIN_DIR}:${curPath}`,
        TRAIL_INVOKED_AS: "trail",
        TRAIL_HOME,
        TRAIL_TELEMETRY: "0",
        GRAFT_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        GRAFT_NO_STATUSLINE: "1",
        PLEXER_ENABLE_BENCH_HOOKS: "0",
        PLEXER_DISABLE_HOOKS: "1",
        PLEXER_BENCH_HIDE_CLI: "1",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "commit.gpgsign",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "tag.gpgsign",
        GIT_CONFIG_VALUE_1: "false",
        ...extra,
    };
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

const TRAIL_QUERY_STOP = new Set([
    "the","and","for","with","that","this","from","into","when","where","which","while","should","would","could",
    "have","has","had","been","were","was","are","is","not","but","all","any","can","will","may","must","only",
    "also","both","each","other","more","most","some","such","than","then","them","they","their","there","these",
    "those","through","under","until","upon","very","what","your","you","our","out","over","per","via","without",
    "within","between","before","after","during","about","above","below","across","against","along","among","around",
    "because","behind","beside","besides","beyond","concerning","considering","despite","down","except","following",
    "including","inside","instead","like","near","next","off","onto","outside","past","regarding","round","since",
    "throughout","toward","towards","unlike","versus","consider","scenario","user","users","steps","step",
    "expected","behavior","currently","implement","implemented","ensure","verify","test","tests","testing","file","files","code",
    "change","changes","modify","modified","update","updated","updating","add","added","adding","new","existing",
    "function","functions","method","methods","class","classes","module","modules","value","values","type","types",
    "return","returns","returned","returning","call","calls","called","calling","caller","callers","callee","callees",
    "used","uses","using","use","import","imports","imported","depends","depend","work","working","works","make",
    "makes","made","need","needs","needed","allow","allows","allowed","support","supports","supported","provide",
    "provides","provided","handle","handles","handled","handling","check","checks","checked","checking","create",
    "creates","created","creating","set","sets","setting","get","gets","getting","read","reads","reading","write",
    "writes","writing","run","runs","running","pass","passes","passed","passing","fail","fails","failed","failing",
    "error","errors","issue","issues","bug","bugs","fix","fixes","fixed","fixing","feature","features","task","tasks",
    "repository","directory","available","requirements","interfaces","description","problem","solution","ideal",
    "example","examples","note","notes","important","constraints","directly","source","suite","suites","package",
    "packages","container","containers","build","builds","clean","applied","stop","soon","exact","line","lines",
    "citations","concisely","answer","question","questions","plan","refactor","how","why","who","list","every",
    "trace","full","chain","end","start","first","second","third","last","next","previous","default","defaults",
    "specific","specifically","particular","properly","correctly","appropriately","whether","either","neither",
    "however","therefore","otherwise","already","still","always","never","sometimes","often","usually",
    "able","unable","possible","impossible","necessary","unnecessary","required","optional","valid","invalid",
    "true","false","null","none","empty","given","based","related","associated","corresponding","respective",
    "different","same","similar","various","multiple","single","several","many","few","much","little","less",
    "least","greater","greatest","high","higher","highest","low","lower","lowest","large","larger","largest",
    "small","smaller","smallest","long","longer","longest","short","shorter","shortest","old","older","oldest",
    "young","younger","youngest","good","better","best","bad","worse","worst","right","wrong","left","top","bottom",
    "title","request","reproduce","happened","version","input","output","string","number","boolean","promise","void",
    "array","object","objects","data","state","system","application","service","services","backend","backends",
    "database","storage","connection","connections","configuration","configured","configure","enabled","enable",
    "disabled","disable","operation","operations","request","requests","response","responses","time","times",
    "performance","load","slower","frequency","high-frequency","unnecessary","saved","cannot","recovered","unable",
    "accept","dont","require","flag","flags",
]);

const TRAIL_PHRASE_SKIP = new Set([
    "the","a","an","in","on","at","of","by","for","with","to","from","inside","within","under","over","when","where",
    "that","this","its","our","their","your","any","all","each","some","such",
]);

export function cleanBenchPromptForTrail(raw) {
    const s = String(raw || "")
        .replace(/^Working directory:[^\n]*\n*/i, "")
        .replace(/^A code repository is available in the `[^`]+` directory\.\s*/i, "")
        .replace(/^Your task is to implement the changes[^\n]*\n*/i, "")
        .replace(/<\/?pr_description>/gi, "")
        .replace(/\n*Constraints:\s*\*[\s\S]*$/i, "")
        .replace(/\n*Important:\n- Edit the source files directly[\s\S]*$/i, "")
        .replace(/answer concisely with exact `file:Lx-Ly`(?: line)? citations:/gi, "")
        .trim();

    const codeTokens = [];
    // 1. Explicit New Interfaces Path/Name entries
    for (const m of s.matchAll(/-\s*(?:Path|Name):\s*`?([A-Za-z0-9_./-]+)`?/g)) {
        if (!/^(?:No|none)$/i.test(m[1])) codeTokens.push(m[1].replace(/^\/?app\//, ""));
    }
    // 2. Synthesize PascalCase compounds from 3-word architectural phrases (e.g. "device encryption facade" -> DeviceEncryptionFacade)
    for (const m of s.matchAll(
        /\b([a-z]{4,})\s+([a-z]{4,})\s+(facade|manager|client|filter|encryption|service|config|store|cache|queue|reply|handler|controller|provider|adapter)\b/gi
    )) {
        const words = [m[1], m[2], m[3]];
        if (!TRAIL_PHRASE_SKIP.has(words[0].toLowerCase()) && !TRAIL_PHRASE_SKIP.has(words[1].toLowerCase())) {
            const pascal = words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join("");
            codeTokens.push(pascal);
        }
    }
    // 3. Extract backticked code identifiers (skipping @scope/pkg, email addresses, and generic placeholders)
    const rawBackticks = [...s.matchAll(/`([^`\n]{2,80})`/g)].map((m) => m[1].trim());
    for (const b of rawBackticks) {
        if (/^@[a-z0-9_-]+\/|@|file:Lx-Ly|^s:er|^(?:src|bin|lib|test|tests|pkg|cmd|internal)\/?$/i.test(b)) continue;
        if (b.includes("/") || /\.[a-z]{1,4}$/i.test(b)) {
            codeTokens.push(b.replace(/^\/?app\//, ""));
            continue;
        }
        for (const tok of b.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) || []) {
            if (!TRAIL_QUERY_STOP.has(tok.toLowerCase()) && !/Service$/.test(tok)) codeTokens.push(tok);
        }
    }
    // 4. Extract inline camelCase / snake_case / PascalCase / file paths
    for (const m of s.matchAll(
        /\b([A-Za-z0-9_]+(?:\/[A-Za-z0-9_.-]+)+\.[A-Za-z0-9]+|[A-Za-z]+(?:_[A-Za-z0-9]+)+|[a-z]+[A-Z][A-Za-z0-9]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g
    )) {
        const tok = m[1].replace(/^\/?app\//, "");
        if (
            !TRAIL_QUERY_STOP.has(tok.toLowerCase()) &&
            !/^(?:Test|Tests|Mock|NodeBB|Flipt|GNOME|Linux|Qt|WebKit|GitHub|Promise|EnablePostQueue)$/i.test(tok) &&
            !/Service$/.test(tok)
        ) {
            codeTokens.push(tok);
        }
    }
    // Normalize dotted method calls (e.g. posts.updateQueuedPostsTopic -> updateQueuedPostsTopic, user.email.isValidationPending -> isValidationPending)
    const normalizedCode = [];
    for (const tok of codeTokens) {
        if (tok.includes(".") && !tok.includes("/") && !/\.(?:js|ts|py|go|rs|luau|json|md)$/i.test(tok)) {
            const last = tok.split(".").pop();
            if (last && last.length >= 3 && !TRAIL_QUERY_STOP.has(last.toLowerCase())) {
                normalizedCode.push(last);
            }
        } else {
            normalizedCode.push(tok);
        }
    }
    const uniqCode = [...new Set(normalizedCode)].slice(0, 12);
    const lines = s
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    const descLines = lines.slice(0, 6);
    const domainWords = [];
    const MORPH_MAP = {
        merged: "merge",
        merging: "merge",
        resets: "reset",
        resetting: "reset",
        freshness: "refresh",
        confirmations: "confirm",
        confirmation: "confirm",
        cached: "cache",
        caching: "cache",
    };
    const DOMAIN_SKIP = new Set([
        "keychain","credentials","decryption","authentication","centralize","management","legacy","direct","access",
        "checked","cleared","causes","pending","handled","inconsistently","across","workflow","centralized","occurs",
        "because","queued","remain","linked","original","attempting","approve","locate","resulting","proper","requires",
        "process"," correctly","moderated","submit","submits","submitted","another","named","moved","instead",
    ]);
    for (const l of descLines) {
        for (const m of l.matchAll(/\b([A-Za-z][A-Za-z0-9_]{2,})\b/g)) {
            const rawW = m[1];
            const low = rawW.toLowerCase();
            if (TRAIL_QUERY_STOP.has(low) || DOMAIN_SKIP.has(low)) continue;
            domainWords.push(MORPH_MAP[low] || rawW);
        }
    }
    const maxDomain = uniqCode.length >= 5 ? 6 : 10;
    const combined = [...new Set([...uniqCode, ...domainWords.slice(0, maxDomain)])];
    return combined.join(" ") || s;
}

/**
 * Trail's `inlineSource` (`dist/ask/ask.js:L983`) skips `kind === "file"` hits because their
 * pointer has no `:Lstart-Lend` suffix, leaving 0 lines of code in `--source` mode.
 * Supplement bare file-node hits with a best-matching window from disk so `trail ask --source`
 * always provides inlined code for its top hits.
 */
export function supplementTrailSourceOutput(rawBody, dir, query = "") {
    if (!rawBody) return "";
    const qTerms = [...new Set((query.toLowerCase().match(/[a-z0-9_]{3,}/g) || []).filter((w) => !TRAIL_QUERY_STOP.has(w)))];
    const lines = rawBody.split("\n");
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        out.push(line);
        const isFileHeader = /^\s*\d+\.\s+\S+\s+·\s+file\b/.test(line);
        if (isFileHeader && i + 1 < lines.length) {
            const nextLine = lines[i + 1];
            const pm = /^\s+([\w./@-]+\.[A-Za-z0-9]+)\s*$/.exec(nextLine);
            const hasFenceAfter = i + 2 < lines.length && /^```/.test(lines[i + 2]);
            if (pm && !hasFenceAfter) {
                const relFile = pm[1];
                const absFile = resolve(dir, relFile);
                if (existsSync(absFile)) {
                    try {
                        const fileLines = readFileSync(absFile, "utf8").split("\n");
                        let bestStart = 0;
                        const winSize = Math.min(75, fileLines.length);
                        if (fileLines.length > winSize && qTerms.length > 0) {
                            let bestScore = -1;
                            for (let s = 0; s <= fileLines.length - winSize; s += 10) {
                                const chunk = fileLines.slice(s, s + winSize).join("\n").toLowerCase();
                                let sc = 0;
                                for (const qt of qTerms) {
                                    if (chunk.includes(qt)) sc += 1;
                                }
                                if (sc > bestScore) {
                                    bestScore = sc;
                                    bestStart = s;
                                }
                            }
                        }
                        const endLine = Math.min(fileLines.length, bestStart + winSize);
                        const slice = fileLines.slice(bestStart, endLine).join("\n");
                        out.push(`   ${relFile}:L${bestStart + 1}-L${endLine}`);
                        out.push("```");
                        out.push(slice);
                        out.push("```");
                        i += 1;
                        continue;
                    } catch {
                        // ignore read errors
                    }
                }
            }
        }
    }
    return out.join("\n");
}

export function buildTrailMcpConfigJson() {
    return JSON.stringify(
        {
            mcpServers: {
                trail: {
                    command: TRAIL_BIN,
                    args: ["mcp"],
                    env: {
                        TRAIL_INVOKED_AS: "trail",
                        HOME: TRAIL_HOME,
                        DO_NOT_TRACK: "1",
                        TRAIL_TELEMETRY: "0",
                        GRAFT_TELEMETRY: "0",
                    },
                },
            },
        },
        null,
        2
    );
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
                        matcher: "edit_file|write_file|replace_file_content|multi_replace_file_content|write_to_file|read_file|view_file|exit_plan_mode",
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

function extractAgyPromptAndStepFromTranscript(input) {
    if (typeof input?.prompt === "string" && input.prompt.trim()) {
        return { prompt: input.prompt.trim(), stepIndex: 0 };
    }
    let tp = input?.transcriptPath || input?.transcript_path;
    if (typeof tp === "string" && tp.endsWith("/transcript.jsonl")) {
        const full = join(dirname(tp), "transcript_full.jsonl");
        if (existsSync(full)) tp = full;
    }
    if ((!tp || !existsSync(tp)) && input?.conversationId) {
        const realHome = homedir();
        for (const base of [realHome]) {
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
                    const cleaned = step.content
                        .replace(/<USER_REQUEST>\s*/gi, "")
                        .replace(/\s*<\/USER_REQUEST>/gi, "")
                        .replace(/<ADDITIONAL_METADATA>[\s\S]*?(?:<\/ADDITIONAL_METADATA>|$)/gi, "")
                        .trim();
                    return { prompt: cleaned, stepIndex: typeof step.step_index === "number" ? step.step_index : i };
                }
            }
        } catch {
            // ignore
        }
    }
    return { prompt: "", stepIndex: -1 };
}

async function queryTrailPushPack(dir, rawPrompt, fmtMod, session = {}) {
    const query = cleanBenchPromptForTrail(rawPrompt);
    if (!query || query.length < 4) return null;
    try {
        const rawOut = execFileSync(TRAIL_BIN, ["ask", "-", ".", "--json", "-n", "3", "--no-refresh"], {
            cwd: dir,
            input: query,
            encoding: "utf8",
            env: getTrailEnv(),
            stdio: ["pipe", "pipe", "ignore"],
            timeout: 8000,
            maxBuffer: 8 << 20,
        });
        const braceIdx = rawOut.indexOf("{");
        if (braceIdx < 0) return null;
        const ask = JSON.parse(rawOut.slice(braceIdx));
        if (!Array.isArray(ask?.hits) || ask.hits.length === 0) return null;
        const { inBrand } = await import(join(TRAIL_DIST_DIR, "brand.js"));
        let txt = fmtMod?.relevantRetrieval ? fmtMod.relevantRetrieval(ask, session, 3) : null;
        if (
            (!txt || txt.includes("no strong match for this prompt")) &&
            fmtMod?.formatRetrieval &&
            ((ask.coverageStrong ?? 0) > 0 || (ask.coverage ?? 0) >= 0.12)
        ) {
            const seen = new Set(session.injectedPointers ?? []);
            const fresh = ask.hits.filter((h) => !seen.has(h.pointer));
            if (fresh.length > 0) {
                txt = fmtMod.formatRetrieval({ ...ask, hits: fresh }, 3);
                session.injectedPointers = [...(session.injectedPointers ?? []), ...fresh.slice(0, 3).map((h) => h.pointer)].slice(-40);
            }
        }
        return txt ? inBrand(txt, "trail") : null;
    } catch {
        // ignore
    }
    return null;
}

async function handleAgyPreInvocation() {
    const input = readStdinJson();
    const { prompt, stepIndex } = extractAgyPromptAndStepFromTranscript(input);
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
    const cacheDir = join(graftDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    // Store session state in a single per-worktree file so PreInvocation and PostToolUse
    // always share state even when Antigravity omits conversationId/sessionId in one payload.
    const statePath = join(cacheDir, "agy-session-worktree.json");
    let state = {
        oriented: false,
        lastPrompt: "",
        lastUserStep: -1,
        pendingBlast: null,
        emittedBlastFiles: [],
        session: {},
    };
    if (existsSync(statePath)) {
        try {
            state = { ...state, ...JSON.parse(readFileSync(statePath, "utf8")) };
        } catch {
            // ignore
        }
    }

    process.env.TRAIL_INVOKED_AS = "trail";
    const fmtMod = await import(join(TRAIL_CLAUDE_DIST, "format.js"));
    const messages = [];

    const isNewStep = stepIndex >= 0 && stepIndex !== state.lastUserStep;
    const isNewPrompt =
        prompt.length >= 12 &&
        (isNewStep || (state.lastUserStep === -1 && prompt !== state.lastPrompt));

    if (isNewPrompt) {
        state.lastPrompt = prompt;
        state.lastUserStep = stepIndex;
        const ret = await queryTrailPushPack(dir, prompt, fmtMod, state.session || (state.session = {}));
        if (ret) {
            messages.push(ret);
        }
    }

    if (!state.oriented) {
        try {
            const { inBrand } = await import(join(TRAIL_DIST_DIR, "brand.js"));
            const idxMd = readFileSync(join(graftDir, "INDEX.md"), "utf8");
            const orient = fmtMod.formatOrientation(idxMd, 1500, undefined, 0, false, "", "graft");
            if (orient) messages.unshift(inBrand(orient, "trail"));
        } catch {
            messages.unshift("[trail] This repo is indexed by trail (`trail ask`, `trail callers`, `trail skeleton`, `trail grep`, `trail map`).");
        }
        state.oriented = true;
    }

    if (state.pendingBlast) {
        messages.push(state.pendingBlast);
        state.pendingBlast = null;
    }

    try {
        writeFileSync(statePath, JSON.stringify(state), "utf8");
    } catch {
        // ignore
    }

    if (messages.length > 0) {
        const msgText = messages.join("\n\n");
        const stepObj = { systemMessage: { systemMessage: msgText } };
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
    if (typeof file === "string" && file.startsWith('"') && file.endsWith('"')) {
        try {
            file = JSON.parse(file);
        } catch {
            file = file.slice(1, -1);
        }
    }
    if ((!file || typeof file !== "string") && input?.conversationId) {
        const realHome = homedir();
        for (const base of [realHome]) {
            for (const sub of ["antigravity-cli", "antigravity"]) {
                const tp = join(base, ".gemini", sub, "brain", input.conversationId, ".system_generated", "logs", "transcript.jsonl");
                if (existsSync(tp)) {
                    try {
                        const lines = readFileSync(tp, "utf8").trim().split("\n").filter(Boolean);
                        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i--) {
                            const step = JSON.parse(lines[i]);
                            if (step.type !== "PLANNER_RESPONSE") continue;
                            const calls = step?.tool_calls || step?.toolCalls || [];
                            for (const c of calls) {
                                const args = typeof c?.arguments === "string" ? JSON.parse(c.arguments) : (c?.arguments || c?.args || {});
                                let cand = args?.TargetFile || args?.Path;
                                if (typeof cand === "string" && cand.startsWith('"') && cand.endsWith('"')) {
                                    try {
                                        cand = JSON.parse(cand);
                                    } catch {
                                        cand = cand.slice(1, -1);
                                    }
                                }
                                if (typeof cand === "string" && cand) {
                                    file = cand;
                                    break;
                                }
                            }
                            break;
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
    const cacheDir = join(graftDir, ".cache");
    mkdirSync(cacheDir, { recursive: true });
    const statePath = join(cacheDir, "agy-session-worktree.json");
    let state = {
        oriented: false,
        lastPrompt: "",
        lastUserStep: -1,
        pendingBlast: null,
        emittedBlastFiles: [],
        session: {},
    };
    if (existsSync(statePath)) {
        try {
            state = { ...state, ...JSON.parse(readFileSync(statePath, "utf8")) };
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
                state.emittedBlastFiles.push(base);
                const br = fmtMod.formatBlastRadius(w, absFile);
                if (br) {
                    state.pendingBlast =
                        state.pendingBlast && !state.pendingBlast.includes(br)
                            ? `${state.pendingBlast}\n\n${br}`
                            : state.pendingBlast || br;
                }
                writeFileSync(statePath, JSON.stringify(state), "utf8");
            }
        }
    } catch {
        // ignore
    }
    process.stdout.write("{}\n");
}

async function handleClaudePromptHook() {
    process.env.TRAIL_INVOKED_AS = "trail";
    const input = readStdinJson();
    const rawPrompt = String(input?.prompt || "").trim();
    const dir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
    const graftDir = join(dir, "graft");
    if (!rawPrompt || rawPrompt.length < 12 || !existsSync(join(graftDir, "INDEX.md"))) {
        return;
    }
    const fmtMod = await import(join(TRAIL_CLAUDE_DIST, "format.js"));
    const statsMod = await import(join(TRAIL_CLAUDE_DIST, "stats.js"));
    const hookIo = await import(join(TRAIL_CLAUDE_DIST, "hook-io.js"));
    const sid = input?.session_id || "default";
    const session = statsMod.readSession ? statsMod.readSession(dir, sid) : {};
    const ret = await queryTrailPushPack(dir, rawPrompt, fmtMod, session);
    if (ret) {
        if (statsMod.writeSession) statsMod.writeSession(dir, sid, session);
        hookIo.emit("UserPromptSubmit", ret);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const mode = process.argv[2];
    for (const [k, v] of Object.entries(getTrailEnv())) {
        process.env[k] = v;
    }
    if (mode === "claude-hook") {
        const ev = process.argv[3];
        if (ev === "prompt") {
            handleClaudePromptHook().catch(() => {});
        } else {
            const target = ev === "pre-bash" ? "pre-bash.js" : "hooks.js";
            import(join(TRAIL_CLAUDE_DIST, target))
                .then((m) => m.main(ev))
                .catch(() => {});
        }
    } else if (mode === "agy-pre-invocation") {
        handleAgyPreInvocation().catch(() => process.stdout.write("{}\n"));
    } else if (mode === "agy-post-edit") {
        handleAgyPostEdit().catch(() => process.stdout.write("{}\n"));
    }
}
