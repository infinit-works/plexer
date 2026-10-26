/**
 * What `plexer init` *would* write, computed before anything is written.
 *
 * The picker and `--dry-run` both need the exact path list up front, so every
 * writer in the init path (instruction files, MCP configs, hooks, the Claude
 * Code layer) exposes a pure `*Targets()` function and then consumes that same
 * list to do its writing. One source of truth, so a plan can never drift from
 * what a real run touches.
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS, detectHosts } from './registry.js';
import { CLI_MCP_OPT_IN_HOSTS, mcpTargets } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeTargets } from '../claude/init.js';
import { claudeGlobalTargets } from './claude-global.js';
import { dirExists } from './config-write.js';
/** The instruction-file write for one host, derived from its registry entry. */
function instructionTarget(repo, host) {
    return {
        hostId: host.id,
        id: host.id,
        path: join(repo, host.relPath),
        scope: 'repo',
        kind: 'instruction',
        what: host.kind === 'owned' ? 'plexer-owned file' : 'fenced plexer section',
    };
}
/**
 * Every host plexer can wire, each with the full set of files selecting it would
 * touch. `ids`, when given, restricts the plan to those hosts.
 */
export function planInit(repo, opts = {}) {
    const home = opts.home ?? homedir();
    const detected = new Set(detectHosts(home, repo).map((h) => h.id));
    const claudeDetected = dirExists(join(home, '.claude')) || dirExists(join(repo, '.claude'));
    const plans = [
        { id: 'claude', name: 'Claude Code', detected: claudeDetected, writes: [...claudeTargets(repo), ...claudeGlobalTargets(home)] },
        ...HOSTS.map((host) => ({
            id: host.id,
            name: host.name,
            detected: detected.has(host.id),
            writes: [
                instructionTarget(repo, host),
                ...mcpTargets(repo, [host.id], { home }),
                ...(host.id === 'agents' ? hookTargets(home) : []),
                ...(host.id === 'antigravity' ? antigravitySkillTargets(home) : []),
            ],
        })),
    ];
    return opts.ids ? plans.filter((p) => opts.ids.includes(p.id)) : plans;
}
/** Flatten a plan down to the writes for the selected host ids and active flags. */
export function selectedWrites(plan, ids, opts = {}) {
    return plan
        .filter((p) => ids.includes(p.id))
        .flatMap((p) => p.writes)
        .filter((w) => {
        if (opts.global === false && w.scope === 'global')
            return false;
        if (w.kind === 'mcp') {
            if (opts.mcp === false)
                return false;
            if (opts.mcp !== true && CLI_MCP_OPT_IN_HOSTS.has(w.hostId))
                return false;
        }
        if (opts.hooks === false && w.kind === 'hook')
            return false;
        if (opts.skills === false && w.kind === 'skill')
            return false;
        return true;
    });
}
