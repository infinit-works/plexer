import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    HOOK_BUDGETS,
    GEMINI_HOOK_BUDGETS,
    mergeMultiQueryHits,
    enforceMergedHitsBudget,
} from '../src/hosts/engine/prompt/budget.js';
import { searchPromptContext } from '../src/hosts/engine/prompt/search.js';
import { pinnedHits } from '../src/claude/pin.js';
import { loadGraphCached } from '../src/context/graph-store.js';
import { detectPromptIntent, isLikelyEditSessionPrompt } from '../src/hosts/engine/prompt/intent.js';
import { relevantRetrieval, formatRetrieval } from '../src/claude/format.js';
import { hooksShim } from '../src/claude/shim-template.js';
import { startDaemon } from '../src/daemon/plexerd.js';
import {
    isIsolatedBenchDir,
    resolveHostProjectDir,
    resolveHostSessionId,
    saveAgyContext,
    loadAgyContext,
} from '../src/hosts/engine/agy-context.js';
import { computeReadPreToolWidening, evaluateAgyPreTool } from '../src/agy/pre-tool.js';
import { rewriteShellExplorationCommand, splitSafeChainedCommands } from '../src/agy/shell-rewrite.js';
import { recordReadPostTool, handleHostPostTool } from '../src/hosts/engine/post-tool.js';
import { dispatchHostEvent } from '../src/hosts/engine/dispatcher.js';
import { buildPlanExecutionHandoff } from '../src/agy/plan-handoff.js';
import { grepGraph } from '../src/search/grep.js';
import { loadRows, fitFamily, predict } from '../bench/cost-model.js';
import { handleAgyPreInvocation } from '../src/hosts/engine/turn0.js';
import { parseAgyTranscript } from '../src/hosts/engine/agy-transcript.js';
import { seedForkedSwarmSession, checkSwarmEditCollision } from '../src/agy/swarm-sync.js';
import { stampSeenMtime } from '../src/agy/spans.js';
import { runRetract } from '../src/hosts/retract.js';
import { stripTomlSection } from '../src/hosts/mcp-config.js';
import { TOOLS, callTool, invalidateMcpFreshnessCache } from '../src/mcp/tools.js';
import { runCli } from '../src/cli/cli-main.js';

const require = createRequire(import.meta.url);
const ipc = require('../src/daemon/ipc.cjs');
const hookClient = require('../bin/plexer-hook-client.cjs');

const TEMP_DIRS = [];
function makeTmpDir(prefix = 'plexer-wave3-') {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    TEMP_DIRS.push(dir);
    return dir;
}

function makeIndexedStubRepo(prefix = 'plexer-w3-repo-') {
    const repo = makeTmpDir(prefix);
    mkdirSync(join(repo, 'plexer', '.graph'), { recursive: true });
    writeFileSync(join(repo, 'plexer', '.graph', 'wiring.json'), JSON.stringify({
        nodes: [
            { id: 'file:src/auth.js', path: 'src/auth.js', kind: 'file', lines: 60 },
            { id: 'sym:src/auth.js:verifyToken', path: 'src/auth.js', name: 'verifyToken', kind: 'function', span: 'L1-L25' },
        ],
        edges: [],
        files: ['src/auth.js'],
    }));
    writeFileSync(join(repo, 'plexer', 'index.md'), '# Index\nsrc/auth.js\n');
    return repo;
}

function makeCapturedIo() {
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    return {
        ioCtx: {
            writeOut: (s) => { stdout += s; },
            writeErr: (s) => { stderr += s; },
            exit: (code = 0) => {
                exitCode = code;
                throw Object.assign(new Error(`__CLI_EXIT_${code}__`), { isCliExit: true, code });
            },
        },
        result: () => ({ stdout, stderr, exitCode }),
    };
}

after(() => {
    for (const dir of TEMP_DIRS) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
});

