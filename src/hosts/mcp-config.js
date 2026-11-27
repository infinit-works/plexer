/**
 * Register the plexer MCP server in each host's config.
 * JSON hosts get a keyed merge (other servers preserved; unparseable files
 * are never rewritten). The TOML host gets an append-if-absent section.
 *
 * `mcpTargets()` is the pure "which files would this touch" half, so `plexer
 * init --dry-run` and the picker can report paths without writing;
 * `registerMcpConfigs()` walks that same list to do the writing.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BIN_LAUNCH, mergeJsonKey } from '../util/config-write.js';
import { dirExists } from '../util/fs.js';
export { BIN_LAUNCH, mergeJsonKey };
/**
 * CLI/skill hosts (`claude`, `agents`/Codex, `antigravity`, `gemini`) already
 * run the `plexer` CLI via `SKILL.md` / `AGENTS.md` / hooks, so MCP server
 * registration is opt-in (`--mcp` / `opts.mcp === true`) on those hosts.
 */
export const CLI_MCP_OPT_IN_HOSTS = new Set(['claude', 'agents', 'antigravity', 'gemini']);
function opencodeEntry() {
    const { command, args } = BIN_LAUNCH;
    return { type: 'local', command: [command, ...args], enabled: true };
}
/** The `[mcp_servers.plexer]` table header, as written and as matched. */
const TOML_HEADER = '[mcp_servers.plexer]';
/**
 * Remove the `[mcp_servers.plexer]` table from a TOML config, returning the rest.
 *
 * Line-based on purpose: a real parse-and-reserialize would reformat the user's
 * whole file. The table runs from its header to the next `[`-header or EOF, which
 * is exactly the shape {@link upsertCodexToml} appends. Exported so the writer and
 * `retract.js` can never disagree about what "plexer's section" means.
 */
const isPlexerTomlHeader = (line) => {
    const t = line.trim();
    return t === TOML_HEADER || (t.startsWith('[mcp_servers.plexer.') && t.endsWith(']'));
};

export function stripTomlSection(text) {
    const lines = text.split('\n');
    const kept = [];
    let found = false;
    let i = 0;
    while (i < lines.length) {
        if (isPlexerTomlHeader(lines[i])) {
            found = true;
            i += 1;
            while (i < lines.length && !lines[i].trimStart().startsWith('['))
                i += 1;
            continue;
        }
        kept.push(lines[i]);
        i += 1;
    }
    if (!found)
        return { rest: text, found: false };
    const rest = kept
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '');
    return { rest, found: true };
}
/**
 * Register plexer in a TOML config, replacing any existing section.
 *
 * Strips and re-appends the section so the launch command converges idempotently
 * while leaving foreign tables untouched.
 */
function upsertCodexToml(id, path) {
    const existed = existsSync(path);
    const text = existed ? readFileSync(path, 'utf8') : '';
    const { command, args } = BIN_LAUNCH;
    const argList = args.map((a) => JSON.stringify(a)).join(", ");
    const section = `${TOML_HEADER}\ncommand = ${JSON.stringify(command)}\nargs = [${argList}]\n`;
    const { rest, found } = stripTomlSection(text);
    // Byte-identical already: don't rewrite the file just to reorder it.
    if (found && text === appendSection(rest, section))
        return { id, path, action: 'unchanged' };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, appendSection(rest, section));
    return { id, path, action: existed ? 'updated' : 'created' };
}
/** Append a section after exactly one blank line, or at the top of an empty file. */
function appendSection(text, section) {
    if (text.trim() === '')
        return section;
    const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
    return `${text}${sep}${section}`;
}
function jsonTarget(hostId, id, path, topKey, entry, scope = 'repo') {
    return { hostId, id, path, scope, kind: 'mcp', what: `${topKey}.plexer`, format: 'json', topKey, entry };
}
/**
 * The MCP config files selecting these hosts would touch — pure, no writes.
 * Codex's target is the user-level `~/.codex/config.toml`, so it is scoped
 * 'global': registering there affects every project on the machine.
 */
export function mcpTargets(repo, ids, opts = {}) {
    const home = opts.home ?? homedir();
    const out = [];
    for (const id of ids) {
        switch (id) {
            case 'cursor':
                out.push(jsonTarget(id, id, join(repo, '.cursor', 'mcp.json'), 'mcpServers', BIN_LAUNCH));
                break;
            case 'gemini':
                out.push(jsonTarget(id, id, join(repo, '.gemini', 'settings.json'), 'mcpServers', BIN_LAUNCH));
                break;
            case 'antigravity':
                // Antigravity reads MCP from its own registry, separate from Gemini CLI's
                // `.gemini/settings.json` — a global `~/.gemini/config/mcp_config.json`.
                // Standard `{command,args}` under `mcpServers`. Global scope: it applies
                // to every workspace opened in Antigravity.
                out.push(jsonTarget(id, 'antigravity', join(home, '.gemini', 'config', 'mcp_config.json'), 'mcpServers', BIN_LAUNCH, 'global'));
                break;
            case 'kiro':
                out.push(jsonTarget(id, id, join(repo, '.kiro', 'settings', 'mcp.json'), 'mcpServers', BIN_LAUNCH));
                break;
            case 'grok':
                // Grok reads MCP from repo-level `.grok/config.toml` (`[mcp_servers.<name>]`),
                // the same TOML shape Codex uses at ~/.codex/config.toml.
                out.push({
                    hostId: id, id: 'grok', path: join(repo, '.grok', 'config.toml'),
                    scope: 'repo', kind: 'mcp', what: '[mcp_servers.plexer]', format: 'toml',
                });
                break;
            case 'copilot':
                out.push(jsonTarget(id, 'copilot', join(repo, '.vscode', 'mcp.json'), 'servers', { type: 'stdio', ...BIN_LAUNCH }));
                break;
            case 'windsurf':
                out.push(jsonTarget(id, 'windsurf', join(home, '.codeium', 'windsurf', 'mcp_config.json'), 'mcpServers', BIN_LAUNCH, 'global'));
                break;
            case 'opencode':
                out.push(jsonTarget(id, 'opencode', join(repo, 'opencode.json'), 'mcp', opencodeEntry()));
                break;
            case 'agents':
                // Guarded on the CLI actually being installed, so a plan only ever
                // lists files a real run would touch.
                if (dirExists(join(home, '.codex'))) {
                    out.push({
                        hostId: id, id: 'codex', path: join(home, '.codex', 'config.toml'),
                        scope: 'global', kind: 'mcp', what: '[mcp_servers.plexer]', format: 'toml',
                    });
                }
                break;
            default:
                break; // adal: no MCP target in this phase
        }
    }
    return out;
}
export function registerMcpConfigs(repo, ids, opts = {}) {
    return mcpTargets(repo, ids, opts)
        .filter((t) => opts.global !== false || t.scope !== 'global')
        .map((t) => t.format === 'toml'
        ? upsertCodexToml(t.id, t.path)
        : mergeJsonKey(t.id, t.path, t.topKey, t.entry));
}
