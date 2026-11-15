/**
 * Codebase health visualizations:
 * 1. `plexer health tree` — Annotated LLM-readable directory/file tree with LOC, fan-in/fan-out, and open issues.
 * 2. `plexer health viz` — Self-contained interactive HTML treemap (`plexer/.health/treemap.html`).
 */
import { statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const gitHistoryCache = new Map();

function gitHistoryStamp(rootDir, contextDir) {
    let headMtime = 0;
    let indexMtime = 0;
    let refsMtime = 0;
    try { headMtime = Math.round(statSync(join(rootDir, ".git/HEAD")).mtimeMs); } catch {}
    try { indexMtime = Math.round(statSync(join(rootDir, ".git/logs/HEAD")).mtimeMs); } catch {}
    try { refsMtime = Math.round(statSync(join(rootDir, ".git/packed-refs")).mtimeMs); } catch {}
    return `${resolve(rootDir)}::${resolve(contextDir || rootDir)}::${headMtime}:${indexMtime}:${refsMtime}`;
}
import { analyzeGitHistory } from "../blast/history.js";
import { computeInDegree } from "../context/symbol-query.js";
import { computeOutDegree } from "./concerns.js";
import { computeScoreSnapshot } from "./scoring.js";
import { healthDir } from "./state.js";
import { SCORED_ZONES } from "./zones.js";

/**
 * Build a hierarchical directory/file tree structure from `graph`, `state`, and `readLines`.
 */
function insertFileIntoHealthTree(root, node, zone, loc, fanIn, fanOut, fileIssues, churn = 0, churnScore = 0) {
    const parts = node.path.replace(/\\/g, "/").split("/").filter(Boolean);
    let cur = root;
    cur.loc += loc;
    cur.file_count += 1;
    cur.open_issues += fileIssues.length;
    cur.fan_in += fanIn;
    cur.fan_out += fanOut;
    cur.total_churn += churn;

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
                churn,
                churnScore,
                total_churn: churn,
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
                    total_churn: 0,
                    childrenMap: new Map(),
                };
                cur.childrenMap.set(part, nextDir);
            }
            nextDir.loc += loc;
            nextDir.file_count += 1;
            nextDir.open_issues += fileIssues.length;
            nextDir.fan_in += fanIn;
            nextDir.fan_out += fanOut;
            nextDir.total_churn += churn;
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
function normalizeHealthTreeGraph(graph) {
    if (Array.isArray(graph?.nodes)) return graph;
    return {
        ...graph,
        nodes: (graph?.files || []).map((f, i) => ({
            id: f.id ?? f.path ?? i,
            kind: "file",
            path: f.path,
            lineCount: f.lineCount,
        })),
        edges: graph?.edges || [],
    };
}

function groupOpenHealthIssuesByFile(state) {
    const issuesByFile = new Map();
    for (const iss of Object.values(state?.issues || {})) {
        if (iss.status !== "open" || iss.suppressed) continue;
        const f = iss.file || "repo";
        let arr = issuesByFile.get(f);
        if (!arr) {
            arr = [];
            issuesByFile.set(f, arr);
        }
        arr.push(iss);
    }
    return issuesByFile;
}

function readNodeChurnMetrics(gitHistory, nodePath) {
    const churn =
        gitHistory?.files?.[nodePath]?.commits ??
        (gitHistory?.fileChurn instanceof Map ? gitHistory.fileChurn.get(nodePath) : undefined) ??
        0;
    const churnScore =
        gitHistory?.files?.[nodePath]?.churnScore ??
        (gitHistory?.maxChurn > 0 ? Math.round((churn / gitHistory.maxChurn) * 100) / 100 : 0);
    return { churn, churnScore };
}

export function buildHealthTreeData(graph, state, zoneMap, readLines, opts = {}) {
    const safeGraph = normalizeHealthTreeGraph(graph);
    const inDeg = computeInDegree(safeGraph);
    const outDeg = computeOutDegree(safeGraph);
    const gitHistory = opts?.files || opts?.fileChurn ? opts : opts?.gitHistory || null;
    const issuesByFile = groupOpenHealthIssuesByFile(state);
    const root = {
        name: ".", path: ".", kind: "dir", loc: 0, file_count: 0,
        open_issues: 0, fan_in: 0, fan_out: 0, total_churn: 0, childrenMap: new Map(),
    };

    for (const node of safeGraph.nodes) {
        if (node.kind !== "file") continue;
        const zone = zoneMap?.get ? zoneMap.get(node.path) || "production" : zoneMap?.[node.path] || "production";
        if (!SCORED_ZONES.has(zone) && zone !== "test") continue;
        const lines = typeof readLines === "function" ? readLines(node.path) || [] : [];
        const loc = Math.max(1, lines.length || Number(node.lineCount) || 1);
        const { churn, churnScore } = readNodeChurnMetrics(gitHistory, node.path);
        insertFileIntoHealthTree(
            root, node, zone, loc,
            inDeg.get(node.id) || 0, outDeg.get(node.id) || 0,
            issuesByFile.get(node.path) || [], churn, churnScore,
        );
    }
    return mapTreeToPlain(root);
}

