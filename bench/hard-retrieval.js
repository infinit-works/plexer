#!/usr/bin/env node
/**
 * Hard 104-Query Retrieval & Negative-Control Stress Suite (`bench/hard-retrieval.js`).
 *
 * Tests 5 adversarial retrieval buckets on a self-contained deterministic polyglot corpus:
 *   1. Ambiguous symbol disambiguation (24 queries)
 *   2. Python class signals/attributes & cross-file .connect() callers (20 queries)
 *   3. CommonJS dotted namespaces & multi-hop ESM barrel re-exports (20 queries)
 *   4. Cross-language multi-hop callers & intent (20 queries: TS/JS/Py/Go/Rust/Luau)
 *   5. Negative / out-of-scope queries measuring high-confidence false positives (20 queries)
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ask, buildGraph } from "../src/index.js";
import { relevantRetrieval } from "../src/claude/format.js";
import { queryPromptContext } from "../src/claude/hooks.js";

function buildHardCorpus(dir) {
    const write = (rel, content) => {
        const p = join(dir, rel);
        mkdirSync(join(p, ".."), { recursive: true });
        writeFileSync(p, content, "utf8");
    };

    const queries = [];

    // 1. Ambiguous symbol disambiguation: 8 domains × 3 methods (validate, dispatch, connect) = 24 queries
    const domains = [
        { slug: "invoice_tax", ext: "ts", topic: "invoice GST VAT tax ledger rounding reconciliation" },
        { slug: "tls_cert", ext: "ts", topic: "TLS certificate chain pinning SPKI fingerprint expiry" },
        { slug: "ws_frame", ext: "js", topic: "websocket opcode frame masking payload continuation" },
        { slug: "k8s_affinity", ext: "go", topic: "kubernetes pod topology affinity taint scheduler" },
        { slug: "oauth_pkce", ext: "ts", topic: "OAuth PKCE code verifier SHA256 challenge nonce" },
        { slug: "graphql_depth", ext: "js", topic: "GraphQL AST selection query depth complexity limiter" },
        { slug: "cron_jitter", ext: "py", topic: "cron expression deterministic backoff jitter window" },
        { slug: "stripe_idem", ext: "ts", topic: "payment idempotency ledger dedupe lock key" },
    ];
    for (const d of domains) {
        const file = `src/ambig/${d.slug}.${d.ext}`;
        if (d.ext === "go") {
            write(
                file,
                `package ${d.slug}\n` +
                    `type Engine struct{}\n` +
                    `// Checks ${d.topic}.\nfunc (e *Engine) Validate(input string) bool { return len(input) > 0 }\n` +
                    `// Dispatches ${d.topic} tasks.\nfunc (e *Engine) Dispatch(job string) bool { return e.Validate(job) }\n` +
                    `// Opens ${d.topic} transport.\nfunc (e *Engine) Connect(addr string) bool { return addr != "" }\n`
            );
        } else if (d.ext === "py") {
            write(
                file,
                `class Engine:\n` +
                    `    def validate(self, item):\n        """Validate ${d.topic}."""\n        return bool(item)\n` +
                    `    def dispatch(self, item):\n        """Dispatch ${d.topic}."""\n        return self.validate(item)\n` +
                    `    def connect(self, endpoint):\n        """Connect ${d.topic}."""\n        return bool(endpoint)\n`
            );
        } else {
            write(
                file,
                `/** Handles ${d.topic}. */\n` +
                    `export function validate(v) { return Boolean(v); }\n` +
                    `/** Dispatches ${d.topic}. */\n` +
                    `export function dispatch(x) { return validate(x); }\n` +
                    `/** Connects ${d.topic}. */\n` +
                    `export function connect(u) { return String(u); }\n`
            );
        }
        queries.push({ cat: "ambiguous", query: `how does ${d.topic} validate rules`, goldPath: file });
        queries.push({ cat: "ambiguous", query: `where does ${d.topic} dispatch work`, goldPath: file });
        queries.push({ cat: "ambiguous", query: `where does ${d.topic} connect endpoint`, goldPath: file });
    }

    // 2. Python signals & cross-file .connect() callers: 10 signal defs + 10 consumers = 20 queries
    const pySpecs = [
        ["download_queue", "bandwidth telemetry transfer stalled", "bytes_stalled"],
        ["tab_renderer", "chromium GPU process crash recovery", "gpu_crashed"],
        ["cookie_jar", "third party storage partition eviction", "cookies_evicted"],
        ["key_router", "chord sequence shortcut timeout reset", "chord_timed_out"],
        ["spell_dict", "hunspell language dictionary reload", "dict_reloaded"],
        ["history_wal", "sqlite WAL vacuum checkpoint trigger", "wal_checkpoint"],
        ["proxy_pac", "PAC proxy autodetect resolver failure", "pac_failed"],
        ["media_drm", "widevine CDM session license error", "cdm_errored"],
        ["pdf_spool", "print spooler rasterizer page overflow", "spool_overflow"],
        ["ipc_socket", "local domain socket peer hangup event", "peer_hangup"],
    ];
    for (const [slug, desc, sigName] of pySpecs) {
        const defFile = `py_signals/${slug}_emitter.py`;
        const useFile = `py_signals/${slug}_listener.py`;
        const cls = slug.replace(/(?:^|_)([a-z])/g, (_, c) => c.toUpperCase()) + "Process";
        write(
            defFile,
            `class Signal:\n    def connect(self, cb): pass\n` +
                `class ${cls}:\n` +
                `    """Handles ${desc}."""\n` +
                `    ${sigName} = Signal()\n` +
                `    def emit_event(self, payload):\n        self.${sigName}.connect(payload)\n`
        );
        write(
            useFile,
            `from .${slug}_emitter import ${cls}\n` +
                `class Controller_${slug}:\n` +
                `    def __init__(self):\n` +
                `        self._proc = ${cls}()\n` +
                `    def bind_${slug}_handlers(self):\n` +
                `        """Consumer subscribing to ${desc} events."""\n` +
                `        self._proc.${sigName}.connect(self._on_${sigName})\n` +
                `    def _on_${sigName}(self, detail):\n` +
                `        return detail\n`
        );
        queries.push({ cat: "python_signals", query: `where is ${desc} signal declared`, goldPath: defFile });
        queries.push({ cat: "python_signals", query: `which consumer listener subscribes to ${desc}`, goldPath: useFile });
    }

    // 3. ESM barrels & CommonJS dotted namespaces: 10 ESM barrels + 10 CommonJS dotted = 20 queries
    const barrelSpecs = [
        ["ledger_export", "double entry accrual ledger CSV export"],
        ["cache_warmup", "cold tier cache hydration prefetch batch"],
        ["schema_migrate", "idempotent postgres advisory lock migration"],
        ["audit_digest", "tamper evident SHA512 merkle audit chain"],
        ["rate_shield", "distributed token bucket burst quota shield"],
        ["tenant_shard", "consistent hash ring shard rebalance plan"],
        ["secret_rotate", "envelope KMS key rotation version bump"],
        ["webhook_hmac", "replay resistant webhook HMAC timestamp guard"],
        ["search_stem", "porter stemmer inverted bitmap posting merge"],
        ["flag_rollout", "deterministic murmur percentage flag rollout"],
    ];
    for (const [slug, desc] of barrelSpecs) {
        const impl = `barrels/${slug}/core.ts`;
        const idx = `barrels/${slug}/index.ts`;
        write(impl, `/** Implements ${desc}. */\nexport function execute_${slug}(input: string) { return input.trim(); }\n`);
        write(idx, `export { execute_${slug} } from "./core";\n`);
        queries.push({ cat: "barrels_cjs", query: `implementation of ${desc}`, goldPath: impl });
    }

    const cjsSpecs = [
        ["BillingCycle", "billing cycle prorated invoice settlement"],
        ["SessionVault", "encrypted session vault sliding renewal"],
        ["MailRelay", "SMTP bounce retry queue circuit trip"],
        ["SearchIndexer", "incremental document vector shard flush"],
        ["AssetBundler", "content addressed static bundle manifest"],
        ["QuotaMeter", "tenant metering rollup counter commit"],
        ["WebhookSink", "outbound webhook circuit breaker trip"],
        ["ConfigStore", "hot reload configuration schema snapshot"],
        ["AuditTrail", "immutable compliance event ring buffer"],
        ["TokenIssuer", "short lived asymmetric bearer token mint"],
    ];
    for (const [ns, desc] of cjsSpecs) {
        const file = `cjs/${ns}.js`;
        write(
            file,
            `const ${ns} = module.exports;\n` +
                `${ns}.channel = {};\n` +
                `/** Handles ${desc}. */\n` +
                `${ns}.channel.send = async function (payload) { return payload; };\n`
        );
        queries.push({ cat: "barrels_cjs", query: `where is ${desc} implemented`, goldPath: file });
    }

    // 4. Multi-hop & polyglot (TS, JS, Python, Go, Rust, Luau): 20 queries
    const polySpecs = [
        ["poly/ts/auth_flow.ts", "export function verifySessionJwt(t: string) { return t.length > 0; } // JWT refresh rotation"],
        ["poly/ts/session_repo.ts", 'import { verifySessionJwt } from "./auth_flow";\nexport function attachAuth(t: string) { return verifySessionJwt(t); } // middleware guard'],
        ["poly/go/wal_writer.go", "package wal\n// AppendFrame encodes CRC32 write ahead log frame headers.\nfunc AppendFrame(b []byte) int { return len(b) }\n"],
        ["poly/go/compactor.go", "package wal\n// ReclaimTombstones compacts stale LSM SSTable delete markers.\nfunc ReclaimTombstones() int { return 0 }\n"],
        ["poly/rust/varint.rs", "/// Encodes unsigned LEB128 variable length integer into wire buffer.\npub fn encode_varint(n: u64) -> u8 { (n & 0x7f) as u8 }\n"],
        ["poly/rust/typecheck.rs", "/// Detects cyclic struct type references during schema resolution.\npub fn check_type_cycle(id: usize) -> bool { id > 0 }\n"],
        ["poly/luau/graph.luau", "-- Flush reactive signal graph and prune runaway ping pong effect loops.\nlocal function flushEffects() return true end\nreturn { flushEffects = flushEffects }\n"],
        ["poly/luau/history.luau", "-- Record undo and redo canvas snapshot transactions with pointer lock.\nlocal function pushUndoSnapshot() return true end\nreturn { pushUndoSnapshot = pushUndoSnapshot }\n"],
        ["poly/py/heap_sched.py", "def schedule_cron_heap(jobs):\n    \"\"\"Orders delayed cron tasks in a binary min heap by next run timestamp.\"\"\"\n    return sorted(jobs)\n"],
        ["poly/py/atomic_ckpt.py", "def write_checkpoint_atomic(path):\n    \"\"\"Flushes crash recovery state via tempfile fsync and atomic rename.\"\"\"\n    return path\n"],
        ["poly/ts/chunk_sync.ts", "export function replicatePartDeltas(p: number[]) { return p.length; } // incremental chunk replication"],
        ["poly/go/raft_vote.go", "package raft\n// RequestVote runs randomized election timer quorum ballots.\nfunc RequestVote(term int) bool { return term > 0 }\n"],
        ["poly/rust/emit_luau.rs", "/// Generates zero allocation Luau buffer pack serializer instructions.\npub fn emit_serializer() -> usize { 1 }\n"],
        ["poly/js/pool_retry.js", "// Persistent IPC pipe connection pool with exponential backoff jitter.\nexport function acquirePooledPipe() { return 1; }\n"],
        ["poly/py/latency_p99.py", "def compute_p99_bucket(samples):\n    \"\"\"Computes sliding histogram percentile latency p99 bucket counts.\"\"\"\n    return len(samples)\n"],
        ["poly/ts/bloom_probe.ts", "export function mayContainKey(h: number) { return (h & 7) === 0; } // probabilistic bloom filter lookup"],
        ["poly/go/tls_dial.go", "package netx\n// DialMutualTls enforces client X509 mutual authentication certificates.\nfunc DialMutualTls() bool { return true }\n"],
        ["poly/rust/lexer_span.rs", "/// Scans UTF8 source characters into lexical tokens and column byte spans.\npub fn scan_tokens(s: &str) -> usize { s.len() }\n"],
        ["poly/luau/spring.luau", "-- Computes critically damped spring harmonic velocity interpolation.\nlocal function stepSpringVelocity(v) return v end\nreturn { stepSpringVelocity = stepSpringVelocity }\n"],
        ["poly/js/csrf_double.js", "// Verifies stateless double submit CSRF cookie header signature mismatch.\nexport function verifyCsrfToken(a, b) { return a === b; }\n"],
    ];
    const polyQueries = [
        "JWT refresh rotation session verification",
        "middleware guard calling verifySessionJwt",
        "CRC32 write ahead log frame encoding",
        "reclaim stale LSM SSTable delete marker tombstones",
        "unsigned LEB128 variable length integer wire encoding",
        "detect cyclic struct type references in schema resolution",
        "flush reactive signal graph runaway effect loop detection",
        "record undo and redo canvas snapshot transactions",
        "order delayed cron tasks in binary min heap by timestamp",
        "flush crash recovery state with fsync atomic rename",
        "incremental chunk replication for part deltas",
        "randomized raft leader election timer quorum ballot",
        "generate Luau buffer pack serializer instructions",
        "persistent IPC pipe connection pool exponential backoff jitter",
        "sliding histogram percentile latency p99 bucket aggregation",
        "probabilistic bloom filter disk key lookup",
        "X509 mutual TLS client certificate dial",
        "scan UTF8 characters into lexical tokens and column spans",
        "critically damped spring harmonic velocity interpolation",
        "stateless double submit CSRF cookie signature verification",
    ];
    for (let i = 0; i < polySpecs.length; i++) {
        write(polySpecs[i][0], polySpecs[i][1]);
        queries.push({ cat: "polyglot_multihop", query: polyQueries[i], goldPath: polySpecs[i][0] });
    }

    // 4b. Modern languages, JSX, SFC templates, C++ out-of-line & Rust pub-use (12 queries)
    const extSpecs = [
        ["ext/ui/BillingCard.tsx", "export function InvoiceBadge({ total }: { total: number }) { return <span>{total}</span>; }\nexport function BillingCard({ total }: { total: number }) { return <InvoiceBadge total={total} />; }\n", "which TSX BillingCard renders InvoiceBadge total", "ext/ui/BillingCard.tsx"],
        ["ext/vue/QuotaBanner.vue", "<template><QuotaMeter :limit=\"maxQuota\" /></template>\n<script setup lang=\"ts\">\nconst maxQuota = 500;\n</script>\n", "where does QuotaBanner render QuotaMeter maxQuota in template", "ext/vue/QuotaBanner.vue"],
        ["ext/svelte/TokenInput.svelte", "<script lang=\"ts\">\nexport function submitApiToken(tok: string) { return tok.trim(); }\n</script>\n<form on:submit|preventDefault={() => submitApiToken('x')}></form>\n", "which svelte component calls submitApiToken on form submit", "ext/svelte/TokenInput.svelte"],
        ["ext/cpp/ring_buffer.cpp", "class RingBuffer { public: int pushFrame(int v); };\nint RingBuffer::pushFrame(int v) { return v + 1; }\n", "C++ RingBuffer pushFrame out of line method definition", "ext/cpp/ring_buffer.cpp"],
        ["ext/kotlin/LedgerClient.kt", "interface LedgerTransport { fun sendBatch(n: Int): Int }\nclass HttpLedgerClient : LedgerTransport { override fun sendBatch(n: Int): Int = n }\n", "Kotlin HttpLedgerClient implementing LedgerTransport sendBatch", "ext/kotlin/LedgerClient.kt"],
        ["ext/rust/reexport_bus.rs", "pub mod inner { pub fn publish_metric(name: &str) -> usize { name.len() } }\npub use inner::publish_metric;\n", "Rust pub use reexport publish_metric inner module", "ext/rust/reexport_bus.rs"],
        ["ext/bash/deploy_canary.sh", "#!/usr/bin/env bash\nrollout_canary_Traffic() {\n  echo \"$1\"\n}\n", "bash function rollout_canary_Traffic script", "ext/bash/deploy_canary.sh"],
        ["ext/sql/ledger_views.sql", "CREATE TABLE invoice_entries (id BIGINT PRIMARY KEY, cents BIGINT NOT NULL);\nCREATE VIEW daily_invoice_totals AS SELECT id, cents FROM invoice_entries;\n", "SQL view daily_invoice_totals selecting from invoice_entries", "ext/sql/ledger_views.sql"],
        ["ext/hcl/eks_cluster.tf", "resource \"aws_eks_cluster\" \"primary_control_plane\" {\n  name = \"prod-control-plane\"\n}\n", "terraform resource aws_eks_cluster primary_control_plane", "ext/hcl/eks_cluster.tf"],
        ["ext/proto/settlement.proto", "syntax = \"proto3\";\nmessage SettlementEnvelope { string ledger_id = 1; }\nservice SettlementService { rpc Commit(SettlementEnvelope) returns (SettlementEnvelope); }\n", "protobuf SettlementService rpc Commit SettlementEnvelope", "ext/proto/settlement.proto"],
        ["ext/gql/billing_schema.graphql", "type InvoiceSummary { id: ID! totalCents: Int! }\ntype Query { invoiceSummary(id: ID!): InvoiceSummary }\n", "graphql Query invoiceSummary InvoiceSummary schema", "ext/gql/billing_schema.graphql"],
        ["ext/astro/PricingHero.astro", "---\nimport PlanCard from './PlanCard.astro';\n---\n<PlanCard tier=\"enterprise\" />\n", "Astro PricingHero component rendering PlanCard enterprise", "ext/astro/PricingHero.astro"],
    ];
    for (const [file, code, q, gold] of extSpecs) {
        write(file, code);
        queries.push({ cat: "modern_langs_templates", query: q, goldPath: gold });
    }

    // 5. Negative / OOB queries (20 queries): must NOT trigger high-confidence injection
    const oobTopics = [
        "CUDA warp shuffle matrix multiply kernel occupancy",
        "Vulkan raytracing acceleration structure BLAS build",
        "BGPsec autonomous system path cryptographic attestation",
        "MPEG-DASH adaptive bitrate HLS fragment muxer",
        "Bluetooth Low Energy GATT characteristic descriptor CCCD",
        "WebRTC ICE trickle TURN candidate gathering",
        "LLVM SSA phi node dominance frontier elimination",
        "FPGA Verilog AXI4-Stream FIFO CDC synchronizer",
        "DirectX12 descriptor heap root signature binding",
        "PostgreSQL MVCC vacuum freeze transaction wraparound",
        "Kafka KRaft metadata quorum snapshot compaction",
        "OpenGL tessellation evaluation shader barycentric coord",
        "SPICE transient nodal admittance matrix solver",
        "CAN-FD automotive frame arbitration stuffing bit",
        "eBPF XDP socket zero-copy UMEM ring descriptor",
        "QEMU TCG binary translation block chaining",
        "SIMD AVX-512 masked gather scatter permutation",
        "SCTP multi-homing heartbeat chunk SACK recovery",
        "NVMe IO completion queue MSI-X interrupt coalescing",
        "RISC-V Sv48 four-level page table TLB shootdown",
    ];
    for (const q of oobTopics) {
        queries.push({ cat: "negative_oob", query: `how does ${q} work`, goldPath: null });
    }

    return queries;
}

/**
 * Execute the 104-query hard retrieval benchmark in an isolated temporary corpus.
 */
export async function runHardRetrievalSuite({ gate = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "plexer-hard-retrieval-"));
    try {
        const queries = buildHardCorpus(dir);
        await buildGraph(dir, { force: true, graphOnly: true });

        const positive = queries.filter((q) => q.cat !== "negative_oob");
        const negative = queries.filter((q) => q.cat === "negative_oob");
        const byCat = {};
        let hits1 = 0;
        let hits3 = 0;
        let rrSum = 0;
        const misses = [];

        for (const q of positive) {
            byCat[q.cat] = byCat[q.cat] || { total: 0, hits1: 0, hits3: 0, rrSum: 0 };
            byCat[q.cat].total += 1;
            const res = ask(dir, q.query, { limit: 5 });
            let rank = 0;
            for (let i = 0; i < (res.hits || []).length; i++) {
                const ptr = String(res.hits[i].pointer || "").toLowerCase();
                if (ptr.includes(q.goldPath.toLowerCase())) {
                    rank = i + 1;
                    break;
                }
            }
            if (rank === 1) {
                hits1 += 1;
                byCat[q.cat].hits1 += 1;
            } else {
                misses.push({ cat: q.cat, query: q.query, goldPath: q.goldPath, rank, top: res.hits?.[0]?.pointer || "none" });
            }
            if (rank > 0 && rank <= 3) {
                hits3 += 1;
                byCat[q.cat].hits3 += 1;
            }
            if (rank > 0) {
                rrSum += 1 / rank;
                byCat[q.cat].rrSum += 1 / rank;
            }
        }

        let negFalsePositives = 0;
        for (const nq of negative) {
            const ctxC = queryPromptContext(dir, nq.query, { geminiProfile: false });
            const rendC = ctxC ? relevantRetrieval(ctxC, {}, 4, { geminiProfile: false }) : null;
            const ctxG = queryPromptContext(dir, nq.query, { geminiProfile: true });
            const rendG = ctxG ? relevantRetrieval(ctxG, {}, 4, { geminiProfile: true }) : null;
            if (rendC || rendG) {
                negFalsePositives += 1;
            }
        }

        const totalPos = positive.length;
        const recallAt1 = +(hits1 / totalPos).toFixed(3);
        const recallAt3 = +(hits3 / totalPos).toFixed(3);
        const mrr = +(rrSum / totalPos).toFixed(3);
        const negFalsePositiveRate = +(negFalsePositives / negative.length).toFixed(3);

        const categories = {};
        for (const [k, v] of Object.entries(byCat)) {
            categories[k] = {
                total: v.total,
                recallAt1: +(v.hits1 / v.total).toFixed(3),
                recallAt3: +(v.hits3 / v.total).toFixed(3),
                mrr: +(v.rrSum / v.total).toFixed(3),
            };
        }

        const passed = recallAt1 >= 0.90 && recallAt3 >= 0.97 && mrr >= 0.93 && negFalsePositiveRate <= 0.05;
        return {
            totalQueries: queries.length,
            positiveQueries: totalPos,
            negativeQueries: negative.length,
            recallAt1,
            recallAt3,
            mrr,
            negFalsePositives,
            negFalsePositiveRate,
            categories,
            misses: misses.slice(0, 12),
            gate: { enforced: gate, passed },
        };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const gate = process.argv.includes("--gate");
    const json = process.argv.includes("--json");
    const res = await runHardRetrievalSuite({ gate });
    if (json) {
        console.log(JSON.stringify(res, null, 2));
    } else {
        console.log(
            `Hard Retrieval (${res.totalQueries} queries: ${res.positiveQueries} pos, ${res.negativeQueries} neg): ` +
                `Recall@1=${(res.recallAt1 * 100).toFixed(1)}% Recall@3=${(res.recallAt3 * 100).toFixed(1)}% MRR=${res.mrr.toFixed(3)} NegFP=${(res.negFalsePositiveRate * 100).toFixed(1)}% (${res.gate.passed ? "PASS" : "FAIL"})`
        );
    }
    if (gate && !res.gate.passed) process.exit(1);
}
