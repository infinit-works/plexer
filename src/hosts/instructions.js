/**
 * The one canonical Plexer instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */
export function instructionBody() {
    return `## Plexer — Repo Context Graph

This repo is indexed in \`plexer/\` with exact \`file:line\` symbol spans and precomputed call, import, and type edges (auto-refreshes uncommitted edits before each query).

Start with a single \`plexer\` command (or \`plexer_*\` MCP tool) in Turn 1 to get exact \`file:Lx-Ly\` spans and \`L<n>:\` source, then answer or edit directly:

- **Locate one or more subsystems, flows, or symptoms:** \`plexer ask "<query1>" ["<query2>" ...]\` (or \`plexer_find_code\`) — inlines contiguous \`L<n>:\` source by default for the top hits plus relevant same-file helpers, cross-file callees, module-level constants, and quoted \`call sites\` (\`--no-source\` for pointers only; \`--in <scope>/\` to narrow a monorepo). Even when a prompt names a target file or function, start with \`plexer ask\` or \`plexer callers\` in Turn 1 to get both the target's exact \`L<n>:\` span and all cross-file callers/usages in one call.
- **Trace callers, callees & refactor impact:** \`plexer callers <symbols...> [--depth 2]\` (or \`plexer_trace_calls\`) — accepts one or more symbols (\`check\`, \`UserService.login\`, \`Core:Destroy\`, \`auth.ts\`), shows every call site with \`[depth 2 via <sym>]\` provenance, and inlines target + depth-1/depth-2 caller source by default (\`--no-source\` for headers only; \`--direction out\` for callees; \`--depth all\` for full closure; \`plexer blast\` / \`plexer_blast\` for uncommitted diff impact). Untyped local receiver \`.method()\` / \`:Method()\` calls are same-file only (pair with \`plexer grep ".method" --fixed\` for cross-file instance method sites).
- **Read exact line spans across one or more files:** \`plexer read <file:Lx-Ly> [<file2:La-Lb> ...]\` (or \`plexer_read\`) — reads one or more \`file:Lx-Ly\` ranges or \`file:symbol\` spans (or unique basenames) with \`L<n>:\` line numbers in a single call.
- **Symbol-grouped regex or literal search:** \`plexer grep <patterns...>\` (or \`plexer_find_all\`) — inlines 2-line surrounding \`L<n>:\` context by default (\`--fixed\` for literal strings, \`-i\` case-insensitive, \`-C <n>\` or \`--no-source\`, \`--in <scope>/\`).
- **Skim one or more files' APIs (~200 tokens):** \`plexer skeleton <files...>\` (or \`plexer_file_api\`, \`--all-matches\` when ambiguous).
- **Cold repo orientation:** \`plexer map\` (or \`plexer_repo_map\`).
- **Zero redundant reads & fast surgical edits:** When \`plexer ask\`, \`plexer callers\`, \`plexer grep\`, or \`plexer read\` already shows the \`L<n>:\` lines you need, do not re-read them with \`view_file\` / \`Read\` / \`sed\` — cite or edit the \`file:Lx-Ly\` spans directly; never write \`python3\` or \`sed -i\` patch scripts in \`Bash\`, never dump whole files, and never pipe \`plexer\` output through \`head\` or \`tail\`.`;
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
