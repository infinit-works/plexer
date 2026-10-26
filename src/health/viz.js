/**
 * Codebase health visualizations:
 * 1. `plexer health tree` — Annotated LLM-readable directory/file tree with LOC, fan-in/fan-out, and open issues.
 * 2. `plexer health viz` — Self-contained interactive HTML treemap (`plexer/.health/treemap.html`).
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { computeInDegree } from "../graph/relations.js";
import { computeOutDegree } from "./concerns.js";
import { computeScoreSnapshot } from "./scoring.js";
import { healthDir } from "./state.js";
import { SCORED_ZONES } from "./zones.js";

/**
 * Build a hierarchical directory/file tree structure from `graph`, `state`, and `readLines`.
 */
function insertFileIntoHealthTree(root, node, zone, loc, fanIn, fanOut, fileIssues) {
    const parts = node.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let cur = root;
    cur.loc += loc;
    cur.file_count += 1;
    cur.open_issues += fileIssues.length;
    cur.fan_in += fanIn;
    cur.fan_out += fanOut;

    for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        const subPath = parts.slice(0, i + 1).join("/");

        if (isLast) {
            cur.childrenMap.set(part, {
                name: part,
                path: subPath,
                kind: "file",
                zone,
                loc,
                file_count: 1,
                open_issues: fileIssues.length,
                fan_in: fanIn,
                fan_out: fanOut,
                issues: fileIssues.map((iss) => ({
                    id: iss.id,
                    detector: iss.detector,
                    tier: iss.tier,
                    severity: iss.severity,
                    span: iss.span,
                    summary: iss.summary,
                })),
            });
        } else {
            let nextDir = cur.childrenMap.get(part);
            if (!nextDir) {
                nextDir = {
                    name: part,
                    path: subPath,
                    kind: "dir",
                    loc: 0,
                    file_count: 0,
                    open_issues: 0,
                    fan_in: 0,
                    fan_out: 0,
                    childrenMap: new Map(),
                };
                cur.childrenMap.set(part, nextDir);
            }
            nextDir.loc += loc;
            nextDir.file_count += 1;
            nextDir.open_issues += fileIssues.length;
            nextDir.fan_in += fanIn;
            nextDir.fan_out += fanOut;
            cur = nextDir;
        }
    }
}

function mapTreeToPlain(node) {
    const { childrenMap, ...rest } = node;
    if (!childrenMap) return rest;
    const children = [...childrenMap.values()].map(mapTreeToPlain);
    return { ...rest, children };
}

/**
 * Build a hierarchical directory/file tree structure from `graph`, `state`, and `readLines`.
 */
export function buildHealthTreeData(graph, state, zoneMap, readLines) {
    const inDeg = computeInDegree(graph);
    const outDeg = computeOutDegree(graph);

    const issuesByFile = new Map();
    for (const iss of Object.values(state.issues || {})) {
        if (iss.status !== "open") continue;
        const f = iss.file || "repo";
        let arr = issuesByFile.get(f);
        if (!arr) {
            arr = [];
            issuesByFile.set(f, arr);
        }
        arr.push(iss);
    }

    const root = {
        name: ".",
        path: ".",
        kind: "dir",
        loc: 0,
        file_count: 0,
        open_issues: 0,
        fan_in: 0,
        fan_out: 0,
        childrenMap: new Map(),
    };

    for (const node of graph.nodes) {
        if (node.kind !== "file") continue;
        const zone = zoneMap.get(node.path) || "production";
        if (!SCORED_ZONES.has(zone) && zone !== "test") continue;

        const lines = readLines ? readLines(node.path) || [] : [];
        const loc = Math.max(1, lines.length);
        const fanIn = inDeg.get(node.id) || 0;
        const fanOut = outDeg.get(node.id) || 0;
        const fileIssues = issuesByFile.get(node.path) || [];
        insertFileIntoHealthTree(root, node, zone, loc, fanIn, fanOut, fileIssues);
    }

    return mapTreeToPlain(root);
}

/**
 * Render an LLM-readable annotated text tree (`plexer health tree`).
 */
