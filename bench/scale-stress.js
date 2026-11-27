#!/usr/bin/env node
/**
 * Synthetic 25k–100k-node Multi-Language Monorepo Scale & Latency Stress Suite (`bench/scale-stress.js`).
 *
 * Usage:
 *   node bench/scale-stress.js [--nodes 25000] [--gate] [--json]
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { ask, buildGraph, blastRadius, checkGraph, edgeWalk, formatAsk, resolveSymbol } from "../src/index.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { loadGraphCached } from "../src/context/graph-store.js";
import { contextDirFor } from "../src/context/node-file.js";
import { queryPromptContext } from "../src/claude/hooks.js";
import { relevantRetrieval } from "../src/claude/format.js";
import { startDaemon } from "../src/daemon/plexerd.js";
import { sendDaemonRpc } from "../src/daemon/socket-path.js";

function percentile(xs, q) {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
    return Number(s[idx].toFixed(2));
}

/**
 * Generate a deterministic polyglot monorepo targeting `targetNodes` graph nodes.
 */
export function generateSyntheticMonorepo(dir, { targetNodes = 25000, seed = 42 } = {}) {
    // 24 extracted nodes per 5-file polyglot package => exact node scaling around targetNodes
    const NODES_PER_PKG = 24;
    const pkgCount = Math.max(6, Math.ceil(targetNodes / NODES_PER_PKG));
    const touchedSamples = [];

    for (let i = 0; i < pkgCount; i++) {
        const tag = String(i).padStart(4, "0");
        const nextTag = String((i + 1) % pkgCount).padStart(4, "0");
        const pkgDir = join(dir, "packages", `svc_${tag}`);
        mkdirSync(pkgDir, { recursive: true });

        const tsBarrel = join(pkgDir, "index.ts");
        writeFileSync(
            tsBarrel,
            `export { handleRequest_${tag}, validateToken_${tag}, buildAudit_${tag} } from "./service";\n`,
            "utf8"
        );

        const tsService = join(pkgDir, "service.ts");
        writeFileSync(
            tsService,
            [
                `import { dispatchDownstream_${nextTag} } from "../svc_${nextTag}/legacy.js";`,
                `export class TokenService_${tag} {`,
                `    readonly realm = "realm_${tag}";`,
                `    verify(secret: string): boolean {`,
                `        return secret.length > 4 && checkQuota_${tag}(secret);`,
                `    }`,
                `}`,
                `export function checkQuota_${tag}(key: string): boolean {`,
                `    return key.startsWith("tok_") && buildAudit_${tag}(key) > 0;`,
                `}`,
                `export function validateToken_${tag}(tok: string): boolean {`,
                `    const svc = new TokenService_${tag}();`,
                `    return svc.verify(tok);`,
                `}`,
                `export function buildAudit_${tag}(k: string): number {`,
                `    return k.length + ${(i + seed) % 97};`,
                `}`,
                `export function handleRequest_${tag}(tok: string): boolean {`,
                `    if (!validateToken_${tag}(tok)) return false;`,
                `    return Boolean(dispatchDownstream_${nextTag}(tok));`,
                `}`,
                ``,
            ].join("\n"),
            "utf8"
        );

        const jsLegacy = join(pkgDir, "legacy.js");
        writeFileSync(
            jsLegacy,
            [
                `const ns_${tag} = { reset: {} };`,
                `ns_${tag}.reset.send = function sendReset_${tag}(addr) {`,
                `    return String(addr || "").trim();`,
                `};`,
                `function dispatchDownstream_${tag}(payload) {`,
                `    return ns_${tag}.reset.send(payload);`,
                `}`,
                `module.exports = { ns_${tag}, dispatchDownstream_${tag} };`,
                ``,
            ].join("\n"),
            "utf8"
        );

        const pyWorker = join(pkgDir, "worker.py");
        writeFileSync(
            pyWorker,
            [
                `class SignalEmitter:`,
                `    def connect(self, fn):`,
                `        return fn`,
                `class JobProcess_${tag}:`,
                `    error_signal = SignalEmitter()`,
                `    def __init__(self):`,
                `        self._proc = SignalEmitter()`,
                `    def start_job(self):`,
                `        self.error_signal.connect(self._on_fail)`,
                `    def _on_fail(self, code):`,
                `        return code + 1`,
                `def run_worker_${tag}(proc: JobProcess_${tag}):`,
                `    proc.error_signal.connect(proc._on_fail)`,
                `    return True`,
                ``,
            ].join("\n"),
            "utf8"
        );

        const goHandler = join(pkgDir, "handler.go");
        writeFileSync(
            goHandler,
            [
                `package svc_${tag}`,
                `type Store_${tag} struct {`,
                `    Name string`,
                `}`,
                `func (s *Store_${tag}) Validate() bool {`,
                `    return len(s.Name) > 0`,
                `}`,
                `func EvaluateFlag_${tag}(s *Store_${tag}) bool {`,
                `    return s.Validate()`,
                `}`,
                ``,
            ].join("\n"),
            "utf8"
        );

        if (i < 12) touchedSamples.push(tsService);
    }

    return { pkgCount, touchedSamples };
}

