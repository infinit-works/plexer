import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { antigravityPluginRules, canonicalCoreRules, cursorRule, instructionBody, kiroSteering, windsurfRule } from "../src/hosts/instructions.js";
import { mcpInstructions, toolSearchQuery } from "../src/mcp/instructions.js";
import { PLEXER_MCP_TOOL_CANONICAL } from "../src/mcp/tool-names.js";
import { evaluateAgyPreTool, evaluateSearchAndGatePreTool } from "../src/agy/pre-tool.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI_BIN = join(REPO_ROOT, "bin", "plexer.js");
const ALLOWED_PLUGIN_KEYS = new Set([
    "name", "displayName", "version", "description", "author",
    "homepage", "repository", "logo", "suggestedPrompts", "disabled",
]);
const BINARY_EXTS = new Set([".wasm", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".sqlite", ".db"]);

function parseFrontmatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
    assert.ok(m, "SKILL.md must begin with YAML frontmatter");
    const raw = m[1];
    const nameMatch = /^name:\s*(.+)$/m.exec(raw);
    let desc = "";
    const descFold = /^description:\s*>-\r?\n((?:[ \t]+.*\r?\n?)+)/m.exec(raw);
    if (descFold) {
        desc = descFold[1].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ");
    } else {
        const descSingle = /^description:\s*(.+)$/m.exec(raw);
        if (descSingle) desc = descSingle[1].trim().replace(/^["']|["']$/g, "");
    }
    return { name: nameMatch?.[1]?.trim() ?? "", description: desc };
}

function collectShippedTextFiles(root, entries) {
    const out = [];
    const walk = (abs) => {
        const st = statSync(abs);
        if (st.isDirectory()) {
            const base = abs.split(/[\\/]/).pop();
            if (base === "node_modules" || base === ".git" || base === "grammars") return;
            for (const name of readdirSync(abs)) walk(join(abs, name));
            return;
        }
        if (st.isFile() && !BINARY_EXTS.has(extname(abs).toLowerCase())) {
            out.push(abs);
        }
    };
    for (const rel of entries) {
        const p = join(root, rel);
        if (existsSync(p)) walk(p);
    }
    return out;
}

describe("skill, rule, MCP & guardrail parity", () => {
    it("keeps rules/AGENTS.md synchronized with antigravityPluginRules() and host rules AGY-free", () => {
        const rulesText = readFileSync(join(REPO_ROOT, "rules", "AGENTS.md"), "utf8").trim();
        assert.equal(rulesText, antigravityPluginRules().trim(), "rules/AGENTS.md must match antigravityPluginRules()");

        const hostBody = instructionBody();
        assert.ok(hostBody.includes(canonicalCoreRules()), "instructionBody() must embed canonicalCoreRules()");
        assert.equal(hostBody.includes("exit_plan_mode"), false, "host-neutral instructionBody must not leak exit_plan_mode");
        assert.equal(hostBody.includes("write_file"), false, "host-neutral instructionBody must not leak write_file");

        assert.ok(cursorRule().includes(hostBody), "cursorRule must embed instructionBody()");
        assert.ok(kiroSteering().includes(hostBody), "kiroSteering must embed instructionBody()");
        assert.ok(windsurfRule().includes(hostBody), "windsurfRule must embed instructionBody()");
    });

    it("aligns instruction prose with live bin/plexer.js commands and flags", () => {
        const surfaces = [
            readFileSync(join(REPO_ROOT, "rules", "AGENTS.md"), "utf8"),
            readFileSync(join(REPO_ROOT, "SKILL.md"), "utf8"),
            readFileSync(join(REPO_ROOT, "skills", "plexer-health", "SKILL.md"), "utf8"),
            instructionBody(),
            readFileSync(join(REPO_ROOT, "agents", "openai.yaml"), "utf8"),
        ];
        for (const text of surfaces) {
            assert.equal(text.includes('grep "<pat>" [dir]'), false, "must use --in dir, never positional [dir] on grep");
            assert.equal(text.includes("impact <files...>"), false, "impact accepts <symbols...>, never <files...>");
        }

        const runHelp = (...args) => execFileSync(process.execPath, [CLI_BIN, ...args, "--help"], { encoding: "utf8" });
        const rootHelp = runHelp();
        for (const sub of ["read", "ask", "callers", "callees", "impact", "blast", "skeleton", "grep", "map", "health"]) {
            assert.ok(rootHelp.includes(sub), `CLI --help must expose ${sub}`);
        }
        const grepHelp = runHelp("grep");
        for (const flag of ["--in", "-F", "--fixed", "-i", "--ignore-case"]) {
            assert.ok(grepHelp.includes(flag), `grep --help must expose ${flag}`);
        }
        const healthHelp = runHelp("health");
        for (const flag of ["--diff", "--in", "--stateless", "--count", "--cluster", "--lanes", "--attest", "--false-positive", "--permanent", "--dry-run", "--prepare", "--run-batches", "--focus", "--detail", "--detector", "--output", "--status", "--code"]) {
            assert.ok(healthHelp.includes(flag), `health --help must expose ${flag}`);
        }
    });

    it("keeps mcpInstructions() under 1,000 chars and synchronized with TOOLS", () => {
        const instr = mcpInstructions();
        assert.ok(instr.length <= 1000, `mcpInstructions (${instr.length} chars) must stay <= 1000 chars`);
        assert.equal(/\n- plexer_[a-z_]+ —/.test(instr), false, "mcpInstructions bullets must avoid spaced em-dash labels");
        for (const name of PLEXER_MCP_TOOL_CANONICAL) {
            assert.ok(instr.includes(`- ${name}:`), `mcpInstructions must document - ${name}:`);
            assert.ok(toolSearchQuery().includes(`mcp__plexer__${name}`));
        }
    });

    it("validates plugin.json schema, SKILL.md frontmatter, and package portability", () => {
        const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
        const plugin = JSON.parse(readFileSync(join(REPO_ROOT, "plugin.json"), "utf8"));
        for (const k of Object.keys(plugin)) {
            assert.ok(ALLOWED_PLUGIN_KEYS.has(k), `unexpected plugin.json field: ${k}`);
        }
        assert.equal(plugin.version, pkg.version);
        assert.ok(plugin.logo && existsSync(join(REPO_ROOT, plugin.logo)), "plugin.json logo must exist");
        assert.equal(Array.isArray(plugin.suggestedPrompts) && plugin.suggestedPrompts.length, 3, "suggestedPrompts must have 3 items");

        for (const rel of ["SKILL.md", join("skills", "plexer-health", "SKILL.md")]) {
            const text = readFileSync(join(REPO_ROOT, rel), "utf8");
            const { name, description } = parseFrontmatter(text);
            assert.ok(name.length > 0, `${rel} frontmatter requires name`);
            assert.ok(description.length > 0 && description.length <= 1024, `${rel} description length (${description.length}) must be 1..1024`);
            assert.equal(/<[^>]+>/.test(description), false, `${rel} description must not contain XML tags`);
            assert.ok(text.split("\n").length < 500, `${rel} must remain under 500 lines`);
        }

        const shipped = collectShippedTextFiles(REPO_ROOT, pkg.files ?? []);
        assert.ok(shipped.length > 20);
        for (const file of shipped) {
            const raw = readFileSync(file, "utf8");
            assert.equal(/(?:\/home\/|\/Users\/|C:\\\\Users\\\\)/.test(raw), false, `non-portable path found in ${file}`);
        }
    });

    it("guards against shell-script edits to indexed source files while allowing non-source/read-only commands", () => {
        const tmp = mkdtempSync(join(tmpdir(), "plexer-shell-edit-"));
        try {
            mkdirSync(join(tmp, "src"), { recursive: true });
            mkdirSync(join(tmp, "scripts"), { recursive: true });
            mkdirSync(join(tmp, "plexer", ".graph"), { recursive: true });
            writeFileSync(join(tmp, "src", "app.js"), "export function run() { return 1; }\n", "utf8");
            writeFileSync(join(tmp, "package.json"), '{ "name": "fixture" }\n', "utf8");
            writeFileSync(join(tmp, "scripts", "codegen.js"), "console.log('ok');\n", "utf8");

            const stubGraph = {
                nodes: [
                    { id: "src/app.js", path: "src/app.js", kind: "file", span: "L1-L1" },
                    { id: "src/app.js#run", path: "src/app.js", name: "run", kind: "function", span: "L1-L1" },
                ],
                edges: [],
            };
            const getGraph = () => stubGraph;

            for (const cmd of [
                "sed -i 's/1/2/' src/app.js",
                "perl -pi -e 's/1/2/' src/app.js",
                "python3 -c \"open('src/app.js', 'w').write('x')\"",
                "node -e \"require('fs').writeFileSync('src/app.js', 'x')\"",
            ]) {
                const gemState = {};
                const first = evaluateAgyPreTool(
                    { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
                    { repoRoot: tmp, agyState: gemState, geminiProfile: true, getGraph },
                );
                assert.equal(first.decision, "deny", `Gemini profile must deny first attempt of ${cmd}`);
                assert.ok(first.reason.includes("src/app.js"));

                const retry = evaluateAgyPreTool(
                    { toolCall: { name: "run_command", args: { CommandLine: cmd } } },
                    { repoRoot: tmp, agyState: gemState, geminiProfile: true, getGraph },
                );
                assert.equal(retry.decision, "allow", `Gemini profile must allow retry of ${cmd}`);

                const claudeRes = evaluateSearchAndGatePreTool({
                    toolName: "Bash",
                    toolArgs: { command: cmd },
                    repoRoot: tmp,
                    agyState: {},
                    geminiProfile: false,
                    getGraph,
                });
                assert.equal(claudeRes, null, `Claude profile must allow batch shell edits without nag on ${cmd}`);
            }

            for (const safeCmd of [
                "sed -n '1,5p' src/app.js",
                "sed -i 's/fixture/demo/' package.json",
                "node scripts/codegen.js",
                "node --test",
                "python3 -c \"open('/tmp/plexer-out.txt', 'w').write('ok')\"",
            ]) {
                const res = evaluateSearchAndGatePreTool({
                    toolName: "run_command",
                    toolArgs: { CommandLine: safeCmd },
                    repoRoot: tmp,
                    agyState: {},
                    geminiProfile: true,
                    getGraph,
                });
                assert.equal(res, null, `safe/non-indexed command must not trigger shell-edit guard: ${safeCmd}`);
            }
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
