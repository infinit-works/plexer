import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempTracker, runPlexerCli as runCli, writeFilesAndCommit as initGitChild } from "./helpers/git-fixture.js";

const { makeTempDir, cleanup } = createTempTracker("plexer-ws-cli-");

after(cleanup);

describe("Multi-repo Workspace CLI Federation (`plexer/workspace.json` + `.code-workspace`)", () => {
    it("runs build, check, ask, callers, grep, and map across child git repos via CLI", () => {
        const wsRoot = makeTempDir();
        writeFileSync(
            join(wsRoot, "project.code-workspace"),
            JSON.stringify({ folders: [{ path: "auth-svc" }, { path: "billing-svc" }] }, null, 2),
            "utf8",
        );
        initGitChild(join(wsRoot, "auth-svc"), {
            "src/tokens.ts": [
                "export function verifyBearerJwt(token: string): boolean {",
                '    return token.startsWith("jwt_");',
                "}",
            ].join("\n") + "\n",
            "src/middleware.ts": [
                'import { verifyBearerJwt } from "./tokens";',
                "export function authorizeRequest(hdr: string): boolean {",
                "    return verifyBearerJwt(hdr);",
                "}",
            ].join("\n") + "\n",
        });
        initGitChild(join(wsRoot, "billing-svc"), {
            "src/invoice.ts": [
                "export function settleMonthlyInvoice(cents: number): number {",
                "    return Math.max(0, cents);",
                "}",
            ].join("\n") + "\n",
            "src/runner.ts": [
                'import { settleMonthlyInvoice } from "./invoice";',
                "export function runBillingJob(): number {",
                "    return settleMonthlyInvoice(4200);",
                "}",
            ].join("\n") + "\n",
        });

        // 1. build federates into plexer/workspace.json + per-child plexer/ graphs
        const buildRes = runCli(wsRoot, ["build"]);
        assert.equal(buildRes.status, 0, buildRes.stderr);
        assert.equal(existsSync(join(wsRoot, "plexer", "workspace.json")), true);
        const wsIndex = JSON.parse(readFileSync(join(wsRoot, "plexer", "workspace.json"), "utf8"));
        assert.deepEqual(wsIndex, { version: 1, children: ["auth-svc", "billing-svc"] });

        // 2. check reports ok on clean federated workspace
        const checkOk = runCli(wsRoot, ["check", "--json"]);
        assert.equal(checkOk.status, 0, checkOk.stderr);
        const checkJson = JSON.parse(checkOk.stdout);
        assert.equal(checkJson.ok, true);
        assert.equal(checkJson.missing.length, 0);

        // 3. ask fuses across both repos cleanly & honors --in <child>
        const askBoth = runCli(wsRoot, ["ask", "verifyBearerJwt settleMonthlyInvoice"]);
        assert.equal(askBoth.status, 0, askBoth.stderr);
        assert.match(askBoth.stdout, /auth-svc\//);
        assert.match(askBoth.stdout, /billing-svc\//);

        const askScoped = runCli(wsRoot, ["ask", "settleMonthlyInvoice", "--in", "billing-svc", "--json"]);
        assert.equal(askScoped.status, 0, askScoped.stderr);
        const askJson = JSON.parse(askScoped.stdout);
        assert.ok(askJson.hits.length >= 1);
        assert.ok(askJson.hits.every((h) => h.pointer.startsWith("billing-svc/")));

        // 4. callers finds workspace callers & exits 1 on unknown symbol
        const callersOk = runCli(wsRoot, ["callers", "verifyBearerJwt"]);
        assert.equal(callersOk.status, 0, callersOk.stderr);
        assert.match(callersOk.stdout, /auth-svc\//);
        assert.match(callersOk.stdout, /authorizeRequest/);

        const callersMiss = runCli(wsRoot, ["callers", "nonExistentWorkspaceSymbol"]);
        assert.equal(callersMiss.status, 1, "missing symbol in workspace callers must exit 1");

        // 5. grep searches across both repos
        const grepOk = runCli(wsRoot, ["grep", "settleMonthlyInvoice", "--fixed"]);
        assert.equal(grepOk.status, 0, grepOk.stderr);
        assert.match(grepOk.stdout, /billing-svc\//);

        // 6. map summarizes workspace children
        const mapOk = runCli(wsRoot, ["map"]);
        assert.equal(mapOk.status, 0, mapOk.stderr);
        assert.match(mapOk.stdout, /workspace map/);
        assert.match(mapOk.stdout, /auth-svc\//);
        assert.match(mapOk.stdout, /billing-svc\//);

        // 7. Missing child index fails `plexer check` with exit code 1
        rmSync(join(wsRoot, "billing-svc", "plexer"), { recursive: true, force: true });
        const checkMissing = runCli(wsRoot, ["check", "--json"]);
        assert.equal(checkMissing.status, 1, "missing child graph must fail workspace check with exit 1");
        const missingJson = JSON.parse(checkMissing.stdout);
        assert.equal(missingJson.ok, false);
        assert.ok(missingJson.missing.some((m) => m === "billing-svc" || m.includes("billing-svc")));
    });
});
