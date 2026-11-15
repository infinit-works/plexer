import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../src/index.js";
import { agySessionPath } from "../src/agy/session.js";
import { computeCodeStamp, sendDaemonRpc } from "../src/daemon/socket-path.js";
import { createSidecarHandlers } from "../sidecars/viz/main.mjs";

const CLI_PATH = new URL("../bin/plexer.js", import.meta.url).pathname;
const PKG_ROOT = resolve(new URL("..", import.meta.url).pathname);
const CLEANUP_DIRS = [];
const CLEANUP_FILES = [];

function makeTempDir(prefix = "plexer-polyglot-") {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    CLEANUP_DIRS.push(dir);
    return dir;
}

function trackAgySid(sid) {
    CLEANUP_FILES.push(agySessionPath(sid));
    return sid;
}

function readWiring(repo) {
    return JSON.parse(readFileSync(join(repo, "plexer", ".graph", "wiring.json"), "utf8"));
}

after(() => {
    for (const f of CLEANUP_FILES) {
        try { rmSync(f, { force: true }); } catch {}
    }
    for (const d of CLEANUP_DIRS) {
        try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
});

describe("Polyglot CHA, TS/Go/Python/Svelte/Astro/Vue Extraction, Grep Escapes, Cross-Host Hooks, Daemon & Sidecar Security", () => {
    it("resolves CHA interface_dispatch (TS implements, Rust impl Trait, Go structural interface), TS/Go/Python signatures & CJS/default exports", async () => {
        const repo = makeTempDir("plexer-test-cha-");
        mkdirSync(join(repo, "src", "ts"), { recursive: true });
        mkdirSync(join(repo, "src", "rust"), { recursive: true });
        mkdirSync(join(repo, "src", "go"), { recursive: true });
        mkdirSync(join(repo, "src", "py"), { recursive: true });
        mkdirSync(join(repo, "src", "cjs"), { recursive: true });

        // TypeScript CHA + optional_parameter + Promise<T> + renamed default export
        writeFileSync(
            join(repo, "src", "ts", "gateway.ts"),
            [
                "export interface PaymentGateway {",
                "    charge(amount: number, retry?: number): Promise<boolean>;",
                "}",
                "export class StripeGateway implements PaymentGateway {",
                "    async charge(amount: number, retry?: number): Promise<boolean> {",
                "        return amount > 0 || Boolean(retry);",
                "    }",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "ts", "defaultClient.ts"),
            [
                "export default class LedgerClient {",
                "    submitEntry(code: string): boolean { return code.length > 0; }",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "ts", "checkout.ts"),
            [
                'import type { PaymentGateway } from "./gateway";',
                'import RenamedLedger from "./defaultClient";',
                "export async function runPayment(gw: PaymentGateway, amount: number): Promise<boolean> {",
                "    const client = new RenamedLedger();",
                '    client.submitEntry("tx_1");',
                "    return gw.charge(amount);",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );

        // Rust trait + impl Trait
        writeFileSync(
            join(repo, "src", "rust", "store.rs"),
            [
                "pub trait CacheStore {",
                "    fn lookup(&self, key: &str) -> i32;",
                "}",
                "pub struct MemCache;",
                "impl CacheStore for MemCache {",
                "    fn lookup(&self, _key: &str) -> i32 { 42 }",
                "}",
                "pub fn fetch_value(store: &dyn CacheStore) -> i32 {",
                '    store.lookup("k")',
                "}",
            ].join("\n") + "\n",
            "utf8",
        );

        // Go structural interface + params
        writeFileSync(
            join(repo, "go.mod"),
            "module example.com/poly\ngo 1.22\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "go", "notify.go"),
            [
                "package notify",
                "type Notifier interface {",
                "    SendNotice(msg string) error",
                "}",
                "type EmailNotifier struct{}",
                "func (e EmailNotifier) SendNotice(msg string) error { return nil }",
                "func DispatchAlert(n Notifier, text string) error {",
                "    return n.SendNotice(text)",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );

        // Python Optional[T] & self.attr: T
        writeFileSync(
            join(repo, "src", "py", "runner.py"),
            [
                "from typing import Optional",
                "class WorkerClient:",
                "    def execute(self, payload: str) -> str:",
                "        return payload",
                "class JobRunner:",
                "    client: Optional[WorkerClient]",
                "    def __init__(self, client: WorkerClient):",
                "        self.client: WorkerClient = client",
                "    def run_job(self, item: str) -> str:",
                '        return self.client.execute(item)',
            ].join("\n") + "\n",
            "utf8",
        );

        // CJS barrel re-export
        writeFileSync(
            join(repo, "src", "cjs", "impl.js"),
            "function performCjsWork(v) { return v + 1; }\nmodule.exports = { performCjsWork };\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "cjs", "index.js"),
            'module.exports = require("./impl");\n',
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "cjs", "caller.js"),
            'const { performCjsWork } = require("./index");\nfunction callCjs() { return performCjsWork(7); }\n',
            "utf8",
        );

        await buildGraph(repo, { force: true });
        const g = readWiring(repo);

        // TS CHA interface_dispatch + renamed default import + signatures
        const tsDispatch = g.edges.find(
            (e) =>
                e.relation === "calls" &&
                e.confidence === "interface_dispatch" &&
                e.source.includes("src/ts/checkout.ts#runPayment") &&
                e.target.includes("StripeGateway.charge"),
        );
        assert.ok(tsDispatch, "TS interface call must dispatch via CHA to StripeGateway.charge");

        const tsDefaultEdge = g.edges.find(
            (e) =>
                e.relation === "calls" &&
                e.source.includes("src/ts/checkout.ts#runPayment") &&
                e.target.includes("LedgerClient.submitEntry"),
        );
        assert.ok(tsDefaultEdge, "Renamed TS default class import method call must resolve to LedgerClient.submitEntry");

        const chargeNode = g.nodes.find((n) => n.id.includes("StripeGateway.charge"));
        assert.ok(chargeNode?.signature?.includes("retry?: number"), `expected optional parameter in TS signature, got: ${chargeNode?.signature}`);
        assert.ok(chargeNode?.signature?.includes("Promise<boolean>"), `expected Promise<boolean> in TS signature, got: ${chargeNode?.signature}`);

        // Rust trait CHA
        const rustDispatch = g.edges.find(
            (e) =>
                e.relation === "calls" &&
                e.source.includes("src/rust/store.rs#fetch_value") &&
                e.target.includes("MemCache.lookup"),
        );
        assert.ok(rustDispatch, "Rust trait impl method must receive CHA dispatch edge");

        // Go params + structural interface dispatch
        const goFn = g.nodes.find((n) => n.id.includes("src/go/notify.go#DispatchAlert"));
        assert.ok(goFn?.signature?.includes("n Notifier"), `expected Go parameter signature, got: ${goFn?.signature}`);
        const goDispatch = g.edges.find(
            (e) =>
                e.relation === "calls" &&
                e.source.includes("src/go/notify.go#DispatchAlert") &&
                e.target.includes("EmailNotifier.SendNotice"),
        );
        assert.ok(goDispatch, "Go structural interface must dispatch to EmailNotifier.SendNotice");

        // Python Optional[T] / self.attr: T call
        const pyEdge = g.edges.find(
            (e) =>
                e.relation === "calls" &&
                e.source.includes("src/py/runner.py#JobRunner.run_job") &&
                e.target.includes("WorkerClient.execute"),
        );
        assert.ok(pyEdge, "Python self.client: WorkerClient must resolve call to WorkerClient.execute");

        // CJS barrel re-export resolution
        const cjsEdge = g.edges.find(
            (e) =>
                e.relation === "calls" &&
                e.source.includes("src/cjs/caller.js#callCjs") &&
                e.target.includes("src/cjs/impl.js#performCjsWork"),
        );
        assert.ok(cjsEdge, "CJS barrel re-export must resolve call to impl.js#performCjsWork");
    });

    it("extracts exact L<n> spans across .svelte, .astro, and .vue <script lang=\"tsx\"> containers & handles complex grep patterns", async () => {
        const repo = makeTempDir("plexer-test-containers-");
        mkdirSync(join(repo, "src"), { recursive: true });

        writeFileSync(
            join(repo, "src", "Counter.svelte"),
            [
                "<script lang=\"ts\">",
                "  export function incrementCounter(v: number): number {",
                "    return v + 1;",
                "  }",
                "</script>",
                "<button>{incrementCounter(1)}</button>",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "Card.astro"),
            [
                "---",
                "export function buildAstroTitle(s: string): string {",
                "  return s.toUpperCase();",
                "}",
                "---",
                "<div>{buildAstroTitle('hi')}</div>",
                "<script>",
                "  function initClientPanel() {",
                "    return true;",
                "  }",
                "</script>",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "Panel.vue"),
            [
                "<template><div /></template>",
                '<script lang="tsx">',
                "export function renderVueTsxBadge(label: string) {",
                "  return <span>{label}</span>;",
                "}",
                "</script>",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "patterns.ts"),
            [
                "export function evalFallback(a: string, b: string): string {",
                '    const escaped = "a\\"b";',
                "    return a || b || escaped;",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );

        await buildGraph(repo, { force: true });
        const g = readWiring(repo);

        const svelteFn = g.nodes.find((n) => n.name === "incrementCounter");
        assert.equal(svelteFn?.span, "L2-L4", `Svelte line span shifted: ${svelteFn?.span}`);
        const astroFmFn = g.nodes.find((n) => n.name === "buildAstroTitle");
        assert.equal(astroFmFn?.span, "L2-L4", `Astro frontmatter line span shifted: ${astroFmFn?.span}`);
        const vueTsxFn = g.nodes.find((n) => n.name === "renderVueTsxBadge");
        assert.equal(vueTsxFn?.span, "L3-L5", `Vue TSX line span shifted: ${vueTsxFn?.span}`);

        // Grep escaped pipe & quoted-string pattern cleanly without ReDoS error
        const pipeGrep = spawnSync(process.execPath, [CLI_PATH, "grep", "\\|\\|", repo, "--no-refresh"], {
            encoding: "utf8",
            env: { ...process.env, PLEXER_NO_DAEMON: "1" },
        });
        assert.equal(pipeGrep.status, 0, pipeGrep.stderr);
        assert.match(pipeGrep.stdout, /evalFallback/);

        const strRegex = '(?:\\\\.|[^"\\\\])+';
        const strGrep = spawnSync(process.execPath, [CLI_PATH, "grep", strRegex, repo, "--no-refresh"], {
            encoding: "utf8",
            env: { ...process.env, PLEXER_NO_DAEMON: "1" },
        });
        assert.equal(strGrep.status, 0, strGrep.stderr);
        assert.match(strGrep.stdout, /src\/patterns\.ts/);
    });

    it("routes cross-host hooks, PLEXER_DISABLE_HOOKS=1, quote-safe _batch, plexerd codeStamp drain, & Wave 1E sidecar isolation", async () => {
        const repo = makeTempDir("plexer-test-hooks-");
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(
            join(repo, "src", "service.ts"),
            "export function handleGatewayRequest(id: string): string { return `ok:${id}`; }\n",
            "utf8",
        );
        execFileSync("git", ["init", "-q"], { cwd: repo });
        await buildGraph(repo, { force: true });

        // 1. Cross-host hook envelopes (claude, codex, gemini, cursor, antigravity) with cleaned session files
        const hosts = [
            { event: "prompt", sid: trackAgySid(`cross-claude-${Date.now()}`), payload: (s) => ({ session_id: s, cwd: repo, prompt: "Inspect handleGatewayRequest" }) },
            { event: "prompt", sid: trackAgySid(`cross-codex-${Date.now()}`), payload: (s) => ({ session_id: s, cwd: repo, prompt: "Inspect handleGatewayRequest" }) },
            { event: "gemini-before-agent", sid: trackAgySid(`cross-gemini-${Date.now()}`), payload: (s) => ({ session_id: s, cwd: repo, prompt: "Inspect handleGatewayRequest" }) },
            { event: "cursor-before-submit", sid: trackAgySid(`cross-cursor-${Date.now()}`), payload: (s) => ({ conversation_id: s, workspace_roots: [repo], prompt: "Inspect handleGatewayRequest" }) },
            { event: "agy-pre-invocation", sid: trackAgySid(`cross-agy-${Date.now()}`), payload: (s) => ({ conversationId: s, workspacePaths: [repo], prompt: "Inspect handleGatewayRequest" }) },
        ];
        for (const h of hosts) {
            const res = spawnSync(process.execPath, [CLI_PATH, "_hook", h.event], {
                input: JSON.stringify(h.payload(h.sid)),
                encoding: "utf8",
                env: { ...process.env, PLEXER_NO_DAEMON: "1" },
            });
            assert.equal(res.status, 0, `${h.event} failed: ${res.stderr}`);
            assert.match(res.stdout, /handleGatewayRequest/, `${h.event} should inject handleGatewayRequest context`);
        }

        // 2. PLEXER_DISABLE_HOOKS=1 disables hooks with valid JSON fallback while normal CLI commands keep working
        const disabledHook = spawnSync(process.execPath, [CLI_PATH, "_hook", "agy-pre-tool"], {
            input: JSON.stringify({ conversationId: "noop", toolCall: { name: "read_file", args: {} } }),
            encoding: "utf8",
            env: { ...process.env, PLEXER_DISABLE_HOOKS: "1" },
        });
        assert.equal(disabledHook.status, 0);
        assert.deepEqual(JSON.parse(disabledHook.stdout), { decision: "allow" });

        const cliStillWorks = spawnSync(process.execPath, [CLI_PATH, "ask", "handleGatewayRequest", repo, "--no-refresh"], {
            encoding: "utf8",
            env: { ...process.env, PLEXER_DISABLE_HOOKS: "1", PLEXER_NO_DAEMON: "1" },
        });
        assert.equal(cliStillWorks.status, 0, "PLEXER_DISABLE_HOOKS=1 must not break regular plexer CLI");
        assert.match(cliStillWorks.stdout, /handleGatewayRequest/);

        // 3. Quote-safe `_batch` tokenization & execution via real CLI process
        const batchOut = spawnSync(
            process.execPath,
            [
                CLI_PATH,
                "_batch",
                'grep "function handleGatewayRequest(id: string)" . --fixed --no-refresh',
                "grep 'return `ok:${id}`;' . --fixed --no-refresh",
            ],
            {
                cwd: repo,
                encoding: "utf8",
                env: { ...process.env, PLEXER_NO_DAEMON: "1" },
            },
        );
        assert.equal(batchOut.status, 0, batchOut.stderr);
        assert.match(batchOut.stdout, /function handleGatewayRequest\(id: string\)/);
        assert.match(batchOut.stdout, /return `ok:\$\{id\}`;/);

        // 4. `plexerd` codeStamp mismatch drains and signals `restartRequired: true`
        const sockDir = makeTempDir("plexer-daemon-sock-");
        const sockPath = join(sockDir, "plexerd.sock");
        const daemon = spawn(process.execPath, [CLI_PATH, "_daemon"], {
            cwd: repo,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, PLEXER_DAEMON_SOCK: sockPath },
        });
        try {
            const deadline = Date.now() + 5000;
            while (!existsSync(sockPath) && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 25));
            }
            assert.equal(existsSync(sockPath), true, "plexerd must listen on PLEXER_DAEMON_SOCK");
            const currentStamp = computeCodeStamp(PKG_ROOT);
            const pingOk = await sendDaemonRpc(sockPath, { id: 1, type: "ping", codeStamp: currentStamp });
            assert.equal(pingOk.ok, true);
            const drainRes = await sendDaemonRpc(sockPath, { id: 2, type: "ping", codeStamp: "stale-mismatch-stamp" });
            assert.equal(drainRes.restartRequired, true, "mismatched codeStamp must trigger daemon drain with restartRequired: true");
        } finally {
            daemon.kill("SIGTERM");
            await new Promise((resolveExit) => {
                daemon.once("exit", resolveExit);
                setTimeout(resolveExit, 1500);
            });
        }

        // 5. Wave 1E regression: strictWs sidecar jails `?ws=` & returns 404 on `/api/treemap` when unindexed
        const unindexedRepo = makeTempDir("plexer-test-unindexed-");
        const handlers = createSidecarHandlers({ allowedRoots: [repo], strictWs: true });
        const escapedWs = handlers.apis["/api/rev"]({ ws: unindexedRepo });
        assert.equal(escapedWs.status, 403, "strictWs sidecar must reject unauthorized ?ws= with 403");

        const unindexedHandlers = createSidecarHandlers({ allowedRoots: [unindexedRepo], strictWs: true });
        const missingTreemap = unindexedHandlers.apis["/api/treemap"]({ ws: unindexedRepo });
        assert.equal(missingTreemap.status, 404, "sidecar /api/treemap must return 404 when repo is unindexed");
    });
});