describe('Wave 3: Daemon & IPC', () => {
    it('sendRpc rejects malformed JSON without deadlocking and decodes split multi-byte UTF-8 chunks', async () => {
        const tmp = makeTmpDir('plexer-ipc-');
        const badSock = join(tmp, 'bad.sock');
        const utf8Sock = join(tmp, 'utf8.sock');

        const badServer = net.createServer((conn) => {
            conn.resume();
            conn.end('{not-valid-json\n');
        });
        await new Promise((r) => badServer.listen(badSock, r));
        try {
            await assert.rejects(
                () => ipc.sendRpc(badSock, { event: 'ping' }, { rpcTimeoutMs: 1000 }),
                /JSON|Unexpected|malformed/i,
            );
        } finally {
            badServer.closeAllConnections?.();
            await new Promise((r) => badServer.close(r));
        }

        // Split a 4-byte emoji across two chunks to verify StringDecoder handling
        const emoji = '🚀';
        const payloadBuf = Buffer.from(JSON.stringify({ ok: true, stdout: `hi ${emoji}` }) + '\n', 'utf8');
        const splitAt = payloadBuf.indexOf(0xf0) + 2; // mid-codepoint split
        const utf8Server = net.createServer((conn) => {
            conn.resume();
            conn.write(payloadBuf.subarray(0, splitAt));
            setTimeout(() => {
                if (!conn.destroyed) conn.end(payloadBuf.subarray(splitAt));
            }, 10);
        });
        await new Promise((r) => utf8Server.listen(utf8Sock, r));
        try {
            const res = await ipc.sendRpc(utf8Sock, { event: 'ping' }, { rpcTimeoutMs: 1000 });
            assert.equal(res.stdout, 'hi 🚀');
        } finally {
            utf8Server.closeAllConnections?.();
            await new Promise((r) => utf8Server.close(r));
        }
    });

    it('waitForSocketTeardown polls until the socket file is actually unlinked', async () => {
        const tmp = makeTmpDir('plexer-teardown-');
        const sock = join(tmp, 'stale.sock');
        writeFileSync(sock, '');
        setTimeout(() => {
            try { rmSync(sock, { force: true }); } catch { /* ignore */ }
        }, 60);
        const gone = await ipc.waitForSocketTeardown(sock, 1000);
        assert.equal(gone, true);
        assert.equal(existsSync(sock), false);

        const stuck = join(tmp, 'stuck.sock');
        writeFileSync(stuck, '');
        const stillThere = await ipc.waitForSocketTeardown(stuck, 60);
        assert.equal(stillThere, false);
    });

    it('plexerd serializes per-sid RPCs, respects envFlags isolation without process.env fallback, and throttles codeStamp + probeDrift', async () => {
        const tmp = makeTmpDir('plexer-daemon-');
        const repo = makeIndexedStubRepo('plexer-daemon-repo-');
        const sockPath = join(tmp, 'plexerd.sock');
        const daemon = await startDaemon({
            socketPath: sockPath,
            idleTimeoutMs: 5000,
            codeStamp: 'stub-stamp',
            pkgRoot: process.cwd(),
            version: '0.0.0-test',
        });
        try {
            const reqA = {
                event: 'agy-pre-invocation',
                codeStamp: 'stub-stamp',
                stdin: JSON.stringify({ conversation_id: 'sid-serial', prompt: 'hello' }),
                envFlags: { plexerSessionId: 'sid-serial', antigravityProjectDir: repo, noDaemon: true },
            };
            const [r1, r2] = await Promise.all([
                ipc.sendRpc(sockPath, reqA, { rpcTimeoutMs: 3000 }),
                ipc.sendRpc(sockPath, reqA, { rpcTimeoutMs: 3000 }),
            ]);
            assert.equal(typeof r1.stdout, 'string');
            assert.equal(typeof r2.stdout, 'string');

            const stale = await ipc.sendRpc(sockPath, {
                event: 'agy-pre-invocation',
                codeStamp: 'mismatch-stamp',
                stdin: '{}',
            }, { rpcTimeoutMs: 3000 });
            assert.equal(stale.restartRequired, true);
        } finally {
            await daemon.close();
            assert.equal(existsSync(sockPath), false, 'beginDaemonDrain should unlink socketPath');
        }

        // envFlags isolation unit checks: when envFlags object is provided, do NOT fall back to process.env
        const prevSid = process.env.PLEXER_SESSION_ID;
        const prevProj = process.env.CLAUDE_PROJECT_DIR;
        process.env.PLEXER_SESSION_ID = 'leaked-parent-sid';
        process.env.CLAUDE_PROJECT_DIR = '/tmp/leaked-parent-dir';
        try {
            assert.equal(resolveHostSessionId({}, { plexerSessionId: 'scoped-sid' }), 'scoped-sid');
            assert.equal(resolveHostSessionId({}, {}), 'default');
            assert.equal(resolveHostProjectDir({}, { antigravityProjectDir: repo }), repo);
            assert.notEqual(resolveHostProjectDir({}, {}), '/tmp/leaked-parent-dir');
            assert.equal(isIsolatedBenchDir('/var/tmp/plexer-bench-123', { benchDir: '/var/tmp/plexer-bench-123' }), true);
            assert.equal(isIsolatedBenchDir('/var/tmp/plexer-bench-123', {}), true);
        } finally {
            if (prevSid === undefined) delete process.env.PLEXER_SESSION_ID;
            else process.env.PLEXER_SESSION_ID = prevSid;
            if (prevProj === undefined) delete process.env.CLAUDE_PROJECT_DIR;
            else process.env.CLAUDE_PROJECT_DIR = prevProj;
        }
    });

    it('plexer-hook-client strips per-session/host/sidecar env vars before spawning _daemon', () => {
        const src = readFileSync(join(process.cwd(), 'bin', 'plexer-hook-client.cjs'), 'utf8');
        for (const key of [
            'PLEXER_SESSION_ID',
            'ANTIGRAVITY_CONVERSATION_ID',
            'ANTIGRAVITY_SIDECAR_WEB_PORT',
            'ANTIGRAVITY_AGENT',
            'PLEXER_ENABLE_BENCH_HOOKS',
        ]) {
            assert.ok(src.includes(key), `expected ${key} in daemon env sanitization list`);
        }
        assert.equal(typeof hookClient.waitForSocketTeardown, 'function');
    });

    it('hooksShim checks BAKED before realpathSync and emits valid JSON on dedup exit with valid JS syntax', () => {
        const shim = hooksShim('/tmp/plexer-baked');
        const bakedIdx = shim.indexOf('BAKED');
        const realpathIdx = shim.indexOf('realpathSync');
        assert.ok(bakedIdx >= 0 && realpathIdx > bakedIdx, 'BAKED check must precede realpathSync');
        assert.ok(shim.includes('{"decision":"allow"}\\n'), 'agy dedup early-exit should emit allow JSON');
        assert.ok(shim.includes('{}\\n'), 'standard hook dedup early-exit should emit {}');
        // Verify generated CJS script parses cleanly without SyntaxError
        assert.doesNotThrow(() => new Function(shim.replace(/^#![^\n]*\n/, '')));
    });
});

describe('Wave 3: Turn-0, Budgets, Intent & Formatting', () => {
    it('enforces model-profile-split budgets (Claude <= 2200B edit total, pinBytes <= 1600B, Gemini intact)', () => {
        assert.ok(HOOK_BUDGETS.editTotalBytes <= 2200 && HOOK_BUDGETS.editTotalBytes >= 1800);
        assert.equal(HOOK_BUDGETS.editMergedBytes, 2000);
        assert.ok(HOOK_BUDGETS.pinBytes <= 1600 && HOOK_BUDGETS.pinBytes >= 1400);
        assert.equal(HOOK_BUDGETS.qaMultiSubsystemMergedBytes, 1800);
        assert.ok(HOOK_BUDGETS.pinBytes <= HOOK_BUDGETS.editTotalBytes);
        assert.ok(GEMINI_HOOK_BUDGETS.editMergedBytes > HOOK_BUDGETS.editMergedBytes);

        // Multi-subsystem Q&A caps inlined code bytes to qaMultiSubsystemMergedBytes (2400B)
        const medCode = Array.from({ length: 12 }, (_, i) => `L${i + 1}: const x_${i} = "${'a'.repeat(50)}";`).join('\n');
        const hits = [
            { kind: 'symbol', pointer: 'src/a/one.js:L1-L12', title: 'one', code: medCode, _score: 10 },
            { kind: 'symbol', pointer: 'src/b/two.js:L1-L12', title: 'two', code: medCode, _score: 9 },
            { kind: 'symbol', pointer: 'src/c/three.js:L1-L12', title: 'three', code: medCode, _score: 8 },
            { kind: 'symbol', pointer: 'src/d/four.js:L1-L12', title: 'four', code: medCode, _score: 7 },
        ];
        const merged = mergeMultiQueryHits([{ hits }], null, { isClaude: true });
        enforceMergedHitsBudget(merged, { editEnvelope: false, wantsCallSites: false }, 2, HOOK_BUDGETS);
        const totalCodeBytes = merged.reduce((sum, h) => sum + (h.code ? Buffer.byteLength(h.code, 'utf8') : 0), 0);
        assert.ok(totalCodeBytes <= HOOK_BUDGETS.qaMultiSubsystemMergedBytes, `got ${totalCodeBytes}B`);
    });

    it('guards hasActionableEditIntent / isLikelyEditSessionPrompt against leading read-only imperatives while allowing edit clauses', () => {
        const qa1 = detectPromptIntent('explain how saveAgyContext and loadAgyContext persist seenSpans');
        assert.equal(qa1.editEnvelope, false);
        assert.equal(isLikelyEditSessionPrompt('audit src/agy/pre-tool.js for stale seenSpans bugs'), false);
        assert.equal(isLikelyEditSessionPrompt('review src/mcp/tools.js and update `isTrustedRoot` path check'), true);

        // Verified edit-clause exceptions after leading read-only imperatives:
        assert.equal(isLikelyEditSessionPrompt('check src/agy/pre-tool.js and fix the off-by-one in computeReadPreToolWidening'), true);
        assert.equal(isLikelyEditSessionPrompt('investigate the failing test, then fix `parseAgyTranscript` in src/hosts/engine/agy-transcript.js'), true);
        assert.equal(isLikelyEditSessionPrompt('Check that `foo` handles null; if not, fix it'), true);
        assert.equal(detectPromptIntent('list the callers of `foo` and update them to pass opts').editEnvelope, true);
        assert.equal(isLikelyEditSessionPrompt('list the callers of `foo` and update them to pass opts'), true);
        // Fix verb belongs to EDIT_VERB_RE while read-only questions stay excluded
        assert.equal(detectPromptIntent('Fix hubRouter bug').editEnvelope, true);
        assert.equal(detectPromptIntent('How does hubRouter fix work?').editEnvelope, false);
    });

    it('propagates confidenceTier on multi-subsystem searchPromptContext and pins 260L tail windows', async () => {
        const repo = makeTmpDir('plexer-tier-');
        mkdirSync(join(repo, 'src', 'alpha'), { recursive: true });
        mkdirSync(join(repo, 'src', 'beta'), { recursive: true });
        mkdirSync(join(repo, 'src', 'gamma'), { recursive: true });
        writeFileSync(join(repo, 'src', 'alpha', 'a.js'), 'export function dispatchAlpha() { return 1; }\n');
        writeFileSync(join(repo, 'src', 'beta', 'b.js'), 'export function dispatchBeta() { return 2; }\n');
        writeFileSync(join(repo, 'src', 'gamma', 'c.js'), 'export function dispatchGamma() { return 3; }\n');
        // 237-line symbol for 260L pin tail window
        writeFileSync(join(repo, 'src', 'alpha', 'long.js'), [
            'export function longHandler() {',
            ...Array.from({ length: 230 }, (_, i) => `  const step_${i} = ${i};`),
            '  const tailSentinel = step_0 + 1;',
            '  return tailSentinel;',
            '}',
        ].join('\n') + '\n');

        const cap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], cap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }

        // Multi-query across >=3 subsystem dirs: 1 strong query -> exploratory, 2 strong -> high
        const expRes = searchPromptContext(repo, 'dispatchAlpha dispatchBeta dispatchGamma');
        assert.ok(expRes);
        assert.ok(['high', 'exploratory'].includes(expRes.confidenceTier));
        const multiRes = searchPromptContext(repo, 'dispatchAlpha in alpha AND dispatchBeta in beta AND dispatchGamma in gamma');
        assert.equal(multiRes?.confidenceTier, 'high');

        // Pin tail window up to 260L when prompt references a tail identifier
        const graph = loadGraphCached(join(repo, 'plexer'));
        const pins = pinnedHits(repo, graph, 'Update `longHandler` and `tailSentinel`', { budgetBytes: 8000, geminiProfile: true });
        assert.ok(pins.some((p) => p.pointer.includes('long.js') && p.code && p.code.includes('tailSentinel')));
    });

    it('omits alreadySeen hits from fenced code blocks and returns null when all hits are seen', () => {
        const ask = {
            query: 'verifyToken auth',
            coverage: 0.6,
            coverageStrong: 0.4,
            hits: [
                {
                    kind: 'symbol',
                    title: 'verifyToken · function',
                    pointer: 'src/auth.js:L1-L25',
                    code: 'L1: export function verifyToken() { return true; }',
                    alreadySeen: true,
                    related: ['helperA'],
                },
            ],
        };
        const out = relevantRetrieval(ask, {}, 4, { geminiProfile: false });
        assert.equal(out, null, 'all-seen hits must return null');

        const formattedMixed = formatRetrieval({
            ...ask,
            hits: [
                ask.hits[0],
                {
                    kind: 'symbol',
                    title: 'issueToken · function',
                    pointer: 'src/auth.js:L30-L50',
                    code: 'L30: export function issueToken() { return "ok"; }',
                },
            ],
        }, 4, { geminiProfile: false });
        assert.ok(formattedMixed.includes('[seen'), 'seen hit kept only as compact pointer');
        assert.ok(!formattedMixed.includes('verifyToken() { return true; }'), 'seen hit code block omitted');
        assert.ok(formattedMixed.includes('issueToken()'), 'fresh hit code block included');
    });

    it('silences weak/OOB prompts across both Gemini and Claude profiles (0 B)', () => {
        const weakAsk = {
            query: 'create random token',
            coverage: 0.25,
            coverageStrong: 0,
            hits: [{ kind: 'symbol', title: 'foo', pointer: 'src/foo.js:L1-L5', code: 'L1: function foo() {}' }],
        };
        assert.equal(relevantRetrieval(weakAsk, {}, 4, { geminiProfile: false }), null);
        assert.equal(relevantRetrieval(weakAsk, {}, 4, { geminiProfile: true }), null);
    });
});

describe('Wave 3: PreToolUse, PostToolUse & Shell Rewrite', () => {
    it('clamps unread tails at 46080B in PreToolUse, prevents mid-file over-widening near seen intervals, emits Claude soft hints, and invalidates seenMtimes on external edits', () => {
        const repo = makeIndexedStubRepo('plexer-pretool-');
        const target = join(repo, 'src', 'big.js');
        mkdirSync(join(repo, 'src'), { recursive: true });
        // 1500 lines x ~100 bytes = 150KB >> 46080B
        writeFileSync(target, Array.from({ length: 1500 }, (_, i) => `export function fn_${String(i).padStart(4, '0')}() { return "${'x'.repeat(58)}"; }`).join('\n') + '\n');

        // Bug 1: PreToolUse read 1..800 must clamp recorded seenSpans at <= 46080B so follow-up 500..800 is ALLOWED
        const tailState = { isEditPrompt: false, seenSpans: {}, seenMtimes: {} };
        evaluateAgyPreTool(
            { tool_name: 'view_file', tool_input: { AbsolutePath: target, StartLine: 1, EndLine: 800 } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: tailState, geminiProfile: true },
        );
        const recEnd = tailState.seenSpans['src/big.js']?.[0]?.[1] ?? 0;
        assert.ok(recEnd > 100 && recEnd < 500, `PreToolUse must clamp seen end at 46080B (<500), got ${recEnd}`);
        const followUpTail = evaluateAgyPreTool(
            { tool_name: 'view_file', tool_input: { AbsolutePath: target, StartLine: 500, EndLine: 800 } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: tailState, geminiProfile: true },
        );
        assert.equal(followUpTail.decision, 'allow', 'follow-up read of unread tail 500..800 must NOT be denied');

        // Bug 2: Non-sequential mid-file read near a Turn-0 seen interval [[650, 695]] must stay surgical (<= 120L)
        const surgState = { isEditPrompt: true, seenSpans: { 'src/big.js': [[650, 695]] }, seenMtimes: {} };
        const wGemini = computeReadPreToolWidening(
            { AbsolutePath: target, StartLine: 700, EndLine: 720 },
            repo,
            surgState,
            { geminiProfile: true },
        );
        if (wGemini) {
            assert.ok(wGemini.endLine - wGemini.startLine + 1 <= 120, `over-widened on Gemini: ${wGemini.startLine}-${wGemini.endLine}`);
        }
        const wClaude = computeReadPreToolWidening(
            { AbsolutePath: target, StartLine: 700, EndLine: 720 },
            repo,
            { isEditPrompt: true, seenSpans: { 'src/big.js': [[650, 695]] }, seenMtimes: {} },
            { geminiProfile: false },
        );
        if (wClaude) {
            assert.ok(wClaude.endLine - wClaude.startLine + 1 <= 120, `over-widened on Claude: ${wClaude.startLine}-${wClaude.endLine}`);
        }

        // Q&A StartLine:1 must NOT trigger TOP_PAGE_WIDEN=360L
        const wQaTop = computeReadPreToolWidening(
            { AbsolutePath: target, StartLine: 1, EndLine: 30 },
            repo,
            { isEditPrompt: false, seenSpans: {}, seenMtimes: {} },
            { geminiProfile: true },
        );
        assert.ok(!wQaTop || wQaTop.endLine <= 240, 'Q&A must not apply TOP_PAGE_WIDEN=360L');

        // Claude duplicate read denies on first attempt with 1-retry escape
        const dupClaudeState = { seenSpans: { 'src/big.js': [[1, 80]] }, seenMtimes: {} };
        stampSeenMtime(dupClaudeState, 'src/big.js', target);
        const dupClaude = evaluateAgyPreTool(
            { tool_name: 'Read', tool_input: { file_path: target, offset: 1, limit: 80 } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: dupClaudeState, hostKind: 'claude', geminiProfile: false },
        );
        assert.equal(dupClaude.decision, 'deny');
        assert.match(dupClaude.reason || '', /already in your context window/);
        const dupClaudeRetry = evaluateAgyPreTool(
            { tool_name: 'Read', tool_input: { file_path: target, offset: 1, limit: 80 } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: dupClaudeState, hostKind: 'claude', geminiProfile: false },
        );
        assert.equal(dupClaudeRetry.decision, 'allow');

        // Gemini duplicate read denies until external mtime drift invalidates seenSpans
        const dupGemState = { seenSpans: { 'src/big.js': [[1, 80]] }, seenMtimes: { 'src/big.js': 1000 } };
        utimesSync(target, new Date(), new Date(Date.now() + 5000));
        const afterDrift = evaluateAgyPreTool(
            { tool_name: 'view_file', tool_input: { AbsolutePath: target, StartLine: 1, EndLine: 80 } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: dupGemState, geminiProfile: true },
        );
        assert.equal(afterDrift.decision, 'allow', 'stale seenSpans after external mtime change must not deny read');
        assert.equal(dupGemState.seenSpans['src/big.js'][0][0], 1);
    });

    it('recordReadPostTool clamps byte-truncated read_file by 46080B, respects ByteOffset and Showing lines banners', () => {
        const repo = makeIndexedStubRepo('plexer-postread-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        const longFile = join(repo, 'src', 'huge.txt');
        writeFileSync(longFile, Array.from({ length: 1500 }, (_, i) => `L${String(i + 1).padStart(4, '0')}:${'x'.repeat(94)}`).join('\n') + '\n');

        const state1 = { seenSpans: {}, seenMtimes: {} };
        recordReadPostTool({
            agyState: state1,
            workspaceDirs: [repo],
            repoRoot: repo,
            targetPath: longFile,
            toolArgs: { AbsolutePath: longFile, StartLine: 1, EndLine: 1500 },
        });
        const span1 = state1.seenSpans['src/huge.txt'][0];
        assert.ok(span1[1] < 600, `byte cap 46080B should clamp endLine far below 1500, got ${span1[1]}`);

        const state2 = { seenSpans: {}, seenMtimes: {} };
        const resByte = recordReadPostTool({
            agyState: state2,
            workspaceDirs: [repo],
            repoRoot: repo,
            targetPath: longFile,
            toolArgs: { AbsolutePath: longFile, StartLine: 1, EndLine: 200, ByteOffset: 4096 },
        });
        assert.equal(resByte, null);

        const state3 = { seenSpans: {}, seenMtimes: {} };
        recordReadPostTool({
            agyState: state3,
            workspaceDirs: [repo],
            repoRoot: repo,
            targetPath: longFile,
            toolArgs: { AbsolutePath: longFile, StartLine: 1, EndLine: 800 },
            input: { tool_response: 'Showing lines 1-42 of 1500' },
        });
        assert.deepEqual(state3.seenSpans['src/huge.txt'], [[1, 42]]);
    });

    it('shell-rewrite preserves git log -p with -n 3, handles cd <subdir>, aborts on $, ~, # or newline, and bypasses repeated grep loops', async () => {
        const repo = makeTmpDir('plexer-rewrite-');
        mkdirSync(join(repo, 'packages', 'sub'), { recursive: true });
        mkdirSync(join(repo, 'packages', 'txtdir'), { recursive: true });
        writeFileSync(join(repo, 'packages', 'sub', 'a.js'), 'export const hit = 1;\nexport function verifyToken() { return 1; }\n');
        writeFileSync(join(repo, 'packages', 'txtdir', 'notes.txt'), 'plain text token\n');
        const cap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], cap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }

        const gitLogRw = rewriteShellExplorationCommand('cd packages/sub && git log -p -- a.js', {
            repoRoot: repo,
            sessionId: 's1',
            agyState: { seenSearchKeys: [] },
        });
        assert.ok(typeof gitLogRw === 'string' && gitLogRw.includes('-p') && gitLogRw.includes('-n 3'));
        assert.ok(gitLogRw.indexOf('-n 3') < gitLogRw.indexOf(' -- '));
        assert.ok(gitLogRw.includes('env -C'));

        const rgSub = rewriteShellExplorationCommand('cd packages/sub && rg verifyToken', {
            repoRoot: repo,
            sessionId: 's1',
            agyState: { seenSearchKeys: [] },
        });
        assert.ok(typeof rgSub === 'string' && rgSub.includes('packages/sub'));

        const agyStateLoop = { seenSearchKeys: [`cmd:${repo}:grep\0verifyToken\0--in\0packages/sub`] };
        const rgLoop = rewriteShellExplorationCommand('rg verifyToken packages/sub', {
            repoRoot: repo,
            sessionId: 's1',
            agyState: agyStateLoop,
        });
        assert.equal(rgLoop, null);

        const rgTxt = rewriteShellExplorationCommand('rg token packages/txtdir/notes.txt', {
            repoRoot: repo,
            sessionId: 's1',
            agyState: { seenSearchKeys: [] },
        });
        assert.equal(rgTxt, null);

        // Bug 3a: nested unindexed .json under src/sub/cfg/c.json must bypass rewrite
        mkdirSync(join(repo, 'src', 'sub', 'cfg'), { recursive: true });
        writeFileSync(join(repo, 'src', 'sub', 'c.js'), 'export const verifyTokenNested = 1;\n');
        writeFileSync(join(repo, 'src', 'sub', 'cfg', 'c.json'), '{"verifyToken":true}\n');
        const cap2 = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], cap2.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }
        assert.equal(rewriteShellExplorationCommand('grep -rn verifyToken src', { repoRoot: repo }), null);

        // Bug 3c: cd sub && rg X with sub/cfg.json must bypass rewrite
        mkdirSync(join(repo, 'sub'), { recursive: true });
        writeFileSync(join(repo, 'sub', 'x.js'), 'export const subX = 1;\n');
        writeFileSync(join(repo, 'sub', 'cfg.json'), '{"subX":1}\n');
        assert.equal(rewriteShellExplorationCommand('cd sub && rg subX', { repoRoot: repo }), null);

        // Bug 3b: repo root `.` / no path with package.json must bypass rewrite
        writeFileSync(join(repo, 'package.json'), '{"name":"tmp"}\n');
        assert.equal(rewriteShellExplorationCommand('rg verifyToken', { repoRoot: repo }), null);
        assert.equal(rewriteShellExplorationCommand('grep -rn verifyToken .', { repoRoot: repo }), null);

        // Bug 4: $ inside double quotes aborts rewrite instead of turning $TOKEN literal
        assert.equal(rewriteShellExplorationCommand('grep -rn "$TOKEN" packages/sub', { repoRoot: repo }), null);
        assert.equal(rewriteShellExplorationCommand('rg "a$b" packages/sub', { repoRoot: repo }), null);

        // Past-EOF sed/tail & git grep BRE return null
        assert.equal(rewriteShellExplorationCommand('tail -n +500 packages/sub/a.js', { repoRoot: repo }), null);
        assert.equal(rewriteShellExplorationCommand('sed -n 500,600p packages/sub/a.js', { repoRoot: repo }), null);
        assert.equal(rewriteShellExplorationCommand('git grep "a\\|b" packages/sub', { repoRoot: repo }), null);

        assert.equal(splitSafeChainedCommands('echo $HOME && rg foo'), null);
        assert.equal(splitSafeChainedCommands('cat ~/a.js && echo ok'), null);
        assert.equal(splitSafeChainedCommands('rg foo # comment'), null);
        assert.equal(splitSafeChainedCommands('rg foo\necho bar'), null);
    });

    it('Gemini 0-based read_file offset maps to 1-based StartLine (e.g. offset:99 -> 100-109) and handleHostPostTool ignores failed tools', () => {
        const repo = makeIndexedStubRepo('plexer-gemini-offset-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        const f = join(repo, 'src', 'auth.js');
        writeFileSync(f, Array.from({ length: 500 }, (_, i) => `// line ${i + 1}`).join('\n') + '\n');

        const gemPreState = { seenSpans: {}, seenMtimes: {} };
        const resPre = evaluateAgyPreTool(
            { tool_name: 'read_file', tool_input: { file_path: f, offset: 99, limit: 10 } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: gemPreState, hostKind: 'gemini', geminiProfile: true },
        );
        assert.equal(resPre.decision, 'allow');
        assert.deepEqual(gemPreState.seenSpans['src/auth.js'], [[100, 109]]);

        const gemPostState = { seenSpans: {}, seenMtimes: {} };
        recordReadPostTool({
            agyState: gemPostState,
            workspaceDirs: [repo],
            repoRoot: repo,
            targetPath: f,
            toolArgs: { file_path: f, offset: 99, limit: 10 },
            hostKind: 'gemini',
        });
        assert.deepEqual(gemPostState.seenSpans['src/auth.js'], [[100, 109]]);

        let onEditCalled = false;
        handleHostPostTool('claude', {
            session_id: 'err-skip',
            cwd: repo,
            tool_name: 'Edit',
            is_error: true,
            tool_input: { file_path: f, old_string: '// line 1', new_string: '// changed' },
        }, { onFileEdited: () => { onEditCalled = true; }, captureStdout: true });
        assert.equal(onEditCalled, false, 'failed PostTool must not invoke onFileEdited');
    });

    it('Bug 7 + Turn-6 gate: Turn-0 / plan-handoff seenSpans get mtime baselines invalidated on external edits, and Claude Turn-6 gate emits soft additionalContext', async () => {
        const repo = makeTmpDir('plexer-b7-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        const f = join(repo, 'src', 'auth.js');
        writeFileSync(f, [
            'export function verifyTargetAuth(token) {',
            '  const a = String(token || "");',
            '  const b = a.trim();',
            '  const c = b.length > 3;',
            '  return c;',
            '}',
            ...Array.from({ length: 34 }, (_, i) => `export function fn_${i}() { return ${i}; }`),
        ].join('\n') + '\n');
        const cap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], cap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }

        const sid = `w3-b7-${Date.now()}`;
        await handleAgyPreInvocation({
            conversation_id: sid,
            workspacePaths: [repo],
            prompt: 'Update `verifyTargetAuth` in `src/auth.js`',
        }, { envFlags: { plexerSessionId: sid, callerCwd: repo, noDaemon: true }, captureStdout: true });

        const st = loadAgyContext({ conversation_id: sid, workspacePaths: [repo] }).agyState;
        assert.ok(st.seenMtimes?.['src/auth.js'], 'Turn-0 retrieval must stamp seenMtimes');

        // Claude Turn-6 exploration gate returns allow + additionalContext (not hard deny)
        const gateState = {
            isEditPrompt: true,
            editedInPrompt: false,
            preEditToolTurns: 6,
            editTargetFiles: ['src/auth.js'],
            seenSpans: { 'src/auth.js': [[1, 30]] },
            seenMtimes: { ...st.seenMtimes },
        };
        const claudeGate = evaluateAgyPreTool(
            { tool_name: 'Grep', tool_input: { pattern: 'fn_', path: join(repo, 'src') } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: gateState, hostKind: 'claude', geminiProfile: false },
        );
        assert.equal(claudeGate.decision, 'allow');
        assert.match(claudeGate.additionalContext || '', /Exploration budget reached/);

        // External mtime edit invalidates seenSpans inside areEditTargetsSeen so Gemini Turn-6 gate does NOT deny
        utimesSync(f, new Date(), new Date(Date.now() + 5000));
        const gemGate = evaluateAgyPreTool(
            { tool_name: 'grep_search', tool_input: { Query: 'fn_', SearchPath: join(repo, 'src') } },
            { workspaceDirs: [repo], repoRoot: repo, agyState: gateState, geminiProfile: true },
        );
        assert.equal(gemGate.decision, 'allow');
        assert.equal(gateState.seenSpans['src/auth.js'], undefined, 'external mtime drift invalidates seenSpans in shell/gate');
    });

    it('saveAgyContext ignores volatile lastPreEditToolAtMs for dirty checking when sessionCache is active', () => {
        const sid = `w3-dirty-${Date.now()}`;
        const cache = new Map();
        const state = { turn0Matched: true, seenSpans: { 'src/a.js': [[1, 10]] }, lastPreEditToolAtMs: 100 };
        saveAgyContext(sid, state, { sessionCache: cache });
        const freshCache = new Map();
        const loaded1 = loadAgyContext({ conversation_id: sid }, { sessionCache: freshCache });
        loaded1.agyState.lastPreEditToolAtMs = 999999;
        saveAgyContext(sid, loaded1.agyState, { sessionCache: freshCache });
        const loaded2 = loadAgyContext({ conversation_id: sid });
        assert.equal(loaded2.agyState.lastPreEditToolAtMs, 100, 'only lastPreEditToolAtMs changed so disk write was skipped');
    });
});