/**
 * Run the full synthetic scale benchmark across build, dirty cone, ask, callers, blast,
 * Turn-0 hook, daemon RPC, and RSS memory.
 */
export async function runScaleStress({ targetNodes = 25000, gate = false, json = false } = {}) {
    const repoDir = mkdtempSync(join(tmpdir(), "plexer-scale-repo-"));
    const daemonSock = `/tmp/plexer-scale-${process.pid}.sock`;
    let daemon = null;

    try {
        const gen = generateSyntheticMonorepo(repoDir, { targetNodes });
        execFileSync("git", ["init", "-q"], { cwd: repoDir });
        execFileSync("git", ["config", "user.email", "scale@plexer.invalid"], { cwd: repoDir });
        execFileSync("git", ["config", "user.name", "Scale Bench"], { cwd: repoDir });
        execFileSync("git", ["add", "-A"], { cwd: repoDir });
        execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", "init", "--no-verify"], { cwd: repoDir });

        const outDir = contextDirFor(repoDir);
        const tBuild0 = performance.now();
        await buildGraph(repoDir, { contextDir: outDir, graphOnly: true, force: true });
        const coldBuildMs = Number((performance.now() - tBuild0).toFixed(1));

        const tCheck0 = performance.now();
        await checkGraph(repoDir, { contextDir: outDir });
        const checkMs = Number((performance.now() - tCheck0).toFixed(1));

        // 1-file dirty-cone refresh
        appendFileSync(gen.touchedSamples[0], "\n// scale dirty 1-file probe\n", "utf8");
        const tDirty1 = performance.now();
        await ensureFreshGraph(repoDir, { contextDir: outDir });
        const dirtyCone1FileMs = Number((performance.now() - tDirty1).toFixed(1));

        // 10-file dirty-cone refresh
        for (let k = 1; k <= 10 && k < gen.touchedSamples.length; k++) {
            appendFileSync(gen.touchedSamples[k], `\n// scale dirty probe ${k}\n`, "utf8");
        }
        const tDirty10 = performance.now();
        await ensureFreshGraph(repoDir, { contextDir: outDir });
        const dirtyCone10FilesMs = Number((performance.now() - tDirty10).toFixed(1));

        const graph = loadGraphCached(outDir);
        const nodes = graph?.nodes?.length || 0;
        const edges = graph?.edges?.length || 0;

        const queries = [
            "token validation quota service 0001",
            "downstream legacy reset send 0002",
            "worker python error signal connect 0003",
            "go store validate evaluate flag 0004",
            "handle request downstream 0005",
            "build audit secret length verify",
            "signal emitter connect fail",
            "evaluate flag store validate",
            "token service realm secret",
        ];

        // Warm once
        ask(repoDir, queries[0], { contextDir: outDir, source: true });
        const askTimes = [];
        for (const q of queries) {
            const t0 = performance.now();
            formatAsk(ask(repoDir, q, { contextDir: outDir, source: true }));
            askTimes.push(performance.now() - t0);
        }

        const callerSyms = [
            "validateToken_0001",
            "validateToken_0002",
            "buildAudit_0003",
            "checkQuota_0004",
            "dispatchDownstream_0002",
            "JobProcess_0003.error_signal",
            "EvaluateFlag_0004",
            "handleRequest_0001",
            "TokenService_0001",
        ];
        const callerTimes = [];
        for (const s of callerSyms) {
            const t0 = performance.now();
            const hits = resolveSymbol(graph, s);
            if (hits[0]) edgeWalk(graph, hits[0], "in", 2);
            callerTimes.push(performance.now() - t0);
        }

        const tBlast0 = performance.now();
        blastRadius(repoDir, { contextDir: outDir });
        const blastMs = Number((performance.now() - tBlast0).toFixed(1));

        // Warm Turn-0 once before timing
        const warmT0 = queryPromptContext(repoDir, "Fix authentication token quota check in svc_0001");
        if (warmT0) relevantRetrieval(warmT0, {});
        const t0Times = [];
        for (let i = 0; i < 3; i++) {
            const t0 = performance.now();
            const ctxObj = queryPromptContext(repoDir, `Fix authentication token quota check in svc_000${i + 1}`);
            if (ctxObj) relevantRetrieval(ctxObj, {});
            t0Times.push(performance.now() - t0);
        }

        // Isolated daemon RPC benchmark
        daemon = await startDaemon({ socketPath: daemonSock, idleTimeoutMs: 60_000 });
        await sendDaemonRpc(
            daemonSock,
            { id: 1, type: "cli", version: daemon.version, argv: ["ask", queries[0], "--source", "--no-refresh"], cwd: repoDir },
            { connectTimeoutMs: 500, rpcTimeoutMs: 5000 }
        );
        const rpcTimes = [];
        for (let i = 0; i < 5; i++) {
            const t0 = performance.now();
            await sendDaemonRpc(
                daemonSock,
                { id: i + 2, type: "cli", version: daemon.version, argv: ["ask", queries[i], "--source", "--no-refresh"], cwd: repoDir },
                { connectTimeoutMs: 500, rpcTimeoutMs: 5000 }
            );
            rpcTimes.push(performance.now() - t0);
        }

        const peakRssMb = Math.round(process.memoryUsage().rss / (1024 * 1024));
        const metrics = {
            targetNodes,
            nodes,
            edges,
            coldBuildMs,
            checkMs,
            dirtyCone1FileMs,
            dirtyCone10FilesMs,
            askSourceP50Ms: percentile(askTimes, 0.5),
            askSourceP95Ms: percentile(askTimes, 0.95),
            callersD2P50Ms: percentile(callerTimes, 0.5),
            blastMs,
            turn0HookMs: percentile(t0Times, 0.5),
            daemonRpcMs: percentile(rpcTimes, 0.5),
            peakRssMb,
        };

        const scale = Math.max(1, targetNodes / 25000);
        const thresholds = {
            coldBuildMs: Math.round(2200 * scale),
            dirtyCone1FileMs: Math.round(120 * scale),
            askSourceP50Ms: Math.round(35 * scale),
            callersD2P50Ms: Math.round(25 * scale),
            turn0HookMs: Math.round(90 * scale),
            daemonRpcMs: Math.round(45 * scale),
            peakRssMb: Math.round(420 * scale),
        };
        const gateFailures = [];
        for (const [k, limit] of Object.entries(thresholds)) {
            if (metrics[k] > limit) {
                gateFailures.push(`${k}=${metrics[k]} > ${limit}`);
            }
        }
        const passed = gateFailures.length === 0;
        const result = { ...metrics, thresholds, gate: { enforced: gate, passed, failures: gateFailures } };

        if (!json) {
            console.log(`# Scale Stress Benchmark (${nodes.toLocaleString()} nodes, ${edges.toLocaleString()} edges)`);
            console.log(
                `coldBuild=${coldBuildMs}ms | check=${checkMs}ms | dirty1=${dirtyCone1FileMs}ms | dirty10=${dirtyCone10FilesMs}ms | ` +
                    `ask p50=${metrics.askSourceP50Ms}ms p95=${metrics.askSourceP95Ms}ms | callers p50=${metrics.callersD2P50Ms}ms | ` +
                    `blast=${blastMs}ms | turn0=${metrics.turn0HookMs}ms | daemonRpc=${metrics.daemonRpcMs}ms | RSS=${peakRssMb}MB`
            );
            if (gate) {
                console.log(`Gate: ${passed ? "PASS" : `FAIL (${gateFailures.join("; ")})`}`);
            }
        }
        return result;
    } finally {
        try {
            if (daemon && typeof daemon.close === "function") {
                await daemon.close();
            }
        } catch {
            // ignore shutdown race
        }
        rmSync(daemonSock, { force: true });
        rmSync(`${daemonSock}.lock`, { force: true });
        rmSync(repoDir, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const args = process.argv.slice(2);
    const nIdx = args.indexOf("--nodes");
    const targetNodes = nIdx >= 0 && Number(args[nIdx + 1]) > 0 ? Number(args[nIdx + 1]) : 25000;
    const gate = args.includes("--gate");
    const json = args.includes("--json");
    const res = await runScaleStress({ targetNodes, gate, json });
    if (json) console.log(JSON.stringify(res, null, 2));
    if (gate && !res.gate.passed) process.exit(1);
}