/**
 * Render an LLM-readable annotated text tree (`plexer health tree`).
 */
function resolveHealthTreeFocus(root, focus) {
    if (!focus) return { node: root };
    let cur = root;
    const parts = String(focus)
        .replace(/\\/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .split("/")
        .filter(Boolean);
    for (const p of parts) {
        const found = (cur.children || []).find((c) => c.name === p);
        if (!found) return { error: `Directory not found in health tree: ${focus}` };
        cur = found;
    }
    return { node: cur };
}

function sortHealthTreeChildren(children = [], sortBy = "loc") {
    return [...children].sort((a, b) => {
        if (sortBy === "issues")
            return b.open_issues - a.open_issues || b.loc - a.loc || a.name.localeCompare(b.name);
        if (sortBy === "coupling")
            return b.fan_in + b.fan_out - (a.fan_in + a.fan_out) || b.loc - a.loc;
        return b.loc - a.loc || b.open_issues - a.open_issues || a.name.localeCompare(b.name);
    });
}

function renderHealthTreeNode(lines, node, prefix, depth, cfg) {
    if (depth > cfg.maxDepth) return;
    const children = sortHealthTreeChildren(node.children || [], cfg.sortBy).filter((c) => c.loc >= cfg.minLoc);
    for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const isLast = i === children.length - 1;
        const branch = isLast ? "└── " : "├── ";
        const nextPrefix = prefix + (isLast ? "    " : "│   ");

        if (child.kind === "dir") {
            const issueTag = child.open_issues > 0 ? ` · ⚠ ${child.open_issues} open` : " · ✓ clean";
            lines.push(`${prefix}${branch}${child.name}/ (${child.file_count} files, ${child.loc} LOC${issueTag})`);
            renderHealthTreeNode(lines, child, nextPrefix, depth + 1, cfg);
            continue;
        }
        const issueTag = child.open_issues > 0 ? ` · ⚠ ${child.open_issues} open` : "";
        const couplingTag = child.fan_in > 0 || child.fan_out > 0 ? ` · ←${child.fan_in} →${child.fan_out}` : "";
        lines.push(`${prefix}${branch}${child.name} (${child.loc} LOC${couplingTag}${issueTag})`);
        if (!cfg.detail || !Array.isArray(child.issues)) continue;
        for (const iss of child.issues.slice(0, 5)) {
            lines.push(`${nextPrefix}  • [${iss.tier} · ${iss.detector}] ${iss.span}: ${iss.summary}`);
        }
    }
}

export function generateHealthTreeText(graph, state, zoneMap, readLines, opts = {}) {
    const cfg = {
        maxDepth: Number(opts.depth) > 0 ? Number(opts.depth) : 3,
        minLoc: Number(opts.minLoc) > 0 ? Number(opts.minLoc) : 0,
        sortBy: opts.sort || "loc",
        detail: Boolean(opts.detail),
    };
    const { node: root, error } = resolveHealthTreeFocus(
        buildHealthTreeData(graph, state, zoneMap, readLines),
        opts.focus,
    );
    if (error) return error;

    const lines = [
        `plexer health tree (${root.path}) — ${root.file_count} files · ${root.loc} LOC · ${root.open_issues} open findings`,
    ];
    renderHealthTreeNode(lines, root, "", 1, cfg);
    return lines.join("\n");
}

