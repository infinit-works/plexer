import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGraph } from '../src/graph/build.js';
import { loadGraphCached } from '../src/context/graph-store.js';
import { extractFile, languageOf, warmDepthGrammars } from '../src/graph/extract.js';
import { resolveEdges } from '../src/graph/resolve.js';
import { pinnedHits, resolveNamedDefinitions } from '../src/claude/pin.js';
import { formatBlastRadius } from '../src/claude/format.js';
import { ask } from '../src/ask/ask.js';
import { personalizedPageRank } from '../src/ask/graph-rank.js';
import {
    CLAUDE_NARROW_HOOK_BUDGETS,
    FAST_GEMINI_HOOK_BUDGETS,
    GEMINI_HOOK_BUDGETS,
    GEMINI_NARROW_HOOK_BUDGETS,
    HOOK_BUDGETS,
    isFastGeminiModelProfile,
    isNarrowPrompt,
    resolveHookBudgets,
} from '../src/hosts/engine/prompt/budget.js';
import { handleSessionStartHook } from '../src/hosts/engine/turn0.js';
import { dispatchHostEvent, handleHostPreTool } from '../src/hosts/engine/dispatcher.js';
import { handleHostPostTool } from '../src/hosts/engine/post-tool.js';
import { evaluateAgyPreTool, evaluateSearchAndGatePreTool } from '../src/agy/pre-tool.js';

