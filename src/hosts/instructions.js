/**
 * The one canonical Plexer instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */
export function instructionBody() {
    return `## Plexer: Repo Context Graph

This repo is indexed in \`plexer/\` with exact \`file:line\` symbol spans and precomputed call, import, and type edges (uncommitted edits refresh automatically before each query).

Use Turn-0 \`[plexer]\` context first, or run one batched \`plexer\` command (or \`plexer_*\` MCP tool) in Turn 1 to get exact \`file:Lx-Ly\` spans and \`L<n>:\` source:

- **Batch into one call or one parallel turn:** Pass multiple \`<file:symbol|file:Lx-Ly>\` or \`<symbol>\` arguments in **one** \`plexer read\` or \`plexer callers\` call (or 1 parallel tool batch). Never serialize 1 query or file read per turn, and never re-run \`plexer ask\` on spans already inlined in Turn-0 \`[plexer]\` context.
- **Locate subsystems, flows, or symptoms:** \`plexer ask "<query1>" ["<query2>" ...]\` (or \`plexer_find_code\`) inlines contiguous \`L<n>:\` source for the top hits plus same-file helpers, cross-file callees, module constants, and quoted \`call sites\` (\`--no-source\` for pointers only; \`--in <scope>/\` to narrow a monorepo). When no Turn-0 block is present, start with \`plexer ask\` or \`plexer callers\` in Turn 1 to get both the target span and cross-file usages in one call.
- **Trace callers, callees, and refactor impact:** \`plexer callers <symbols...> [--depth 2]\` (or \`plexer_trace_calls\`) accepts multiple symbols (\`check\`, \`UserService.login\`, \`Core:Destroy\`, \`auth.ts\`), shows every call site with \`[depth 2 via <sym>]\` provenance, and inlines target and caller source (\`--no-source\` for headers only; \`--direction out\` for callees; \`--depth all\` for full closure; \`plexer blast\` / \`plexer_blast\` for uncommitted diff impact). Untyped local receiver \`.method()\` / \`:Method()\` calls are same-file only (pair with \`plexer grep ".method" --fixed\` for cross-file instance method sites).
- **Read exact spans across multiple files:** \`plexer read <file:symbol|file:Lx-Ly> [<file2:La-Lb> ...]\` (or \`plexer_read\`) returns \`L<n>:\` source for all requested symbols or line ranges in a single call.
- **Symbol-grouped regex or literal search:** \`plexer grep <patterns...>\` (or \`plexer_find_all\`) inlines 2-line surrounding \`L<n>:\` context (\`--fixed\` for literal strings, \`-i\` case-insensitive, \`-C <n>\` or \`--no-source\`, \`--in <scope>/\`).
- **Skim file APIs (~200 tokens) or repo layout:** \`plexer skeleton <files...>\` (or \`plexer_file_api\`, \`--all-matches\` when ambiguous); \`plexer map\` (or \`plexer_repo_map\`) for cold repo orientation.
- **Skip redundant reads and shell patchers:** When \`[plexer]\` or \`plexer\` output already shows the \`L<n>:\` lines you need, cite or edit those spans directly without re-opening the file. Never dump whole files, never pipe \`plexer\` output through \`head\` or \`tail\`, and never spawn \`python3\`, \`node\`, or \`sed -i\` scripts to edit files.`;
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