const TREEMAP_CSS = `
  :root { --bg: #0b0f19; --panel: #111827; --border: #1e293b; --text: #f8fafc; --muted: #94a3b8; --accent: #3b82f6; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; padding: 16px; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 12px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; margin-bottom: 10px; }
  .toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; margin-bottom: 10px; }
  .breadcrumbs { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .crumb { cursor: pointer; color: #60a5fa; padding: 2px 6px; border-radius: 4px; background: rgba(59,130,246,0.12); }
  .crumb:hover { background: rgba(59,130,246,0.25); }
  .controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .btn { background: #1e293b; color: var(--text); border: 1px solid #334155; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .btn:hover, .btn.active { background: var(--accent); border-color: #60a5fa; color: #fff; }
  input[type="search"], select { background: #0f172a; color: var(--text); border: 1px solid #334155; border-radius: 6px; padding: 4px 8px; font-size: 12px; font-family: inherit; }
  .badges { display: flex; gap: 8px; font-size: 12px; flex-wrap: wrap; }
  .badge { padding: 4px 10px; border-radius: 6px; background: #0f172a; border: 1px solid var(--border); }
  #viewport { position: relative; flex: 1; background: #090d16; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .node-rect { position: absolute; border: 1px solid rgba(15,23,42,0.85); border-radius: 4px; padding: 4px 6px; overflow: hidden; cursor: pointer; transition: filter 0.1s ease; user-select: none; }
  .node-rect:hover { filter: brightness(1.18); z-index: 2; border-color: #f8fafc; }
  .node-rect.is-focused { z-index: 3; border: 2px solid #f8fafc; box-shadow: 0 0 0 2px rgba(59,130,246,0.75); }
  html.treemap-light { --bg: #f8fafc; --panel: #f1f5f9; --border: #cbd5e1; --text: #0f172a; --muted: #475569; --accent: #3b82f6; }
  html.treemap-light #viewport { background: #e2e8f0; }
  html.treemap-light .btn { background: #ffffff; border-color: #cbd5e1; color: #0f172a; }
  html.treemap-light input[type="search"], html.treemap-light select { background: #ffffff; border-color: #cbd5e1; color: #0f172a; }
  html.treemap-light .badge { background: #ffffff; }
  .node-label { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-shadow: 0 1px 2px rgba(0,0,0,0.8); }
  .node-sub { font-size: 10px; color: rgba(248,250,252,0.8); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #tooltip { position: fixed; display: none; pointer-events: none; z-index: 100; background: rgba(15, 23, 42, 0.96); border: 1px solid #475569; border-radius: 8px; padding: 10px 12px; max-width: 420px; font-size: 11px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
  .tt-title { font-weight: 700; font-size: 12px; margin-bottom: 4px; color: #f8fafc; word-break: break-all; }
  .tt-meta { color: #94a3b8; margin-bottom: 6px; }
  .tt-issue { color: #fca5a5; margin-top: 3px; line-height: 1.35; }
`;