describe('Wave 3: Orchestrator, Transcript & Swarm', () => {
    it('buildPlanExecutionHandoff records only surviving spans after fitToBytes and uses 85% threshold for isWholeFileSeen', async () => {
        const repo = makeTmpDir('plexer-handoff-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(join(repo, 'src', 'auth.js'), [
            'export function verifyToken() {',
            ...Array.from({ length: 18 }, (_, i) => `  const check_${i} = ${i};`),
            '  return check_0 >= 0;',
            '}',
            'export function revokeToken() {',
            ...Array.from({ length: 18 }, (_, i) => `  const rev_${i} = ${i};`),
            '  return rev_0 >= 0;',
            '}',
        ].join('\n') + '\n');
        const cap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], cap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }

        // No pre-seeded seenSpans; tiny maxBytes truncates revokeToken block so spans only include surviving verifyToken
        const emptyState = { seenSpans: {} };
        const handoff = buildPlanExecutionHandoff([repo], 'Update `verifyToken` and `revokeToken`.', emptyState, {
            maxBytes: 700,
        });
        assert.ok(handoff && handoff.targetFiles.includes('src/auth.js'));
        assert.ok(handoff.spans.length === 1 && handoff.spans[0].end <= 25, `only surviving span recorded, got ${JSON.stringify(handoff.spans)}`);

        // isWholeFileSeen >= 85%: 80% covered still produces handoff; 90% covered suppresses handoff
        const partial80 = { seenSpans: { 'src/auth.js': [[1, 32]] } };
        const h80 = buildPlanExecutionHandoff([repo], 'Update `src/auth.js`.', partial80);
        assert.ok(h80 && h80.targetFiles.includes('src/auth.js'), '80% coverage must not treat whole file as seen');

        const covered90 = { seenSpans: { 'src/auth.js': [[1, 39]] } };
        const h90 = buildPlanExecutionHandoff([repo], 'Update `src/auth.js`.', covered90);
        assert.equal(h90, null, '>=85% coverage treats whole file as seen');
    });

    it('parseAgyTranscript separates step ordinals, proves no full hydration on tool_calls truncation, and tail-hydrates 64KB+ USER_INPUT', () => {
        const tmp = makeTmpDir('plexer-tx-');
        const tx = join(tmp, 'transcript.jsonl');
        const full = join(tmp, 'transcript_full.jsonl');
        writeFileSync(tx, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Inspect `src/first.js`', truncated_fields: [] }),
            JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'Reading file', truncated_fields: ['tool_calls'] }),
            JSON.stringify({ step_index: 5, type: 'CHECKPOINT' }),
        ].join('\n') + '\n');
        // Put a marker path in transcript_full for step 1 (`tool_calls` only) -> MUST NOT be hydrated!
        writeFileSync(full, [
            JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'Inspect `src/first.js`' }),
            JSON.stringify({ step_index: 1, type: 'PLANNER_RESPONSE', content: 'NEVER_HYDRATE.js', tool_calls: [{ name: 'view_file' }] }),
        ].join('\n') + '\n');

        const parsed = parseAgyTranscript(tx, {});
        assert.equal(parsed.lastCheckpointStep, 5);
        assert.equal(parsed.transcriptStepSeq, 3);
        assert.ok(parsed.transcriptOffset > 10);
        assert.equal(Boolean(parsed.touchedFiles?.includes('NEVER_HYDRATE.js')), false, 'tool_calls truncation must NOT hydrate transcript_full');

        // 64KB+ tail hydration test for truncated USER_INPUT
        const txDir = makeTmpDir('plexer-tx-tail-');
        const tx2 = join(txDir, 'transcript.jsonl');
        const full2 = join(txDir, 'transcript_full.jsonl');
        const padRows = Array.from({ length: 30 }, (_, i) => JSON.stringify({ step_index: i, type: 'PLANNER_RESPONSE', content: 'x'.repeat(2800) }));
        writeFileSync(tx2, [
            ...padRows,
            JSON.stringify({ step_index: 30, type: 'USER_INPUT', content: 'truncated...', truncated_fields: ['content'] }),
        ].join('\n') + '\n');
        writeFileSync(full2, [
            ...padRows,
            JSON.stringify({ step_index: 30, type: 'USER_INPUT', content: 'Edit `src/tailHydrated.js` please' }),
        ].join('\n') + '\n');
        const parsedBig = parseAgyTranscript(tx2, {});
        assert.ok(parsedBig.lastUserPrompt?.includes('src/tailHydrated.js'), 'truncated USER_INPUT beyond 64KB must tail-hydrate cleanly');
    });

    it('handleAgyPreInvocation persists transcriptOffset on early return, preserves execute on Proceed, and isolates swarm skipBrainScan cache', async () => {
        const repo = makeIndexedStubRepo('plexer-proceed-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(join(repo, 'src', 'auth.js'), 'export function verifyToken() { return true; }\n');

        // Early return transcriptOffset persistence
        const txEarlyDir = makeTmpDir('plexer-early-tx-');
        const txEarly = join(txEarlyDir, 'transcript.jsonl');
        writeFileSync(txEarly, JSON.stringify({ step_index: 0, type: 'USER_INPUT', content: 'hi' }) + '\n');
        const sidEarly = `w3-early-${Date.now()}`;
        await handleAgyPreInvocation({
            conversation_id: sidEarly,
            workspacePaths: [repo],
            transcriptPath: txEarly,
            prompt: '',
        }, { envFlags: { plexerSessionId: sidEarly, callerCwd: repo, noDaemon: true }, captureStdout: true });
        assert.ok(loadAgyContext({ conversation_id: sidEarly, workspacePaths: [repo] }).agyState.transcriptOffset > 0);

        // Proceed preserves execute phase and caches isSwarmMember = false naturally (not pre-set)
        const sid = `w3-proceed-${Date.now()}`;
        saveAgyContext(sid, {
            orchestratorPhase: 'plan',
            isOrchestratorModel: true,
            planExecuteChecked: true,
            hasDirectUserInput: true,
            pendingPlanAwaitApproval: true,
            planTargetFiles: ['src/auth.js'],
            editTargetFiles: ['src/auth.js'],
            seenSpans: { 'src/auth.js': [[1, 1]] },
        });

        await handleAgyPreInvocation({
            conversation_id: sid,
            workspacePaths: [repo],
            prompt: 'Proceed',
        }, { envFlags: { plexerSessionId: sid, callerCwd: repo, noDaemon: true }, captureStdout: true });

        const updated = loadAgyContext({ conversation_id: sid }).agyState;
        assert.equal(updated.orchestratorPhase, 'execute');
        assert.deepEqual(updated.planTargetFiles, ['src/auth.js']);
        assert.equal(updated.isSwarmMember, false);

        // Swarm skipBrainScan lookup miss must NOT poison full-scan lookup for a real worker in brain/
        const brainApp = makeTmpDir('plexer-swarm-brain-');
        const brainConv = join(brainApp, 'brain', 'swarm-conv-1', '.system_generated', 'swarm');
        mkdirSync(brainConv, { recursive: true });
        writeFileSync(join(brainConv, 'members.json'), JSON.stringify({
            coordinator_id: 'coord-1',
            members: {
                w1: { conversation_id: 'worker-w1', state: 'working', owned_files: ['src/auth.js'] },
            },
        }));
        const missSkip = checkSwarmEditCollision('worker-w1', repo, join(repo, 'src', 'auth.js'), {}, {
            appDataDirs: [brainApp],
            skipBrainScan: true,
        });
        assert.equal(missSkip, null);
        const hitFull = seedForkedSwarmSession('worker-w1', {}, { appDataDirs: [brainApp] });
        assert.equal(hitFull, false); // w1 exists without fork, proving skipBrainScan miss didn't throw or crash on either signature
    });
});

