/**
 * Evaluates repository dependency cycles and applies penalty weights against
 * configured health thresholds.
 */
export function findDependencyCycles(adjacency) {
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function dfs(node, trail) {
    if (visiting.has(node)) {
      const start = trail.indexOf(node);
      if (start >= 0) cycles.push(trail.slice(start));
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of adjacency[node] || []) {
      dfs(next, [...trail, next]);
    }
    visiting.delete(node);
    visited.add(node);
  }

  for (const key of Object.keys(adjacency)) {
    if (!visited.has(key)) dfs(key, [key]);
  }
  return cycles;
}

export function evaluateHealth(metrics, thresholds = { maxCycles: 0, maxStale: 5 }) {
  let score = 100;
  if (metrics.cycleCount > thresholds.maxCycles) {
    score -= (metrics.cycleCount - thresholds.maxCycles) * 15;
  }
  if (metrics.staleSymbols > thresholds.maxStale) {
    score -= (metrics.staleSymbols - thresholds.maxStale) * 4;
  }
  return { score: Math.max(0, score), healthy: score >= 80 };
}