const TREEMAP_CLIENT_SCRIPT = `
    const rootData = JSON.parse(document.getElementById("tree-data").textContent);
    const viewport = document.getElementById("viewport");
    const breadcrumbsEl = document.getElementById("breadcrumbs");
    const tooltip = document.getElementById("tooltip");
    const searchInput = document.getElementById("search-filter");
    const zoneSelect = document.getElementById("zone-filter");
    const zoomOutBtn = document.getElementById("zoom-out");

    let currentNode = rootData;
    let navStack = [rootData];
    let colorMode = "cruft";
    let searchQuery = "";
    let selectedZone = "all";
    let focusedPath = "";

    function worstAspectRatio(row, sideLength) {
      if (row.length === 0 || sideLength <= 0) return Infinity;
      let sum = 0, maxA = 0, minA = Infinity;
      for (const item of row) {
        sum += item.area;
        if (item.area > maxA) maxA = item.area;
        if (item.area < minA) minA = item.area;
      }
      if (sum <= 0 || minA <= 0) return Infinity;
      const s2 = sum * sum;
      const w2 = sideLength * sideLength;
      return Math.max((w2 * maxA) / s2, s2 / (w2 * minA));
    }

    function squarify(items, rect) {
      const results = [];
      let { x, y, w, h } = rect;
      const valid = items.filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
      const totalValue = valid.reduce((acc, it) => acc + it.value, 0);
      if (totalValue <= 0 || w <= 0 || h <= 0) return results;

      const totalArea = w * h;
      const scaled = valid.map((it) => ({ ...it, area: (it.value / totalValue) * totalArea }));

      let row = [];
      let remaining = scaled.slice();

      function layoutRow(r) {
        const rowArea = r.reduce((a, b) => a + b.area, 0);
        if (w >= h) {
          const rowW = rowArea / Math.max(1, h);
          let curY = y;
          for (const it of r) {
            const itemH = it.area / Math.max(1, rowW);
            results.push({ ...it, x, y: curY, w: rowW, h: itemH });
            curY += itemH;
          }
          x += rowW;
          w = Math.max(0, w - rowW);
        } else {
          const rowH = rowArea / Math.max(1, w);
          let curX = x;
          for (const it of r) {
            const itemW = it.area / Math.max(1, rowH);
            results.push({ ...it, x: curX, y, w: itemW, h: rowH });
            curX += itemW;
          }
          y += rowH;
          h = Math.max(0, h - rowH);
        }
      }

      while (remaining.length > 0) {
        const next = remaining[0];
        const shortSide = Math.max(1, Math.min(w, h));
        if (row.length === 0 || worstAspectRatio(row.concat([next]), shortSide) <= worstAspectRatio(row, shortSide)) {
          row.push(next);
          remaining.shift();
        } else {
          layoutRow(row);
          row = [];
        }
      }
      if (row.length > 0) layoutRow(row);
      return results;
    }

    function matchesFilters(node) {
      if (node.kind === "file") {
        if (selectedZone !== "all" && node.zone !== selectedZone) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const pathMatch = (node.path || "").toLowerCase().includes(q);
          const issueMatch = (node.issues || []).some((i) => (i.summary || "").toLowerCase().includes(q) || (i.detector || "").toLowerCase().includes(q));
          return pathMatch || issueMatch;
        }
        return true;
      }
      return (node.children || []).some(matchesFilters);
    }

    function computeNodeColor(node, mode) {
      if (mode === "cruft") {
        const issues = node.open_issues || 0;
        if (issues === 0) return "#065f46";
        if (issues <= 2) return "#b45309";
        if (issues <= 5) return "#c2410c";
        return "#b91c1c";
      }
      if (mode === "coupling") {
        const c = (node.fan_in || 0) + (node.fan_out || 0);
        if (c <= 2) return "#1e3a8a";
        if (c <= 8) return "#0284c7";
        if (c <= 18) return "#7c3aed";
        return "#be185d";
      }
      if (mode === "churn") {
        const ch = (node.total_churn ?? node.churn ?? 0) * Math.max(1, Math.log10((node.loc || 10) + 1));
        if (ch <= 1) return "#1f2937";
        if (ch <= 6) return "#0f766e";
        if (ch <= 15) return "#d97706";
        return "#dc2626";
      }
      const l = node.loc || 0;
      if (l < 100) return "#1e293b";
      if (l < 300) return "#1d4ed8";
      if (l < 600) return "#4338ca";
      return "#6d28d9";
    }

    function renderBreadcrumbs() {
      breadcrumbsEl.innerHTML = "";
      navStack.forEach((n, idx) => {
        const span = document.createElement("span");
        span.className = "crumb";
        span.textContent = idx === 0 ? "root" : n.name;
        span.onclick = () => {
          navStack = navStack.slice(0, idx + 1);
          currentNode = navStack[navStack.length - 1];
          render();
        };
        breadcrumbsEl.appendChild(span);
        if (idx < navStack.length - 1) {
          const sep = document.createElement("span");
          sep.style.color = "#64748b";
          sep.textContent = "/";
          breadcrumbsEl.appendChild(sep);
        }
      });
    }

    function escHtml(val) {
      return String(val ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function showTooltip(e, node) {
      tooltip.style.display = "block";
      const churnVal = node.total_churn ?? node.churn ?? 0;
      let html = '<div class="tt-title">' + escHtml(node.path) + '</div>';
      html += '<div class="tt-meta">' + Number(node.loc || 0) + ' LOC · fan-in ←' + Number(node.fan_in || 0) + ' · fan-out →' + Number(node.fan_out || 0) + ' · churn ' + Number(churnVal || 0) + ' · ' + Number(node.open_issues || 0) + ' open issue(s)</div>';
      if (Array.isArray(node.issues) && node.issues.length > 0) {
        for (const iss of node.issues.slice(0, 6)) {
          html += '<div class="tt-issue">• [' + escHtml(iss.tier) + ' · ' + escHtml(iss.detector) + '] ' + escHtml(iss.span) + ': ' + escHtml(iss.summary) + '</div>';
        }
      }
      tooltip.innerHTML = html;
      const x = Math.min(window.innerWidth - 430, e.clientX + 14);
      const y = Math.min(window.innerHeight - 180, e.clientY + 14);
      tooltip.style.left = Math.max(8, x) + "px";
      tooltip.style.top = Math.max(8, y) + "px";
    }

    function zoomTo(node) {
      if (node.kind === "dir" && (node.children || []).length > 0) {
        navStack.push(node);
        currentNode = node;
        render();
      }
    }

    function zoomOut() {
      if (navStack.length > 1) {
        navStack.pop();
        currentNode = navStack[navStack.length - 1];
        render();
      }
    }

    function render() {
      renderBreadcrumbs();
      viewport.innerHTML = "";
      const rect = { x: 0, y: 0, w: viewport.clientWidth || 960, h: viewport.clientHeight || 600 };
      const children = (currentNode.children || []).filter(matchesFilters).map((c) => ({
        node: c,
        value: Math.max(1, c.loc || 1),
      }));
      const boxes = squarify(children, rect);
      for (const box of boxes) {
        const n = box.node;
        const div = document.createElement("div");
        const isFocused = focusedPath && (n.path === focusedPath || (n.kind === "dir" && (focusedPath === n.path || focusedPath.startsWith(n.path + "/"))));
        div.className = isFocused ? "node-rect is-focused" : "node-rect";
        div.style.left = Math.round(box.x) + "px";
        div.style.top = Math.round(box.y) + "px";
        div.style.width = Math.max(1, Math.round(box.w)) + "px";
        div.style.height = Math.max(1, Math.round(box.h)) + "px";
        div.style.background = computeNodeColor(n, colorMode);

        if (box.w > 48 && box.h > 22) {
          const lbl = document.createElement("div");
          lbl.className = "node-label";
          lbl.textContent = (n.kind === "dir" ? n.name + "/" : n.name);
          div.appendChild(lbl);
          if (box.h > 38) {
            const sub = document.createElement("div");
            sub.className = "node-sub";
            sub.textContent = n.loc + " LOC · " + (n.open_issues || 0) + " open";
            div.appendChild(sub);
          }
        }
        div.onclick = () => {
          if (n.kind === "dir" && (n.children || []).length > 0) {
            zoomTo(n);
          } else if (n.path && window.parent && window.parent !== window) {
            window.parent.postMessage({ type: "plexer-treemap-select", path: n.path }, "*");
          }
        };
        div.onmousemove = (e) => showTooltip(e, n);
        div.onmouseleave = () => { tooltip.style.display = "none"; };
        viewport.appendChild(div);
      }
    }

    function findAncestorChain(node, targetPath, trail) {
      const nextTrail = trail.concat([node]);
      if (node.path === targetPath) return nextTrail;
      for (const child of node.children || []) {
        if (child.path === targetPath || (child.kind === "dir" && targetPath.startsWith(child.path + "/"))) {
          const hit = findAncestorChain(child, targetPath, nextTrail);
          if (hit) return hit;
        }
      }
      return null;
    }

    function focusPathInTreemap(rawPath) {
      let norm = String(rawPath || "").split(String.fromCharCode(92)).join("/");
      while (norm.startsWith("./")) norm = norm.slice(2);
      while (norm.length > 1 && norm.endsWith("/")) norm = norm.slice(0, -1);
      focusedPath = norm;
      if (!norm) {
        navStack = [rootData];
        currentNode = rootData;
        render();
        return;
      }
      const chain = findAncestorChain(rootData, norm, []);
      if (chain && chain.length > 0) {
        const last = chain[chain.length - 1];
        const dirChain = last.kind === "dir" && (last.children || []).length > 0 ? chain : chain.slice(0, Math.max(1, chain.length - 1));
        navStack = dirChain;
        currentNode = dirChain[dirChain.length - 1];
      }
      render();
    }

    window.addEventListener("message", (ev) => {
      if (ev.source !== window.parent) return;
      const msg = ev?.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "plexer-treemap-focus" && typeof msg.path === "string") {
        focusPathInTreemap(msg.path);
      } else if (msg.type === "plexer-treemap-theme") {
        document.documentElement.classList.toggle("treemap-light", Boolean(msg.light));
      }
    });

    zoomOutBtn.onclick = zoomOut;
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") zoomOut(); });
    window.addEventListener("resize", render);
    searchInput.oninput = (e) => { searchQuery = e.target.value.trim(); render(); };
    zoneSelect.onchange = (e) => { selectedZone = e.target.value; render(); };
    document.querySelectorAll(".color-btn").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".color-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        colorMode = btn.dataset.mode;
        render();
      };
    });
    render();
`;

