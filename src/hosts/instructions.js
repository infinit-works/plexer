/**
 * Canonical Plexer instruction blocks rendered into each host's native format.
 * Update shared behavioral rules in `canonicalCoreRules()` so every host stays
 * synchronized without leaking host-specific tool names.
 */
export function canonicalCoreRules() {
    return [
        'Start from Turn-0 `[plexer]` context instead of shell searches or file paging. Skip `plexer/SKILL.md` daily; load `plexer-health` only for `plexer health`.',
        '',
        '- **Zero-tool answers:** Cite Turn-0 `<n>:` spans and `call sites` (`file:Lx-Ly`) with 0 tool calls when sufficient.',
        '- **Edit-first, stop once green:** Edit localized `(named in prompt)` and `<n>:` spans directly without re-reading; skip `[seen: ...]`. Run one narrow check and stop.',
        '- **Batch & parallel:** Check `likely co-edits / tests` and `// other symbols`. Parallelize native file reads for medium/multi-file spans; use `plexer read` for compact targeted spans or symbol lookups, and parallelize edits/calls.',
    ].join('\n');
}

export function instructionBody() {
    return [
        '## Plexer Code Graph Rules',
        '',
        canonicalCoreRules(),
        '- **CLI / MCP:** `plexer read <file:sym|file:Lx-Ly ...>` (`plexer_read`), `ask "<q>" [--in dir]` (`plexer_find_code`), `callers|callees <syms...> [-d 2|all]` (`plexer_trace_calls`), `impact <syms...>` / `blast [--base ref]` (`plexer_blast`), `skeleton <files...>` (`plexer_file_api`), `grep "<pat>" [--in dir] [-F] [-i]` (`plexer_find_all`), `map` (`plexer_repo_map`).',
    ].join('\n');
}

export function antigravityPluginRules() {
    return [
        '# Plexer Code Graph Rules',
        '',
        canonicalCoreRules(),
        '- **Orchestrator / plan mode:** Answer Q&A in 0 calls; in plan mode never call `write_file`—localize once, keep `exit_plan_mode` concise (`file:Lx-Ly` spans and exact edit bullets, no full code reprints), then apply planned edits in 1 parallel turn.',
        '- **CLI:** `plexer read <file:sym|file:Lx-Ly ...>`, `ask "<q>" [--in dir]`, `callers|callees <syms...> [-d 2|all]`, `impact <syms...>`, `blast [--base ref]`, `skeleton <files...>`, `grep "<pat>" [--in dir] [-F] [-i]`, `map`.',
    ].join('\n');
}

export function cursorRule() {
    return `---
description: Use the Plexer context graph in plexer/ before exploring source
alwaysApply: true
---
${instructionBody()}
`;
}
export function kiroSteering() {
    return `---
inclusion: always
---
${instructionBody()}
`;
}
export function windsurfRule() {
    return `${instructionBody()}
`;
}