export function generateHealthTreeText(graph, state, zoneMap, readLines, opts = {}) {
    const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : 3;
    const minLoc = Number(opts.minLoc) > 0 ? Number(opts.minLoc) : 0;
    const sortBy = opts.sort || "loc";
    const detail = Boolean(opts.detail);

    let root = buildHealthTreeData(graph, state, zoneMap, readLines);

    if (opts.focus) {
        const parts = String(opts.focus)
            .replace(/\\/g, "/")
            .replace(/^\/+|\/+$/g, "")
            .split("/")
            .filter(Boolean);
        for (const p of parts) {
            const found = (root.children || []).find((c) => c.name === p);
            if (!found) {
                return `Directory not found in health tree: ${opts.focus}`;
            }
            root = found;
        }
    }

    const sortChildren = (children = []) => {
        return [...children].sort((a, b) => {
            if (sortBy === "issues") {
                return b.open_issues - a.open_issues || b.loc - a.loc || a.name.localeCompare(b.name);
            }
            if (sortBy === "coupling") {
                return b.fan_in + b.fan_out - (a.fan_in + a.fan_out) || b.loc - a.loc;
            }
            return b.loc - a.loc || b.open_issues - a.open_issues || a.name.localeCompare(b.name);
        });
    };

    const lines = [
        `plexer health tree (${root.path}) — ${root.file_count} files · ${root.loc} LOC · ${root.open_issues} open findings`,
    ];

    function renderTreeNode(node, prefix, depth) {
        if (depth > maxDepth) return;
        const children = sortChildren(node.children || []).filter((c) => c.loc >= minLoc);
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const isLast = i === children.length - 1;
            const branch = isLast ? "└── " : "├── ";
            const nextPrefix = prefix + (isLast ? "    " : "│   ");

            if (child.kind === "dir") {
                const issueTag = child.open_issues > 0 ? ` · ⚠ ${child.open_issues} open` : " · ✓ clean";
                lines.push(
                    `${prefix}${branch}${child.name}/ (${child.file_count} files, ${child.loc} LOC${issueTag})`,
                );
                renderTreeNode(child, nextPrefix, depth + 1);
            } else {
                const issueTag =
                    child.open_issues > 0 ? ` · ⚠ ${child.open_issues} open` : "";
                const couplingTag =
                    child.fan_in > 0 || child.fan_out > 0
                        ? ` · ←${child.fan_in} →${child.fan_out}`
                        : "";
                lines.push(
                    `${prefix}${branch}${child.name} (${child.loc} LOC${couplingTag}${issueTag})`,
                );
                if (detail && Array.isArray(child.issues) && child.issues.length > 0) {
                    for (const iss of child.issues.slice(0, 5)) {
                        lines.push(
                            `${nextPrefix}  • [${iss.tier} · ${iss.detector}] ${iss.span}: ${iss.summary}`,
                        );
                    }
                }
            }
        }
    }

    renderTreeNode(root, "", 1);
    return lines.join("\n");
}

const TREEMAP_CSS = `
  :root { --bg: #0f172a; --panel: #1e293b; --border: #334155; --text: #f8fafc; --muted: #94a3b8; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; padding: 20px; }
  header { display: flex; justify-content: space-between; align-items: center; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 14px 18px; margin-bottom: 16px; }
  .badges { display: flex; gap: 12px; font-size: 13px; }
  .badge { padding: 4px 10px; border-radius: 6px; background: #0f172a; border: 1px solid var(--border); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; }
  .tile { border-radius: 6px; padding: 10px 12px; border: 1px solid rgba(255,255,255,0.12); display: flex; flex-direction: column; justify-content: space-between; min-height: 76px; }
  .tile-clean { background: rgba(16, 185, 129, 0.16); border-color: rgba(16, 185, 129, 0.45); }
  .tile-warn  { background: rgba(245, 158, 11, 0.18); border-color: rgba(245, 158, 11, 0.5); }
  .tile-hot   { background: rgba(239, 68, 68, 0.22); border-color: rgba(239, 68, 68, 0.55); }
  .path { font-size: 12px; font-weight: 600; word-break: break-all; margin-bottom: 6px; }
  .meta { font-size: 11px; color: var(--muted); display: flex; justify-content: space-between; }
`;

/**
 * Generate a self-contained interactive HTML treemap (`plexer health viz`).
 */
export function generateHealthTreemapHtml(contextDir, graph, state, zoneMap, readLines, opts = {}) {
    const tree = buildHealthTreeData(graph, state, zoneMap, readLines);
    const scores = computeScoreSnapshot(state);
    const outPath = opts.output
        ? resolve(opts.output)
        : join(healthDir(contextDir), "treemap.html");

    const safeJson = JSON.stringify(tree).replace(/<\//g, "<\\/");
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>plexer health treemap — strict ${scores.strict}%</title>
<style>${TREEMAP_CSS}</style>
</head>
<body>
  <header>
    <div>
      <strong>plexer health treemap</strong>
      <span style="color:var(--muted);margin-left:10px;">${tree.file_count} files · ${tree.loc} LOC · ${tree.open_issues} open issues</span>
    </div>
    <div class="badges">
      <span class="badge">Strict: <strong>${scores.strict}%</strong></span>
      <span class="badge">Overall: ${scores.overall}%</span>
      <span class="badge">Objective: ${scores.objective}%</span>
      <span class="badge">Verified: ${scores.verified}%</span>
    </div>
  </header>
  <div id="grid" class="grid"></div>
  <script id="tree-data" type="application/json">${safeJson}</script>
  <script>
    const root = JSON.parse(document.getElementById("tree-data").textContent);
    const files = [];
    function collect(node) {
      if (node.kind === "file") files.push(node);
      for (const c of node.children || []) collect(c);
    }
    collect(root);
    files.sort((a, b) => b.loc - a.loc);
    const grid = document.getElementById("grid");
    for (const f of files) {
      const div = document.createElement("div");
      const cls = f.open_issues >= 3 ? "tile-hot" : f.open_issues >= 1 ? "tile-warn" : "tile-clean";
      div.className = "tile " + cls;
      const p = document.createElement("div");
      p.className = "path";
      p.textContent = f.path;
      const m = document.createElement("div");
      m.className = "meta";
      m.textContent = f.loc + " LOC · ←" + f.fan_in + " →" + f.fan_out + " · " + f.open_issues + " open";
      div.appendChild(p);
      div.appendChild(m);
      grid.appendChild(div);
    }
  </script>
</body>
</html>\n`;

    writeFileSync(outPath, html, "utf8");
    return {
        output_path: outPath,
        total_files: tree.file_count,
        total_loc: tree.loc,
        open_issues: tree.open_issues,
        scores,
    };
}
