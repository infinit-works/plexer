import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildGraph } from '../src/index.js';
import { canSeedGraph, localCloneOriginRoot, seedGraph } from '../src/graph/seed.js';
import { pickRepoForTargetPath, queryMultiWorkspaceContext, resolveAgyWorkspaceDirs } from '../src/agy/multi-workspace.js';
import { buildPlanExecutionHandoff } from '../src/agy/plan-handoff.js';
import { buildAgyContextGraph, computeSidecarRev, discoverConversationSwarm } from '../src/agy/context-graph.js';
import { isSyntheticOrMetaPrompt } from '../src/claude/hooks.js';
import { agySessionPath, emptyAgySession, readAgySession, writeAgySession } from '../src/agy/session.js';
import { resolveAgyRepoDir, resolveHostProjectDir, resolveHostSessionId } from '../src/hosts/engine/agy-context.js';
import { handleAgyPreInvocation } from '../src/hosts/engine/turn0.js';
import { handleAgyPreTool } from '../src/hosts/engine/dispatcher.js';
import { handleAgyPostTool } from '../src/hosts/engine/post-tool.js';
import { startVizServer } from '../src/viz/serve.js';
import { createSidecarHandlers } from '../sidecars/viz/main.mjs';

const CLEANUP_DIRS = [];
const CLEANUP_FILES = [];

function makeTempDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    CLEANUP_DIRS.push(dir);
    return dir;
}

function trackAgySession(sid) {
    CLEANUP_FILES.push(agySessionPath(sid));
    return sid;
}

after(() => {
    for (const f of CLEANUP_FILES) {
        try {
            rmSync(f, { force: true });
        } catch {
            // Best-effort temp session cleanup.
        }
    }
    for (const d of CLEANUP_DIRS) {
        try {
            rmSync(d, { recursive: true, force: true });
        } catch {
            // Best-effort temp cleanup.
        }
    }
});

async function buildSampleRepo(prefix, filesMap, gitCommit = true) {
    const repo = makeTempDir(prefix);
    for (const [rel, content] of Object.entries(filesMap)) {
        const full = join(repo, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, content, 'utf8');
    }
    execFileSync('git', ['init', '-q'], { cwd: repo });
    if (gitCommit) {
        execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
        execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo });
        execFileSync('git', ['add', '.'], { cwd: repo });
        execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'], { cwd: repo });
    }
    await buildGraph(repo, { force: true });
    return repo;
}

function extractSysMsg(rawJson) {
    const obj = JSON.parse(rawJson || '{}');
    return obj.injectSteps?.[0]?.systemMessage?.systemMessage || obj.systemMessage || '';
}

