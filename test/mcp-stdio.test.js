import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { buildGraph } from "../src/index.js";
import { CLI_PATH, createTempTracker, initGitCommit } from "./helpers/git-fixture.js";

const { makeTempDir: makeTempRepo, cleanup } = createTempTracker("plexer-mcp-stdio-");

const EXPECTED_TOOLS = [
    "plexer_find_code",
    "plexer_read",
    "plexer_file_api",
    "plexer_check_freshness",
    "plexer_trace_calls",
    "plexer_find_all",
    "plexer_repo_map",
    "plexer_blast",
    "plexer_health",
];

class McpStdioClient {
    constructor(cwd, args = ["mcp"], roots = []) {
        this.child = spawn(process.execPath, [CLI_PATH, ...args], {
            cwd,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                ...process.env,
                PLEXER_NO_DAEMON: "1",
            },
        });
        this.roots = roots;
        this.nextId = 1;
        this.pending = new Map();
        this.rootsRequests = 0;
        this.stderr = "";
        this.closed = false;
        this.exitCode = null;
        this.child.stderr.on("data", (chunk) => {
            this.stderr += String(chunk);
        });
        this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
        this.exitPromise = new Promise((resolve) => {
            this.child.once("exit", (code) => {
                this.exitCode = code ?? -1;
                this.closed = true;
                for (const [, entry] of this.pending) {
                    clearTimeout(entry.timer);
                    entry.reject(new Error(`MCP server exited unexpectedly (${this.exitCode}): ${this.stderr}`));
                }
                this.pending.clear();
                this.rl.close();
                resolve(this.exitCode);
            });
        });
        this.child.on("error", (err) => {
            for (const [, entry] of this.pending) {
                clearTimeout(entry.timer);
                entry.reject(err);
            }
            this.pending.clear();
        });
        this.rl.on("line", (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const msg = JSON.parse(trimmed);
            if (msg.method === "roots/list" && msg.id !== undefined) {
                this.rootsRequests += 1;
                this.send({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { roots: this.roots.map((r) => ({ uri: pathToFileURL(r).href })) },
                });
                return;
            }
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                if (msg.error) reject(new Error(`${msg.error.code}: ${msg.error.message}`));
                else resolve(msg.result);
            }
        });
    }

    send(obj) {
        this.child.stdin.write(`${JSON.stringify(obj)}\n`);
    }

    request(method, params = {}) {
        if (this.closed || this.exitCode !== null) {
            return Promise.reject(new Error(`MCP client already closed before ${method} (exit=${this.exitCode})`));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP request timed out: ${method} (${this.stderr})`));
                }
            }, 8000);
            timer.unref?.();
            this.pending.set(id, { resolve, reject, timer });
            this.send({ jsonrpc: "2.0", id, method, params });
        });
    }

    notify(method, params = {}) {
        this.send({ jsonrpc: "2.0", method, params });
    }

    close() {
        if (this.exitCode !== null) {
            this.rl.close();
            return Promise.resolve(this.exitCode);
        }
        this.closed = true;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    this.child.kill("SIGKILL");
                } catch {
                    // Process already terminated.
                }
                resolve(-1);
            }, 3000);
            timer.unref?.();
            this.exitPromise.then((code) => {
                clearTimeout(timer);
                resolve(code);
            });
            this.child.stdin.end();
        });
    }
}

after(cleanup);

describe("MCP Stdio Server (`bin/plexer.js mcp`)", () => {
    it("validates roots/list from cwd=/tmp, rejects unauthorized dir=\"/\", deduplicates seenSpans, and serves all 9 tools", async () => {
        const repo = makeTempRepo("plexer-mcp-repo-");
        mkdirSync(join(repo, "src"), { recursive: true });
        mkdirSync(join(repo, "test"), { recursive: true });
        writeFileSync(
            join(repo, "src", "ledger.ts"),
            [
                "export function calculateLedgerBalance(entries: number[]): number {",
                "    return entries.reduce((sum, v) => sum + v, 0);",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "service.ts"),
            [
                'import { calculateLedgerBalance } from "./ledger";',
                "export function settleAccount(entries: number[]): number {",
                "    return calculateLedgerBalance(entries);",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "test", "ledger.test.ts"),
            'import { settleAccount } from "../src/service";\nsettleAccount([10, 20]);\n',
            "utf8",
        );
        initGitCommit(repo);
        await buildGraph(repo, { force: true });

        // Working tree change so plexer_blast has concrete diff impact
        writeFileSync(
            join(repo, "src", "ledger.ts"),
            [
                "export function calculateLedgerBalance(entries: number[]): number {",
                "    return entries.reduce((sum, v) => sum + Math.max(0, v), 0);",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );

        const client = new McpStdioClient(tmpdir(), ["mcp"], [repo]);
        try {
            // 1. initialize + notifications/initialized -> triggers roots/list
            const initRes = await client.request("initialize", { protocolVersion: "2024-11-05" });
            assert.equal(initRes.serverInfo.name, "plexer");
            assert.ok(typeof initRes.instructions === "string" && initRes.instructions.length > 0);
            client.notify("notifications/initialized");

            // 2. tools/list returns all 9 canonical tools
            const listRes = await client.request("tools/list");
            const names = listRes.tools.map((t) => t.name);
            assert.deepEqual(names, EXPECTED_TOOLS, `expected exact 9 MCP tools, got ${names.join(", ")}`);

            // 3. Root-validated workspace works from cwd=/tmp WITHOUT passing explicit dir
            const findRes = await client.request("tools/call", {
                name: "plexer_find_code",
                arguments: { query: "calculateLedgerBalance" },
            });
            assert.equal(findRes.isError, false, findRes.content[0].text);
            assert.ok(client.rootsRequests >= 1, "server must request roots/list on notifications/initialized");
            assert.match(findRes.content[0].text, /calculateLedgerBalance/);

            // 4. Reject filesystem root "/" traversal when not authorized
            const rootReject = await client.request("tools/call", {
                name: "plexer_find_code",
                arguments: { query: "anything", dir: "/" },
            });
            assert.equal(rootReject.isError, true, 'dir="/" traversal must be rejected with isError: true');

            // 5. Reject unauthorized outside directory without index
            const unauthDir = makeTempRepo("plexer-mcp-unauth-");
            const unauthReject = await client.request("tools/call", {
                name: "plexer_repo_map",
                arguments: { dir: unauthDir },
            });
            assert.equal(unauthReject.isError, true, "unauthorized unindexed outside directory must be rejected");

            // 6. Per-connection seenSpans dedup across plexer_find_code -> plexer_read
            const readDedup = await client.request("tools/call", {
                name: "plexer_read",
                arguments: { spans: "src/ledger.ts:L1-L3" },
            });
            assert.equal(readDedup.isError, false);
            assert.match(readDedup.content[0].text, /\[seen:/i);

            const readFull = await client.request("tools/call", {
                name: "plexer_read",
                arguments: { spans: "src/ledger.ts:L1-L3", full: true },
            });
            assert.equal(readFull.isError, false);
            assert.match(readFull.content[0].text, /calculateLedgerBalance/);

            // 7. Remaining 7 tools over real stdio connection
            const fileApi = await client.request("tools/call", {
                name: "plexer_file_api",
                arguments: { file: "src/service.ts" },
            });
            assert.equal(fileApi.isError, false);
            assert.match(fileApi.content[0].text, /settleAccount/);

            const freshness = await client.request("tools/call", {
                name: "plexer_check_freshness",
                arguments: {},
            });
            assert.equal(freshness.isError, false);

            const callers = await client.request("tools/call", {
                name: "plexer_trace_calls",
                arguments: { symbol: "calculateLedgerBalance" },
            });
            assert.equal(callers.isError, false);
            assert.match(callers.content[0].text, /settleAccount/);

            const grepRes = await client.request("tools/call", {
                name: "plexer_find_all",
                arguments: { pattern: "settleAccount", fixed: true },
            });
            assert.equal(grepRes.isError, false);
            assert.match(grepRes.content[0].text, /ledger\.test\.ts/);

            const mapRes = await client.request("tools/call", {
                name: "plexer_repo_map",
                arguments: {},
            });
            assert.equal(mapRes.isError, false);
            assert.match(mapRes.content[0].text, /src\//);

            const blastRes = await client.request("tools/call", {
                name: "plexer_blast",
                arguments: { format: "markdown" },
            });
            assert.equal(blastRes.isError, false);
            assert.match(blastRes.content[0].text, /settleAccount|service\.ts/);

            const healthRes = await client.request("tools/call", {
                name: "plexer_health",
                arguments: { action: "scan", format: "json" },
            });
            assert.equal(healthRes.isError, false);
            const hJson = JSON.parse(healthRes.content[0].text);
            assert.equal(typeof hJson.scores?.strict, "number");
        } finally {
            const exitCode = await client.close();
            assert.equal(exitCode, 0, `expected MCP stdio server exit 0, stderr: ${client.stderr}`);
        }
    });
});
