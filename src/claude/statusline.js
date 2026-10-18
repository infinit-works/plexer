import { renderStatusline, renderSubagent } from './format.js';
import { nearestPlexerRoot } from '../graph/root.js';
import {
    readStats,
    readSession,
    emptyStats,
    readWiring,
    computeStats,
    readStdin,
    projectDir,
} from '../util/state.js';
/**
 * The statusline's fast path is the hook-maintained cache (plexer/.cache/stats.json).
 * When it's absent — a fresh checkout, or a plain `plexer build` that doesn't write the
 * cache — fall back to reading the graph itself (wiring.json) so the bar reflects reality
 * immediately instead of showing "not built". An empty wiring.json is still a graph
 * (docs-only repos legitimately have 0 nodes); "not built" is only when the artifact
 * is missing. The graph carries no drift signal, so it reads as synced until the next
 * edit repopulates the cache. Still a pure read (no subprocess): the cache is preferred
 * because it carries live dirty/stale state.
 */
export function resolveStats(dir) {
    const cached = readStats(dir);
    if (cached && cached.nodeCount > 0)
        return cached;
    const wiring = readWiring(dir);
    if (wiring)
        return { ...emptyStats(), ...(cached ?? {}), ...computeStats(wiring) };
    return cached ?? null;
}
export function main() {
    const input = readStdin();
    const rawDir = projectDir(input);
    const dir = nearestPlexerRoot(rawDir)?.root ?? rawDir;
    const agent = input?.agent?.name;
    if (agent) {
        const session = readSession(dir, input.session_id || 'default');
        process.stdout.write(renderSubagent(agent, session));
        return;
    }
    const stats = resolveStats(dir);
    const raw = input?.context_window?.used_percentage;
    const usedPct = typeof raw === 'number' ? Math.round(raw) : null;
    process.stdout.write(renderStatusline(stats, { usedPct }).join('\n'));
}
