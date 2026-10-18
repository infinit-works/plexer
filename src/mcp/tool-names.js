/**
 * The plexer MCP tool names, kept in a zero-import module so both the MCP server
 * (which also pulls in the whole engine) and the hooks (which must stay cheap
 * and engine-free) can share one list.
 */
/** The tools plexer advertises, as their canonical names. */
export const PLEXER_MCP_TOOL_CANONICAL = [
    'plexer_find_code',
    'plexer_find_all',
    'plexer_trace_calls',
    'plexer_file_api',
    'plexer_repo_map',
    'plexer_check_freshness',
];