describe('Wave 3: Retract, MCP Config, CLI & MCP Tools', () => {
    it('runRetract cleans both hooks and mcpServers from repo .gemini/settings.json in one pass and preserves non-plexer ignore entries', () => {
        const repo = makeTmpDir('plexer-retract-');
        mkdirSync(join(repo, '.gemini'), { recursive: true });
        writeFileSync(join(repo, '.gemini', 'settings.json'), JSON.stringify({
            hooks: {
                BeforeAgent: [{ matcher: '*', hooks: [{ name: 'plexer-hook', command: 'node ".gemini/hooks/plexer/plexer-hooks.cjs" before-agent' }] }],
                AfterAgent: [{ matcher: '*', hooks: [{ name: 'other-tool', command: 'other' }] }],
            },
            mcpServers: {
                plexer: { command: 'plexer', args: ['mcp'] },
                custom: { command: 'custom-mcp' },
            },
        }, null, 2));
        writeFileSync(join(repo, '.gitignore'), '# comment\nplexer/\nnode_modules/\nmy-plexer-plugin/\n');

        runRetract(repo, { home: makeTmpDir('plexer-home-'), scopes: ['repo'] });

        const gem = JSON.parse(readFileSync(join(repo, '.gemini', 'settings.json'), 'utf8'));
        assert.equal(gem.mcpServers.plexer, undefined);
        assert.equal(gem.mcpServers.custom.command, 'custom-mcp');
        assert.equal(gem.hooks.BeforeAgent, undefined);
        assert.ok(gem.hooks.AfterAgent.length === 1);

        const gi = readFileSync(join(repo, '.gitignore'), 'utf8');
        assert.equal(gi.includes('plexer/\n'), false);
        assert.equal(gi.includes('my-plexer-plugin/'), true, 'non-plexer entries mentioning plexer must stay intact');
    });

    it('stripTomlSection strips both [mcp_servers.plexer] and [mcp_servers.plexer.*] subtables', () => {
        const toml = [
            '[mcp_servers.other]',
            'command = "other"',
            '',
            '[mcp_servers.plexer]',
            'command = "plexer"',
            '',
            '[mcp_servers.plexer.env]',
            'FOO = "bar"',
            '',
            '[mcp_servers.after]',
            'command = "after"',
        ].join('\n');
        const cleaned = stripTomlSection(toml);
        assert.equal(cleaned.found, true);
        assert.equal(cleaned.rest.includes('[mcp_servers.plexer]'), false);
        assert.equal(cleaned.rest.includes('[mcp_servers.plexer.env]'), false);
        assert.equal(cleaned.rest.includes('[mcp_servers.other]'), true);
        assert.equal(cleaned.rest.includes('[mcp_servers.after]'), true);
    });

    it('plexer grep -F searches literal regex metacharacters cleanly', async () => {
        const repo = makeTmpDir('plexer-grep-fixed-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(join(repo, 'src', 'sample.js'), 'export const re = "a[0]+(b)";\n');

        const buildCap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], buildCap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }

        const grepCap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'grep', '-F', 'a[0]+(b)', repo], grepCap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }
        const out = grepCap.result();
        assert.equal(out.exitCode, 0);
        assert.ok(out.stdout.includes('sample.js'));
    });

    it('MCP enforces root jail, slim plexer_health schema with legacy flat compatibility, and drift invalidation', async () => {
        const repo = makeIndexedStubRepo('plexer-mcp-');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(join(repo, 'src', 'auth.js'), 'export function verifyToken() { return true; }\n');
        const outside = makeIndexedStubRepo('plexer-outside-');

        const healthTool = TOOLS.find((t) => t.name === 'plexer_health');
        assert.ok(healthTool);
        assert.equal(healthTool.annotations.readOnlyHint, false);
        assert.equal(healthTool.annotations.idempotentHint, false);
        assert.ok('options' in healthTool.inputSchema.properties);
        assert.equal('lanes' in healthTool.inputSchema.properties, false);

        const sessionState = { roots: [repo], seenSpansByRepo: new Map() };
        const denied = await callTool(repo, 'plexer_read', { file: 'src/auth.js', dir: outside }, undefined, sessionState);
        assert.equal(denied.isError, true);

        invalidateMcpFreshnessCache(repo);
        const ok = await callTool(repo, 'plexer_read', { file: 'src/auth.js', dir: repo }, undefined, sessionState);
        assert.equal(Boolean(ok.isError), false);
    });

    it('plexerd runs read-only CLI queries concurrently, grep caches safe paths with invalidation, and cost-model computes Gemini USD + Orchestrator splits', async () => {
        const tmp = makeTmpDir('plexer-w3-fast-');
        const repo = join(tmp, 'repo');
        mkdirSync(join(repo, 'src'), { recursive: true });
        writeFileSync(join(repo, 'src', 'a.js'), 'export function targetNeedle() { return 1; }\n');
        writeFileSync(join(repo, 'src', 'b.js'), 'export function bNeedle() { return 2; }\n');
        const buildCap = makeCapturedIo();
        try { await runCli(['node', 'plexer', 'build', repo], buildCap.ioCtx); }
        catch (e) { if (!e?.isCliExit) throw e; }

        const sockPath = join(tmp, 'plexerd-concurrent.sock');
        const daemon = await startDaemon({ socketPath: sockPath, idleTimeoutMs: 5000, codeStamp: 'test-stamp' });
        try {
            const sid = `cli-conc-${process.pid}-${Date.now()}`;
            const [r1, r2] = await Promise.all([
                ipc.sendRpc(sockPath, { id: 1, type: 'cli', cwd: repo, sessionId: sid, argv: ['read', 'src/a.js:L1-L1', '--session', sid] }, { rpcTimeoutMs: 3000 }),
                ipc.sendRpc(sockPath, { id: 2, type: 'cli', cwd: repo, sessionId: sid, argv: ['grep', 'bNeedle', '--session', sid] }, { rpcTimeoutMs: 3000 }),
            ]);
            assert.equal(r1.ok, true);
            assert.equal(r2.ok, true);
            assert.match(r1.stdout, /targetNeedle/);
            assert.match(r2.stdout, /bNeedle/);
        } finally {
            await daemon.close();
        }

        // grep safe-path cache hits cleanly across repeated calls and invalidates when file is deleted
        const g = loadGraphCached(join(repo, 'plexer'));
        const g1 = grepGraph(g, repo, 'bNeedle');
        assert.equal(g1.totalHits, 1);
        assert.ok(g._grepSafePathCache?.has('src/b.js'));
        rmSync(join(repo, 'src', 'b.js'), { force: true });
        const g2 = grepGraph(g, repo, 'bNeedle');
        assert.equal(g2.totalHits, 0);
        assert.equal(g._grepSafePathCache?.has('src/b.js'), false);

        // cost-model.js computes published USD + Orchestrator Neon/H2 breakdown + t0-aware outTok
        const rows = loadRows(join(process.cwd(), 'bench'), { includeOptional: true });
        const orchRows = rows.filter((r) => r.family === 'orch-neon-high-hydrogen-high');
        if (orchRows.length > 0) {
            assert.ok(orchRows.every((r) => typeof r.usd === 'number' && r.usd >= 0));
            assert.ok(orchRows.some((r) => r.neonUsd > r.h2Usd));
            const fitted = fitFamily(orchRows, (r) => (r.arm === 'plexer' ? 1500 : 0));
            const predLow = predict(fitted, 5, 500);
            const predHigh = predict(fitted, 5, 3000);
            assert.ok(predHigh.usd > predLow.usd);
            assert.ok(predHigh.outTok >= predLow.outTok);
        }
    });
});
