import { existsSync } from 'node:fs';
import { computeReadPreToolWidening, evaluateAgyPreTool, rewriteChainedPlexerCommand } from '../../agy/pre-tool.js';
import { pickRepoForTargetPath } from '../../agy/multi-workspace.js';
import { nearestPlexerRoot } from '../../graph/root.js';
import { contextDirFor } from '../../util/paths.js';
import { readStdin } from '../../util/state.js';
import {
    activeWorkspaceDirs, emitHookPayload, isEarlyIsolatedBenchCall, isIsolatedBenchDir,
    labelPrefixForRepo, loadAgyContext, readEngineSession, resolveHostProjectDir,
    resolveHostSessionId, resolveToolTargetPath, saveAgyContext, unquoteArg,
} from './agy-context.js';
import { handleAgyPreInvocation, handleSessionStartHook, handleTurn0Hook } from './turn0.js';
import { handleAgyPostEdit, handleAgyPostTool, handleAgyStop, handleHostPostTool, handleHostStopHook } from './post-tool.js';

function formatHostPreToolAllow(hostKind, updatedInput) {
    if (hostKind === 'gemini') {
        return { decision: 'allow', hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: updatedInput } };
    }
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput } };
}

export function handleAgyPreTool(input, opts = {}) {
    if (isEarlyIsolatedBenchCall(input, opts)) return emitHookPayload(`${JSON.stringify({ decision: 'allow' })}\n`, opts);
    const { sid, agyState, dir } = loadAgyContext(input, opts);
    const workspaceDirs = activeWorkspaceDirs(input, agyState, dir, opts);
    const targetPath = resolveToolTargetPath(input);
    const targetRepo = pickRepoForTargetPath(targetPath, workspaceDirs, dir);
    if (isIsolatedBenchDir(dir, opts.envFlags) || isIsolatedBenchDir(targetRepo, opts.envFlags)) {
        return emitHookPayload(`${JSON.stringify({ decision: 'allow' })}\n`, opts);
    }
    const result = evaluateAgyPreTool(input, {
        repoRoot: targetRepo,
        agyState,
        getGraph: opts.getGraph,
        relPrefix: labelPrefixForRepo(workspaceDirs, targetRepo),
        sessionId: sid,
    });
    saveAgyContext(sid, agyState, opts);
    return emitHookPayload(`${JSON.stringify(result)}\n`, opts);
}

export function handleHostPreTool(hostKind, input, opts = {}) {
    const rawDir = resolveHostProjectDir(input, opts.envFlags);
    const root = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    if (isIsolatedBenchDir(root, opts.envFlags)) return emitHookPayload('{}\n', opts);
    const toolName = String(input?.tool_name ?? input?.toolName ?? input?.toolCall?.name ?? '');
    const toolInput = input?.tool_input ?? input?.toolCall?.args ?? input?.args ?? {};
    const sid = resolveHostSessionId(input, opts.envFlags);

    if (/^(?:Bash|run_shell_command)$/i.test(toolName)) {
        const cmd = String(toolInput?.command ?? toolInput?.CommandLine ?? '');
        const rewritten = rewriteChainedPlexerCommand(cmd, sid);
        if (!rewritten) return emitHookPayload('{}\n', opts);
        return emitHookPayload(`${JSON.stringify(formatHostPreToolAllow(hostKind, { ...toolInput, command: rewritten }))}\n`, opts);
    }

    if (!/^(?:Read|read_file)$/i.test(toolName)) return emitHookPayload('{}\n', opts);
    const targetPath = unquoteArg(toolInput?.file_path ?? toolInput?.path ?? toolInput?.Path ?? '');
    const targetRepo = nearestPlexerRoot(targetPath || root)?.root ?? root;
    if (isIsolatedBenchDir(targetRepo, opts.envFlags) || !existsSync(contextDirFor(targetRepo))) return emitHookPayload('{}\n', opts);

    const agyState = readEngineSession(sid, opts);
    const widened = computeReadPreToolWidening(toolInput, targetRepo, agyState, { getGraph: opts.getGraph });
    saveAgyContext(sid, agyState, opts);
    if (!widened) return emitHookPayload('{}\n', opts);

    const updated = hostKind === 'gemini'
        ? { ...toolInput, start_line: widened.startLine, end_line: widened.endLine, offset: widened.startLine, limit: widened.limit }
        : { ...toolInput, offset: widened.startLine, limit: widened.limit };
    return emitHookPayload(`${JSON.stringify(formatHostPreToolAllow(hostKind, updated))}\n`, opts);
}

const EVENT_HANDLERS = {
    'agy-pre-invocation': (p, o) => handleAgyPreInvocation(p, o),
    'agy-pre-tool': (p, o) => handleAgyPreTool(p, o),
    'agy-post-tool': (p, o) => handleAgyPostTool(p, o),
    'agy-post-edit': (p, o) => handleAgyPostEdit(p, o),
    'agy-stop': (p, o) => handleAgyStop(p, o),
    'agy-post-cascade-response': (p, o) => handleAgyStop(p, o),
    'session-start': (p, o) => handleSessionStartHook(p, o),
    'prompt': (p, o) => handleTurn0Hook('claude', p, o),
    'user-prompt-submit': (p, o) => handleTurn0Hook('claude', p, o),
    'pre-tool-use': (p, o) => handleHostPreTool('claude', p, o),
    'claude-pre-tool': (p, o) => handleHostPreTool('claude', p, o),
    'post-tool': (p, o) => handleHostPostTool('claude', p, o),
    'post-tool-use': (p, o) => handleHostPostTool('claude', p, o),
    'post-edit': (p, o) => handleHostPostTool('claude', p, o),
    'post-edit-sync': (p, o) => handleHostPostTool('claude', p, o),
    'stop': (p, o) => handleHostStopHook(p, o),
    'gemini-before-agent': (p, o) => handleTurn0Hook('gemini', p, o),
    'gemini-before-tool': (p, o) => handleHostPreTool('gemini', p, o),
    'gemini-after-tool': (p, o) => handleHostPostTool('gemini', p, o),
    'cursor-before-submit': (p, o) => handleTurn0Hook('cursor', p, o),
    'cursor-after-file-edit': (p, o) => handleHostPostTool('cursor', p, o),
};

export async function dispatchHostEvent(event, input = undefined, opts = {}) {
    const payload = input !== undefined && input !== null ? input : readStdin();
    try {
        const handler = EVENT_HANDLERS[event];
        return handler ? await handler(payload, opts) : emitHookPayload('{}\n', opts);
    } catch {
        return emitHookPayload('{}\n', opts);
    }
}
