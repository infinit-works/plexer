/**
 * Subagent prompt normalization and sandbox posture detection for Antigravity.
 */

const BOILERPLATE_LINE_RE = /^(?:\s*[-*]?\s*(?:Output contract|Assigned paths?|Deliverables?|Coordination|Messaging|Communication|Swarm protocol|Reporting|Workflow step|Stage)\s*:|\s*(?:Do not edit outside|Never modify files outside|Call `?(?:send_message|invoke_subagent|run_workflow)`?|Use `?(?:send_message)`? to|You must call `?send_message`?|Return a concise summary|Report back to|End your turn by))/i;

const INLINE_BOILERPLATE_RE = /\b(?:use|call)\s+`?(?:send_message|run_workflow)`?\b[^.\n]*(?:\.|$)/gi;

const READ_ONLY_SANDBOX_RE = /\b(?:read-only sandbox|without `?(?:run_command|shell)`?|no (?:shell|command|terminal) tool|cannot run commands|you do not have `?(?:run_command)`?)\b/i;

/**
 * Strip delegation and swarm orchestration scaffolding from subagent prompts before
 * Turn-0 query distillation while keeping explicit file paths and symbol names.
 */
export function stripSubagentBoilerplate(prompt) {
    if (!prompt || typeof prompt !== 'string')
        return '';

    let text = prompt
        .replace(/<\/?(?:SUBAGENT_BRIEF|SWARM_BRIEF|ASSIGNMENT|TASK_CONTEXT|WORKFLOW_STEP)>/gi, '\n')
        .replace(INLINE_BOILERPLATE_RE, ' ');

    const keptLines = [];
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trim();
        if (!line)
            continue;
        if (BOILERPLATE_LINE_RE.test(line)) {
            // Preserve explicit file paths or backticked symbols named on assignment lines.
            const refs = [];
            for (const m of line.matchAll(/`([^`]+)`|([A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8}(?::[A-Za-z0-9_.-]+)?)/g)) {
                const tok = m[1] || m[2];
                if (tok && !/^(?:send_message|run_command|read_file|edit_file|invoke_subagent)$/i.test(tok))
                    refs.push(tok);
            }
            if (refs.length > 0)
                keptLines.push(refs.join(' '));
            continue;
        }
        keptLines.push(rawLine);
    }

    const collapsed = keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return collapsed || prompt.trim();
}

/**
 * True when the hook payload indicates a read-only subagent that lacks `run_command`.
 */
export function isReadOnlySubagentInput(input, rawPrompt = '') {
    if (input?.readOnly === true || input?.readonly === true || input?.sandboxMode === 'read-only')
        return true;
    const agent = String(input?.agentName ?? input?.agent_name ?? input?.subagentType ?? input?.mode ?? '').trim().toLowerCase();
    if (agent === 'research' || agent === 'ask' || agent === 'plan' || agent === 'code-reviewer' || agent === 'reviewer')
        return true;
    const tools = Array.isArray(input?.tools) ? input.tools.map((t) => String(t).toLowerCase()) : null;
    if (tools && !tools.some((t) => /^(?:run_command|bash|shell|run_shell_command|execute_command)$/.test(t)))
        return true;
    return READ_ONLY_SANDBOX_RE.test(String(rawPrompt || ''));
}

/**
 * Remove CLI command suggestions from Turn-0 output when the subagent has no shell access.
 */
export function stripCliNudges(text) {
    if (!text || typeof text !== 'string')
        return text;
    return text
        .replace(/\n\s*… \+\d+ more — run `plexer callers [^`\n]+`/g, '')
        .replace(/ — run `plexer [^`\n]+`/g, '')
        .replace(/\s*\([^)\n]*`plexer [^)\n]*\)/g, '')
        .replace(/\s*Run `plexer [^`\n]+`\./g, '');
}
