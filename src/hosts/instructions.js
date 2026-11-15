/**
 * The one canonical Plexer instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */
export function instructionBody() {
    return `## Plexer: Repo Context Graph

This repo is indexed in \`plexer/\` with exact \`file:line\` symbol spans and precomputed call, import, and type edges (uncommitted edits refresh automatically before each query).

Use Turn-0 \`[plexer]\` context first, or run one batched \`plexer\` command (or \`plexer_*\` MCP tool) in Turn 1 to get exact \`file:Lx-Ly\` spans and \`L<n>:\` source:

- **Batch without \`&&\` shell overflows:** Pass multiple \`<file:symbol|file:Lx-Ly>\` or \`<symbol>\` arguments in **one** \`plexer read\`, \`plexer callers\`, or \`plexer grep\` call, or issue **parallel** tool calls in a single turn. Never \`&&\`-chain multiple \`plexer\` commands in one shell call (combined output over ~10 KB truncates into a spill file), never serialize 1 query per turn, and never re-run \`plexer ask\` on spans already inlined in Turn-0 \`[plexer]\` context.
- **Locate subsystems, flows, or symptoms:** \`plexer ask "<query1>" ["<query2>" ...]\` (or \`plexer_find_code\`) inlines contiguous \`L<n>:\` source for the top hits plus same-file helpers, cross-file callees, module constants, and quoted \`call sites\` (\`--no-source\` for pointers only; \`--in <scope>/\` to narrow a monorepo). When no Turn-0 block is present, start with \`plexer ask\` or \`plexer callers\` in Turn 1 to get both the target span and cross-file usages in one call.
- **Trace callers, callees, and refactor impact:** \`plexer callers <symbols...> [--depth 2]\` (or \`plexer_trace_calls\`) accepts multiple symbols (\`check\`, \`UserService.login\`, \`Core:Destroy\`, \`auth.ts\`), shows every call site with \`[depth 2 via <sym>]\` provenance, resolves unique untyped \`.method()\` / \`:Method()\` callers across files, and lists any remaining unlinked lexical receiver sites automatically (\`--no-source\` for headers only; \`--direction out\` for callees; \`--depth all\` for full closure; \`plexer blast\` / \`plexer_blast\` for uncommitted diff impact).
- **Read targeted spans or large single files cleanly:** \`plexer read <file:symbol|file:Lx-Ly> [<file2:La-Lb> ...] [--full]\` (or \`plexer_read\`) merges overlapping ranges and returns \`L<n>:\` source across 1–6 targeted spans (\`<=200\` lines per file) in one ~9 KB call. When editing multiple regions of one file or needing \`>200\` lines of a single file, read that file once in parallel with your native file-read tool (\`read_file\`, \`view_file\`, \`Read\`) instead of slicing it across serial turns.
- **Symbol-grouped regex or literal search:** \`plexer grep <patterns...>\` (or \`plexer_find_all\`) inlines 2-line surrounding \`L<n>:\` context (\`--fixed\` for literal strings, \`-i\` case-insensitive, \`-C <n>\` or \`--no-source\`, \`--in <scope>/\`).
- **Skim file APIs (~200 tokens) or repo layout:** \`plexer skeleton <files...>\` (or \`plexer_file_api\`, \`--all-matches\` when ambiguous); \`plexer map\` (or \`plexer_repo_map\`) for cold repo orientation.
- **Skip redundant reads and shell patchers:** When \`[plexer]\` or \`plexer\` output already shows the \`L<n>:\` lines you need, cite or edit those spans directly without re-opening the file. Never pipe \`plexer\` output through \`head\` or \`tail\`, and never spawn \`python3\`, \`node\`, or \`sed -i\` scripts to edit files.`;
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
