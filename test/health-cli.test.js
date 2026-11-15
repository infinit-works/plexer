import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../src/index.js";
import { runHealthCommand } from "../src/health/health-cli.js";

const CLI_PATH = new URL("../bin/plexer.js", import.meta.url).pathname;
const CLEANUP_DIRS = [];

function makeTempRepo(prefix = "plexer-health-cli-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    CLEANUP_DIRS.push(dir);
    return dir;
}

function initGit(cwd) {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init"], { cwd });
}

function runCliHealth(cwd, args = []) {
    return spawnSync(process.execPath, [CLI_PATH, "health", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PLEXER_NO_DAEMON: "1" },
    });
}

async function captureConsole(fn) {
    const out = [];
    const err = [];
    const origLog = console.log;
    const origErr = console.error;
    const prevCode = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a) => out.push(a.join(" "));
    console.error = (...a) => err.push(a.join(" "));
    try {
        const res = await fn();
        return { res, stdout: out.join("\n"), stderr: err.join("\n"), exitCode: process.exitCode ?? 0 };
    } finally {
        console.log = origLog;
        console.error = origErr;
        process.exitCode = prevCode;
    }
}

after(() => {
    for (const dir of CLEANUP_DIRS) {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup.
        }
    }
});

describe("plexer health CLI (runHealthCommand, flags, exit codes, git mv, & AST syntax guard)", () => {
    it("exercises scan -> next -> status -> suppress -> resolve -> autofix --dry-run -> move via git mv with real CLI exit codes", async () => {
        const repo = makeTempRepo("plexer-hcli-loop-");
        mkdirSync(join(repo, "src"), { recursive: true });

        writeFileSync(
            join(repo, "src", "helper.ts"),
            [
                'import { unusedHelper } from "./unusedTarget";',
                "export function computeTotal(price: number, qty: number): number {",
                '    console.log("DEBUG trace total");',
                "    try {",
                "        return price * qty;",
                "    } catch {",
                "        return 0;",
                "    }",
                "}",
                "export function orphanExportedHelper(): number {",
                "    return 42;",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "unusedTarget.ts"),
            "export function unusedHelper(): number { return 1; }\nexport function usedHelper(): number { return 2; }\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "consumer.ts"),
            [
                'import { computeTotal } from "./helper";',
                'import { usedHelper } from "./unusedTarget";',
                "export function checkout(n: number): number {",
                "    return computeTotal(n, usedHelper());",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        initGit(repo);
        await buildGraph(repo, { force: true });

        // 1. scan via runHealthCommand (--format json)
        const scanOut = await captureConsole(() => runHealthCommand(repo, ["scan"], { json: true }));
        assert.equal(scanOut.exitCode, 0);
        const scanJson = JSON.parse(scanOut.stdout);
        assert.ok(scanJson.scores.strict < 100, "initial repo with issues must score < 100");
        assert.ok(scanJson.queue.items.length >= 2, `expected open issues, got ${scanJson.queue.items.length}`);

        // 2. next & status via real CLI binary
        const nextCli = runCliHealth(repo, ["next", "--json"]);
        assert.equal(nextCli.status, 0, nextCli.stderr);
        const nextJson = JSON.parse(nextCli.stdout);
        const nonDebugItems = nextJson.queue.items.filter((i) => i.detector !== "debug_logs");
        assert.ok(nonDebugItems.length >= 2, `expected >= 2 non-debug open issues, got ${nextJson.queue.items.length}`);
        const firstId = nonDebugItems[0].id;
        const secondId = nonDebugItems[1].id;

        const statusCli = runCliHealth(repo, ["status"]);
        assert.equal(statusCli.status, 0, statusCli.stderr);
        assert.match(statusCli.stdout, /strict/i);

        // 3. suppress error exitCode (1) on missing pattern/bad attestation, and success exitCode (0) with valid --reason
        const badSuppress = await captureConsole(() =>
            runHealthCommand(repo, ["suppress", firstId], { falsePositive: true, reason: "false positive" }),
        );
        assert.equal(badSuppress.exitCode, 1, "boilerplate false-positive reason must set exitCode 1");

        const goodSuppress = runCliHealth(repo, [
            "suppress",
            firstId,
            "--false-positive",
            "--reason",
            "Intentional fixture test case suppressed in health-cli suite",
        ]);
        assert.equal(goodSuppress.status, 0, goodSuppress.stderr);

        // 4. resolve error exitCode (1) on non-existent ID, and success exitCode (0) with --confirm
        const badResolve = await captureConsole(() =>
            runHealthCommand(repo, ["resolve", "nonexistent::issue::id"], { confirm: true }),
        );
        assert.equal(badResolve.exitCode, 1, "unknown issue pattern in resolve must set exitCode 1");

        const goodResolve = runCliHealth(repo, [
            "resolve",
            secondId,
            "--confirm",
            "--note",
            "Verified manually before rescan",
        ]);
        assert.equal(goodResolve.status, 0, goodResolve.stderr);

        // 5. autofix --dry-run preserves files on disk; real autofix marks reconciled issue verified: false
        const beforeHelper = readFileSync(join(repo, "src", "helper.ts"), "utf8");
        const dryAutofix = await captureConsole(() =>
            runHealthCommand(repo, ["autofix", "debug-logs"], { dryRun: true, json: true }),
        );
        assert.equal(dryAutofix.exitCode, 0);
        const dryJson = JSON.parse(dryAutofix.stdout);
        assert.equal(dryJson.dry_run, true);
        assert.ok(dryJson.total_edits >= 1, "debug-logs fixer should detect DEBUG console.log");
        assert.equal(readFileSync(join(repo, "src", "helper.ts"), "utf8"), beforeHelper, "--dry-run must not write disk");

        const realAutofix = await captureConsole(() =>
            runHealthCommand(repo, ["autofix", "debug-logs"], { json: true }),
        );
        assert.equal(realAutofix.exitCode, 0);
        const realFixJson = JSON.parse(realAutofix.stdout);
        assert.ok(realFixJson.reconciled_issue_ids.length >= 1, "autofix must reconcile fixed issue IDs");
        const stateAfterFix = JSON.parse(readFileSync(join(repo, "plexer", ".health", "state.json"), "utf8"));
        const fixedIssue = stateAfterFix.issues[realFixJson.reconciled_issue_ids[0]];
        assert.equal(fixedIssue.status, "fixed");
        assert.equal(fixedIssue.verified, false, "autofix reconciliation must mark issue verified: false until next scan");

        // 6. move via `git mv` updates git index + consumer import paths
        const moveRes = await captureConsole(() =>
            runHealthCommand(repo, ["move", "src/unusedTarget.ts", "src/shared/movedTarget.ts"], { json: true }),
        );
        assert.equal(moveRes.exitCode, 0);
        const moveJson = JSON.parse(moveRes.stdout);
        assert.equal(moveJson.move_method, "git_mv", "move in git worktree must use `git mv`");
        assert.equal(existsSync(join(repo, "src", "unusedTarget.ts")), false);
        assert.equal(existsSync(join(repo, "src", "shared", "movedTarget.ts")), true);
        const gitStatus = execFileSync("git", ["status", "--short"], { cwd: repo, encoding: "utf8" });
        assert.match(gitStatus, /R\s+src\/unusedTarget\.ts\s+->\s+src\/shared\/movedTarget\.ts|src\/shared\/movedTarget\.ts/);
        assert.match(readFileSync(join(repo, "src", "consumer.ts"), "utf8"), /\.\/shared\/movedTarget/);

        // 7. jailed plan cluster rejections via runHealthCommand & CLI
        const createCluster = runCliHealth(repo, ["plan", "cluster", "create", "demo_cluster", firstId]);
        assert.equal(createCluster.status, 0, createCluster.stderr);
        const jailedExport = runCliHealth(repo, ["plan", "cluster", "export", "demo_cluster", "--output", "../outside-cluster.json"]);
        assert.notEqual(jailedExport.status, 0, "jailed plan cluster export --output outside repo must fail");

        const jailedImport = runCliHealth(repo, ["plan", "cluster", "import", "../outside-cluster.json"]);
        assert.notEqual(jailedImport.status, 0, "jailed plan cluster import outside repo must fail");
    });

    it("aborts autofix cleanly via Tree-sitter AST syntax guard when removing a line would introduce syntax errors", async () => {
        const repo = makeTempRepo("plexer-hcli-astguard-");
        mkdirSync(join(repo, "src"), { recursive: true });
        // Splitting `const total = 1 +\n console.log("DEBUG ...");` is valid JS before autofix,
        // whereas stripping the `console.log` line leaves `const total = 1 +` followed by `const after = 2;` (syntax error).
        const original = [
            "export function guardedComputation(): number {",
            "    const total = 1 +",
            '        console.log("DEBUG guard test");',
            "    const after = 2;",
            "    return Number(Boolean(total)) + after;",
            "}",
        ].join("\n") + "\n";
        writeFileSync(join(repo, "src", "astGuard.ts"), original, "utf8");
        initGit(repo);
        await buildGraph(repo, { force: true });

        const res = await captureConsole(() =>
            runHealthCommand(repo, ["autofix", "debug-logs"], { json: true }),
        );
        assert.equal(res.exitCode, 0);
        const parsed = JSON.parse(res.stdout);
        assert.equal(parsed.files_changed, 0, "syntax-breaking autofix must not apply edits");
        assert.equal(parsed.aborted_files.length, 1, "must record file in aborted_files");
        assert.equal(parsed.aborted_files[0].file, "src/astGuard.ts");
        assert.equal(parsed.aborted_files[0].reason, "syntax_error_increase");
        assert.equal(readFileSync(join(repo, "src", "astGuard.ts"), "utf8"), original, "aborted file must stay untouched on disk");
    });
});
