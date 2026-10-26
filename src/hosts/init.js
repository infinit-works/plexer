/**
 * Multi-host init: write each selected host's instruction file.
 * Selection = explicit ids > all > detected. Claude Code is handled
 * separately by src/claude/init.js (hooks + statusline + skill).
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildGraphIfMissing } from '../claude/init.js';
import { HOSTS, detectHosts } from './registry.js';
import { upsertSection } from './sections.js';
import { CLI_MCP_OPT_IN_HOSTS, registerMcpConfigs } from './mcp-config.js';
import { installCodexHooks } from './codex-hooks.js';
import { installAntigravitySkill } from './antigravity.js';
import { writeOwned } from './config-write.js';
export { buildGraphIfMissing };
export function runHostsInit(repo, opts = {}) {
    const home = opts.home ?? homedir();
    let selected;
    let unknown = [];
    if (opts.agents !== undefined) {
        const byId = new Map(HOSTS.map((h) => [h.id, h]));
        selected = opts.agents.flatMap((id) => byId.get(id) ?? []);
        unknown = opts.agents.filter((id) => !byId.has(id));
    }
    else if (opts.all) {
        selected = HOSTS;
    }
    else {
        selected = detectHosts(home, repo);
    }
    const written = [];
    for (const host of selected) {
        const path = join(repo, host.relPath);
        let action;
        if (host.kind === 'owned') {
            const res = writeOwned(host.id, path, host.content());
            action = res.action === 'updated' ? 'replaced' : res.action;
        }
        else {
            action = upsertSection(path, host.content()).action;
        }
        written.push({ id: host.id, path, action });
    }
    const skipped = HOSTS.filter((h) => !selected.includes(h)).map((h) => h.id);
    const mcpHostIds = opts.mcp === false
        ? []
        : selected
            .map((h) => h.id)
            .filter((id) => opts.mcp === true || !CLI_MCP_OPT_IN_HOSTS.has(id));
    const mcp = mcpHostIds.length === 0
        ? []
        : registerMcpConfigs(repo, mcpHostIds, { home, global: opts.global });
    // The Codex hook targets are user-level (~/.codex), so --no-global suppresses them.
    const hooks = opts.hooks === false || opts.global === false || !selected.some((h) => h.id === 'agents')
        ? []
        : installCodexHooks(home);
    // Antigravity's skill is a global write too, so --no-global suppresses it as well.
    const antigravitySkill = opts.global === false || !selected.some((h) => h.id === 'antigravity')
        ? []
        : installAntigravitySkill(home, { hooks: opts.hooks, skills: opts.skills });
    return { written, skipped, unknown, mcp, hooks: [...hooks, ...antigravitySkill] };
}