function buildTreemapHtmlDocument(tree, scores) {
    const safeJson = JSON.stringify(tree).replace(
        /[<>&\u2028\u2029]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    const strictScore = Number(scores?.strict ?? 100);
    const overallScore = Number(scores?.overall ?? 100);
    const objectiveScore = Number(scores?.objective ?? 100);
    const verifiedScore = Number(scores?.verified ?? 100);
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>plexer health treemap — strict ${strictScore}%</title>
<style>${TREEMAP_CSS}</style>
</head>
<body>
  <header>
    <div>
      <strong>plexer health treemap</strong>
      <span id="summary-stats" style="color:var(--muted);margin-left:10px;">${tree.file_count} files · ${tree.loc} LOC · ${tree.open_issues} open issues · ${tree.total_churn || 0} churn</span>
    </div>
    <div class="badges">
      <span class="badge">Strict: <strong>${strictScore}%</strong></span>
      <span class="badge">Overall: ${overallScore}%</span>
      <span class="badge">Objective: ${objectiveScore}%</span>
      <span class="badge">Verified: ${verifiedScore}%</span>
    </div>
  </header>
  <div class="toolbar">
    <div class="breadcrumbs">
      <button id="zoom-out" class="btn" title="Zoom out (Esc)">← Back</button>
      <div id="breadcrumbs"></div>
    </div>
    <div class="controls">
      <span style="font-size:11px;color:var(--muted);">Color by:</span>
      <button class="btn color-btn active" data-mode="cruft" value="cruft">cruft</button>
      <button class="btn color-btn" data-mode="coupling" value="coupling">coupling</button>
      <button class="btn color-btn" data-mode="churn" value="churn">churn</button>
      <button class="btn color-btn" data-mode="loc" value="loc">loc</button>
      <select id="zone-filter" title="Filter by zone">
        <option value="all">All zones</option>
        <option value="production">production</option>
        <option value="test">test</option>
      </select>
      <input id="search-filter" type="search" placeholder="Search path or issue..." />
    </div>
  </div>
  <div id="viewport"></div>
  <div id="tooltip"></div>
  <script id="tree-data" type="application/json">${safeJson}</script>
  <script>${TREEMAP_CLIENT_SCRIPT}</script>
</body>
</html>\n`;
}

/**
 * Generate a 100% offline, zero-CDN self-contained interactive HTML squarified treemap (`plexer health viz`).
 */
export function generateHealthTreemapHtml(arg1, arg2, arg3, arg4, arg5, opts = {}) {
    const isDirectTreeCall = typeof arg1 === "object" && arg1 !== null;
    let tree;
    let scores;
    let outPath = null;

    if (isDirectTreeCall) {
        tree = arg1;
        scores = arg2 || { strict: 100, overall: 100, objective: 100, verified: 100 };
        const directOpts = arg3 || {};
        if (directOpts.output) outPath = resolve(directOpts.output);
    } else {
        const contextDir = arg1;
        const graph = arg2;
        const state = arg3;
        const zoneMap = arg4;
        const readLines = arg5;
        let gitHistory = opts.gitHistory || null;
        if (!gitHistory) {
            try {
                const rootDir = opts.rootDir || dirname(resolve(contextDir));
                const cacheKey = gitHistoryStamp(rootDir, contextDir);
                if (gitHistoryCache.has(cacheKey)) {
                    gitHistory = gitHistoryCache.get(cacheKey);
                } else {
                    gitHistory = analyzeGitHistory(rootDir, contextDir);
                    if (gitHistoryCache.size > 24) gitHistoryCache.clear();
                    gitHistoryCache.set(cacheKey, gitHistory);
                }
            } catch {
                gitHistory = null;
            }
        }
        tree = buildHealthTreeData(graph, state, zoneMap, readLines, { ...opts, gitHistory });
        scores = computeScoreSnapshot(state);
        outPath = opts.output
            ? resolve(opts.output)
            : join(healthDir(contextDir), "treemap.html");
    }

    const html = buildTreemapHtmlDocument(tree, scores);

    if (outPath && opts.write !== false) {
        writeFileSync(outPath, html, "utf8");
    }
    if (isDirectTreeCall) {
        return html;
    }
    return {
        output_path: outPath,
        total_files: tree.file_count,
        total_loc: tree.loc,
        total_churn: tree.total_churn || 0,
        open_issues: tree.open_issues,
        scores,
        html,
    };
}