describe('Antigravity 2.0 App Wave 2 Upgrades', () => {
    it('seeds graph from local git-clone origin and alternates while rejecting remote URLs', async () => {
        const origin = await buildSampleRepo('plexer-w2-origin-', {
            'src/math.js': 'export function addNumbers(a, b) {\n  return a + b;\n}\n',
        });

        const clone = makeTempDir('plexer-w2-clone-');
        rmSync(clone, { recursive: true, force: true });
        execFileSync('git', ['clone', '-q', origin, clone]);
        assert.equal(existsSync(join(clone, 'plexer')), false);
        assert.equal(resolve(localCloneOriginRoot(clone)), resolve(origin));
        assert.equal(canSeedGraph(clone), true);

        const res = seedGraph(clone);
        assert.equal(res.seeded, true);
        assert.equal(resolve(res.from), resolve(origin));
        assert.equal(existsSync(join(clone, 'plexer', '.graph', 'wiring.json')), true);

        // Remote origin URL with no alternates must return null (zero network probes)
        const remoteRepo = makeTempDir('plexer-w2-remote-');
        execFileSync('git', ['init', '-q'], { cwd: remoteRepo });
        execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/org/repo.git'], { cwd: remoteRepo });
        assert.equal(localCloneOriginRoot(remoteRepo), null);
        assert.equal(canSeedGraph(remoteRepo), false);
    });

    it('resolves multi-root workspacePaths, routes PreToolUse/PostToolUse, and fuses cross-repo Turn-0 results with RRF', async () => {
        const repoA = await buildSampleRepo('plexer-test-w2-wsA-', {
            'src/authService.js': [
                'export function validateSessionToken(token) {',
                '  if (!token) return false;',
                '  return token.startsWith("tok_");',
                '}',
            ].join('\n') + '\n',
        });
        const repoB = await buildSampleRepo('plexer-test-w2-wsB-', {
            'src/billingWorker.js': [
                'export function reconcileInvoiceBatch(items) {',
                '  return (items || []).reduce((acc, item) => acc + (item.cents || 0), 0);',
                '}',
            ].join('\n') + '\n',
        });

        const wsDirs = resolveAgyWorkspaceDirs({ workspacePaths: [repoA, repoB] });
        assert.equal(wsDirs.length, 2);
        assert.equal(resolve(pickRepoForTargetPath(join(repoB, 'src', 'billingWorker.js'), wsDirs, repoA)), resolve(repoB));

        const fused = queryMultiWorkspaceContext(
            wsDirs,
            'validateSessionToken and reconcileInvoiceBatch across workspaces',
        );
        assert.ok(fused, 'expected fused multi-workspace retrieval result');
        assert.equal(fused.multiRoot, true);
        const pointers = (fused.hits || []).map((h) => h.pointer);
        assert.ok(pointers.some((p) => p.startsWith(`${basename(repoA)}/`)), `expected ${basename(repoA)} prefix in ${pointers}`);
        assert.ok(pointers.some((p) => p.startsWith(`${basename(repoB)}/`)), `expected ${basename(repoB)} prefix in ${pointers}`);

        const sid = trackAgySession(`w2-multi-${Date.now()}`);
        const captured = await handleAgyPreInvocation({
            conversationId: sid,
            workspacePaths: [repoA, repoB],
            cwd: repoA,
            prompt: 'Inspect validateSessionToken and reconcileInvoiceBatch before editing both.',
        }, { captureStdout: true });
        const sysMsg = extractSysMsg(captured);
        assert.ok(sysMsg.includes(basename(repoA)) || sysMsg.includes(basename(repoB)));

        const preOut = handleAgyPreTool({
            conversationId: sid,
            workspacePaths: [repoA, repoB],
            cwd: repoA,
            toolCall: {
                name: 'read_file',
                args: { Path: join(repoB, 'src', 'billingWorker.js') },
            },
        }, { captureStdout: true });
        const preParsed = JSON.parse(preOut);
        assert.equal(preParsed.decision, 'allow');

        handleAgyPostTool({
            conversationId: sid,
            workspacePaths: [repoA, repoB],
            cwd: repoA,
            toolCall: {
                name: 'read_file',
                args: { Path: join(repoB, 'src', 'billingWorker.js'), StartLine: 1, EndLine: 3 },
            },
        }, { captureStdout: true });
    });

    it('stages <=1800B execution handoff on exit_plan_mode for unread targets, skips seen targets, and guards [plan review]', async () => {
        const repo = await buildSampleRepo('plexer-test-w2-plan-', {
            'src/targetEngine.js': [
                'export function computePricingDelta(base, factor) {',
                '  const raw = base * factor;',
                '  return Math.round(raw * 100) / 100;',
                '}',
            ].join('\n') + '\n',
            'src/callerRoute.js': [
                'import { computePricingDelta } from "./targetEngine.js";',
                'export function handleQuoteRequest(req) {',
                '  return computePricingDelta(req.base, req.factor);',
                '}',
            ].join('\n') + '\n',
            'test/targetEngine.test.js': [
                'import { computePricingDelta } from "../src/targetEngine.js";',
                'computePricingDelta(10, 1.5);',
            ].join('\n') + '\n',
        });

        assert.equal(isSyntheticOrMetaPrompt('[plan review] Please review execution'), true);
        assert.equal(isSyntheticOrMetaPrompt('<SYSTEM_MESSAGE>internal</SYSTEM_MESSAGE>'), true);

        const freshState = emptyAgySession();
        const planText = '1. Update `computePricingDelta` in `src/targetEngine.js`.';
        const handoff = buildPlanExecutionHandoff([repo], planText, freshState);
        assert.ok(handoff?.text);
        assert.ok(Buffer.byteLength(handoff.text, 'utf8') <= 1800);
        assert.ok(handoff.text.includes('computePricingDelta'));
        assert.ok(handoff.text.includes('handleQuoteRequest'));

        // All targets already seen -> 0 B (null)
        const seenState = emptyAgySession();
        seenState.seenSpans = {
            'src/targetEngine.js': [[1, 10]],
            'src/callerRoute.js': [[1, 10]],
            'test/targetEngine.test.js': [[1, 10]],
        };
        assert.equal(buildPlanExecutionHandoff([repo], planText, seenState), null);

        // End-to-end exit_plan_mode PostToolUse -> PreInvocation consumption + seenSpans recording
        const sid = trackAgySession(`w2-plan-${Date.now()}`);
        writeAgySession(sid, emptyAgySession());
        handleAgyPostTool({
            conversationId: sid,
            workspacePaths: [repo],
            cwd: repo,
            toolCall: { name: 'exit_plan_mode', args: { plan: planText } },
        }, { captureStdout: true });

        const out = await handleAgyPreInvocation({
            conversationId: sid,
            workspacePaths: [repo],
            cwd: repo,
            prompt: '[plan review] status check',
        }, { captureStdout: true });
        const msg = extractSysMsg(out);
        assert.ok(msg.includes('[plexer] execution handoff'));
        assert.ok(msg.includes('computePricingDelta'));
    });

    it('runs live ensureFreshGraph drift repair in handleAgyPreInvocation and triggers onGraphRefreshed', async () => {
        const repo = await buildSampleRepo('plexer-test-w2-drift-', {
            'src/initialMod.js': 'export function originalFn() { return 1; }\n',
        });

        writeFileSync(
            join(repo, 'src', 'brandNewHelper.js'),
            'export function freshTelemetryHelper(x) {\n  return x * 2;\n}\n',
            'utf8',
        );

        const refreshedDirs = [];
        const sid = trackAgySession(`w2-drift-${Date.now()}`);
        const captured = await handleAgyPreInvocation({
            conversationId: sid,
            workspacePaths: [repo],
            cwd: repo,
            prompt: 'Where is `freshTelemetryHelper` defined and what does it return?',
        }, {
            captureStdout: true,
            onGraphRefreshed: (r) => refreshedDirs.push(resolve(r)),
        });

        assert.ok(refreshedDirs.includes(resolve(repo)), 'expected onGraphRefreshed to fire on live file addition');
        const msg = extractSysMsg(captured);
        assert.ok(msg.includes('freshTelemetryHelper'), `expected Turn-0 to index & retrieve new helper, got: ${msg}`);
    });

    it('builds live Session & Swarm Blast Graph detecting concurrent edit collisions and ignoring narrator/monitor', async () => {
        const repo = await buildSampleRepo('plexer-w2-swarm-', {
            'src/core.js': 'export function sharedCore(v) {\n  return v + 1;\n}\n',
            'src/caller.js': 'import { sharedCore } from "./core.js";\nexport function runCaller() { return sharedCore(2); }\n',
            'src/reader.js': 'export function readOnlyUtil() { return true; }\n',
        });

        const appData = makeTempDir('plexer-w2-appdata-');
        const sid = `w2-coord-${Date.now()}`;
        const worker1Id = `w2-alpha-${Date.now()}`;
        const worker2Id = `w2-beta-${Date.now()}`;
        const monitorId = `w2-mon-${Date.now()}`;

        mkdirSync(join(appData, 'brain', sid, '.system_generated', 'swarm'), { recursive: true });
        writeFileSync(join(appData, 'brain', sid, '.system_generated', 'swarm', 'members.json'), JSON.stringify({
            title: 'Wave 2 Swarm Test',
            members: {
                alpha: { conversation_id: worker1Id, role: 'worker', model: 'm1', state: 'working', workspace: 'share' },
                beta: { conversation_id: worker2Id, role: 'worker', model: 'm1', state: 'waiting', workspace: 'inherit' },
                narrator: { conversation_id: monitorId, role: 'narrator', state: 'waiting' },
                monitor: { conversation_id: monitorId, role: 'monitor', state: 'waiting' },
            },
        }));

        mkdirSync(join(appData, 'brain', worker1Id, '.system_generated', 'logs'), { recursive: true });
        writeFileSync(join(appData, 'brain', worker1Id, '.system_generated', 'logs', 'transcript.jsonl'), [
            JSON.stringify({
                tool_calls: [
                    { name: 'replace_file_content', args: { TargetFile: join(repo, 'src', 'core.js') } },
                    { name: 'view_file', args: { AbsolutePath: join(repo, 'src', 'reader.js') } },
                ],
            }),
        ].join('\n') + '\n');

        mkdirSync(join(appData, 'brain', worker2Id, '.system_generated', 'logs'), { recursive: true });
        writeFileSync(join(appData, 'brain', worker2Id, '.system_generated', 'logs', 'transcript.jsonl'), [
            JSON.stringify({
                tool_calls: [
                    { name: 'edit_file', args: { Path: join(repo, 'src', 'core.js') } },
                ],
            }),
        ].join('\n') + '\n');

        mkdirSync(join(appData, 'brain', monitorId, '.system_generated', 'logs'), { recursive: true });
        writeFileSync(join(appData, 'brain', monitorId, '.system_generated', 'logs', 'transcript.jsonl'), [
            JSON.stringify({ tool_calls: [{ name: 'write_file', args: { Path: join(repo, 'src', 'reader.js') } }] }),
        ].join('\n') + '\n');

        const swarm = discoverConversationSwarm(sid, repo, { appDataDirs: [appData] });
        assert.equal(swarm.workers.length, 2);
        assert.equal(swarm.workers.some((w) => w.name === 'narrator' || w.name === 'monitor'), false);

        const rev1 = computeSidecarRev({ repoRoot: repo, sid, appDataDirs: [appData] });
        assert.match(rev1, /^\d+:\d+:\d+$/);

        const cg = buildAgyContextGraph({ repoRoot: repo, sid, appDataDirs: [appData] });
        assert.equal(cg.meta.swarmTitle, 'Wave 2 Swarm Test');
        assert.equal(cg.meta.collisionCount, 1);

        const coreNode = cg.nodes.find((n) => n.relFile === 'src/core.js');
        assert.equal(coreNode?.type, 'collision');
        assert.deepEqual(coreNode.workers.map((w) => w.name).sort(), ['alpha', 'beta']);

        const callerNode = cg.nodes.find((n) => n.relFile === 'src/caller.js');
        assert.equal(callerNode?.type, 'affected');

        const readerNode = cg.nodes.find((n) => n.relFile === 'src/reader.js');
        assert.equal(readerNode?.type, 'retrieved');
    });

    it('serves full 4-tab viewer routes, jailed /api/source, and disk-free /api/treemap in sidecar & startVizServer', async () => {
        const repo = await buildSampleRepo('plexer-w2-viz-', {
            'src/sample.js': 'export function helloViz() {\n  return "ok";\n}\n',
            '.env': 'SECRET_TOKEN=hidden\n',
        });

        const appData = makeTempDir('plexer-w2-viz-app-');
        class MockResponse {
            constructor(body, init = {}) {
                this.body = body;
                this.contentType = init.contentType || 'text/plain';
                this.status = init.status ?? 200;
                this.headers = init.headers || {};
            }
        }
        const handlers = createSidecarHandlers({ ResponseClass: MockResponse, appDataDirs: [appData] });

        const indexResp = handlers.pages['/']();
        assert.equal(indexResp.status, 200);
        assert.ok(indexResp.body.includes('/preload.js'));
        assert.ok(indexResp.body.includes('id="tab-treemap"'));
        assert.ok(indexResp.body.includes('id="workspace-select"'));

        const jsResp = handlers.pages['/app.js']();
        assert.equal(jsResp.status, 200);
        assert.match(jsResp.contentType, /javascript/);

        const revResp = handlers.apis['/api/rev']({ ws: repo });
        assert.equal(resolve(revResp.repo), resolve(repo));
        assert.match(revResp.rev, /^\d+:\d+:\d+$/);

        const traversalResp = handlers.apis['/api/source']({ ws: repo, path: '../etc/passwd' });
        assert.equal(traversalResp.status, 403);

        const dotfileResp = handlers.apis['/api/source']({ ws: repo, path: '.env' });
        assert.equal(dotfileResp.status, 403);

        const goodSource = handlers.apis['/api/source']({ ws: repo, path: 'src/sample.js', span: 'L1-L3' });
        assert.equal(goodSource.status, 200);
        assert.ok(JSON.parse(goodSource.body).lines.some((l) => l.text.includes('helloViz')));

        const treemapResp = handlers.apis['/api/treemap']({ ws: repo });
        assert.equal(treemapResp.status, 200);
        assert.ok(treemapResp.body.includes('plexer-treemap-select'));
        assert.equal(existsSync(join(repo, 'plexer', '.health', 'treemap.html')), false);

        // Verify standalone startVizServer /api/treemap headers & zero disk write
        const srv = await startVizServer({ root: repo, contextDir: join(repo, 'plexer'), port: 0 });
        try {
            const tRes = await fetch(`${srv.url}/api/treemap`);
            assert.equal(tRes.status, 200);
            assert.equal(tRes.headers.get('x-frame-options'), 'SAMEORIGIN');
            assert.match(tRes.headers.get('content-security-policy') || '', /frame-ancestors 'self'/);
            const tHtml = await tRes.text();
            assert.ok(tHtml.includes('plexer-treemap-select'));
            assert.equal(existsSync(join(repo, 'plexer', '.health', 'treemap.html')), false);
        } finally {
            await srv.close();
        }
    });

    it('ignores ambient ANTIGRAVITY_PROJECT_DIR and ANTIGRAVITY_CONVERSATION_ID when payload provides workspacePaths and conversationId', async () => {
        const repo = await buildSampleRepo('plexer-w2-env-iso-', {
            'src/isolatedAuth.js': [
                'export function verifyIsolatedSession(token) {',
                '  return Boolean(token && token.startsWith("iso_"));',
                '}',
            ].join('\n') + '\n',
        });

        const sid = trackAgySession(`w2-env-iso-${Date.now()}`);
        const leakPath = agySessionPath('leak-check');
        rmSync(leakPath, { force: true });

        const prevProj = process.env.ANTIGRAVITY_PROJECT_DIR;
        const prevConv = process.env.ANTIGRAVITY_CONVERSATION_ID;
        process.env.ANTIGRAVITY_PROJECT_DIR = '/tmp';
        process.env.ANTIGRAVITY_CONVERSATION_ID = 'leak-check';
        try {
            assert.equal(resolveHostProjectDir({ workspacePaths: [repo] }), repo);
            assert.equal(resolveHostSessionId({ conversationId: sid }), sid);
            assert.equal(resolve(resolveAgyRepoDir({ workspacePaths: [repo] }, emptyAgySession())), resolve(repo));

            const out = await handleAgyPreInvocation({
                conversationId: sid,
                workspacePaths: [repo],
                cwd: repo,
                prompt: 'How does verifyIsolatedSession validate tokens?',
            }, { captureStdout: true });
            const msg = extractSysMsg(out);
            assert.ok(msg.includes('verifyIsolatedSession'), `expected retrieval from repo under ${sid}, got: ${msg}`);
            assert.equal(readAgySession(sid).lastProcessedPrompt !== null, true);
            assert.equal(existsSync(leakPath), false, 'ambient ANTIGRAVITY_CONVERSATION_ID session file must not be written');
        } finally {
            if (prevProj === undefined) delete process.env.ANTIGRAVITY_PROJECT_DIR;
            else process.env.ANTIGRAVITY_PROJECT_DIR = prevProj;
            if (prevConv === undefined) delete process.env.ANTIGRAVITY_CONVERSATION_ID;
            else process.env.ANTIGRAVITY_CONVERSATION_ID = prevConv;
        }
    });
});