describe('Track A Regressions & Large-Repo Fixes', () => {
    it('extracts Python class signals/fields, dotted bindings, chained attribute refs, and pins callers', async () => {
        await warmDepthGrammars([languageOf('a.py')]);
        const tmp = mkdtempSync(join(tmpdir(), 'plexer-py-sig-'));
        try {
            mkdirSync(join(tmp, 'pkg'), { recursive: true });
            writeFileSync(
                join(tmp, 'pkg', 'proc.py'),
                [
                    'class GUIProcess:',
                    '    error = pyqtSignal(int)',
                    '    def start(self, cmd):',
                    '        pass',
                ].join('\n') + '\n',
            );
            writeFileSync(
                join(tmp, 'pkg', 'editor.py'),
                [
                    'from . import proc',
                    'class Editor:',
                    '    def __init__(self):',
                    '        self._proc = None',
                    '    def launch(self):',
                    '        self._proc = proc.GUIProcess()',
                    '        self._proc.error.connect(self.on_err)',
                    '    def on_err(self, err):',
                    '        pass',
                ].join('\n') + '\n',
            );
            await buildGraph(tmp);
            const g = loadGraphCached(join(tmp, 'plexer'));
            const errField = g.nodes.find((n) => n.id === 'pkg/proc.py#GUIProcess.error');
            assert.ok(errField, 'GUIProcess.error field node must be extracted');
            assert.equal(errField.kind, 'field');
            assert.equal(errField.owner, 'GUIProcess');

            const refEdge = g.edges.find(
                (e) => e.source === 'pkg/editor.py#Editor.launch' && e.target === 'pkg/proc.py#GUIProcess.error' && e.relation === 'references',
            );
            assert.ok(refEdge, 'chained self._proc.error.connect must resolve references edge to GUIProcess.error');

            const pins = pinnedHits(tmp, g, 'Rename `GUIProcess.error` signal to `error_occurred`', { budgetBytes: 4000, contiguous: true });
            assert.equal(pins.length, 1);
            assert.match(pins[0].code, /caller in pkg\/editor\.py:L\d+-L\d+/);
            assert.ok(pins[0].code.includes('self._proc.error.connect'));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('extracts and pins multi-segment CommonJS namespace methods like SocketUser.reset.send', async () => {
        await warmDepthGrammars([languageOf('a.js')]);
        const ex = extractFile(
            'src/socket.io/user.js',
            [
                'const SocketUser = {};',
                'SocketUser.reset = {};',
                'SocketUser.reset.send = async function (socket, email) {',
                '    return email;',
                '};',
                'module.exports = SocketUser;',
            ].join('\n'),
        );
        const methodNode = ex.nodes.find((n) => n.id === 'src/socket.io/user.js#SocketUser.reset.send');
        assert.ok(methodNode, 'dotted namespace method must retain SocketUser.reset owner');
        assert.equal(methodNode.owner, 'SocketUser.reset');
        assert.equal(methodNode.kind, 'method');

        const pins = resolveNamedDefinitions({ nodes: ex.nodes, edges: resolveEdges(ex.nodes, ex.rawEdges) }, 'Check `SocketUser.reset.send` behavior');
        assert.equal(pins.length, 1);
        assert.equal(pins[0].node.id, 'src/socket.io/user.js#SocketUser.reset.send');
    });

    it('emits contiguous verbatim slices on editEnvelope without mid-body omitted gaps', async () => {
        await warmDepthGrammars([languageOf('a.ts')]);
        const tmp = mkdtempSync(join(tmpdir(), 'plexer-edit-slice-'));
        try {
            mkdirSync(join(tmp, 'src'), { recursive: true });
            const lines = ['export function longMigrate(input: string) {'];
            for (let i = 1; i <= 75; i++) {
                lines.push(i === 58 ? '    const targetEncryptionKey = input.trim();' : `    const step_${i} = ${i};`);
            }
            lines.push('    return targetEncryptionKey;', '}');
            writeFileSync(join(tmp, 'src', 'migrate.ts'), lines.join('\n') + '\n');
            await buildGraph(tmp);

            const res = ask(tmp, 'Update longMigrate targetEncryptionKey trimming', { source: true, editEnvelope: true });
            assert.ok(res.hits.length > 0 && res.hits[0].code);
            assert.equal(res.hits[0].code.includes('omitted)'), false, 'editEnvelope must not emit gapped omitted markers');
            assert.ok(res.hits[0].code.includes('targetEncryptionKey'));
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('allocates fair per-file pin budget across distinct target files without starvation', () => {
        const tmp = mkdtempSync(join(tmpdir(), 'plexer-fair-pin-'));
        try {
            mkdirSync(join(tmp, 'src'), { recursive: true });
            const bodyA = ['export function alphaHandler(x) {', ...Array.from({ length: 35 }, (_, i) => `    const lineA_${i} = x + ${i};`), '    return lineA_0;', '}'].join('\n');
            const bodyB = ['export function betaHandler(y) {', ...Array.from({ length: 20 }, (_, i) => `    const lineB_${i} = y + ${i};`), '    return lineB_0;', '}'].join('\n');
            writeFileSync(join(tmp, 'src', 'a.js'), bodyA + '\n');
            writeFileSync(join(tmp, 'src', 'b.js'), bodyB + '\n');
            const graph = {
                nodes: [
                    { id: 'src/a.js', kind: 'file', path: 'src/a.js', span: 'L1-L38' },
                    { id: 'src/a.js#alphaHandler', name: 'alphaHandler', kind: 'function', path: 'src/a.js', span: 'L1-L38', exported: true },
                    { id: 'src/b.js', kind: 'file', path: 'src/b.js', span: 'L1-L23' },
                    { id: 'src/b.js#betaHandler', name: 'betaHandler', kind: 'function', path: 'src/b.js', span: 'L1-L23', exported: true },
                ],
                edges: [],
            };
            const hits = pinnedHits(tmp, graph, 'Update `alphaHandler` and `betaHandler`', { budgetBytes: 1500, maxPins: 3, contiguous: true });
            const paths = new Set(hits.map((h) => h.pointer.split(':')[0]));
            assert.equal(paths.has('src/a.js'), true);
            assert.equal(paths.has('src/b.js'), true, 'second pinned file must not be starved by first file');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('resolves Fast-Gemini and Claude-Narrow budgets while keeping GEMINI_HOOK_BUDGETS intact', () => {
        assert.equal(isFastGeminiModelProfile({ modelName: 'gemini-4-hydrogen-medium' }), true);
        assert.equal(isFastGeminiModelProfile({ modelName: 'gemini-3-flash' }), true);
        assert.equal(isFastGeminiModelProfile({ modelName: 'orchestrator-neon-high-hydrogen-high' }), false);
        assert.equal(isFastGeminiModelProfile({ modelName: 'gemini-4-neon-medium' }), false);

        assert.equal(isNarrowPrompt('Fix timeout check in `timeoutFor`'), true);
        assert.equal(
            isNarrowPrompt(
                'Working directory: /tmp/plexer-ab/repo\n\nFix timeout check in `timeoutFor`.\n\nConstraints:\n- Keep changes minimal.\n- Run tests to verify all checks.',
            ),
            true,
            'boilerplate preambles must not disqualify short single-target narrow prompts',
        );
        assert.equal(isNarrowPrompt('Update all callers across the repo for `timeoutFor`'), false);

        assert.equal(resolveHookBudgets({ geminiProfile: true, narrowPrompt: true }), GEMINI_NARROW_HOOK_BUDGETS);
        assert.equal(resolveHookBudgets({ geminiProfile: true, fastProfile: true }), FAST_GEMINI_HOOK_BUDGETS);
        assert.equal(resolveHookBudgets({ geminiProfile: true, xhighProfile: false }), GEMINI_HOOK_BUDGETS);
        assert.equal(resolveHookBudgets({ geminiProfile: false, narrowPrompt: true }), CLAUDE_NARROW_HOOK_BUDGETS);
        assert.equal(resolveHookBudgets({ geminiProfile: false, narrowPrompt: false }), HOOK_BUDGETS);
    });

    it('suppresses SessionStart orientation, Claude shell rewrites, and Turn-6 Orchestrator planning hard-deny', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'plexer-hooks-a-'));
        try {
            mkdirSync(join(tmp, 'src'), { recursive: true });
            mkdirSync(join(tmp, 'plexer', '.cache'), { recursive: true });
            writeFileSync(join(tmp, 'src', 'mod.js'), 'export function foo() { return 1; }\n');
            await buildGraph(tmp);

            const ssOut = await handleSessionStartHook({ cwd: tmp, session_id: 's1' }, { captureStdout: true });
            assert.equal(ssOut, '');

            const agyState = {
                isEditPrompt: true,
                editedInPrompt: false,
                preEditToolTurns: 7,
                lastObservedModel: 'orchestrator-neon-xhigh-hydrogen-xhigh',
                editTargetFiles: ['src/mod.js'],
                seenSpans: { 'src/mod.js': [[1, 1]] },
            };
            const preRes = evaluateAgyPreTool(
                { toolCall: { name: 'grep_search', args: { Query: 'foo', SearchPath: tmp } } },
                { repoRoot: tmp, agyState, geminiProfile: true },
            );
            assert.equal(preRes.decision, 'allow', 'unconfirmed high/xhigh Orchestrator Turn-6 gate must soft-allow');
            assert.match(preRes.additionalContext, /Exploration budget reached/);

            const claudeShell = evaluateAgyPreTool(
                { toolCall: { name: 'Bash', args: { command: 'sed -n "1,5p" src/mod.js' } } },
                { repoRoot: tmp, agyState: {}, geminiProfile: false, hostKind: 'claude' },
            );
            assert.equal(claudeShell.decision, 'allow');
            assert.match(String(claudeShell.overwrite?.command ?? ''), /(?:\bplexer|plexer\.js['"]?)\s+read\b/, 'Claude profile must rewrite shell file-slice reads to plexer read');

            const claudeGate = evaluateSearchAndGatePreTool({
                toolName: 'Bash',
                toolArgs: { command: "sed -i 's/1/2/' src/mod.js" },
                repoRoot: tmp,
                agyState: {},
                geminiProfile: false,
                getGraph: () => ({ nodes: [{ id: 'src/mod.js', path: 'src/mod.js', kind: 'file', span: 'L1-L1' }], edges: [] }),
            });
            assert.equal(claudeGate, null);

            const g = {
                nodes: [
                    { id: 'src/a.js', kind: 'file', path: 'src/a.js', span: 'L1-L2' },
                    { id: 'src/a.js#x', name: 'x', kind: 'function', path: 'src/a.js', span: 'L1-L2' },
                    { id: 'src/b.js', kind: 'file', path: 'src/b.js', span: 'L1-L2' },
                    { id: 'src/b.js#y', name: 'y', kind: 'function', path: 'src/b.js', span: 'L1-L2' },
                ],
                edges: [{ source: 'src/b.js#y', target: 'src/a.js#x', relation: 'calls' }],
            };
            formatBlastRadius(g, 'src/a.js', 8, tmp);
            assert.ok(g._basenameCounts instanceof Map, 'formatBlastRadius must cache _basenameCounts');

            const pr = personalizedPageRank(g, new Map([['src/a.js#x', 1]]));
            assert.ok((pr.get('src/b.js#y') ?? 0) > 0, 'sparse PPR must propagate along incoming call edge');
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});
