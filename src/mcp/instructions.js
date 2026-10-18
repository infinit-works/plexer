/**
 * The `instructions` string returned in plexer's MCP `initialize` response.
 *
 * This is the one piece of plexer prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which plexer's six arrived as
 * six bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; plexer used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads all six tools for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget plexer gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */
import { PLEXER_MCP_TOOL_CANONICAL } from './tool-names.js';
/** The `select:` argument that loads every plexer tool in one lookup. */
export function toolSearchQuery() {
    return `select:${PLEXER_MCP_TOOL_CANONICAL.map((t) => `mcp__plexer__${t}`).join(',')}`;
}
export function mcpInstructions() {
    return [
        'This repo is indexed by plexer (exact file:line spans + call/import/type edges; auto-refreshes uncommitted edits). Use plexer to get inlined L<n>: source and call edges first; do not re-read spans already shown in tool output.',
        '',
        `**If these tools are deferred (names shown, schemas withheld), load them all in ONE lookup:** ToolSearch "${toolSearchQuery()}" — never one at a time.`,
        '',
        '- plexer_find_code — locate + understand a flow: ranked hits with L<n>: source, same-file helpers, and constants inlined.',
        '- plexer_trace_calls — callers, callees (direction:"out"), and blast radius (depth:2 or "all", source:true for call-site source).',
        '- plexer_find_all — regex/literal search grouped by symbol (fixed:true, context:3 or source:true).',
        '- plexer_file_api — signatures-only file API in ~200 tokens.',
        '- plexer_repo_map — directory clusters, hubs, and hotspots.',
        '- plexer_check_freshness — report whether the graph is in sync with the working tree.',
    ].join('\n');
}
