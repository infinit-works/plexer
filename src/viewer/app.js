const PALETTE = [
  "#5b73e8", "#38bdf8", "#34d399", "#a78bfa", "#f59e0b",
  "#60a5fa", "#2dd4bf", "#818cf8", "#fb923c", "#94a3b8",
];

const KIND_COLORS = Object.freeze(
  Object.assign(Object.create(null), {
    file: "#5b73e8",
    module: "#38bdf8",
    class: "#f59e0b",
    struct: "#fb923c",
    interface: "#a78bfa",
    trait: "#c084fc",
    function: "#2dd4bf",
    method: "#34d399",
    type: "#818cf8",
    enum: "#eab308",
    constant: "#94a3b8",
    variable: "#64748b",
    collision: "#f43f5e",
    changed: "#f59e0b",
    affected: "#5b73e8",
    retrieved: "#38bdf8",
  })
);

const sidecarState = {
  active: typeof window !== "undefined" && Boolean(window.sidecar),
  pinnedWs: "",
  workspaces: [],
  lastRev: "",
  treemapLoadedKey: "",
  revTimer: 0,
  treemapReqSeq: 0,
};

function buildApiUrl(path) {
  if (!sidecarState.active) return path;
  const sep = path.includes("?") ? "&" : "?";
  const params = new URLSearchParams();
  if (sidecarState.pinnedWs) params.set("ws", sidecarState.pinnedWs);
  else if (sidecarState.workspaces[0]) params.set("fallback_ws", sidecarState.workspaces[0]);
  if (window.sidecar?.conversationId) params.set("sid", window.sidecar.conversationId);
  const qs = params.toString();
  return qs ? `${path}${sep}${qs}` : path;
}

function apiFetch(path) {
  const url = buildApiUrl(path);
  return sidecarState.active && window.sidecar?.fetch ? window.sidecar.fetch(url) : fetch(url);
}

const state = {
  contextGraph: null,
  codeGraph: null,
  health: null,
  activeTab: "modules",
  outlineOpen: typeof window !== "undefined" ? window.innerWidth > 900 : true,
  collapsedDirs: new Set(),
  collapsedFiles: new Set(),
  filesCollapseInitialized: false,
  lastOutlineKey: "",
  search: "",
  searchMatches: [],
  searchMatchIds: new Set(),
  searchMatchIndex: -1,
  scopeFilter: "",
  legendFilter: null,
  selectedId: null,
  hoveredId: null,
  activeHoverId: null,
  hoveredClusterKey: null,
  hoverTimer: 0,
  hopDepth: 1,
  hasInitialLoad: false,
  // Kinetic selection animations (ripples + bounded directional edge flow)
  selectionRipples: [],
  flowPhase: 0,
  flowUntil: 0,
  flowIntensity: 0,
  // Render & transition dirty tracking to avoid idle O(V+E) sweeps
  visualDirty: true,
  channelsSettled: false,
  edgeCacheDirty: true,
  lastClippedArrowLen: 0,
  lastZoomBucket: -1,
  physicsClusters: [],
  hullGroups: [],
  layoutCache: new Map(),
  isMorphingPositions: false,
  // Shortest-path trace (Shift+Click)
  pathTargetId: null,
  pathSteps: [],
  pathNodeIds: new Set(),
  pathEdgeKeys: new Set(),
  pathDirection: "",
  // Cycle detection (Tarjan SCC)
  cycleNodeIds: new Set(),
  cycleEdgeKeys: new Set(),
  highlightCycles: false,
  // Cluster enclosures
  clusterHulls: [],
  hullFocusByKey: new Map(),
  hullsDirty: true,
  // Live source preview cache
  sourceCache: new Map(),
  sourceExpanded: new Set(),
  sourceCollapsed: false,
  sourceReqSeq: 0,
  focusedIssue: null,
  treemapFocusPath: "",
  quickFilterHitIndex: -1,
  suppressHistory: false,
  // Active canvas graph
  nodes: [],
  edges: [],
  nodeById: new Map(),
  adjIn: new Map(),
  adjOut: new Map(),
  legend: [],
  // Camera, smooth transitions & simulation
  cam: { x: 0, y: 0, k: 1 },
  camTarget: { x: 0, y: 0, k: 1, active: false, tau: 88 },
  focusMix: 0,
  lastFrameTime: 0,
  alpha: 0,
  rafId: 0,
  draggingNode: null,
  panning: false,
  panStart: { x: 0, y: 0, camX: 0, camY: 0 },
  pointerDownPos: { x: 0, y: 0 },
  // Full wiring index for inspector & graph builders
  wiringById: new Map(),
  wiringIn: new Map(),
  wiringOut: new Map(),
  fileSymbols: new Map(),
  dirColorMap: new Map(),
};

const FLOW_DURATION_MS = 4000;
const labelWidthCache = new Map();

function getCachedLabelWidth(text, fontSize, weight = 600) {
  if (!text) return 0;
  const key = `${weight}:${text}`;
  let baseW = labelWidthCache.get(key);
  if (baseW === undefined) {
    ctx.save();
    ctx.font = `${weight} 11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    baseW = ctx.measureText(text).width;
    ctx.restore();
    labelWidthCache.set(key, baseW);
  }
  return baseW * (fontSize / 11);
}

const CANVAS_THEME_DARK = {
  isLight: false,
  nodeStroke: "#0a0d13",
  labelText: "#e2e8f0",
  activeLabelText: "#ffffff",
  brightLabelText: "#f8fafc",
  pillBg: "rgba(10, 13, 19, 0.94)",
  hullBg: "rgba(12, 16, 24, 0.88)",
  hullHoverBg: "rgba(22, 29, 44, 0.96)",
  hullHoverText: "#ffffff",
  gridDot: "#64748b",
  edgeBase: "#526077",
  edgeHeavy: "#64748b",
  activeRingFocus: "#ffffff",
  flowCore: "#ffffff",
  rippleInner: "#ffffff",
  haloHover: "#e2e8f0",
  specular: "#ffffff",
  healthSevere: "#f87171",
  healthWarn: "#f59e0b",
};

const CANVAS_THEME_LIGHT = {
  isLight: true,
  nodeStroke: "#f8fafc",
  labelText: "#1e293b",
  activeLabelText: "#0f172a",
  brightLabelText: "#0f172a",
  pillBg: "rgba(255, 255, 255, 0.94)",
  hullBg: "rgba(241, 245, 249, 0.90)",
  hullHoverBg: "rgba(226, 232, 240, 0.98)",
  hullHoverText: "#0f172a",
  gridDot: "#94a3b8",
  edgeBase: "#94a3b8",
  edgeHeavy: "#64748b",
  activeRingFocus: "#0f172a",
  flowCore: "#0f172a",
  rippleInner: "#0f172a",
  haloHover: "#475569",
  specular: "#ffffff",
  healthSevere: "#dc2626",
  healthWarn: "#d97706",
};

function getCanvasTheme() {
  const isLight = typeof document !== "undefined" && document.documentElement.classList.contains("sidecar-light");
  return isLight ? CANVAS_THEME_LIGHT : CANVAS_THEME_DARK;
}

function parseSpanRange(span) {
  if (!span || typeof span !== "string") return null;
  const m = /^[Ll]?(\d+)(?:[-:][Ll]?(\d+))?/.exec(span.trim());
  if (!m) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start;
  if (!Number.isFinite(start) || start < 1) return null;
  return { start, end: Math.max(start, Number.isFinite(end) ? end : start) };
}

function inferFileZone(relPath, fileHealth) {
  if (fileHealth?.zone) return String(fileHealth.zone).toLowerCase();
  const norm = String(relPath || "").replace(/\\/g, "/");
  if (!norm) return "production";
  if (/(?:^|\/)(?:test|tests|__tests__)\/|(?:\.|_)(?:test|spec)\.[A-Za-z0-9]+$/i.test(norm)) return "test";
  if (/(?:^|\/)(?:scripts|bin|tools)\//i.test(norm)) return "scripts";
  if (/(?:^|\/)(?:docs?|examples?)\/|\.md$/i.test(norm)) return "docs";
  if (/(?:^|\/)(?:vendor|node_modules|dist|build|generated)\//i.test(norm)) return "vendor";
  return "production";
}

function getIssuesForNode(n) {
  const fileHealth = n?.path ? state.health?.by_file?.[n.path] : null;
  if (!fileHealth || !fileHealth.count) return [];
  const all = Array.isArray(fileHealth.issues) ? fileHealth.issues : [];
  if (n.startLine != null && n.endLine != null) {
    return all.filter((iss) => {
      const r = parseSpanRange(iss.span);
      return r ? r.end >= n.startLine && r.start <= n.endLine : false;
    });
  }
  return all;
}

function classifyIssueUrgency(iss) {
  const t = String(iss?.tier || "").toUpperCase();
  if (t === "T1" || t === "T2") return "severe";
  if (t === "T3" || t === "T4") return "warn";
  const sev = String(iss?.severity || "").toLowerCase();
  return sev === "critical" || sev === "high" ? "severe" : "warn";
}

function resolveNodeHealthTier(n) {
  const fileHealth = n?.path ? state.health?.by_file?.[n.path] : null;
  if (!fileHealth || !fileHealth.count) return null;
  if (n.startLine != null && n.endLine != null) {
    let tier = null;
    for (const iss of getIssuesForNode(n)) {
      const u = classifyIssueUrgency(iss);
      if (u === "severe") return "severe";
      tier = u;
    }
    return tier;
  }
  const maxTier = String(fileHealth.max_tier || "").toUpperCase();
  if (maxTier === "T1" || maxTier === "T2") return "severe";
  if (maxTier === "T3" || maxTier === "T4") return "warn";
  const maxSev = String(fileHealth.max_severity || "").toLowerCase();
  return maxSev === "critical" || maxSev === "high" ? "severe" : "warn";
}

function fuzzySubseqScore(text, query) {
  if (!query) return 1;
  const hay = String(text || "").toLowerCase();
  const q = query.toLowerCase();
  if (hay === q) return 100;
  if (hay.startsWith(q)) return 80;
  const subIdx = hay.indexOf(q);
  if (subIdx >= 0) return 60 - Math.min(30, subIdx);
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < hay.length && qi < q.length; i++) {
    if (hay[i] === q[qi]) {
      qi++;
      streak++;
      score += 1 + streak;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? Math.min(45, score) : 0;
}

function parseQuickFilterQuery(raw) {
  const tokens = String(raw || "").trim().split(/\s+/).filter(Boolean);
  const parsed = { issues: [], zones: [], swarms: [], terms: [] };
  for (const tok of tokens) {
    const lower = tok.toLowerCase();
    if (lower.startsWith("@issue")) {
      const val = lower.includes(":") ? lower.slice(lower.indexOf(":") + 1) : "";
      parsed.issues.push(val);
    } else if (lower.startsWith("@zone:")) {
      const val = lower.slice(6);
      if (val) parsed.zones.push(val);
    } else if (lower.startsWith("@swarm:")) {
      const val = lower.slice(7).replace(/^@/, "");
      if (val) parsed.swarms.push(val);
    } else {
      parsed.terms.push(lower);
    }
  }
  return parsed;
}

function matchesNodeIssueFilter(n, issueFilters) {
  if (issueFilters.length === 0) return true;
  const scopedIssues = getIssuesForNode(n);
  const fallbackAll = n.path ? (state.health?.by_file?.[n.path]?.issues ?? []) : [];
  const list = n.startLine != null ? scopedIssues : fallbackAll;
  const count = n.startLine != null ? scopedIssues.length : (state.health?.by_file?.[n.path]?.count ?? 0);
  if (count === 0) return false;
  for (const det of issueFilters) {
    if (!det) continue;
    const hit = list.some((iss) => String(iss.detector || "").toLowerCase().includes(det) || String(iss.tier || "").toLowerCase() === det);
    if (!hit) return false;
  }
  return true;
}

function matchesNodeScopeFilters(n, parsed) {
  if (parsed.zones.length > 0) {
    const zone = inferFileZone(n.path, n.path ? state.health?.by_file?.[n.path] : null);
    if (!parsed.zones.some((z) => zone.includes(z))) return false;
  }
  if (parsed.swarms.length > 0) {
    const ctxWorkers = n.raw?.workers ?? state.contextGraph?.nodes?.find((cn) => cn.relFile === n.path)?.workers ?? [];
    const names = ctxWorkers.map((w) => String(w.name || "").toLowerCase());
    if (!parsed.swarms.some((sw) => names.some((wn) => wn.includes(sw)))) return false;
  }
  return true;
}

function scoreNodeFilterTerms(n, terms) {
  if (terms.length === 0) return 50;
  let total = 0;
  for (const term of terms) {
    const s = Math.max(
      fuzzySubseqScore(n.label, term),
      fuzzySubseqScore(n.path, term) * 0.85,
      fuzzySubseqScore(n.sublabel, term) * 0.6,
      String(n.raw?.summary ?? "").toLowerCase().includes(term) ? 20 : 0,
    );
    if (s <= 0) return 0;
    total += s;
  }
  return total;
}

function scoreNodeAgainstFilter(n, parsed) {
  if (!matchesNodeIssueFilter(n, parsed.issues)) return 0;
  if (!matchesNodeScopeFilters(n, parsed)) return 0;
  return scoreNodeFilterTerms(n, parsed.terms);
}

const el = {
  repoName: document.getElementById("repo-name"),
  repoSubtitle: document.getElementById("repo-subtitle"),
  outlineToggleBtn: document.getElementById("outline-toggle-btn"),
  outlineSidebar: document.getElementById("outline-sidebar"),
  outlineCount: document.getElementById("outline-count"),
  outlineExpandAll: document.getElementById("outline-expand-all"),
  outlineCollapseAll: document.getElementById("outline-collapse-all"),
  outlineClose: document.getElementById("outline-close"),
  outlineList: document.getElementById("outline-list"),
  tabs: document.getElementById("view-tabs"),
  tabModules: document.getElementById("tab-modules"),
  tabSymbols: document.getElementById("tab-symbols"),
  tabContext: document.getElementById("tab-context"),
  tabTreemap: document.getElementById("tab-treemap"),
  workspaceSelect: document.getElementById("workspace-select"),
  searchInput: document.getElementById("search-input"),
  searchCount: document.getElementById("search-count"),
  quickFilterPopover: document.getElementById("quick-filter-popover"),
  scopeSelect: document.getElementById("scope-select"),
  btnFit: document.getElementById("btn-fit"),
  btnRelayout: document.getElementById("btn-relayout"),
  canvasStage: document.getElementById("canvas-stage"),
  treemapStage: document.getElementById("treemap-stage"),
  treemapFrame: document.getElementById("treemap-frame"),
  canvas: document.getElementById("graph-canvas"),
  canvasEmpty: document.getElementById("canvas-empty"),
  canvasHud: document.getElementById("canvas-hud"),
  hudStats: document.getElementById("hud-stats"),
  hudLegend: document.getElementById("hud-legend"),
  zoomHud: document.getElementById("zoom-hud"),
  zoomOutBtn: document.getElementById("zoom-out-btn"),
  zoomResetBtn: document.getElementById("zoom-reset-btn"),
  zoomInBtn: document.getElementById("zoom-in-btn"),
  zoomFitBtn: document.getElementById("zoom-fit-btn"),
  inspector: document.getElementById("inspector"),
  inspKind: document.getElementById("insp-kind"),
  inspScope: document.getElementById("insp-scope"),
  inspTitle: document.getElementById("insp-title"),
  inspClose: document.getElementById("insp-close"),
  inspLoc: document.getElementById("insp-loc"),
  inspCopy: document.getElementById("insp-copy"),
  inspFocusSymbols: document.getElementById("insp-focus-symbols"),
  inspOpenFile: document.getElementById("insp-open-file"),
  inspPinPrompt: document.getElementById("insp-pin-prompt"),
  inspPinBundle: document.getElementById("insp-pin-bundle"),
  inspControlsRow: document.getElementById("insp-controls-row"),
  inspHops: document.getElementById("insp-hops"),
  inspPathBox: document.getElementById("insp-path-box"),
  inspSig: document.getElementById("insp-sig"),
  inspSummary: document.getElementById("insp-summary"),
  inspSourceBox: document.getElementById("insp-source-box"),
  inspSections: document.getElementById("insp-sections"),
};

const ctx = el.canvas.getContext("2d");

function dirGroupOf(path) {
  if (!path) return "root";
  const parts = path.split("/");
  if (parts.length <= 1) return "(root)";
  return parts[0] === "src" && parts.length > 2 ? `src/${parts[1]}` : parts[0];
}

function colorForDir(dir) {
  if (!state.dirColorMap.has(dir)) {
    state.dirColorMap.set(dir, PALETTE[state.dirColorMap.size % PALETTE.length]);
  }
  return state.dirColorMap.get(dir);
}

function indexWiringGraph(codeGraph) {
  state.wiringById.clear();
  state.wiringIn.clear();
  state.wiringOut.clear();
  state.fileSymbols.clear();
  state.dirColorMap.clear();
  if (!codeGraph?.nodes) return;

  const dirs = new Set();
  for (const n of codeGraph.nodes) {
    state.wiringById.set(n.id, n);
    dirs.add(dirGroupOf(n.path));
    if (n.kind !== "file") {
      const list = state.fileSymbols.get(n.path) ?? [];
      list.push(n);
      state.fileSymbols.set(n.path, list);
    }
  }
  for (const d of [...dirs].sort()) colorForDir(d);

  for (const e of codeGraph.edges ?? []) {
    const outList = state.wiringOut.get(e.source) ?? [];
    outList.push(e);
    state.wiringOut.set(e.source, outList);

    const inList = state.wiringIn.get(e.target) ?? [];
    inList.push(e);
    state.wiringIn.set(e.target, inList);
  }

  // Populate directory/scope dropdown while preserving active selection if still valid
  const sortedDirs = [...dirs].filter((d) => d !== "(root)").sort();
  if (sortedDirs.length > 1) {
    const prevScope = state.scopeFilter;
    el.scopeSelect.innerHTML =
      `<option value="">All directories (${sortedDirs.length})</option>` +
      sortedDirs.map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(d)}/</option>`).join("");
    if (prevScope && sortedDirs.includes(prevScope)) {
      el.scopeSelect.value = prevScope;
    } else {
      state.scopeFilter = "";
      el.scopeSelect.value = "";
    }
    el.scopeSelect.classList.remove("hidden");
  } else {
    state.scopeFilter = "";
    el.scopeSelect.classList.add("hidden");
  }
}

function matchesScope(path) {
  if (state.scopeFilter) {
    if (dirGroupOf(path) !== state.scopeFilter && !path?.startsWith(state.scopeFilter + "/")) {
      return false;
    }
  }
  return true;
}

function matchesFilter(path, name) {
  if (!matchesScope(path)) return false;
  if (state.search) {
    const parsed = parseQuickFilterQuery(state.search);
    return scoreNodeAgainstFilter({ path, label: name, sublabel: "" }, parsed) > 0;
  }
  return true;
}

function applyLegendFilter(items, getKey, colorFn, maxLegend = Infinity) {
  const keysSeen = [...new Set(items.map(getKey))];
  const legend = keysSeen.slice(0, maxLegend).map((k) => ({ key: k, label: k, color: colorFn(k) }));
  if (state.legendFilter && !keysSeen.includes(state.legendFilter)) {
    state.legendFilter = null;
  }
  const filtered = state.legendFilter ? items.filter((it) => getKey(it) === state.legendFilter) : items;
  return { legend, filtered };
}

function buildModulesView() {
  const cg = state.codeGraph;
  if (!cg?.nodes?.length) {
    return { nodes: [], edges: [], legend: [], empty: "No wiring graph found — run `plexer build` first." };
  }
  const allMatchingFiles = cg.nodes.filter((n) => n.kind === "file" && matchesScope(n.path));
  const { legend, filtered: fileNodes } = applyLegendFilter(allMatchingFiles, (f) => dirGroupOf(f.path), colorForDir, 10);
  const allowedFiles = new Set(fileNodes.map((n) => n.path));
  const edgeWeights = new Map();

  for (const e of cg.edges ?? []) {
    const srcNode = state.wiringById.get(e.source);
    const tgtNode = state.wiringById.get(e.target);
    const srcFile = srcNode?.path;
    const tgtFile = tgtNode?.path;
    if (!srcFile || !tgtFile || srcFile === tgtFile) continue;
    if (!allowedFiles.has(srcFile) || !allowedFiles.has(tgtFile)) continue;
    const key = `${srcFile}→${tgtFile}`;
    const prev = edgeWeights.get(key) ?? { source: srcFile, target: tgtFile, weight: 0, relations: new Set() };
    prev.weight++;
    prev.relations.add(e.relation);
    edgeWeights.set(key, prev);
  }

  const deg = new Map();
  for (const e of edgeWeights.values()) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + e.weight);
    deg.set(e.target, (deg.get(e.target) ?? 0) + e.weight);
  }

  const nodes = fileNodes.map((f) => {
    const group = dirGroupOf(f.path);
    const symCount = (state.fileSymbols.get(f.path) ?? []).length;
    const d = deg.get(f.path) ?? 0;
    return {
      id: f.id,
      label: f.name,
      sublabel: group,
      dirGroup: group,
      fileGroup: f.path,
      kind: "file",
      path: f.path,
      span: f.span,
      color: colorForDir(group),
      radius: Math.max(7, Math.min(22, 6 + Math.sqrt(symCount * 1.5 + d * 0.6))),
      degree: d,
      symCount,
      raw: f,
    };
  });

  const edges = [...edgeWeights.values()].map((e) => ({
    source: e.source,
    target: e.target,
    weight: e.weight,
    relation: [...e.relations].join(", "),
  }));

  return { nodes, edges, legend, empty: nodes.length === 0 ? "No files match the current filter." : null };
}

function buildSymbolsView() {
  const cg = state.codeGraph;
  if (!cg?.nodes?.length) {
    return { nodes: [], edges: [], legend: [], empty: "No wiring graph found — run `plexer build` first." };
  }
  const baseSyms = cg.nodes.filter((n) => n.kind !== "file" && matchesScope(n.path));
  const { legend, filtered: allSyms } = applyLegendFilter(baseSyms, (n) => n.kind, (k) => KIND_COLORS[k] ?? "#546fff");
  const symSet = new Set(allSyms.map((n) => n.id));

  const deg = new Map();
  const edges = [];
  for (const e of cg.edges ?? []) {
    if (!symSet.has(e.source) || !symSet.has(e.target) || e.source === e.target) continue;
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
    edges.push({ source: e.source, target: e.target, weight: 1, relation: e.relation });
  }

  const nodes = allSyms.map((s) => {
    const d = deg.get(s.id) ?? 0;
    const dirGroup = dirGroupOf(s.path);
    const range = parseSpanRange(s.span);
    return {
      id: s.id,
      label: s.name,
      sublabel: s.path.split("/").pop(),
      dirGroup,
      fileGroup: s.path,
      kind: s.kind,
      path: s.path,
      span: s.span,
      startLine: range?.start ?? null,
      endLine: range?.end ?? null,
      color: KIND_COLORS[s.kind] ?? "#546fff",
      radius: Math.max(5.5, Math.min(18, 5 + Math.sqrt(d * 1.4))),
      degree: d,
      raw: s,
    };
  });

  return { nodes, edges, legend, empty: nodes.length === 0 ? "No symbols match the current filter." : null };
}

function buildContextView() {
  const g = state.contextGraph;
  if (!g?.nodes?.length) {
    return { nodes: [], edges: [], legend: [], empty: g?.meta?.emptyNote ?? "No context / blast nodes to display." };
  }
  const baseNodes = g.nodes;
  const { legend, filtered: rawNodes } = applyLegendFilter(baseNodes, (n) => n.type ?? "concept", (k) => KIND_COLORS[k] ?? "#546fff");
  const ids = new Set(rawNodes.map((n) => n.id ?? n.slug));

  const edges = (g.edges ?? [])
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => ({
      source: e.source,
      target: e.target,
      weight: 1,
      relation: e.relation,
      description: e.description,
    }));

  const deg = new Map();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }

  const nodes = rawNodes.map((n) => {
    const id = n.id ?? n.slug;
    const kind = n.type ?? "concept";
    const d = deg.get(id) ?? 0;
    const firstSource = n.sources?.[0]?.path ?? n.sources?.[0] ?? "";
    const cleanPath = n.relFile || n.file || (typeof firstSource === "string" ? firstSource.split(" · ")[0].split(":")[0] : "");
    return {
      id,
      label: n.name ?? id,
      sublabel: kind,
      dirGroup: kind,
      fileGroup: cleanPath || kind,
      kind,
      path: cleanPath,
      span: "",
      color: KIND_COLORS[kind] ?? "#546fff",
      radius: Math.max(9, Math.min(22, 9 + Math.sqrt(d * 2))),
      degree: d,
      raw: n,
    };
  });

  return { nodes, edges, legend, empty: nodes.length === 0 ? "No nodes match filter." : null };
}

function findBestCirclePlacement(items, k, pad, overlapsAny) {
  const item = items[k];
  const r = item.r;
  let bestX = 0;
  let bestY = 0;
  let bestScore = Infinity;
  let found = false;

  const startIdx = Math.max(0, k - 18);
  for (let i = startIdx; i < k; i++) {
    const a = items[i];
    const ra = a.r + r + pad;
    for (let j = i + 1; j < k; j++) {
      const b = items[j];
      const rb = b.r + r + pad;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      const d = Math.sqrt(d2);
      if (d <= 0.001 || d > ra + rb || d < Math.abs(ra - rb)) continue;

      const u = (ra * ra - rb * rb + d2) / (2 * d);
      const h2 = Math.max(0, ra * ra - u * u);
      const h = Math.sqrt(h2);
      const mx = a.x + (u * dx) / d;
      const my = a.y + (u * dy) / d;
      const ox = (-dy * h) / d;
      const oy = (dx * h) / d;

      for (let sign = -1; sign <= 1; sign += 2) {
        const cx = mx + sign * ox;
        const cy = my + sign * oy;
        const score = cx * cx + cy * cy;
        if (score < bestScore && !overlapsAny(cx, cy, r, k)) {
          bestScore = score;
          bestX = cx;
          bestY = cy;
          found = true;
        }
      }
    }
  }

  if (!found) {
    const angle = k * 2.399963229728653;
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    let stepR = items[0].r + r + pad;
    while (overlapsAny(ux * stepR, uy * stepR, r, k)) {
      stepR += Math.max(6, r * 0.55);
    }
    bestX = ux * stepR;
    bestY = uy * stepR;
  }

  item.x = bestX;
  item.y = bestY;
}

function centerPackedCircles(items, pad) {
  const M = items.length;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < M; i++) {
    const it = items[i];
    minX = Math.min(minX, it.x - it.r);
    maxX = Math.max(maxX, it.x + it.r);
    minY = Math.min(minY, it.y - it.r);
    maxY = Math.max(maxY, it.y + it.r);
  }
  const shiftX = (minX + maxX) * 0.5;
  const shiftY = (minY + maxY) * 0.5;
  let maxExtent = 0;
  for (let i = 0; i < M; i++) {
    const it = items[i];
    it.x -= shiftX;
    it.y -= shiftY;
    const ext = Math.hypot(it.x, it.y) + it.r;
    if (ext > maxExtent) maxExtent = ext;
  }
  return { enclosingRadius: maxExtent + pad * 0.5 };
}

/**
 * Front-chain / tangent circle packing for a list of circular items `{ r, weight }`.
 * Places highest-weight items near the center and packs remaining items tightly without overlap.
 */
function packCircles(items, pad = 12) {
  const M = items.length;
  if (M === 0) return { enclosingRadius: 0 };

  items.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || (b.r ?? 0) - (a.r ?? 0));

  if (M === 1) {
    items[0].x = 0;
    items[0].y = 0;
    return { enclosingRadius: items[0].r + pad * 0.5 };
  }

  items[0].x = 0;
  items[0].y = 0;
  items[1].x = items[0].r + items[1].r + pad;
  items[1].y = 0;

  const overlapsAny = (cx, cy, r, count) => {
    for (let i = count - 1; i >= 0; i--) {
      const other = items[i];
      const minD = r + other.r + pad - 0.1;
      const dx = cx - other.x;
      const dy = cy - other.y;
      if (dx * dx + dy * dy < minD * minD) return true;
    }
    return false;
  };

  for (let k = 2; k < M; k++) {
    findBestCirclePlacement(items, k, pad, overlapsAny);
  }

  return centerPackedCircles(items, pad);
}

function groupNodesByDirAndFile(nodes) {
  const dirMap = new Map();
  for (const n of nodes) {
    const d = n.dirGroup ?? n.sublabel ?? "default";
    let fileMap = dirMap.get(d);
    if (!fileMap) {
      fileMap = new Map();
      dirMap.set(d, fileMap);
    }
    const f = n.fileGroup ?? n.path ?? n.id;
    let list = fileMap.get(f);
    if (!list) {
      list = [];
      fileMap.set(f, list);
    }
    list.push(n);
  }
  return dirMap;
}

function applyPackedClusterLayout(dirClusters) {
  for (const dCluster of dirClusters) {
    for (const fCluster of dCluster.fileClusters) {
      const fCx = dCluster.x + fCluster.x;
      const fCy = dCluster.y + fCluster.y;
      for (const n of fCluster.members) {
        n.x = fCx + (n.homeOffsetX ?? 0);
        n.y = fCy + (n.homeOffsetY ?? 0);
        n.anchorX = fCx;
        n.anchorY = fCy;
        n.dirAnchorX = dCluster.x;
        n.dirAnchorY = dCluster.y;
        n.clusterRadius = fCluster.r;
        n.dirRadius = dCluster.r;
        n.vx = 0;
        n.vy = 0;
      }
    }
  }
}

function layoutGraph(nodes) {
  const N = nodes.length;
  if (N === 0) return;

  // 3-Tier Hierarchical Circle-Packing: Symbols -> Files -> Directories
  const dirMap = groupNodesByDirAndFile(nodes);
  const isSymbols = state.activeTab === "symbols";
  const nodePad = N > 150 ? 10 : 14;
  const dirClusters = [];

  for (const [dKey, fileMap] of dirMap) {
    const fileClusters = [];
    let dirWeight = 0;

    for (const [fKey, members] of fileMap) {
      let fileDegree = 0;
      const symItems = members.map((n) => {
        const deg = n.degree ?? 0;
        fileDegree += deg;
        return {
          node: n,
          r: n.radius + (isSymbols ? nodePad : 12),
          weight: deg * 2 + n.radius,
          x: 0,
          y: 0,
        };
      });

      const packedSyms = packCircles(symItems, isSymbols ? 10 : 14);
      for (const item of symItems) {
        item.node.homeOffsetX = item.x;
        item.node.homeOffsetY = item.y;
      }

      const filePackR = Math.max(20, packedSyms.enclosingRadius + (isSymbols ? 14 : 8));
      const fWeight = fileDegree * 1.5 + members.length * 3;
      dirWeight += fWeight;
      fileClusters.push({
        key: fKey,
        members,
        r: filePackR,
        weight: fWeight,
        x: 0,
        y: 0,
      });
    }

    const packedFiles = packCircles(fileClusters, isSymbols ? 24 : 18);
    const dirPackR = Math.max(36, packedFiles.enclosingRadius + 22);
    dirClusters.push({
      key: dKey,
      fileClusters,
      r: dirPackR,
      weight: dirWeight,
      x: 0,
      y: 0,
    });
  }

  packCircles(dirClusters, isSymbols ? 48 : 36);
  applyPackedClusterLayout(dirClusters);

  state.hullsDirty = true;
  state.edgeCacheDirty = true;
  rebuildPhysicsClusters();
  populateSpatialGrid();
}

// Reusable spatial grid map + bucket pool to avoid per-frame allocations
const SPATIAL_CELL_SIZE = 160;
const spatialGrid = new Map();
const spatialBucketPool = [];

function populateSpatialGrid() {
  for (const bucket of spatialGrid.values()) {
    bucket.length = 0;
    spatialBucketPool.push(bucket);
  }
  spatialGrid.clear();
  state.edgeCacheDirty = true;
  const nodes = state.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const cx = Math.floor(n.x / SPATIAL_CELL_SIZE);
    const cy = Math.floor(n.y / SPATIAL_CELL_SIZE);
    const key = ((cx & 0xffff) << 16) | (cy & 0xffff);
    let bucket = spatialGrid.get(key);
    if (!bucket) {
      bucket = spatialBucketPool.pop() ?? [];
      spatialGrid.set(key, bucket);
    }
    bucket.push(i);
  }
}

function attachNodePhysicsCluster(n, isSymbols, clusterByKey, clusters) {
  const g = isSymbols ? (n.fileGroup ?? n.dirGroup) : (n.dirGroup ?? n.fileGroup);
  if (!g) {
    n._physCluster = null;
    return;
  }
  let c = clusterByKey.get(g);
  if (!c) {
    c = {
      key: g,
      members: [],
      ax: n.anchorX ?? 0,
      ay: n.anchorY ?? 0,
      radius: isSymbols ? (n.clusterRadius ?? 32) : (n.dirRadius ?? 48),
      cx: 0,
      cy: 0,
      pushX: 0,
      pushY: 0,
    };
    clusterByKey.set(g, c);
    clusters.push(c);
  }
  c.members.push(n);
  n._physCluster = c;
}
function attachNodeHullGroup(n, isSymbols, hullGroupMap) {
  const hullKey = isSymbols ? n.fileGroup : n.dirGroup;
  if (!hullKey || hullKey === "(root)" || hullKey === "root")
    return;
  let hg = hullGroupMap.get(hullKey);
  if (!hg) {
    const dir = isSymbols ? dirGroupOf(hullKey) : hullKey;
    hg = {
      key: hullKey,
      label: isSymbols ? hullKey.split("/").pop() : `${hullKey}/`,
      color: colorForDir(dir),
      members: [],
      memberIds: new Set(),
    };
    hullGroupMap.set(hullKey, hg);
  }
  hg.members.push(n);
  hg.memberIds.add(n.id);
}
function rebuildPhysicsClusters() {
  const nodes = state.nodes;
  const isSymbols = state.activeTab === "symbols";
  const clusterByKey = new Map();
  const clusters = [];
  const hullGroupMap = new Map();
  for (let i = 0; i < nodes.length; i++) {
    attachNodePhysicsCluster(nodes[i], isSymbols, clusterByKey, clusters);
    attachNodeHullGroup(nodes[i], isSymbols, hullGroupMap);
  }
  state.physicsClusters = clusters;
  state.hullGroups = [];
  for (const hg of hullGroupMap.values()) {
    if (hg.members.length >= 2)
      state.hullGroups.push(hg);
  }
}

function applyPairSpatialRepulsion(a, b, i, j, maxDist2, kRepel, alpha) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  let d2 = dx * dx + dy * dy;
  if (d2 > maxDist2)
    return;
  if (d2 < 1) {
    dx = (i % 2 === 0 ? 1 : -1) * 0.5;
    dy = (j % 2 === 0 ? 1 : -1) * 0.5;
    d2 = 1;
  }
  const sameCluster = a._physCluster !== null && a._physCluster === b._physCluster;
  const minGap = a.radius + b.radius + (sameCluster ? 14 : 26);
  const f = (kRepel * (sameCluster ? 0.65 : 1.15) * alpha) / d2;
  const dist = Math.sqrt(d2);
  const overlapPush = dist < minGap ? ((minGap - dist) / dist) * 0.52 : 0;
  const fx = dx * (f / dist + overlapPush);
  const fy = dy * (f / dist + overlapPush);
  a.vx -= fx;
  a.vy -= fy;
  b.vx += fx;
  b.vy += fy;
}
function applySpatialRepulsionForces(nodes, cellSize, maxDist2, kRepel, alpha) {
  const N = nodes.length;
  for (let i = 0; i < N; i++) {
    const a = nodes[i];
    const cx = Math.floor(a.x / cellSize);
    const cy = Math.floor(a.y / cellSize);
    for (let dxCell = -1; dxCell <= 1; dxCell++) {
      const nx = (cx + dxCell) & 0xffff;
      for (let dyCell = -1; dyCell <= 1; dyCell++) {
        const bucket = spatialGrid.get((nx << 16) | ((cy + dyCell) & 0xffff));
        if (!bucket)
          continue;
        for (let bi = 0; bi < bucket.length; bi++) {
          const j = bucket[bi];
          if (j > i)
            applyPairSpatialRepulsion(a, nodes[j], i, j, maxDist2, kRepel, alpha);
        }
      }
    }
  }
}

function applyEdgeSpringForces(edges, kSpring, alpha) {
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    const s = e.sourceNode;
    const t = e.targetNode;
    if (!s || !t) continue;
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const sameFile = s.fileGroup && s.fileGroup === t.fileGroup;
    const sameDir = s.dirGroup && s.dirGroup === t.dirGroup;
    const targetLen = (sameFile ? 38 : sameDir ? 72 : 115) + s.radius + t.radius;
    const springScale = sameFile ? 0.65 : sameDir ? 0.26 : 0.12;
    const f = (dist - targetLen) * kSpring * springScale * alpha;
    const fx = (dx / dist) * f;
    const fy = (dy / dist) * f;
    s.vx += fx;
    s.vy += fy;
    t.vx -= fx;
    t.vy -= fy;
  }
}

function applyClusterSeparationForces(clusters, isSymbols, alpha) {
  const C = clusters.length;
  for (let i = 0; i < C; i++) {
    const c = clusters[i];
    const members = c.members;
    const mLen = members.length;
    let sx = 0;
    let sy = 0;
    for (let m = 0; m < mLen; m++) {
      sx += members[m].x;
      sy += members[m].y;
    }
    c.cx = sx / mLen;
    c.cy = sy / mLen;
    c.pushX = 0;
    c.pushY = 0;
  }

  const clusterGap = isSymbols ? 26 : 34;
  for (let i = 0; i < C; i++) {
    const cA = clusters[i];
    for (let j = i + 1; j < C; j++) {
      const cB = clusters[j];
      let dx = cB.cx - cA.cx;
      let dy = cB.cy - cA.cy;
      const d2 = dx * dx + dy * dy;
      const minD = cA.radius + cB.radius + clusterGap;
      if (d2 < minD * minD) {
        let dist = Math.sqrt(d2);
        if (dist < 0.1) {
          dx = i % 2 === 0 ? 1 : -1;
          dy = j % 2 === 0 ? 1 : -1;
          dist = Math.SQRT2;
        }
        const push = ((minD - dist) / dist) * 0.36 * alpha;
        const px = dx * push;
        const py = dy * push;
        cA.pushX -= px;
        cA.pushY -= py;
        cB.pushX += px;
        cB.pushY += py;
      }
    }
  }
}

function integrateNodePhysicsVelocities(nodes, isSymbols, kHome, kCenter, alpha) {
  const N = nodes.length;
  for (let i = 0; i < N; i++) {
    const n = nodes[i];
    if (n === state.draggingNode) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    const c = n._physCluster;
    if (c) {
      n.vx += c.pushX;
      n.vy += c.pushY;
      const targetHomeX = (c.cx * 0.55 + c.ax * 0.45) + (isSymbols ? (n.homeOffsetX ?? 0) : 0);
      const targetHomeY = (c.cy * 0.55 + c.ay * 0.45) + (isSymbols ? (n.homeOffsetY ?? 0) : 0);
      const pull = (n.degree === 0 ? kHome * 1.25 : kHome) * alpha;
      n.vx += (targetHomeX - n.x) * pull;
      n.vy += (targetHomeY - n.y) * pull;
    } else if (n.anchorX !== undefined) {
      const pull = kHome * alpha;
      n.vx += (n.anchorX - n.x) * pull;
      n.vy += (n.anchorY - n.y) * pull;
    }

    n.vx -= n.x * kCenter * alpha;
    n.vy -= n.y * kCenter * alpha;
    n.vx *= 0.70;
    n.vy *= 0.70;
    n.x += n.vx;
    n.y += n.vy;
  }
}

function stepPhysics() {
  const nodes = state.nodes;
  const edges = state.edges;
  const N = nodes.length;
  if (N <= 1 || state.alpha <= 0.005) {
    state.alpha = 0;
    return false;
  }

  const alpha = state.alpha;
  const isSymbols = state.activeTab === "symbols";
  const kRepel = 920;
  const kSpring = 0.036;
  const kCenter = 0.006;
  const kHome = isSymbols ? 0.068 : 0.048;
  const cellSize = SPATIAL_CELL_SIZE;
  const maxDist2 = cellSize * cellSize;

  if (spatialGrid.size === 0) {
    populateSpatialGrid();
  }

  applySpatialRepulsionForces(nodes, cellSize, maxDist2, kRepel, alpha);
  applyEdgeSpringForces(edges, kSpring, alpha);
  applyClusterSeparationForces(state.physicsClusters, isSymbols, alpha);
  integrateNodePhysicsVelocities(nodes, isSymbols, kHome, kCenter, alpha);

  state.hullsDirty = true;
  state.alpha *= 0.92;
  const stillMoving = state.alpha > 0.005;
  if (!stillMoving) {
    state.alpha = 0;
    populateSpatialGrid();
  }
  return stillMoving;
}

function computeConvexHull(pts) {
  if (pts.length <= 2) return pts;
  const sorted = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

const OCTANT_DIRS = [
  [1, 0],
  [0.7071, 0.7071],
  [0, 1],
  [-0.7071, 0.7071],
  [-1, 0],
  [-0.7071, -0.7071],
  [0, -1],
  [0.7071, -0.7071],
];

function rebuildClusterHulls() {
  state.hullsDirty = false;
  state.clusterHulls = [];
  if (state.activeTab !== "symbols" && state.activeTab !== "modules") return;

  const isSymbols = state.activeTab === "symbols";
  const pad = isSymbols ? 16 : 22;
  const hullGroups = state.hullGroups;

  for (let g = 0; g < hullGroups.length; g++) {
    const hg = hullGroups[g];
    const members = hg.members;
    const mLen = members.length;
    if (mLen < 2) continue;

    const samplePts = [];
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let alphaSum = 0;
    let cxSum = 0;
    let cySum = 0;
    for (let i = 0; i < mLen; i++) {
      const m = members[i];
      alphaSum += m.renderAlpha ?? 1;
      cxSum += m.x;
      cySum += m.y;
      const r = m.radius + pad;
      minX = Math.min(minX, m.x - r);
      maxX = Math.max(maxX, m.x + r);
      minY = Math.min(minY, m.y - r);
      maxY = Math.max(maxY, m.y + r);
      for (let d = 0; d < OCTANT_DIRS.length; d++) {
        samplePts.push({
          x: m.x + OCTANT_DIRS[d][0] * r,
          y: m.y + OCTANT_DIRS[d][1] * r,
        });
      }
    }
    const hull = computeConvexHull(samplePts);
    if (hull.length < 3) continue;
    state.clusterHulls.push({
      key: hg.key,
      label: hg.label,
      color: hg.color,
      hull,
      members,
      memberIds: hg.memberIds,
      cx: cxSum / mLen,
      cy: cySum / mLen,
      minX,
      maxX,
      minY,
      maxY,
      labelX: (minX + maxX) * 0.5,
      labelY: minY + 4,
      headerBox: null,
      alpha: alphaSum / mLen,
      focusMix: state.hullFocusByKey.get(hg.key) ?? 0,
    });
  }
}

/**
 * Lightweight O(N) cluster hull translation during tab-switch position morphs
 * so we avoid sorting 8*N octant points per cluster at 60Hz.
 */
function updateClusterHullsFast() {
  const hulls = state.clusterHulls;
  if (hulls.length === 0) {
    rebuildClusterHulls();
    return;
  }
  const pad = state.activeTab === "symbols" ? 16 : 22;
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i];
    const members = h.members;
    const mLen = members.length;
    let cxSum = 0;
    let cySum = 0;
    let alphaSum = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let m = 0; m < mLen; m++) {
      const node = members[m];
      cxSum += node.x;
      cySum += node.y;
      alphaSum += node.renderAlpha ?? 1;
      const r = node.radius + pad;
      if (node.x - r < minX) minX = node.x - r;
      if (node.x + r > maxX) maxX = node.x + r;
      if (node.y - r < minY) minY = node.y - r;
      if (node.y + r > maxY) maxY = node.y + r;
    }
    const newCx = cxSum / mLen;
    const newCy = cySum / mLen;
    const dx = newCx - h.cx;
    const dy = newCy - h.cy;
    if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
      const pts = h.hull;
      for (let p = 0; p < pts.length; p++) {
        pts[p].x += dx;
        pts[p].y += dy;
      }
      h.cx = newCx;
      h.cy = newCy;
    }
    h.minX = minX;
    h.maxX = maxX;
    h.minY = minY;
    h.maxY = maxY;
    h.labelX = (minX + maxX) * 0.5;
    h.labelY = minY + 4;
    h.alpha = alphaSum / mLen;
  }
}

function smoothstep(edge0, edge1, x) {
  if (edge1 <= edge0) return x >= edge0 ? 1 : 0;
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function getUnobstructedViewportBounds(rect) {
  const leftPad = state.outlineOpen && rect.width > 820 ? 316 : 24;
  const rightPad = !el.inspector.classList.contains("hidden") && rect.width > 760 ? 380 : 24;
  const topPad = 68;
  const bottomPad = 56;
  return {
    left: leftPad,
    right: Math.max(leftPad + 160, rect.width - rightPad),
    top: topPad,
    bottom: Math.max(topPad + 120, rect.height - bottomPad),
    centerX: (leftPad + Math.max(leftPad + 160, rect.width - rightPad)) * 0.5,
    centerY: (topPad + Math.max(topPad + 120, rect.height - bottomPad)) * 0.5,
  };
}

function updateZoomHudReadout() {
  if (el.zoomResetBtn) {
    el.zoomResetBtn.textContent = `${Math.round(state.cam.k * 100)}%`;
  }
}

function setCameraTarget(x, y, k, animate = true, tau = 90) {
  if (!animate) {
    state.cam.x = x;
    state.cam.y = y;
    state.cam.k = k;
    state.camTarget.x = x;
    state.camTarget.y = y;
    state.camTarget.k = k;
    state.camTarget.active = false;
    state.camTarget.tau = tau;
    updateZoomHudReadout();
  } else {
    state.camTarget.x = x;
    state.camTarget.y = y;
    state.camTarget.k = k;
    state.camTarget.active = true;
    state.camTarget.tau = tau;
  }
  requestDraw();
}

function fitNodesToScreen(targetNodes, maxZoom = 2.0, animate = true) {
  const nodes = targetNodes?.length ? targetNodes : state.nodes;
  const rect = el.canvas.getBoundingClientRect();
  if (!nodes.length || rect.width === 0 || rect.height === 0) return;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const nx = n.targetX ?? n.x;
    const ny = n.targetY ?? n.y;
    minX = Math.min(minX, nx - n.radius - 32);
    maxX = Math.max(maxX, nx + n.radius + 32);
    minY = Math.min(minY, ny - n.radius - 32);
    maxY = Math.max(maxY, ny + n.radius + 32);
  }
  const bw = Math.max(120, maxX - minX);
  const bh = Math.max(120, maxY - minY);
  const bounds = getUnobstructedViewportBounds(rect);
  const availW = Math.max(220, bounds.right - bounds.left - 36);
  const availH = Math.max(180, bounds.bottom - bounds.top - 36);
  const scale = Math.min(maxZoom, Math.max(0.12, Math.min(availW / bw, availH / bh)));
  const tx = bounds.centerX - ((minX + maxX) / 2) * scale;
  const ty = bounds.centerY - ((minY + maxY) / 2) * scale;
  setCameraTarget(tx, ty, scale, animate, 95);
}

function fitToScreen(animate = true) {
  fitNodesToScreen(state.nodes, 2.0, animate);
}

function syncTreemapFocus() {
  if (!el.treemapFrame?.contentWindow) return;
  if (state.treemapFocusPath) {
    el.treemapFrame.contentWindow.postMessage({ type: "plexer-treemap-focus", path: state.treemapFocusPath }, "*");
  }
  el.treemapFrame.contentWindow.postMessage({ type: "plexer-treemap-theme", light: getCanvasTheme().isLight }, "*");
}

function focusClusterByKey(clusterKey) {
  if (!clusterKey) return;
  state.treemapFocusPath = clusterKey;
  if (state.activeTab === "treemap") syncTreemapFocus();
  const clusterNodes = state.nodes.filter(
    (n) => n.fileGroup === clusterKey || n.dirGroup === clusterKey
  );
  if (clusterNodes.length > 0) {
    fitNodesToScreen(clusterNodes, 1.85, true);
    for (const n of clusterNodes) {
      n.scaleVel = Math.max(n.scaleVel ?? 0, 1.6);
    }
    requestDraw();
  }
}

/**
 * Compute Tarjan Strongly Connected Components on the active canvas graph
 * to detect circular dependencies and self-loops in O(V + E).
 */
function computeGraphCycles() {
  state.cycleNodeIds.clear();
  state.cycleEdgeKeys.clear();
  const nodes = state.nodes;
  if (!nodes.length) return;

  let index = 0;
  const indices = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const stack = [];
  const sccByNode = new Map();
  let sccCount = 0;

  function strongConnect(vId) {
    indices.set(vId, index);
    lowlink.set(vId, index);
    index++;
    stack.push(vId);
    onStack.add(vId);

    for (const wId of state.adjOut.get(vId) ?? []) {
      if (!indices.has(wId)) {
        strongConnect(wId);
        lowlink.set(vId, Math.min(lowlink.get(vId), lowlink.get(wId)));
      } else if (onStack.has(wId)) {
        lowlink.set(vId, Math.min(lowlink.get(vId), indices.get(wId)));
      }
    }

    if (lowlink.get(vId) === indices.get(vId)) {
      const memberIds = [];
      while (stack.length > 0) {
        const wId = stack.pop();
        onStack.delete(wId);
        memberIds.push(wId);
        if (wId === vId) break;
      }
      if (memberIds.length > 1) {
        const cid = ++sccCount;
        for (const mId of memberIds) {
          state.cycleNodeIds.add(mId);
          sccByNode.set(mId, cid);
        }
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    const id = nodes[i].id;
    if (!indices.has(id)) {
      strongConnect(id);
    }
  }

  for (let i = 0; i < state.edges.length; i++) {
    const e = state.edges[i];
    const cSrc = sccByNode.get(e.source);
    if (cSrc !== undefined && cSrc === sccByNode.get(e.target)) {
      state.cycleEdgeKeys.add(`${e.source}→${e.target}`);
    }
  }
  if (state.cycleEdgeKeys.size === 0) {
    state.highlightCycles = false;
  }
}

function renderQuickFilterPopover() {
  const pop = el.quickFilterPopover;
  if (!pop) return;
  const isFocused = document.activeElement === el.searchInput;
  if (!isFocused) {
    pop.classList.add("hidden");
    return;
  }

  const issueCounts = new Map();
  const zoneSet = new Set(["production", "test"]);
  for (const [fPath, fh] of Object.entries(state.health?.by_file ?? {})) {
    zoneSet.add(inferFileZone(fPath, fh));
    for (const iss of fh.issues ?? []) {
      if (iss?.detector) issueCounts.set(iss.detector, (issueCounts.get(iss.detector) || 0) + 1);
    }
  }
  const topIssues = [...issueCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const workers = state.contextGraph?.meta?.workers ?? [];

  const sections = [];
  if (topIssues.length > 0) {
    const chips = topIssues
      .map(([det, cnt]) => `<button type="button" class="quick-filter-chip" data-qf-token="@issue:${escapeHtml(det)}">@issue:${escapeHtml(det)} (${cnt})</button>`)
      .join("");
    sections.push(`<div class="quick-filter-group"><div class="quick-filter-title">Issues</div><div class="quick-filter-chips">${chips}</div></div>`);
  }
  const zoneChips = [...zoneSet]
    .slice(0, 5)
    .map((z) => `<button type="button" class="quick-filter-chip" data-qf-token="@zone:${escapeHtml(z)}">@zone:${escapeHtml(z)}</button>`)
    .join("");
  sections.push(`<div class="quick-filter-group"><div class="quick-filter-title">Zones</div><div class="quick-filter-chips">${zoneChips}</div></div>`);

  if (workers.length > 0) {
    const wChips = workers
      .slice(0, 6)
      .map((w) => `<button type="button" class="quick-filter-chip" data-qf-token="@swarm:${escapeHtml(w.name)}">@swarm:${escapeHtml(w.name)}</button>`)
      .join("");
    sections.push(`<div class="quick-filter-group"><div class="quick-filter-title">Swarm</div><div class="quick-filter-chips">${wChips}</div></div>`);
  }

  if (state.searchMatches.length > 0) {
    const hitRows = state.searchMatches
      .slice(0, 8)
      .map((n, idx) => {
        const activeCls = idx === state.quickFilterHitIndex ? " active" : "";
        const loc = n.path ? (n.span ? `${n.path}:${n.span}` : n.path) : "";
        return (
          `<button type="button" class="quick-filter-hit${activeCls}" data-qf-jump="${escapeHtml(n.id)}">` +
            `<span>${escapeHtml(n.label ?? n.id)}</span>` +
            `<span class="quick-filter-hit-path">${escapeHtml(loc)}</span>` +
          `</button>`
        );
      })
      .join("");
    sections.push(`<div class="quick-filter-group"><div class="quick-filter-title">Matches (${state.searchMatches.length})</div>${hitRows}</div>`);
  }

  pop.innerHTML = sections.join("");
  pop.classList.remove("hidden");
}

/**
 * Update non-destructive search matches on the current canvas graph and left Outline sidebar.
 */
function updateSearchMatches() {
  state.searchMatches = [];
  state.searchMatchIds.clear();
  state.searchMatchIndex = -1;
  state.quickFilterHitIndex = -1;

  const outlineKey = `${state.codeGraph?.nodes?.length ?? 0}::${state.scopeFilter}::${state.search}`;
  if (outlineKey !== state.lastOutlineKey) {
    renderOutlineView(false);
  }

  const raw = state.search.trim();
  if (!raw) {
    el.searchCount.textContent = "";
    renderQuickFilterPopover();
    requestDraw();
    return;
  }

  const parsed = parseQuickFilterQuery(raw);
  const scored = [];
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    const score = scoreNodeAgainstFilter(n, parsed);
    if (score > 0) {
      scored.push({ n, score });
      state.searchMatchIds.add(n.id);
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.n.degree ?? 0) - (a.n.degree ?? 0) || a.n.id.localeCompare(b.n.id);
  });

  state.searchMatches = scored.map((it) => it.n);
  el.searchCount.textContent = `${state.searchMatches.length}`;
  renderQuickFilterPopover();
  requestDraw();
}

function cycleSearchMatch(delta = 1) {
  if (!state.searchMatches.length) return;
  const total = state.searchMatches.length;
  state.searchMatchIndex =
    state.searchMatchIndex < 0
      ? delta >= 0
        ? 0
        : total - 1
      : (state.searchMatchIndex + delta + total) % total;
  const target = state.searchMatches[state.searchMatchIndex];
  el.searchCount.textContent = `${state.searchMatchIndex + 1}/${total}`;
  openInspector(target.id, true);
  centerOnNode(target, true);
}

function resolveCanvasFocusIds(rawFocusId) {
  const focusIds = new Set();
  if (!rawFocusId) return focusIds;
  if (state.nodeById.has(rawFocusId)) {
    focusIds.add(rawFocusId);
  } else if (state.activeTab === "symbols") {
    const wNode = state.wiringById.get(rawFocusId);
    if (wNode?.kind === "file") {
      for (const s of state.fileSymbols.get(wNode.path) ?? []) {
        if (state.nodeById.has(s.id)) focusIds.add(s.id);
      }
    } else if (wNode?.path && state.nodeById.has(wNode.path)) {
      focusIds.add(wNode.path);
    }
  } else if (state.activeTab === "modules") {
    const wNode = state.wiringById.get(rawFocusId);
    if (wNode?.path && state.nodeById.has(wNode.path)) {
      focusIds.add(wNode.path);
    }
  }
  return focusIds;
}

/**
 * Trigger kinetic selection animations: expanding two-ring ripple + underdamped spring scale pop
 * on the selected node and its 1-hop connected neighbors.
 */
function triggerSelectionAnimation(nodeId) {
  if (!nodeId) return;
  const now = performance.now();
  const targetNodes = [...resolveCanvasFocusIds(nodeId)].map((id) => state.nodeById.get(id)).filter(Boolean);

  for (const cn of targetNodes) {
    cn.scaleVel = 3.2;
    cn.scaleOffset = Math.max(cn.scaleOffset ?? 0, 0.08);
    state.selectionRipples.push({
      node: cn,
      color: cn.color ?? "#5b73e8",
      startTime: now,
      duration: 720,
    });
    for (const nbId of state.adjIn.get(cn.id) ?? []) {
      const nb = state.nodeById.get(nbId);
      if (nb && nb !== cn) nb.scaleVel = Math.max(nb.scaleVel ?? 0, 1.55);
    }
    for (const nbId of state.adjOut.get(cn.id) ?? []) {
      const nb = state.nodeById.get(nbId);
      if (nb && nb !== cn) nb.scaleVel = Math.max(nb.scaleVel ?? 0, 1.55);
    }
  }
  if (state.selectionRipples.length > 16) {
    state.selectionRipples.splice(0, state.selectionRipples.length - 16);
  }
  state.flowUntil = now + FLOW_DURATION_MS;
  state.flowIntensity = 1;
  state.visualDirty = true;
  requestDraw();
}

/**
 * Shortest path between two canvas nodes (Shift+Click on canvas).
 */
function clearShortestPath() {
  state.pathTargetId = null;
  state.pathSteps = [];
  state.pathNodeIds.clear();
  state.pathEdgeKeys.clear();
  state.pathDirection = "";
  state.visualDirty = true;
  if (el.inspPathBox) {
    el.inspPathBox.classList.add("hidden");
    el.inspPathBox.innerHTML = "";
  }
}

function bfsPath(startId, endId, mode) {
  const queue = [startId];
  const prev = new Map([[startId, null]]);
  let head = 0;
  while (head < queue.length) {
    const curr = queue[head++];
    if (curr === endId) {
      const path = [];
      let step = endId;
      while (step !== null) {
        path.push(step);
        step = prev.get(step) ?? null;
      }
      return path.reverse();
    }
    const nextIds =
      mode === "out"
        ? state.adjOut.get(curr) ?? []
        : mode === "in"
          ? state.adjIn.get(curr) ?? []
          : [...(state.adjOut.get(curr) ?? []), ...(state.adjIn.get(curr) ?? [])];
    for (const nxt of nextIds) {
      if (!prev.has(nxt)) {
        prev.set(nxt, curr);
        queue.push(nxt);
      }
    }
  }
  return null;
}

function traceShortestPathTo(targetId) {
  const rawStartId = state.selectedId;
  if (!rawStartId || !targetId || rawStartId === targetId) return;
  const startCandidates = state.nodeById.has(rawStartId)
    ? [rawStartId]
    : [...resolveCanvasFocusIds(rawStartId)];
  const targetCandidates = state.nodeById.has(targetId)
    ? [targetId]
    : [...resolveCanvasFocusIds(targetId)];
  const startId = startCandidates[0];
  const resolvedTargetId = targetCandidates[0];
  if (!startId || !resolvedTargetId || startId === resolvedTargetId) return;
  if (!state.nodeById.has(startId) || !state.nodeById.has(resolvedTargetId)) return;

  let steps = bfsPath(startId, resolvedTargetId, "out");
  let direction = "downstream";
  if (!steps) {
    const rev = bfsPath(resolvedTargetId, startId, "out");
    if (rev) {
      steps = rev;
      direction = "upstream";
    }
  }
  if (!steps) {
    steps = bfsPath(startId, resolvedTargetId, "both");
    direction = "undirected";
  }

  state.pathTargetId = resolvedTargetId;
  state.pathNodeIds.clear();
  state.pathEdgeKeys.clear();
  state.visualDirty = true;

  if (!steps || steps.length < 2) {
    state.pathSteps = [];
    state.pathDirection = "none";
    renderPathBox();
    requestDraw();
    return;
  }

  state.pathSteps = steps;
  state.pathDirection = direction;
  for (let i = 0; i < steps.length; i++) {
    state.pathNodeIds.add(steps[i]);
    if (i + 1 < steps.length) {
      const a = steps[i];
      const b = steps[i + 1];
      if (state.adjOut.get(a)?.has(b)) {
        state.pathEdgeKeys.add(`${a}→${b}`);
      } else if (state.adjOut.get(b)?.has(a)) {
        state.pathEdgeKeys.add(`${b}→${a}`);
      }
    }
  }

  state.flowUntil = performance.now() + FLOW_DURATION_MS;
  state.flowIntensity = 1;
  renderPathBox();
  const pathNodes = steps.map((id) => state.nodeById.get(id)).filter(Boolean);
  if (pathNodes.length > 1) {
    fitNodesToScreen(pathNodes, 1.85, true);
  }
  requestDraw();
}

function renderPathBox() {
  if (!el.inspPathBox) return;
  if (!state.pathTargetId) {
    el.inspPathBox.classList.add("hidden");
    el.inspPathBox.innerHTML = "";
    return;
  }
  el.inspPathBox.classList.remove("hidden");
  if (!state.pathSteps.length) {
    const tgtLabel = state.nodeById.get(state.pathTargetId)?.label ?? state.pathTargetId;
    el.inspPathBox.innerHTML =
      `<div class="insp-path-header">` +
        `<span>No path to ${escapeHtml(tgtLabel)}</span>` +
        `<button type="button" class="btn-xs" data-clear-path="1">Clear</button>` +
      `</div>`;
    return;
  }
  const hops = state.pathSteps.length - 1;
  const rows = state.pathSteps
    .map((id, idx) => {
      const n = state.nodeById.get(id);
      const label = n?.label ?? id;
      const prefix = idx === 0 ? "●" : idx === state.pathSteps.length - 1 ? "◎" : `↳ hop ${idx}`;
      return (
        `<div class="insp-path-step" data-jump-id="${escapeHtml(id)}">` +
          `<span class="insp-edge-name">${escapeHtml(label)}</span>` +
          `<span class="insp-edge-rel">${escapeHtml(prefix)}</span>` +
        `</div>`
      );
    })
    .join("");
  el.inspPathBox.innerHTML =
    `<div class="insp-path-header">` +
      `<span>Path (${hops} hop${hops === 1 ? "" : "s"} · ${escapeHtml(state.pathDirection)})</span>` +
      `<button type="button" class="btn-xs" data-clear-path="1">Clear</button>` +
    `</div>` +
    `<div class="insp-path-steps">${rows}</div>`;
}

let cachedFocusKey = "";
let cachedFocusResult = null;

function collectFocusBfsDistances(focusIds, adjMap, maxLimit) {
  const dist = new Map();
  let frontier = [...focusIds];
  for (let hop = 1; hop <= maxLimit && frontier.length > 0; hop++) {
    const next = [];
    for (let i = 0; i < frontier.length; i++) {
      for (const nb of adjMap.get(frontier[i]) ?? []) {
        if (!focusIds.has(nb) && !dist.has(nb)) {
          dist.set(nb, hop);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Resolve the set of focused canvas node IDs and their multi-hop incoming/outgoing neighbor sets.
 * Selection-first: when a node is pinned/selected, keep its subgraph locked; otherwise use debounced hover preview.
 */
function resolveFocusState() {
  const selectedFocusIds = state.selectedId ? resolveCanvasFocusIds(state.selectedId) : null;
  const hasPinnedFocus = Boolean(selectedFocusIds && selectedFocusIds.size > 0);
  const rawFocusId = hasPinnedFocus ? state.selectedId : state.activeHoverId;
  const key = `${rawFocusId ?? ""}::${hasPinnedFocus ? state.hopDepth : 1}::${state.activeTab}::${state.nodes.length}`;
  if (key === cachedFocusKey && cachedFocusResult) return cachedFocusResult;
  cachedFocusKey = key;
  const focusIds = rawFocusId ? (hasPinnedFocus ? selectedFocusIds : resolveCanvasFocusIds(rawFocusId)) : null;
  if (!focusIds || focusIds.size === 0) {
    cachedFocusResult = { hasFocus: false, isPinned: false, focusIds: null, inSet: null, outSet: null, inDist: null, outDist: null };
    return cachedFocusResult;
  }
  const maxHops = hasPinnedFocus ? state.hopDepth : 1;
  const maxLimit = Number.isFinite(maxHops) ? maxHops : 25;
  const inDist = collectFocusBfsDistances(focusIds, state.adjIn, maxLimit);
  const outDist = collectFocusBfsDistances(focusIds, state.adjOut, maxLimit);
  cachedFocusResult = {
    hasFocus: true,
    isPinned: hasPinnedFocus,
    focusIds,
    inSet: new Set(inDist.keys()),
    outSet: new Set(outDist.keys()),
    inDist,
    outDist,
  };
  return cachedFocusResult;
}

function computeTargetLabelAlpha(n, k, hasFocus, isPinned, isFocus, isHovered, isNeighbor, minHop) {
  if (isHovered || isFocus) return 1.0;
  if (state.pathNodeIds.size > 0) {
    return state.pathNodeIds.has(n.id) ? 1.0 : 0.04;
  }
  if (state.searchMatchIds.size > 0 || state.search) {
    if (state.searchMatchIds.has(n.id)) return 0.98;
    if (isNeighbor) return 0.84;
    return 0.0;
  }
  if (state.highlightCycles && state.cycleNodeIds.size > 0) {
    return state.cycleNodeIds.has(n.id) ? 0.95 : 0.06;
  }
  if (isNeighbor) return minHop === 1 ? 0.94 : Math.max(0.56, 0.92 - (minHop - 1) * 0.15);
  const minZ = n.minZoomForLabel ?? 0;
  const base = minZ <= 0 ? 0.9 : smoothstep(minZ, minZ + 0.35, k) * 0.88;
  if (!hasFocus) return base;
  return isPinned ? base * 0.12 : base * 0.38;
}

function stepChannel(obj, key, target, rate, snap) {
  const curr = obj[key];
  if (snap || curr === undefined) {
    obj[key] = target;
    return false;
  }
  const diff = target - curr;
  if (Math.abs(diff) > 0.004) {
    obj[key] = curr + diff * rate;
    return true;
  }
  obj[key] = target;
  return false;
}

function stepCameraAndEffects(snap, dt, now) {
  const hasPath = state.pathNodeIds.size > 0;
  const isPinned = Boolean(state.selectedId);

  let flowRunning = false;
  if ((isPinned || hasPath) && now < state.flowUntil) {
    state.flowPhase = (state.flowPhase + dt * 0.00052) % 1;
    state.flowIntensity = Math.min(1, (state.flowUntil - now) / 600);
    flowRunning = true;
  } else {
    state.flowIntensity = 0;
  }

  let ripplesRunning = false;
  if (state.selectionRipples.length > 0) {
    for (let i = state.selectionRipples.length - 1; i >= 0; i--) {
      if (now - state.selectionRipples[i].startTime >= state.selectionRipples[i].duration) {
        state.selectionRipples.splice(i, 1);
      }
    }
    ripplesRunning = state.selectionRipples.length > 0;
  }

  let camRunning = false;
  if (state.camTarget.active) {
    const camTau = state.camTarget.tau || 90;
    const camBlend = snap ? 1 : 1 - Math.exp(-dt / camTau);
    const dx = state.camTarget.x - state.cam.x;
    const dy = state.camTarget.y - state.cam.y;
    const dk = state.camTarget.k - state.cam.k;
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2 || Math.abs(dk) > 0.0006) {
      state.cam.x += dx * camBlend;
      state.cam.y += dy * camBlend;
      state.cam.k += dk * camBlend;
      camRunning = true;
    } else {
      state.cam.x = state.camTarget.x;
      state.cam.y = state.camTarget.y;
      state.cam.k = state.camTarget.k;
      state.camTarget.active = false;
    }
    updateZoomHudReadout();
  }

  const zoomBucket = Math.round(state.cam.k * 25);
  if (zoomBucket !== state.lastZoomBucket) {
    state.lastZoomBucket = zoomBucket;
    state.visualDirty = true;
  }

  return { flowRunning, ripplesRunning, camRunning };
}

function stepNodeSpringScale(n, targetScaleOffset, dtSec, snap) {
  if (snap) {
    n.scaleOffset = targetScaleOffset;
    n.scaleVel = 0;
    return false;
  }
  const currScale = n.scaleOffset ?? 0;
  const currVel = n.scaleVel ?? 0;
  const disp = currScale - targetScaleOffset;
  const accel = -420 * disp - 22 * currVel;
  const nextVel = currVel + accel * dtSec;
  const nextScale = currScale + nextVel * dtSec;
  if (Math.abs(nextScale - targetScaleOffset) > 0.002 || Math.abs(nextVel) > 0.01) {
    n.scaleOffset = nextScale;
    n.scaleVel = nextVel;
    return true;
  }
  n.scaleOffset = targetScaleOffset;
  n.scaleVel = 0;
  return false;
}

function stepNodeMorphPosition(n, snap, posBlend) {
  if (n.targetX === undefined || state.alpha !== 0 || n === state.draggingNode) {
    return { positionsMoved: false, stillMorphing: false, channelsMoving: false };
  }
  const dx = n.targetX - n.x;
  const dy = n.targetY - n.y;
  if (snap || (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2)) {
    n.x = n.targetX;
    n.y = n.targetY;
    n.targetX = undefined;
    n.targetY = undefined;
    return { positionsMoved: true, stillMorphing: false, channelsMoving: false };
  }
  n.x += dx * posBlend;
  n.y += dy * posBlend;
  return { positionsMoved: true, stillMorphing: true, channelsMoving: true };
}
function computeNodeTargetBodyAlpha(n, focusCtx, flags) {
  const { hasPath, hasSearch, hasCycleMode, hasFocus, focusPinned, hoveredId, hoverConnectedIds } = focusCtx;
  const { isFocus, isHovered, isNeighbor, isSearchHit, isPathNode, isCycleNode, isClusterHovered, minHop } = flags;
  if (hasPath)
    return isPathNode ? 1.0 : isHovered ? 0.88 : 0.15;
  if (hasFocus) {
    if (isFocus || isHovered || isClusterHovered) return 1.0;
    if (isNeighbor) return minHop === 1 ? 0.96 : Math.max(0.60, 0.95 - (minHop - 1) * 0.14);
    if (hoveredId && hoverConnectedIds.has(n.id)) return Math.max(focusPinned ? 0.62 : 0.78, 0.5);
    if (isSearchHit) return 0.78;
    return focusPinned ? 0.18 : 0.48;
  }
  if (hasSearch)
    return isSearchHit || isHovered || isClusterHovered ? 1.0 : 0.15;
  if (hasCycleMode)
    return isCycleNode || isHovered ? 1.0 : 0.18;
  return 1.0;
}
function stepSingleNodeVisualChannels(n, focusCtx, snap, blend, fastBlend, dtSec, k) {
  const { hasPath, hasSearch, hasCycleMode, hasFocus, focusPinned, focusIds, inSet, outSet, inDist, outDist, hoveredId } = focusCtx;
  const isFocus = hasFocus && focusIds.has(n.id);
  const isHovered = hoveredId === n.id;
  const isIn = hasFocus && inSet.has(n.id);
  const isOut = hasFocus && outSet.has(n.id);
  const isNeighbor = isIn || isOut;
  const hopIn = inDist?.get(n.id) ?? Infinity;
  const hopOut = outDist?.get(n.id) ?? Infinity;
  const minHop = Math.min(hopIn, hopOut);
  const isSearchHit = hasSearch && state.searchMatchIds.has(n.id);
  const isPathNode = hasPath && state.pathNodeIds.has(n.id);
  const isCycleNode = hasCycleMode && state.cycleNodeIds.has(n.id);
  const isClusterHovered = Boolean(state.hoveredClusterKey) && (n.fileGroup === state.hoveredClusterKey || n.dirGroup === state.hoveredClusterKey);
  const targetBody = computeNodeTargetBodyAlpha(n, focusCtx, { isFocus, isHovered, isNeighbor, isSearchHit, isPathNode, isCycleNode, isClusterHovered, minHop });
  const targetLabel = computeTargetLabelAlpha(n, k, hasFocus, focusPinned, isFocus, isHovered || isClusterHovered, isNeighbor, minHop);
  const targets = [
    ["renderAlpha", targetBody, blend],
    ["labelAlpha", targetLabel, blend],
    ["focusMix", isFocus || isPathNode || isSearchHit ? 1.0 : 0.0, blend],
    ["hoverMix", isHovered || isClusterHovered ? 1.0 : 0.0, fastBlend],
    ["inMix", !isFocus && isIn && hopIn <= hopOut ? 1.0 : 0.0, blend],
    ["outMix", !isFocus && isOut && hopOut < hopIn ? 1.0 : 0.0, blend],
    ["pathMix", isPathNode ? 1.0 : 0.0, blend],
    ["cycleMix", !isPathNode && isCycleNode ? 1.0 : 0.0, blend],
  ];
  const scaleOff = isFocus ? 0.18 : isHovered ? 0.12 : isNeighbor && minHop === 1 ? 0.05 : 0.0;
  let moved = stepNodeSpringScale(n, scaleOff, dtSec, snap);
  for (const [prop, val, chBlend] of targets) {
    if (stepChannel(n, prop, val, chBlend, snap)) moved = true;
  }
  return moved;
}
function stepAllNodeVisualChannels(focusCtx, snap, blend, fastBlend, posBlend, dtSec) {
  const k = state.cam.k;
  let channelsMoving = false;
  let positionsMoved = false;
  let stillMorphing = false;
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    const morph = stepNodeMorphPosition(n, snap, posBlend);
    if (morph.positionsMoved) positionsMoved = true;
    if (morph.stillMorphing) stillMorphing = true;
    if (morph.channelsMoving) channelsMoving = true;
    if (stepSingleNodeVisualChannels(n, focusCtx, snap, blend, fastBlend, dtSec, k))
      channelsMoving = true;
  }
  return { channelsMoving, positionsMoved, stillMorphing };
}

function computeEdgeHighlightMix(e, focusCtx, isPathEdge) {
  const { hasPath, hasFocus, focusPinned, focusIds, inSet, outSet, inDist, outDist, hoveredId } = focusCtx;
  let targetOut = 0;
  let targetIn = 0;
  if (hasFocus && !hasPath) {
    const isInternal = focusIds.has(e.source) && focusIds.has(e.target);
    const isOutEdge = (focusIds.has(e.source) || outSet.has(e.source)) && outSet.has(e.target);
    const isInEdge = inSet.has(e.source) && (focusIds.has(e.target) || inSet.has(e.target));
    if (isOutEdge || isInternal) {
      const hop = outDist?.get(e.target) ?? 1;
      targetOut = hop <= 1 ? 1.0 : Math.max(0.55, 1.0 - (hop - 1) * 0.16);
    } else if (isInEdge) {
      const hop = inDist?.get(e.source) ?? 1;
      targetIn = hop <= 1 ? 1.0 : Math.max(0.55, 1.0 - (hop - 1) * 0.16);
    }
  }
  const isHoverEdge = hoveredId && (e.source === hoveredId || e.target === hoveredId) && !isPathEdge && targetOut === 0 && targetIn === 0;
  const targetHover = isHoverEdge ? (focusPinned ? 0.58 : 0.78) : 0;
  return { targetOut, targetIn, targetHover };
}
function stepAllEdgeVisualChannels(focusCtx, snap, blend, fastBlend) {
  const { hasPath, hasCycleMode } = focusCtx;
  let channelsMoving = false;
  for (let i = 0; i < state.edges.length; i++) {
    const e = state.edges[i];
    const edgeKey = e.edgeKey ?? (e.edgeKey = `${e.source}→${e.target}`);
    const isPathEdge = hasPath && state.pathEdgeKeys.has(edgeKey);
    const isCycleEdge = !hasPath && hasCycleMode && state.cycleEdgeKeys.has(edgeKey);
    const { targetOut, targetIn, targetHover } = computeEdgeHighlightMix(e, focusCtx, isPathEdge);
    if (stepChannel(e, "pathMix", isPathEdge ? 1 : 0, blend, snap)) channelsMoving = true;
    if (stepChannel(e, "cycleMix", isCycleEdge ? 1 : 0, blend, snap)) channelsMoving = true;
    if (stepChannel(e, "outMix", targetOut, blend, snap)) channelsMoving = true;
    if (stepChannel(e, "inMix", targetIn, blend, snap)) channelsMoving = true;
    if (stepChannel(e, "hoverMix", targetHover, fastBlend, snap)) channelsMoving = true;
  }
  return channelsMoving;
}

function stepAllHullFocusChannels(focusIds, hoveredId, blend, snap) {
  let channelsMoving = false;
  for (let i = 0; i < state.clusterHulls.length; i++) {
    const h = state.clusterHulls[i];
    let targetHullFocus = state.hoveredClusterKey === h.key ? 0.95 : 0;
    if (focusIds && targetHullFocus < 1.0) {
      for (const fid of focusIds) {
        if (h.memberIds.has(fid)) {
          targetHullFocus = 1.0;
          break;
        }
      }
    }
    if (targetHullFocus < 0.65 && hoveredId && h.memberIds.has(hoveredId)) {
      targetHullFocus = 0.65;
    }
    if (stepChannel(h, "focusMix", targetHullFocus, blend, snap)) {
      channelsMoving = true;
    }
    state.hullFocusByKey.set(h.key, h.focusMix);
  }
  return channelsMoving;
}

function buildHoverConnectedIds(hoveredId) {
  const hoverConnectedIds = new Set();
  if (!hoveredId) return hoverConnectedIds;
  hoverConnectedIds.add(hoveredId);
  for (const s of state.adjIn.get(hoveredId) ?? []) hoverConnectedIds.add(s);
  for (const t of state.adjOut.get(hoveredId) ?? []) hoverConnectedIds.add(t);
  return hoverConnectedIds;
}

function updateMorphAndHullDirtyFlags(nodeStep) {
  if (nodeStep.stillMorphing) {
    state.isMorphingPositions = true;
    state.edgeCacheDirty = true;
    if (state.hullsDirty) rebuildClusterHulls();
    else updateClusterHullsFast();
  } else if (nodeStep.positionsMoved || state.isMorphingPositions) {
    state.isMorphingPositions = false;
    state.hullsDirty = true;
    state.edgeCacheDirty = true;
    populateSpatialGrid();
  }
  if (state.hullsDirty) rebuildClusterHulls();
}

function syncNodeVisualTargets(snap = false, dt = 16) {
  const { flowRunning, ripplesRunning, camRunning } = stepCameraAndEffects(snap, dt, performance.now());
  if (!snap && !state.visualDirty && state.channelsSettled && !state.hullsDirty && !state.isMorphingPositions) {
    return flowRunning || ripplesRunning || camRunning;
  }
  const { hasFocus, isPinned: focusPinned, focusIds, inSet, outSet, inDist, outDist } = resolveFocusState();
  const hasPath = state.pathNodeIds.size > 0;
  const hasSearch = Boolean(state.search);
  const hasCycleMode = state.highlightCycles && state.cycleNodeIds.size > 0;
  const blend = snap ? 1 : 1 - Math.exp(-dt / 95);
  const fastBlend = snap ? 1 : 1 - Math.exp(-dt / 52);
  const posBlend = snap ? 1 : 1 - Math.exp(-dt / 76);
  const targetGlobalFocus = (hasPath || hasSearch || hasCycleMode || (hasFocus && focusPinned)) ? 1.0 : (hasFocus ? 0.52 : 0.0);
  let channelsMoving = stepChannel(state, "focusMix", targetGlobalFocus, blend, snap);
  const hoveredId = state.hoveredId;
  const focusCtx = {
    hasPath, hasSearch, hasCycleMode, hasFocus, focusPinned,
    focusIds, inSet, outSet, inDist, outDist, hoveredId,
    hoverConnectedIds: buildHoverConnectedIds(hoveredId),
  };
  const nodeStep = stepAllNodeVisualChannels(focusCtx, snap, blend, fastBlend, posBlend, Math.min(0.032, dt * 0.001));
  if (nodeStep.channelsMoving) channelsMoving = true;
  if (stepAllEdgeVisualChannels(focusCtx, snap, blend, fastBlend)) channelsMoving = true;
  updateMorphAndHullDirtyFlags(nodeStep);
  if (stepAllHullFocusChannels(focusIds, hoveredId, blend, snap)) channelsMoving = true;
  state.visualDirty = false;
  state.channelsSettled = !channelsMoving;
  return channelsMoving || flowRunning || ripplesRunning || camRunning;
}

function drawWorldGrid(viewMinX, viewMaxX, viewMinY, viewMaxY, k) {
  if (k <= 0.28) return;
  const gridStep = k < 0.72 ? 96 : 48;
  const gridAlpha = smoothstep(0.28, 0.65, k) * 0.14 * (1 - state.focusMix * 0.35);
  if (gridAlpha <= 0.01) return;

  const startX = Math.floor(viewMinX / gridStep) * gridStep;
  const endX = Math.ceil(viewMaxX / gridStep) * gridStep;
  const startY = Math.floor(viewMinY / gridStep) * gridStep;
  const endY = Math.ceil(viewMaxY / gridStep) * gridStep;
  const dotR = Math.max(0.7, 1.05 / Math.sqrt(k));

  ctx.fillStyle = getCanvasTheme().gridDot;
  ctx.globalAlpha = gridAlpha;
  ctx.beginPath();
  for (let x = startX; x <= endX; x += gridStep) {
    for (let y = startY; y <= endY; y += gridStep) {
      ctx.moveTo(x + dotR, y);
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
    }
  }
  ctx.fill();
}

function appendSmoothHullSubpath(pts) {
  const len = pts.length;
  if (len < 3) return;
  const last = pts[len - 1];
  const first = pts[0];
  ctx.moveTo((last.x + first.x) * 0.5, (last.y + first.y) * 0.5);
  for (let j = 0; j < len; j++) {
    const curr = pts[j];
    const next = pts[(j + 1) % len];
    ctx.quadraticCurveTo(curr.x, curr.y, (curr.x + next.x) * 0.5, (curr.y + next.y) * 0.5);
  }
  ctx.closePath();
}

function traceSmoothHullPath(pts) {
  ctx.beginPath();
  appendSmoothHullSubpath(pts);
}

const restingHullBuckets = new Map();
const activeHullsScratch = [];
const headerHullsScratch = [];

function drawHullHeaderPills(headerHulls, headerFontSize, invSqrtK) {
  for (let i = 0; i < headerHulls.length; i++) {
    const h = headerHulls[i];
    const fMix = h.focusMix ?? 0;
    const isHoveredHull = state.hoveredClusterKey === h.key;
    const textAlpha = h._textAlpha;
    const textW = getCachedLabelWidth(h.label, headerFontSize, 600);
    const padX = 6.5 * invSqrtK;
    const padY = 2.6 * invSqrtK;
    const pillW = textW + padX * 2;
    const pillH = headerFontSize + padY * 2;
    const pillX = h.labelX - pillW * 0.5;
    const pillY = h.minY - pillH - 2 * invSqrtK;

    h.headerBox = {
      minX: pillX,
      maxX: pillX + pillW,
      minY: pillY,
      maxY: pillY + pillH,
    };

    const theme = getCanvasTheme();
    ctx.globalAlpha = textAlpha * (0.76 + fMix * 0.22);
    ctx.fillStyle = isHoveredHull ? theme.hullHoverBg : theme.hullBg;
    drawRoundedPill(pillX, pillY, pillW, pillH, 999);
    ctx.fill();

    ctx.globalAlpha = textAlpha * (0.35 + fMix * 0.55);
    ctx.strokeStyle = h.color;
    ctx.lineWidth = (isHoveredHull ? 1.35 : 0.95) * invSqrtK;
    ctx.stroke();

    ctx.globalAlpha = Math.min(1, textAlpha * 1.12);
    ctx.fillStyle = isHoveredHull ? theme.hullHoverText : h.color;
    ctx.fillText(h.label, h.labelX, pillY + pillH * 0.52);
  }
}

function drawClusterHullShapes(activeHulls, invSqrtK) {
  ctx.lineWidth = 1.1 * invSqrtK;
  for (const [color, bucket] of restingHullBuckets) {
    if (bucket.length === 0) continue;
    const baseAlpha = bucket[0].alpha ?? 1;
    ctx.beginPath();
    for (let i = 0; i < bucket.length; i++) {
      appendSmoothHullSubpath(bucket[i].hull);
    }
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.036 * baseAlpha;
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.14 * baseAlpha;
    ctx.stroke();
  }

  for (let i = 0; i < activeHulls.length; i++) {
    const h = activeHulls[i];
    const fMix = h.focusMix ?? 0;
    const baseAlpha = h.alpha ?? 1;
    traceSmoothHullPath(h.hull);
    ctx.fillStyle = h.color;
    ctx.globalAlpha = (0.036 + fMix * 0.068) * baseAlpha;
    ctx.fill();
    ctx.strokeStyle = h.color;
    ctx.lineWidth = (1.1 + fMix * 0.75) * invSqrtK;
    ctx.globalAlpha = (0.14 + fMix * 0.28) * baseAlpha;
    ctx.stroke();
  }
}

function classifyClusterHullForDraw(h, isSymbols, k, labelZoomFade, activeHulls, headerHulls) {
  h.headerBox = null;
  const baseAlpha = h.alpha ?? 1;
  if (baseAlpha <= 0.02) return;
  const fMix = h.focusMix ?? 0;
  const isHoveredHull = state.hoveredClusterKey === h.key;
  if (fMix <= 0.01 && !isHoveredHull) {
    let bucket = restingHullBuckets.get(h.color);
    if (!bucket) {
      bucket = [];
      restingHullBuckets.set(h.color, bucket);
    }
    if (bucket.length === 0 || Math.abs(baseAlpha - (bucket[0].alpha ?? 1)) < 0.02) bucket.push(h);
    else activeHulls.push(h);
  } else {
    activeHulls.push(h);
  }
  const screenHullW = (h.maxX - h.minX) * k;
  if (isSymbols && fMix < 0.1 && !isHoveredHull && (k < 0.35 || screenHullW < 56)) return;
  const textAlpha = (labelZoomFade * 0.74 + fMix * Math.max(0.28, 0.94 - labelZoomFade * 0.68)) * baseAlpha;
  if (textAlpha > 0.05) {
    h._textAlpha = textAlpha;
    headerHulls.push(h);
  }
}

function drawClusterHulls(viewMinX, viewMaxX, viewMinY, viewMaxY, k, invSqrtK) {
  if (state.hullsDirty) rebuildClusterHulls();
  const hulls = state.clusterHulls;
  if (!hulls.length) return;
  const isSymbols = state.activeTab === "symbols";
  const labelZoomFade = smoothstep(isSymbols ? 0.32 : 0.18, isSymbols ? 0.58 : 0.44, k) * (1 - smoothstep(1.75, 2.55, k));
  const headerFontSize = Math.max(9.5, Math.min(13, 10.6 / Math.pow(k, 0.35)));
  ctx.font = `600 ${headerFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  for (const bucket of restingHullBuckets.values()) bucket.length = 0;
  activeHullsScratch.length = 0;
  headerHullsScratch.length = 0;
  for (let i = 0; i < hulls.length; i++) {
    const h = hulls[i];
    if (h.maxX < viewMinX || h.minX > viewMaxX || h.maxY < viewMinY || h.minY > viewMaxY) {
      h.headerBox = null;
      continue;
    }
    classifyClusterHullForDraw(h, isSymbols, k, labelZoomFade, activeHullsScratch, headerHullsScratch);
  }
  drawClusterHullShapes(activeHullsScratch, invSqrtK);
  drawHullHeaderPills(headerHullsScratch, headerFontSize, invSqrtK);
}

function hitTestClusterHeader(clientX, clientY, worldPos) {
  const { x, y } = worldPos ?? screenToWorld(clientX, clientY);
  for (let i = state.clusterHulls.length - 1; i >= 0; i--) {
    const h = state.clusterHulls[i];
    const box = h.headerBox;
    if (!box) continue;
    if (x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY) {
      return h;
    }
  }
  return null;
}

/**
 * Solve for the exact quadratic Bezier parameter u in (0, 1) where ||B(u) - center|| = targetR
 * using 1-step Newton-Raphson refinement from the analytical terminal tangent estimate.
 */
function solveBezierCircleParam(sx, sy, cx, cy, tx, ty, centerX, centerY, targetR, fromEnd) {
  const tanX = fromEnd ? tx - cx : cx - sx;
  const tanY = fromEnd ? ty - cy : cy - sy;
  const tanSpeed = 2 * (Math.sqrt(tanX * tanX + tanY * tanY) || 1);
  let u = fromEnd
    ? Math.max(0.05, Math.min(0.996, 1 - targetR / tanSpeed))
    : Math.max(0.004, Math.min(0.95, targetR / tanSpeed));

  if (state.isMorphingPositions) return u;

  const inv = 1 - u;
  const bx = inv * inv * sx + 2 * inv * u * cx + u * u * tx;
  const by = inv * inv * sy + 2 * inv * u * cy + u * u * ty;
  const rx = bx - centerX;
  const ry = by - centerY;
  const r = Math.sqrt(rx * rx + ry * ry) || 0.0001;
  const err = r - targetR;
  if (Math.abs(err) >= 0.02) {
    const dBx = 2 * inv * (cx - sx) + 2 * u * (tx - cx);
    const dBy = 2 * inv * (cy - sy) + 2 * u * (ty - cy);
    const drDu = (rx * dBx + ry * dBy) / r;
    if (Math.abs(drDu) >= 0.001) {
      u = Math.max(0.004, Math.min(0.996, u - err / drDu));
    }
  }
  return u;
}

/**
 * Compute and store exact perimeter-clipped quadratic Bezier endpoints (via De Casteljau blossom)
 * and secant-aligned arrowhead coordinates so the curve terminates cleanly inside the arrowhead base
 * and the arrowhead tip sits on both the true Bezier curve and the target node's live outer border.
 */
function computeClippedEdgeGeometry(e, arrowLen) {
  const s = e.sourceNode;
  const t = e.targetNode;
  const cx = e._cx;
  const cy = e._cy;
  const sOuterR = s._outerR ?? s.radius;
  const tOuterR = t._outerR ?? t.radius;

  const u0 = solveBezierCircleParam(s.x, s.y, cx, cy, t.x, t.y, s.x, s.y, sOuterR, false);
  const uTip = solveBezierCircleParam(s.x, s.y, cx, cy, t.x, t.y, t.x, t.y, tOuterR, true);

  const invTip = 1 - uTip;
  const tipX = invTip * invTip * s.x + 2 * invTip * uTip * cx + uTip * uTip * t.x;
  const tipY = invTip * invTip * s.y + 2 * invTip * uTip * cy + uTip * uTip * t.y;

  const dTipX = 2 * invTip * (cx - s.x) + 2 * uTip * (t.x - cx);
  const dTipY = 2 * invTip * (cy - s.y) + 2 * uTip * (t.y - cy);
  const tipSpeed = Math.sqrt(dTipX * dTipX + dTipY * dTipY) || 1;

  const hasArrow = e._dist > sOuterR + tOuterR + arrowLen * 0.75 && uTip > u0 + 0.03;
  const u1 = hasArrow
    ? Math.max(u0 + 0.01, uTip - (arrowLen * 0.80) / tipSpeed)
    : Math.max(u0 + 0.01, uTip);

  const inv0 = 1 - u0;
  const sx = inv0 * inv0 * s.x + 2 * inv0 * u0 * cx + u0 * u0 * t.x;
  const sy = inv0 * inv0 * s.y + 2 * inv0 * u0 * cy + u0 * u0 * t.y;

  const inv1 = 1 - u1;
  const bx = inv1 * inv1 * s.x + 2 * inv1 * u1 * cx + u1 * u1 * t.x;
  const by = inv1 * inv1 * s.y + 2 * inv1 * u1 * cy + u1 * u1 * t.y;

  // Exact quadratic Bezier blossom control point B[u0, u1] for sub-segment [u0, u1]
  const w0 = inv0 * inv1;
  const w1 = u0 + u1 - 2 * u0 * u1;
  const w2 = u0 * u1;
  const scx = w0 * s.x + w1 * cx + w2 * t.x;
  const scy = w0 * s.y + w1 * cy + w2 * t.y;

  // Secant-aligned unit vector from curve base B(u1) to curve tip B(uTip)
  let ux = tipX - bx;
  let uy = tipY - by;
  const secDist = Math.sqrt(ux * ux + uy * uy);
  if (secDist > 0.001) {
    ux /= secDist;
    uy /= secDist;
  } else {
    ux = dTipX / tipSpeed;
    uy = dTipY / tipSpeed;
  }

  e._sx = sx;
  e._sy = sy;
  e._scx = scx;
  e._scy = scy;
  e._bx = bx;
  e._by = by;
  e._tipX = tipX;
  e._tipY = tipY;
  e._ux = ux;
  e._uy = uy;
  e._uStart = u0;
  e._uTip = uTip;
  e._hasArrow = hasArrow;
  e._clippedArrowLen = arrowLen;
}

function appendCurveArrowhead(e, arrowLen) {
  if (!e._hasArrow) return;
  const ax = e._tipX;
  const ay = e._tipY;
  const ux = e._ux;
  const uy = e._uy;
  const wing = arrowLen * 0.46;
  const notch = arrowLen * 0.82;
  ctx.moveTo(ax, ay);
  ctx.lineTo(ax - ux * arrowLen - uy * wing, ay - uy * arrowLen + ux * wing);
  ctx.lineTo(ax - ux * notch, ay - uy * notch);
  ctx.lineTo(ax - ux * arrowLen + uy * wing, ay - uy * arrowLen - ux * wing);
  ctx.closePath();
}

function drawRoundedPill(x, y, w, h, r) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Reusable per-color node bucket map & scratch arrays to batch draw calls without per-frame allocations
const restingNodeBuckets = new Map();
const restingHealthSevereScratch = [];
const restingHealthWarnScratch = [];
const activeEdgesScratch = [];
const bgHeavyEdgesScratch = [];
const bgVisibleEdgesScratch = [];
const featuredNodesScratch = [];
const restingLabelsScratch = [];
const activeLabelsScratch = [];

function refreshNodeRadiiAndEdgeGeometry(invSqrtK, arrowLen, drawBgArrows) {
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    const focusMix = n.focusMix ?? 0;
    const hoverMix = n.hoverMix ?? 0;
    const pathMix = n.pathMix ?? 0;
    const activeLift = Math.max(focusMix, hoverMix * 0.75, pathMix);
    const springScale = 1 + (n.scaleOffset ?? 0);
    const drawR = Math.max(3, n.radius * springScale + activeLift * 1.15);
    n._drawR = drawR;
    n._activeLift = activeLift;
    n._outerR = drawR + (0.65 + activeLift * 0.55) * invSqrtK;
  }

  const needClipRefresh =
    state.edgeCacheDirty || Math.abs(arrowLen - state.lastClippedArrowLen) > 0.65;
  if (needClipRefresh) {
    const recomputeBaseCurve = state.edgeCacheDirty;
    const fastMorphClip = state.isMorphingPositions && !drawBgArrows;
    for (let i = 0; i < state.edges.length; i++) {
      const e = state.edges[i];
      const s = e.sourceNode;
      const t = e.targetNode;
      if (!s || !t) continue;
      if (recomputeBaseCurve || e._cx === undefined) {
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const invDist = 1 / dist;
        const offset = e.isBidirectional
          ? Math.min(20, Math.max(6.5, dist * 0.105))
          : Math.min(14, Math.max(3.5, dist * 0.062));
        e._cx = (s.x + t.x) * 0.5 - dy * invDist * offset;
        e._cy = (s.y + t.y) * 0.5 + dx * invDist * offset;
        e._dist = dist;
        if (fastMorphClip) {
          const ux = dx * invDist;
          const uy = dy * invDist;
          const sR = s._outerR ?? s.radius;
          const tR = t._outerR ?? t.radius;
          e._sx = s.x + ux * sR;
          e._sy = s.y + uy * sR;
          e._bx = t.x - ux * tR;
          e._by = t.y - uy * tR;
          e._scx = e._cx;
          e._scy = e._cy;
          e._hasArrow = false;
          e._clippedArrowLen = 0;
          continue;
        }
      }
      computeClippedEdgeGeometry(e, arrowLen);
    }
    state.edgeCacheDirty = false;
    state.lastClippedArrowLen = arrowLen;
  }
}

function edgeInViewBounds(s, t, cx, cy, viewMinX, viewMaxX, viewMinY, viewMaxY) {
  return !(
    (s.x < viewMinX && t.x < viewMinX && cx < viewMinX) ||
    (s.x > viewMaxX && t.x > viewMaxX && cx > viewMaxX) ||
    (s.y < viewMinY && t.y < viewMinY && cy < viewMinY) ||
    (s.y > viewMaxY && t.y > viewMaxY && cy > viewMaxY)
  );
}

function strokeBgEdgeBatches(bgHeavyEdges, bgVisibleEdges, theme, invSqrtK, arrowLen, bgEdgeAlpha, drawBgArrows) {
  if (bgHeavyEdges.length > 0) {
    ctx.beginPath();
    for (let i = 0; i < bgHeavyEdges.length; i++) {
      const e = bgHeavyEdges[i];
      ctx.moveTo(e._sx, e._sy);
      ctx.quadraticCurveTo(e._scx, e._scy, e._bx, e._by);
    }
    ctx.strokeStyle = theme.edgeHeavy;
    ctx.lineWidth = 1.3 * invSqrtK;
    ctx.globalAlpha = Math.min(0.52, bgEdgeAlpha * 1.18);
    ctx.stroke();
  }
  if (drawBgArrows && bgVisibleEdges.length > 0) {
    ctx.beginPath();
    for (let i = 0; i < bgVisibleEdges.length; i++) {
      appendCurveArrowhead(bgVisibleEdges[i], arrowLen);
    }
    ctx.fillStyle = theme.edgeHeavy;
    ctx.globalAlpha = Math.min(0.55, bgEdgeAlpha * 1.15);
    ctx.fill();
  }
}

function drawBackgroundAndCollectActiveEdges(viewMinX, viewMaxX, viewMinY, viewMaxY, invSqrtK, arrowLen, bgEdgeAlpha, drawBgArrows) {
  activeEdgesScratch.length = 0;
  bgHeavyEdgesScratch.length = 0;
  bgVisibleEdgesScratch.length = 0;
  const activeEdges = activeEdgesScratch;
  const bgHeavyEdges = bgHeavyEdgesScratch;
  const bgVisibleEdges = bgVisibleEdgesScratch;
  const theme = getCanvasTheme();
  ctx.beginPath();
  for (let i = 0; i < state.edges.length; i++) {
    const e = state.edges[i];
    const s = e.sourceNode;
    const t = e.targetNode;
    if (!s || !t) continue;
    const cx = e._scx ?? (s.x + t.x) * 0.5;
    const cy = e._scy ?? (s.y + t.y) * 0.5;
    if (!edgeInViewBounds(s, t, cx, cy, viewMinX, viewMaxX, viewMinY, viewMaxY)) continue;
    const maxChannel = Math.max(e.pathMix ?? 0, e.cycleMix ?? 0, e.outMix ?? 0, e.inMix ?? 0, e.hoverMix ?? 0);
    if (maxChannel > 0.01) activeEdges.push(e);
    if (maxChannel >= 0.96) continue;
    if (drawBgArrows && maxChannel <= 0.35) bgVisibleEdges.push(e);
    if ((e.weight ?? 1) > 1) bgHeavyEdges.push(e);
    else {
      ctx.moveTo(e._sx, e._sy);
      ctx.quadraticCurveTo(e._scx, e._scy, e._bx, e._by);
    }
  }
  ctx.strokeStyle = theme.edgeBase;
  ctx.lineWidth = 1.0 * invSqrtK;
  ctx.globalAlpha = bgEdgeAlpha;
  ctx.stroke();
  strokeBgEdgeBatches(bgHeavyEdges, bgVisibleEdges, theme, invSqrtK, arrowLen, bgEdgeAlpha, drawBgArrows);
  return activeEdges;
}

function strokeHighlightedEdgeChannel(e, mix, color, widthBoost, drawFlow, arrowLen, invSqrtK) {
  if (mix <= 0.01) return;
  const s = e.sourceNode;
  const t = e.targetNode;
  const endAlpha = Math.min(s.renderAlpha ?? 1, t.renderAlpha ?? 1);
  const alpha = mix * 0.94 * endAlpha;
  if (alpha <= 0.01) return;

  const activeArrowLen = arrowLen * (1.02 + mix * 0.14);
  if (Math.abs((e._clippedArrowLen ?? 0) - activeArrowLen) > 0.15) {
    computeClippedEdgeGeometry(e, activeArrowLen);
  }

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth =
    Math.min(3.4, (1.22 + Math.log2((e.weight ?? 1) + 1) * 0.42) * (0.88 + mix * 0.24) * widthBoost) * invSqrtK;

  ctx.beginPath();
  ctx.moveTo(e._sx, e._sy);
  ctx.quadraticCurveTo(e._scx, e._scy, e._bx, e._by);
  ctx.stroke();

  if (e._hasArrow) {
    ctx.beginPath();
    appendCurveArrowhead(e, activeArrowLen);
    ctx.fill();

    if (drawFlow && mix > 0.15 && state.flowIntensity > 0.01) {
      const pulseCount = e._dist > 110 ? 2 : 1;
      const dotR = Math.min(3.4, Math.max(1.8, 2.35 * invSqrtK));
      const uSpan = Math.max(0.05, e._uTip - e._uStart);
      for (let p = 0; p < pulseCount; p++) {
        const rawT = (state.flowPhase + p * (1 / pulseCount)) % 1;
        const u = e._uStart + rawT * uSpan;
        const invU = 1 - u;
        const px = invU * invU * s.x + 2 * invU * u * e._cx + u * u * t.x;
        const py = invU * invU * s.y + 2 * invU * u * e._cy + u * u * t.y;
        const edgeFade = Math.sin(rawT * Math.PI) * state.flowIntensity;

        ctx.globalAlpha = alpha * edgeFade * 0.36;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, py, dotR * 2.1, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = alpha * edgeFade * 0.95;
        ctx.fillStyle = getCanvasTheme().flowCore;
        ctx.beginPath();
        ctx.arc(px, py, dotR * 0.85, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawSelectionRipple(rip, now, theme, invSqrtK) {
  const n = rip.node;
  if (!n) return;
  const p = Math.min(1, Math.max(0, (now - rip.startTime) / rip.duration));
  const easeOut = 1 - Math.pow(1 - p, 3);
  const alpha1 = (1 - p) * 0.62;
  if (alpha1 > 0.01) {
    ctx.globalAlpha = alpha1;
    ctx.strokeStyle = rip.color;
    ctx.lineWidth = (2.1 - p * 1.2) * invSqrtK;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + easeOut * 38 * invSqrtK, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (p > 0.16) {
    const p2 = (p - 0.16) / 0.84;
    const ease2 = 1 - Math.pow(1 - p2, 3);
    ctx.globalAlpha = (1 - p2) * 0.42;
    ctx.strokeStyle = theme.rippleInner;
    ctx.lineWidth = 1.2 * invSqrtK;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius + ease2 * 24 * invSqrtK, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawActiveEdgesAndSelectionRipples(activeEdges, arrowLen, invSqrtK) {
  const flowActive = state.flowIntensity > 0.01 && (Boolean(state.selectedId) || state.pathNodeIds.size > 0);
  const theme = getCanvasTheme();
  for (let i = 0; i < activeEdges.length; i++) {
    const e = activeEdges[i];
    if ((e.hoverMix ?? 0) > 0.01) {
      strokeHighlightedEdgeChannel(e, e.hoverMix, e.source === state.hoveredId ? "#fbbf24" : "#7dd3fc", 1.0, false, arrowLen, invSqrtK);
    }
    if ((e.inMix ?? 0) > 0.01) strokeHighlightedEdgeChannel(e, e.inMix, "#38bdf8", 1.05, flowActive, arrowLen, invSqrtK);
    if ((e.outMix ?? 0) > 0.01) strokeHighlightedEdgeChannel(e, e.outMix, "#f59e0b", 1.05, flowActive, arrowLen, invSqrtK);
    if ((e.cycleMix ?? 0) > 0.01) strokeHighlightedEdgeChannel(e, e.cycleMix, "#f43f5e", 1.2, false, arrowLen, invSqrtK);
    if ((e.pathMix ?? 0) > 0.01) strokeHighlightedEdgeChannel(e, e.pathMix, "#34d399", 1.35, flowActive, arrowLen, invSqrtK);
  }
  if (state.selectionRipples.length > 0) {
    const now = performance.now();
    for (let i = 0; i < state.selectionRipples.length; i++) {
      drawSelectionRipple(state.selectionRipples[i], now, theme, invSqrtK);
    }
  }
}

function classifyVisibleNodeBucket(n, bodyAlpha, haloMix, roleMix, featuredNodes) {
  if (haloMix > 0.02 || roleMix > 0.02 || n.isHub) {
    featuredNodes.push(n);
    return;
  }
  let bucket = restingNodeBuckets.get(n.color);
  if (!bucket) {
    bucket = [];
    restingNodeBuckets.set(n.color, bucket);
  }
  if (bucket.length > 0 && Math.abs(bodyAlpha - (bucket[0].renderAlpha ?? 1)) >= 0.02) {
    featuredNodes.push(n);
    return;
  }
  bucket.push(n);
  if (bodyAlpha > 0.3) {
    const hTier = resolveNodeHealthTier(n);
    if (hTier === "severe") restingHealthSevereScratch.push(n);
    else if (hTier === "warn") restingHealthWarnScratch.push(n);
  }
}

function partitionVisibleNodesAndLabels(viewMinX, viewMaxX, viewMinY, viewMaxY) {
  for (const bucket of restingNodeBuckets.values()) bucket.length = 0;
  restingHealthSevereScratch.length = 0;
  restingHealthWarnScratch.length = 0;
  featuredNodesScratch.length = 0;
  restingLabelsScratch.length = 0;
  activeLabelsScratch.length = 0;
  const featuredNodes = featuredNodesScratch;
  const restingLabels = restingLabelsScratch;
  const activeLabels = activeLabelsScratch;
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    if (n.x + n.radius < viewMinX || n.x - n.radius > viewMaxX || n.y + n.radius < viewMinY || n.y - n.radius > viewMaxY) continue;
    const bodyAlpha = n.renderAlpha ?? 1;
    if (bodyAlpha <= 0.01) continue;
    const focusMix = n.focusMix ?? 0;
    const hoverMix = n.hoverMix ?? 0;
    const pathMix = n.pathMix ?? 0;
    const cycleMix = n.cycleMix ?? 0;
    const haloMix = Math.max(pathMix, focusMix, hoverMix * 0.85, cycleMix * 0.75);
    const roleMix = Math.max(pathMix, focusMix, hoverMix, cycleMix, n.inMix ?? 0, n.outMix ?? 0);
    classifyVisibleNodeBucket(n, bodyAlpha, haloMix, roleMix, featuredNodes);
    if ((n.labelAlpha ?? 0) > 0.02) {
      if (Math.max(focusMix, hoverMix, pathMix) > 0.06 || n.isHub) activeLabels.push(n);
      else restingLabels.push(n);
    }
  }
  return { featuredNodes, restingLabels, activeLabels };
}

function drawBatchedHealthRings(nodesList, strokeColor, invSqrtK) {
  if (nodesList.length === 0) return;
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth = 1.35 * invSqrtK;
  const ringPad = 2.2 * invSqrtK;
  ctx.beginPath();
  for (let i = 0; i < nodesList.length; i++) {
    const n = nodesList[i];
    const r = (n._drawR ?? n.radius) + ringPad;
    ctx.moveTo(n.x + r, n.y);
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
  }
  ctx.stroke();
}

function drawBatchedRestingNodes(isDenseSymbols, k, invSqrtK) {
  const theme = getCanvasTheme();
  ctx.lineWidth = 1.15 * invSqrtK;
  ctx.strokeStyle = theme.nodeStroke;
  const drawRestingSpecular = !isDenseSymbols && k > 0.52;
  for (const [color, bucket] of restingNodeBuckets) {
    if (bucket.length === 0) continue;
    const groupAlpha = bucket[0].renderAlpha ?? 1;
    ctx.globalAlpha = groupAlpha;
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < bucket.length; i++) {
      const n = bucket[i];
      const r = n._drawR ?? n.radius;
      ctx.moveTo(n.x + r, n.y);
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.stroke();

    if (drawRestingSpecular) {
      ctx.globalAlpha = groupAlpha * 0.20;
      ctx.fillStyle = theme.specular;
      ctx.beginPath();
      for (let i = 0; i < bucket.length; i++) {
        const n = bucket[i];
        const r = n._drawR ?? n.radius;
        if (r <= 5) continue;
        const sx = n.x - r * 0.24;
        const sy = n.y - r * 0.24;
        const sr = r * 0.46;
        ctx.moveTo(sx + sr, sy);
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  ctx.globalAlpha = 0.78;
  drawBatchedHealthRings(restingHealthSevereScratch, theme.healthSevere, invSqrtK);
  drawBatchedHealthRings(restingHealthWarnScratch, theme.healthWarn, invSqrtK);
}

function drawFeaturedNodes(featuredNodes, k, invSqrtK) {
  const theme = getCanvasTheme();
  for (let i = 0; i < featuredNodes.length; i++) {
    const n = featuredNodes[i];
    const bodyAlpha = n.renderAlpha ?? 1;
    const focusMix = n.focusMix ?? 0;
    const hoverMix = n.hoverMix ?? 0;
    const inMix = n.inMix ?? 0;
    const outMix = n.outMix ?? 0;
    const pathMix = n.pathMix ?? 0;
    const cycleMix = n.cycleMix ?? 0;
    const activeLift = n._activeLift ?? Math.max(focusMix, hoverMix * 0.75, pathMix);
    const drawR = n._drawR ?? n.radius;

    if (n.isHub && bodyAlpha > 0.35) {
      ctx.globalAlpha = bodyAlpha * (0.22 + focusMix * 0.25);
      ctx.strokeStyle = n.color;
      ctx.lineWidth = 1.05 * invSqrtK;
      ctx.beginPath();
      ctx.arc(n.x, n.y, drawR + 3.2 * invSqrtK, 0, Math.PI * 2);
      ctx.stroke();
    }

    const healthTier = bodyAlpha > 0.3 ? resolveNodeHealthTier(n) : null;
    if (healthTier) {
      ctx.globalAlpha = bodyAlpha * 0.82;
      ctx.strokeStyle = healthTier === "severe" ? theme.healthSevere : theme.healthWarn;
      ctx.lineWidth = 1.35 * invSqrtK;
      ctx.beginPath();
      ctx.arc(n.x, n.y, drawR + 2.2 * invSqrtK, 0, Math.PI * 2);
      ctx.stroke();
    }

    const haloMix = Math.max(pathMix, focusMix, hoverMix * 0.85, cycleMix * 0.75);
    if (haloMix > 0.02) {
      const haloColor =
        pathMix >= focusMix && pathMix >= hoverMix && pathMix > 0.1
          ? "#34d399"
          : cycleMix > focusMix && cycleMix > hoverMix && cycleMix > 0.1
            ? "#f43f5e"
            : focusMix >= hoverMix
              ? n.color
              : theme.haloHover;
      ctx.globalAlpha = bodyAlpha * haloMix * 0.26;
      ctx.fillStyle = haloColor;
      ctx.beginPath();
      ctx.arc(n.x, n.y, drawR + (3.6 + haloMix * 2.8) * invSqrtK, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = bodyAlpha;
    ctx.beginPath();
    ctx.arc(n.x, n.y, drawR, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();

    if (k > 0.42 && drawR > 5) {
      ctx.globalAlpha = bodyAlpha * 0.22;
      ctx.fillStyle = theme.specular;
      ctx.beginPath();
      ctx.arc(n.x - drawR * 0.24, n.y - drawR * 0.24, drawR * 0.46, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.globalAlpha = bodyAlpha;
    ctx.lineWidth = (1.15 + activeLift * 1.1) * invSqrtK;
    ctx.strokeStyle = theme.nodeStroke;
    ctx.beginPath();
    ctx.arc(n.x, n.y, drawR, 0, Math.PI * 2);
    ctx.stroke();

    const roleMix = Math.max(pathMix, focusMix, hoverMix, cycleMix, inMix, outMix);
    if (roleMix > 0.02) {
      const ringColor =
        pathMix >= roleMix - 0.01
          ? "#34d399"
          : focusMix >= roleMix - 0.01 || hoverMix >= roleMix - 0.01
            ? theme.activeRingFocus
            : cycleMix >= roleMix - 0.01
              ? "#f43f5e"
              : inMix >= outMix
                ? "#38bdf8"
                : "#f59e0b";
      ctx.globalAlpha = bodyAlpha * roleMix;
      ctx.strokeStyle = ringColor;
      ctx.stroke();
    }
  }
}

function drawNodeLabels(restingLabels, activeLabels, k, invSqrtK) {
  const theme = getCanvasTheme();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const baseFontSize = Math.max(9.5, Math.min(12.5, 10.8 / Math.pow(k, 0.35)));

  if (restingLabels.length > 0) {
    ctx.font = `500 ${baseFontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = theme.labelText;
    const yOffset = 4.5 * invSqrtK;
    for (let i = 0; i < restingLabels.length; i++) {
      const n = restingLabels[i];
      const alpha = (n.labelAlpha ?? 0) * Math.min(1, (n.renderAlpha ?? 1) * 1.35);
      if (alpha <= 0.02) continue;
      ctx.globalAlpha = alpha;
      ctx.fillText(n.label, n.x, n.y + (n._drawR ?? n.radius) + yOffset);
    }
  }

  for (let i = 0; i < activeLabels.length; i++) {
    const n = activeLabels[i];
    const alpha = (n.labelAlpha ?? 0) * Math.min(1, (n.renderAlpha ?? 1) * 1.35);
    if (alpha <= 0.02) continue;
    const pillMix = Math.max(n.focusMix ?? 0, n.hoverMix ?? 0, n.pathMix ?? 0);
    const fontWeight = 600;
    const fontSize = baseFontSize * (pillMix > 0.35 ? 1.06 : 1.03);
    const drawR = n._drawR ?? n.radius;
    const labelY = n.y + drawR + (4.5 + pillMix * 1.2) * invSqrtK;

    ctx.font = `${fontWeight} ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;

    if (pillMix > 0.06) {
      const textW = getCachedLabelWidth(n.label, fontSize, fontWeight);
      const padX = 5.8 * invSqrtK;
      const padY = 2.4 * invSqrtK;
      const pillW = textW + padX * 2;
      const pillH = fontSize + padY * 2;
      const pillX = n.x - pillW * 0.5;
      const pillY = labelY - padY;

      ctx.globalAlpha = alpha * pillMix * 0.9;
      ctx.fillStyle = theme.pillBg;
      drawRoundedPill(pillX, pillY, pillW, pillH, 5 * invSqrtK);
      ctx.fill();

      ctx.globalAlpha = alpha * pillMix * 0.55;
      ctx.strokeStyle = (n.pathMix ?? 0) > 0.5 ? "#34d399" : n.color;
      ctx.lineWidth = 1.05 * invSqrtK;
      ctx.stroke();
    }

    ctx.globalAlpha = alpha;
    ctx.fillStyle = pillMix > 0.35 ? theme.activeLabelText : theme.brightLabelText;
    ctx.fillText(n.label, n.x, labelY);
  }
}

function drawCanvas() {
  const rect = el.canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(rect.width * dpr);
  const targetH = Math.round(rect.height * dpr);
  if (el.canvas.width !== targetW || el.canvas.height !== targetH) {
    el.canvas.width = targetW;
    el.canvas.height = targetH;
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const { x: tx, y: ty, k } = state.cam;
  ctx.translate(tx, ty);
  ctx.scale(k, k);

  const padWorld = 85 / k;
  const viewMinX = -tx / k - padWorld;
  const viewMaxX = (rect.width - tx) / k + padWorld;
  const viewMinY = -ty / k - padWorld;
  const viewMaxY = (rect.height - ty) / k + padWorld;

  const invSqrtK = 1 / Math.sqrt(k);
  const arrowLen = Math.min(8.2, Math.max(4.5, 5.8 * invSqrtK));
  const isDenseSymbols = state.activeTab === "symbols" && state.edges.length > 350;
  const baseBgAlpha = isDenseSymbols ? 0.24 : 0.34;
  const bgEdgeAlpha = Math.max(0.06, baseBgAlpha - state.focusMix * (baseBgAlpha - 0.08));
  const drawBgArrows = !isDenseSymbols
    ? (state.focusMix < 0.92 && k > 0.22) || k > 0.72
    : state.focusMix < 0.85 && k > 0.85;

  refreshNodeRadiiAndEdgeGeometry(invSqrtK, arrowLen, drawBgArrows);
  drawWorldGrid(viewMinX, viewMaxX, viewMinY, viewMaxY, k);
  drawClusterHulls(viewMinX, viewMaxX, viewMinY, viewMaxY, k, invSqrtK);

  const activeEdges = drawBackgroundAndCollectActiveEdges(
    viewMinX,
    viewMaxX,
    viewMinY,
    viewMaxY,
    invSqrtK,
    arrowLen,
    bgEdgeAlpha,
    drawBgArrows
  );
  drawActiveEdgesAndSelectionRipples(activeEdges, arrowLen, invSqrtK);

  const { featuredNodes, restingLabels, activeLabels } = partitionVisibleNodesAndLabels(
    viewMinX,
    viewMaxX,
    viewMinY,
    viewMaxY
  );
  drawBatchedRestingNodes(isDenseSymbols, k, invSqrtK);
  drawFeaturedNodes(featuredNodes, k, invSqrtK);
  drawNodeLabels(restingLabels, activeLabels, k, invSqrtK);

  ctx.restore();
}

function tick(now = performance.now()) {
  state.rafId = 0;
  const dt = state.lastFrameTime ? Math.min(50, Math.max(4, now - state.lastFrameTime)) : 16;
  state.lastFrameTime = now;

  const movingPhysics = stepPhysics();
  const movingTransitions = syncNodeVisualTargets(false, dt);
  drawCanvas();

  if (movingPhysics || movingTransitions) {
    state.rafId = requestAnimationFrame(tick);
  } else {
    state.lastFrameTime = 0;
  }
}

function requestDraw(withSim = false) {
  state.visualDirty = true;
  if (withSim) state.alpha = 1.0;
  if (!state.rafId) {
    state.rafId = requestAnimationFrame(tick);
  }
}

function toggleOutlineSidebar(forceOpen) {
  state.outlineOpen = typeof forceOpen === "boolean" ? forceOpen : !state.outlineOpen;
  el.outlineSidebar?.classList.toggle("collapsed", !state.outlineOpen);
  el.outlineToggleBtn?.classList.toggle("active", state.outlineOpen);
  el.outlineToggleBtn?.setAttribute("aria-expanded", String(state.outlineOpen));
  requestDraw();
}

function buildOutlineDirHtml(dir, entries, hasSearch) {
  const html = [];
  const dirCollapsed = !hasSearch && state.collapsedDirs.has(dir);
  const dirColor = colorForDir(dir);
  html.push(`<div class="outline-dir${dirCollapsed ? " collapsed" : ""}" data-dir-group="${escapeHtml(dir)}">`);
  html.push(
    `<div class="outline-dir-header" data-toggle-dir="${escapeHtml(dir)}">` +
      `<div class="outline-dir-left">` +
        `<span class="outline-chevron">▾</span>` +
        `<span class="outline-dir-dot" style="background:${dirColor}"></span>` +
        `<span class="outline-dir-name">${escapeHtml(dir)}/</span>` +
      `</div>` +
      `<div class="outline-dir-meta">` +
        `<button type="button" class="outline-focus-cluster-btn" data-focus-cluster="${escapeHtml(dir)}" title="Zoom to directory cluster">Focus</button>` +
        `<span>${entries.length}</span>` +
      `</div>` +
    `</div>`
  );
  html.push(`<div class="outline-dir-body">`);
  for (const { file, syms } of entries) {
    const fIn = (state.wiringIn.get(file.id) ?? []).length;
    const fOut = (state.wiringOut.get(file.id) ?? []).length;
    const fileSel = state.selectedId === file.id ? " selected" : "";
    const fileCollapsed = !hasSearch && state.collapsedFiles.has(file.id);
    const shortName = file.path.startsWith(dir + "/") ? file.path.slice(dir.length + 1) : file.path;
    html.push(`<div class="outline-file${fileCollapsed ? " collapsed" : ""}" data-file-id="${escapeHtml(file.id)}">`);
    html.push(
      `<div class="outline-file-row${fileSel}" data-node-id="${escapeHtml(file.id)}" data-file-path="${escapeHtml(file.path)}">` +
        `<div class="outline-file-left">` +
          (syms.length > 0
            ? `<span class="outline-file-chevron" data-toggle-file="${escapeHtml(file.id)}" title="Expand/collapse symbols">▾</span>`
            : `<span class="outline-file-chevron" style="opacity:0.25">·</span>`) +
          `<span class="outline-file-name" title="${escapeHtml(file.path)}">${escapeHtml(shortName)}</span>` +
        `</div>` +
        `<span class="outline-sym-meta">${syms.length}s · ←${fIn} →${fOut}</span>` +
      `</div>`
    );
    if (syms.length > 0) {
      html.push(`<div class="outline-symbols">`);
      for (const s of syms) {
        const sIn = (state.wiringIn.get(s.id) ?? []).length;
        const sOut = (state.wiringOut.get(s.id) ?? []).length;
        const symSel = state.selectedId === s.id ? " selected" : "";
        html.push(
          `<div class="outline-sym-row${symSel}" data-node-id="${escapeHtml(s.id)}" title="${escapeHtml(s.signature || s.name)}">` +
            `<span class="outline-sym-badge" style="color:${KIND_COLORS[s.kind] ?? "#93a8ff"}">${escapeHtml(s.kind.slice(0, 4))}</span>` +
            `<span class="outline-sym-name">${escapeHtml(s.name)}</span>` +
            `<span class="outline-sym-meta">←${sIn} →${sOut}</span>` +
          `</div>`
        );
      }
      html.push(`</div>`);
    }
    html.push(`</div>`);
  }
  html.push(`</div></div>`);
  return html.join("");
}

function renderOutlineView(preserveScroll = true) {
  if (!el.outlineList) return;
  const prevScrollTop = el.outlineList.scrollTop;
  const cg = state.codeGraph;
  state.lastOutlineKey = `${cg?.nodes?.length ?? 0}::${state.scopeFilter}::${state.search}`;
  if (!cg?.nodes?.length) {
    if (el.outlineCount) el.outlineCount.textContent = "0";
    el.outlineList.innerHTML = `<div class="empty-state">No wiring graph found — run <code>plexer build</code> first.</div>`;
    return;
  }

  const files = cg.nodes
    .filter((n) => n.kind === "file")
    .sort((a, b) => a.path.localeCompare(b.path));

  if (!state.filesCollapseInitialized && files.length > 8) {
    state.filesCollapseInitialized = true;
    for (const f of files) {
      state.collapsedFiles.add(f.id);
    }
  }

  const byDir = new Map();
  let matchedSymbols = 0;
  let matchedFiles = 0;

  for (const f of files) {
    const allSyms = state.fileSymbols.get(f.path) ?? [];
    const syms = allSyms.filter((s) => matchesFilter(s.path, s.name));
    const fileHit = matchesFilter(f.path, f.name);
    if (!fileHit && syms.length === 0) continue;
    matchedFiles++;
    matchedSymbols += state.search ? syms.length : allSyms.length;
    const dir = dirGroupOf(f.path);
    const list = byDir.get(dir) ?? [];
    list.push({ file: f, syms: state.search ? syms : allSyms });
    byDir.set(dir, list);
  }

  if (el.outlineCount) {
    el.outlineCount.textContent = `${matchedFiles}f · ${matchedSymbols}s`;
  }

  if (byDir.size === 0) {
    el.outlineList.innerHTML = `<div class="empty-state">No files or symbols match "${escapeHtml(state.search)}".</div>`;
    return;
  }

  const hasSearch = Boolean(state.search);
  const html = [];
  for (const [dir, entries] of byDir) {
    html.push(buildOutlineDirHtml(dir, entries, hasSearch));
  }
  el.outlineList.innerHTML = html.join("");
  if (preserveScroll) {
    el.outlineList.scrollTop = prevScrollTop;
  }
}

function syncOutlineSelection(selectedId, scrollIntoView = true) {
  if (!el.outlineList) return;
  if (selectedId) {
    const wNode = state.wiringById.get(selectedId);
    if (wNode?.path) {
      const dir = dirGroupOf(wNode.path);
      state.collapsedDirs.delete(dir);
      const dirEl = el.outlineList.querySelector(`[data-dir-group="${CSS.escape(dir)}"]`);
      dirEl?.classList.remove("collapsed");
      if (wNode.kind !== "file") {
        state.collapsedFiles.delete(wNode.path);
        const fileEl = el.outlineList.querySelector(`[data-file-id="${CSS.escape(wNode.path)}"]`);
        fileEl?.classList.remove("collapsed");
      }
    }
  }

  for (const row of el.outlineList.querySelectorAll(".selected")) {
    row.classList.remove("selected");
  }
  if (!selectedId) return;
  const activeRow = el.outlineList.querySelector(`[data-node-id="${CSS.escape(selectedId)}"]`);
  if (activeRow) {
    activeRow.classList.add("selected");
    if (scrollIntoView && state.outlineOpen) {
      activeRow.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }
}

function renderLegend() {
  const hasCycles = state.cycleEdgeKeys.size > 0;
  if (!state.legend.length && !hasCycles) {
    el.hudLegend.classList.add("hidden");
    el.hudLegend.innerHTML = "";
    return;
  }
  el.hudLegend.classList.remove("hidden");
  const chips = state.legend.map((item) => {
    const isActive = state.legendFilter === item.key;
    const isDimmed = state.legendFilter && !isActive;
    const cls = isActive ? " active" : isDimmed ? " dimmed" : "";
    return (
      `<button type="button" class="legend-item${cls}" data-legend-key="${escapeHtml(item.key)}" title="Click to filter by ${escapeHtml(item.label)}">` +
        `<span class="legend-dot" style="background:${item.color}"></span>${escapeHtml(item.label)}` +
      `</button>`
    );
  });
  if (hasCycles) {
    const activeCls = state.highlightCycles ? " active" : "";
    const count = state.cycleEdgeKeys.size;
    chips.push(
      `<button type="button" class="legend-item cycle-chip${activeCls}" data-cycle-toggle="1" title="Highlight circular dependencies (${count} cyclic edge${count === 1 ? "" : "s"})">` +
        `⟳ ${count} cycle${count === 1 ? "" : "s"}` +
      `</button>`
    );
  }
  el.hudLegend.innerHTML = chips.join("");
}

function assignLabelZoomThresholds(nodes) {
  const N = nodes.length;
  if (N === 0) return;
  const isSymbols = state.activeTab === "symbols";
  const ranked = [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.id.localeCompare(b.id));
  const hubCutoff = Math.max(2, Math.min(isSymbols ? 8 : 10, Math.ceil(N * 0.10)));
  const alwaysShowCount = isSymbols && N > 90 ? 12 : 18;
  const midTierCount = isSymbols && N > 90 ? 45 : 65;
  for (let rank = 0; rank < N; rank++) {
    const n = ranked[rank];
    n.isHub = (n.degree ?? 0) >= 4 && rank < hubCutoff;
    if (N <= 45 || rank < alwaysShowCount || n.isHub) {
      n.minZoomForLabel = 0;
    } else if (rank < midTierCount || (n.degree ?? 0) >= (isSymbols ? 4 : 3)) {
      n.minZoomForLabel = isSymbols ? 0.72 : 0.62;
    } else {
      n.minZoomForLabel = (isSymbols ? 1.02 : 0.95) + ((rank - midTierCount) / Math.max(1, N - midTierCount)) * 0.45;
    }
  }
}

function getLayoutCacheKey() {
  return `${state.activeTab}::${state.scopeFilter || ""}::${state.legendFilter || ""}::${state.nodes.length}::${state.edges.length}`;
}

function snapshotLayoutToCache() {
  const key = getLayoutCacheKey();
  const snap = new Map();
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    snap.set(n.id, {
      x: n.targetX ?? n.x,
      y: n.targetY ?? n.y,
      anchorX: n.anchorX,
      anchorY: n.anchorY,
      dirAnchorX: n.dirAnchorX,
      dirAnchorY: n.dirAnchorY,
      homeOffsetX: n.homeOffsetX,
      homeOffsetY: n.homeOffsetY,
      clusterRadius: n.clusterRadius,
      dirRadius: n.dirRadius,
    });
  }
  state.layoutCache.set(key, snap);
}

function runWarmLayout() {
  layoutGraph(state.nodes);
  const warmSteps = state.activeTab === "symbols" ? (state.nodes.length > 180 ? 6 : 12) : 22;
  state.alpha = 1.0;
  for (let i = 0; i < warmSteps; i++) stepPhysics();
  state.alpha = 0;
  snapshotLayoutToCache();
}

function snapshotPreviousNodePositions() {
  const prevPosById = new Map();
  const prevFileAcc = new Map();
  const prevDirAcc = new Map();
  for (let i = 0; i < state.nodes.length; i++) {
    const old = state.nodes[i];
    if (!Number.isFinite(old.x) || !Number.isFinite(old.y)) continue;
    prevPosById.set(old.id, old);
    if (old.fileGroup) {
      const fa = prevFileAcc.get(old.fileGroup) ?? { sx: 0, sy: 0, count: 0 };
      fa.sx += old.x;
      fa.sy += old.y;
      fa.count++;
      prevFileAcc.set(old.fileGroup, fa);
    }
    if (old.dirGroup) {
      const da = prevDirAcc.get(old.dirGroup) ?? { sx: 0, sy: 0, count: 0 };
      da.sx += old.x;
      da.sy += old.y;
      da.count++;
      prevDirAcc.set(old.dirGroup, da);
    }
  }
  return { prevPosById, prevFileAcc, prevDirAcc };
}

function restoreOrComputeLayout(forceRelayout) {
  const cacheKey = getLayoutCacheKey();
  const cachedLayout = !forceRelayout ? state.layoutCache.get(cacheKey) : null;
  if (cachedLayout && cachedLayout.size === state.nodes.length) {
    for (let i = 0; i < state.nodes.length; i++) {
      const n = state.nodes[i];
      const saved = cachedLayout.get(n.id);
      if (saved) {
        n.x = saved.x;
        n.y = saved.y;
        n.anchorX = saved.anchorX;
        n.anchorY = saved.anchorY;
        n.dirAnchorX = saved.dirAnchorX;
        n.dirAnchorY = saved.dirAnchorY;
        n.homeOffsetX = saved.homeOffsetX;
        n.homeOffsetY = saved.homeOffsetY;
        n.clusterRadius = saved.clusterRadius;
        n.dirRadius = saved.dirRadius;
        n.vx = 0;
        n.vy = 0;
      }
    }
    state.alpha = 0;
    rebuildPhysicsClusters();
  } else {
    runWarmLayout();
  }
}

function seedAnimatedNodeMorphPositions(prevPosById, prevFileAcc, prevDirAcc) {
  rebuildClusterHulls();
  for (let i = 0; i < state.nodes.length; i++) {
    const n = state.nodes[i];
    n.targetX = n.x;
    n.targetY = n.y;
    const same = prevPosById.get(n.id);
    const fAcc = n.fileGroup ? prevFileAcc.get(n.fileGroup) : null;
    const dAcc = n.dirGroup ? prevDirAcc.get(n.dirGroup) : null;

    if (same) {
      n.x = same.x;
      n.y = same.y;
      n.renderAlpha = same.renderAlpha ?? 0.9;
      n.labelAlpha = same.labelAlpha ?? 0;
      n.focusMix = same.focusMix ?? 0;
    } else if (fAcc && fAcc.count > 0) {
      const fx = fAcc.sx / fAcc.count;
      const fy = fAcc.sy / fAcc.count;
      n.x = fx + (n.targetX - fx) * 0.14;
      n.y = fy + (n.targetY - fy) * 0.14;
      n.renderAlpha = 0.08;
      n.labelAlpha = 0;
      n.focusMix = 0;
    } else if (dAcc && dAcc.count > 0) {
      const dx = dAcc.sx / dAcc.count;
      const dy = dAcc.sy / dAcc.count;
      n.x = dx * 0.65 + n.targetX * 0.35;
      n.y = dy * 0.65 + n.targetY * 0.35;
      n.renderAlpha = 0.04;
      n.labelAlpha = 0;
      n.focusMix = 0;
    } else {
      n.x = n.targetX * 0.86;
      n.y = n.targetY * 0.86;
      n.renderAlpha = 0.0;
      n.labelAlpha = 0;
      n.focusMix = 0;
    }
  }
  updateClusterHullsFast();
  state.hullsDirty = false;
  state.isMorphingPositions = true;
  populateSpatialGrid();
  fitToScreen(true);
  requestDraw(false);
}

function preservePositionsOnLiveReload(prevPosById) {
  let needsLayout = false;
  for (const n of state.nodes) {
    const prev = prevPosById.get(n.id);
    if (prev) {
      n.x = prev.x;
      n.y = prev.y;
      n.anchorX = prev.anchorX ?? prev.x;
      n.anchorY = prev.anchorY ?? prev.y;
      n.homeOffsetX = prev.homeOffsetX ?? 0;
      n.homeOffsetY = prev.homeOffsetY ?? 0;
      n.clusterRadius = prev.clusterRadius ?? 32;
      n.dirRadius = prev.dirRadius ?? 48;
      n.vx = 0;
      n.vy = 0;
      n.renderAlpha = prev.renderAlpha;
      n.labelAlpha = prev.labelAlpha;
      n.focusMix = prev.focusMix;
    } else {
      needsLayout = true;
    }
  }
  if (needsLayout) {
    runWarmLayout();
  } else {
    rebuildPhysicsClusters();
  }
  state.hullsDirty = true;
  populateSpatialGrid();
  syncNodeVisualTargets(false);
  requestDraw(false);
}

function setTreemapStatusHtml(text) {
  const msgColor = getCanvasTheme().isLight ? "#475569" : "#94a3b8";
  el.treemapFrame.srcdoc = `<p style='padding:16px;font-family:sans-serif;color:${msgColor}'>${text}</p>`;
}

async function fetchTreemapSrcdoc(reqId) {
  try {
    const res = await apiFetch("/api/treemap");
    if (reqId !== sidecarState.treemapReqSeq) return;
    if (res?.ok) el.treemapFrame.srcdoc = await res.text();
    else setTreemapStatusHtml("Treemap unavailable — run plexer build first.");
  } catch {
    if (reqId === sidecarState.treemapReqSeq) setTreemapStatusHtml("Failed to load treemap.");
  }
}

async function ensureTreemapLoaded(force = false) {
  if (!el.treemapFrame) return;
  if (!el.treemapFrame.dataset.syncWired) {
    el.treemapFrame.dataset.syncWired = "1";
    el.treemapFrame.addEventListener("load", () => syncTreemapFocus());
  }
  if (window.__PLEXER_DATA__?.treemapHtml) {
    if (force || !el.treemapFrame.srcdoc) el.treemapFrame.srcdoc = window.__PLEXER_DATA__.treemapHtml;
    else syncTreemapFocus();
    return;
  }
  const key = `${sidecarState.pinnedWs}:${sidecarState.lastRev}:${state.contextGraph?.meta?.repoRoot || ""}`;
  if (!force && sidecarState.treemapLoadedKey === key && (el.treemapFrame.srcdoc || el.treemapFrame.getAttribute("src"))) {
    syncTreemapFocus();
    return;
  }
  sidecarState.treemapLoadedKey = key;
  const reqId = ++sidecarState.treemapReqSeq;
  if (sidecarState.active) await fetchTreemapSrcdoc(reqId);
  else el.treemapFrame.src = "/api/treemap";
}

function rebuildActiveView(resetLayout = true, forceRelayout = false) {
  clearShortestPath();
  clearTimeout(state.hoverTimer);
  state.hoveredId = null;
  state.activeHoverId = null;
  state.hoveredClusterKey = null;
  cachedFocusKey = "";
  cachedFocusResult = null;

  const isTreemap = state.activeTab === "treemap";
  document.body.classList.toggle("treemap-active", isTreemap);
  if (isTreemap) {
    el.canvasStage.classList.add("hidden");
    el.canvasHud?.classList.add("hidden");
    el.zoomHud?.classList.add("hidden");
    el.outlineSidebar?.classList.add("collapsed");
    el.treemapStage?.classList.remove("hidden");
    ensureTreemapLoaded(forceRelayout);
    return;
  }

  el.outlineSidebar?.classList.toggle("collapsed", !state.outlineOpen);
  el.treemapStage?.classList.add("hidden");
  el.canvasStage.classList.remove("hidden");
  el.canvasHud?.classList.remove("hidden");
  el.zoomHud?.classList.remove("hidden");

  const { prevPosById, prevFileAcc, prevDirAcc } = snapshotPreviousNodePositions();

  const built =
    state.activeTab === "modules"
      ? buildModulesView()
      : state.activeTab === "symbols"
        ? buildSymbolsView()
        : buildContextView();

  state.nodes = built.nodes;
  state.edges = built.edges;
  state.legend = built.legend;
  state.nodeById = new Map(built.nodes.map((n) => [n.id, n]));
  state.adjIn = new Map();
  state.adjOut = new Map();

  assignLabelZoomThresholds(state.nodes);

  for (const e of built.edges) {
    e.sourceNode = state.nodeById.get(e.source) ?? null;
    e.targetNode = state.nodeById.get(e.target) ?? null;
    e.edgeKey = `${e.source}→${e.target}`;

    const outSet = state.adjOut.get(e.source) ?? new Set();
    outSet.add(e.target);
    state.adjOut.set(e.source, outSet);

    const inSet = state.adjIn.get(e.target) ?? new Set();
    inSet.add(e.source);
    state.adjIn.set(e.target, inSet);
  }
  for (const e of built.edges) {
    e.isBidirectional = Boolean(state.adjOut.get(e.target)?.has(e.source));
  }

  computeGraphCycles();
  updateSearchMatches();

  if (built.empty) {
    el.canvasEmpty.textContent = built.empty;
    el.canvasEmpty.classList.remove("hidden");
  } else {
    el.canvasEmpty.classList.add("hidden");
  }

  el.hudStats.textContent = `${built.nodes.length} nodes · ${built.edges.length} edges`;
  renderLegend();

  if (resetLayout) {
    restoreOrComputeLayout(forceRelayout);
    const shouldAnimate = state.hasInitialLoad && prevPosById.size > 0;
    state.hasInitialLoad = true;
    if (shouldAnimate) {
      seedAnimatedNodeMorphPositions(prevPosById, prevFileAcc, prevDirAcc);
    } else {
      state.hullsDirty = true;
      populateSpatialGrid();
      fitToScreen(false);
      syncNodeVisualTargets(true);
      requestDraw(false);
    }
  } else {
    preservePositionsOnLiveReload(prevPosById);
  }
}

/**
 * Focus and frame a symbol or file's symbol cluster in the Symbols tab.
 */
function focusInSymbolsView(targetId) {
  if (!targetId) return;
  state.selectedId = targetId;
  if (state.activeTab !== "symbols") {
    setActiveTab("symbols");
  }

  const wNode = state.wiringById.get(targetId);
  const clusterNodes = [];
  if (wNode?.kind === "file") {
    for (const s of state.fileSymbols.get(wNode.path) ?? []) {
      const cn = state.nodeById.get(s.id);
      if (cn) clusterNodes.push(cn);
    }
  } else {
    const cn = state.nodeById.get(targetId);
    if (cn) {
      clusterNodes.push(cn);
      for (const nId of state.adjIn.get(targetId) ?? []) {
        const nb = state.nodeById.get(nId);
        if (nb) clusterNodes.push(nb);
      }
      for (const nId of state.adjOut.get(targetId) ?? []) {
        const nb = state.nodeById.get(nId);
        if (nb) clusterNodes.push(nb);
      }
    }
  }

  openInspector(targetId);
  if (clusterNodes.length === 1) {
    centerOnNode(clusterNodes[0]);
  } else if (clusterNodes.length > 1) {
    fitNodesToScreen(clusterNodes, 1.55);
  }
}

function renderEvidenceSection(evidence) {
  if (!evidence?.length) return "";
  const blocks = evidence
    .map((ev) => {
      const linesHtml = (ev.lines ?? [])
        .map((l) => {
          const cls = l.sign === "+" ? " add" : l.sign === "-" ? " del" : "";
          return (
            `<div class="insp-code-line${cls}">` +
              `<span class="insp-line-num">${escapeHtml(l.n ?? "")}</span>` +
              `<span class="insp-line-sign">${escapeHtml(l.sign ?? " ")}</span>` +
              `<span>${escapeHtml(l.text ?? "")}</span>` +
            `</div>`
          );
        })
        .join("");
      const moreHtml = ev.more ? `<div class="insp-evidence-more">… +${escapeHtml(ev.more)} more line(s)</div>` : "";
      return (
        `<div class="insp-evidence-block">` +
          `<div class="insp-evidence-header">` +
            `<span class="insp-evidence-label">${escapeHtml(ev.label ?? "")}</span>` +
            (ev.note ? `<span class="insp-evidence-note">${escapeHtml(ev.note)}</span>` : "") +
          `</div>` +
          `<pre class="insp-evidence-code">${linesHtml}</pre>` +
          moreHtml +
        `</div>`
      );
    })
    .join("");
  return `<div><div class="insp-section-title">Code Evidence (${evidence.length})</div><div class="insp-edge-list">${blocks}</div></div>`;
}

function renderOwnersSection(owners) {
  if (!owners?.length) return "";
  const rows = owners
    .map((o) => {
      const handle = o.handle ? ` (@${o.handle})` : "";
      const meta = [o.commits ? `${o.commits} commit${o.commits === 1 ? "" : "s"}` : "", o.last ?? ""].filter(Boolean).join(" · ");
      return (
        `<div class="insp-owner-row">` +
          `<span class="insp-owner-name">${escapeHtml(o.name ?? "Owner")}${escapeHtml(handle)}</span>` +
          `<span class="insp-owner-meta">${escapeHtml(meta)}</span>` +
        `</div>`
      );
    })
    .join("");
  return `<div><div class="insp-section-title">Suggested Reviewers / Owners (${owners.length})</div><div class="insp-edge-list">${rows}</div></div>`;
}

const PREVIEW_COLLAPSED_LINES = 35;

function renderSourceBox(nodeId, srcData) {
  if (!el.inspSourceBox || state.selectedId !== nodeId) return;
  if (!srcData?.lines?.length) {
    el.inspSourceBox.classList.add("hidden");
    el.inspSourceBox.innerHTML = "";
    return;
  }
  el.inspSourceBox.classList.remove("hidden");
  const focusIss = state.focusedIssue && state.focusedIssue.path === srcData.path ? state.focusedIssue : null;
  const focusRange = focusIss ? parseSpanRange(focusIss.span) : null;
  const isExpanded = state.sourceExpanded.has(nodeId) || Boolean(focusRange);
  const allLines = srcData.lines;
  const shownLines = isExpanded ? allLines : allLines.slice(0, PREVIEW_COLLAPSED_LINES);
  const hiddenCount = Math.max(0, (srcData.spanEndLine ?? srcData.endLine) - srcData.startLine + 1 - shownLines.length);

  const severeCls = focusIss && classifyIssueUrgency(focusIss) === "severe" ? " is-severe" : "";
  const codeHtml = shownLines
    .map((l) => {
      const inIssue = focusRange && l.n >= focusRange.start && l.n <= focusRange.end;
      const lineCls = inIssue ? `insp-code-line is-highlighted${severeCls}` : "insp-code-line";
      const row =
        `<div class="${lineCls}" data-line-num="${escapeHtml(l.n)}">` +
          `<span class="insp-line-num">${escapeHtml(l.n)}</span>` +
          `<span>${escapeHtml(l.text)}</span>` +
        `</div>`;
      if (inIssue && l.n === focusRange.start) {
        return (
          row +
          `<div class="insp-issue-callout${severeCls}">` +
            `<strong>[${escapeHtml(focusIss.tier || "T2")} · ${escapeHtml(focusIss.detector || "issue")}]</strong> ` +
            `${escapeHtml(focusIss.summary || "")}` +
          `</div>`
        );
      }
      return row;
    })
    .join("");

  const toggleCollapseTxt = state.sourceCollapsed ? "Show" : "Hide";
  const bodyHidden = state.sourceCollapsed ? " hidden" : "";
  const canExpand = allLines.length > PREVIEW_COLLAPSED_LINES || srcData.truncated || isExpanded;
  const footerHtml = canExpand
    ? `<div class="insp-source-footer${bodyHidden}">` +
        `<span>${shownLines.length} of ${ (srcData.spanEndLine ?? srcData.endLine) - srcData.startLine + 1 } lines (${srcData.totalLines} in file)</span>` +
        `<button type="button" class="btn-xs" data-source-expand="${escapeHtml(nodeId)}">` +
          (isExpanded ? "Show fewer lines" : `Expand (+${hiddenCount} lines)`) +
        `</button>` +
      `</div>`
    : "";

  el.inspSourceBox.innerHTML =
    `<div class="insp-source-header">` +
      `<span class="insp-source-title">Source · L${srcData.startLine}–${srcData.startLine + shownLines.length - 1}</span>` +
      `<div class="insp-source-actions">` +
        `<button type="button" class="btn-xs" data-source-copy="${escapeHtml(nodeId)}">Copy Code</button>` +
        `<button type="button" class="btn-xs" data-source-collapse="1">${toggleCollapseTxt}</button>` +
      `</div>` +
    `</div>` +
    `<pre class="insp-source-code${bodyHidden}">${codeHtml}</pre>` +
    footerHtml;

  if (focusRange) {
    const firstHighlighted = el.inspSourceBox.querySelector(".insp-code-line.is-highlighted");
    firstHighlighted?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

async function fetchAndRenderSource(wNode, overrideSpan = null) {
  if (!el.inspSourceBox) return;
  if (window.__PLEXER_DATA__ || !wNode?.path) {
    el.inspSourceBox.classList.add("hidden");
    el.inspSourceBox.innerHTML = "";
    return;
  }
  const nodeId = wNode.id;
  const spanQuery = overrideSpan ?? wNode.span ?? "";
  const wantFull = state.sourceExpanded.has(nodeId);
  const cacheKey = `${wNode.path}:${spanQuery}:${wantFull ? "full" : "default"}`;
  if (state.sourceCache.has(cacheKey)) {
    renderSourceBox(nodeId, state.sourceCache.get(cacheKey));
    return;
  }

  const reqId = ++state.sourceReqSeq;
  try {
    const url = `/api/source?path=${encodeURIComponent(wNode.path)}&span=${encodeURIComponent(spanQuery)}${wantFull ? "&full=1" : ""}`;
    const res = await apiFetch(url);
    if (!res.ok) {
      if (reqId === state.sourceReqSeq) el.inspSourceBox.classList.add("hidden");
      return;
    }
    const data = await res.json();
    state.sourceCache.set(cacheKey, data);
    if (reqId === state.sourceReqSeq && state.selectedId === nodeId) {
      renderSourceBox(nodeId, data);
    }
  } catch {
    if (reqId === state.sourceReqSeq) {
      el.inspSourceBox.classList.add("hidden");
    }
  }
}

function setInspectorOpenState(isOpen) {
  el.inspector.classList.toggle("hidden", !isOpen);
  document.body.classList.toggle("inspector-open", isOpen);
}

function closeInspector(syncHash = false) {
  state.selectedId = null;
  setInspectorOpenState(false);
  syncOutlineSelection(null, false);
  if (syncHash) syncUrlHash(false);
  requestDraw();
}

function renderContextEdgeSection(title, edges, endpointKey) {
  if (!edges.length) return "";
  const items = edges
    .map((e) => {
      const otherId = e[endpointKey];
      const other = state.nodeById.get(otherId)?.label ?? otherId;
      const desc = e.description ? `<div class="insp-edge-desc">${escapeHtml(e.description)}</div>` : "";
      return `<div class="insp-edge-item" data-jump-id="${escapeHtml(otherId)}"><div class="insp-edge-top"><span class="insp-edge-name">${escapeHtml(other)}</span><span class="insp-edge-rel">${escapeHtml(e.relation)}</span></div>${desc}</div>`;
    })
    .join("");
  return `<div><div class="insp-section-title">${escapeHtml(title)} (${edges.length})</div><div class="insp-edge-list">${items}</div></div>`;
}

function buildWiringInspectorSections(wNode) {
  const sections = [];
  const byFile = state.health?.by_file;
  const fileHealth = wNode.path && byFile && Object.hasOwn(byFile, wNode.path) ? byFile[wNode.path] : null;
  if (fileHealth && fileHealth.count > 0) {
    const hItems = (fileHealth.issues ?? [])
      .map(
        (iss) =>
          `<div class="insp-edge-item insp-health-item" data-issue-path="${escapeHtml(wNode.path)}" data-issue-span="${escapeHtml(iss.span ?? "L1")}" data-issue-det="${escapeHtml(iss.detector)}" data-issue-tier="${escapeHtml(iss.tier)}" data-issue-sev="${escapeHtml(iss.severity)}" data-issue-summary="${escapeHtml(iss.summary)}">` +
            `<div class="insp-edge-top">` +
              `<span class="insp-edge-name">${escapeHtml(iss.detector)}</span>` +
              `<div class="insp-health-actions">` +
                `<span class="insp-edge-rel">${escapeHtml(iss.tier)} · ${escapeHtml(iss.severity)}</span>` +
                (sidecarState.active ? `<button type="button" class="btn-xs" data-open-issue-line="1" title="Open at ${escapeHtml(iss.span ?? "L1")}">Open</button>` : "") +
              `</div>` +
            `</div>` +
            `<div class="insp-edge-loc">${escapeHtml(iss.span ?? "L1")} · ${escapeHtml(iss.summary)}</div>` +
          `</div>`
      )
      .join("");
    sections.push(
      `<div><div class="insp-section-title">Health Findings (${fileHealth.count})</div><div class="insp-edge-list">${hItems}</div></div>`
    );
  }
  const targetIds = new Set([wNode.id]);
  if (wNode.kind === "file") {
    for (const s of state.fileSymbols.get(wNode.path) ?? []) targetIds.add(s.id);
  }

  const inEdges = [];
  const outEdges = [];
  for (const tid of targetIds) {
    for (const e of state.wiringIn.get(tid) ?? []) {
      if (!targetIds.has(e.source)) inEdges.push(e);
    }
    for (const e of state.wiringOut.get(tid) ?? []) {
      if (!targetIds.has(e.target)) outEdges.push(e);
    }
  }

  sections.push(renderEdgeSection("← Incoming (Callers / Dependents)", inEdges, "source"));
  sections.push(renderEdgeSection("→ Outgoing (Callees / Dependencies)", outEdges, "target"));

  if (wNode.kind === "file") {
    const syms = state.fileSymbols.get(wNode.path) ?? [];
    if (syms.length > 0) {
      const items = syms
        .map(
          (s) =>
            `<div class="insp-edge-item" data-jump-id="${escapeHtml(s.id)}">` +
              `<div class="insp-edge-top"><span class="insp-edge-name">${escapeHtml(s.name)}</span><span class="insp-edge-rel">${escapeHtml(s.kind)}</span></div>` +
              `<div class="insp-edge-loc">${escapeHtml(s.span)}${s.signature ? " · " + escapeHtml(s.signature.slice(0, 60)) : ""}</div>` +
            `</div>`
        )
        .join("");
      sections.push(`<div><div class="insp-section-title">Symbols in File (${syms.length})</div><div class="insp-edge-list">${items}</div></div>`);
    }
  }
  return sections;
}

function buildContextInspectorSections(cNode, id) {
  const sections = [];
  if (Array.isArray(cNode.workers) && cNode.workers.length > 0) {
    const chips = cNode.workers
      .map((w) => {
        const prefix = w.isSwarmWorker === false ? "" : "@";
        const meta = w.action || w.state || "active";
        return `<button type="button" class="worker-chip" data-worker-conv="${escapeHtml(w.conversationId || "")}" title="Open ${escapeHtml(prefix + w.name)} chat">${escapeHtml(prefix + w.name)} · ${escapeHtml(meta)}</button>`;
      })
      .join("");
    sections.push(`<div><div class="insp-section-title">Session / Swarm Actors (${cNode.workers.length})</div><div class="worker-chips">${chips}</div></div>`);
  }
  if (cNode.evidence?.length) {
    sections.push(renderEvidenceSection(cNode.evidence));
  }
  if (cNode.owners?.length) {
    sections.push(renderOwnersSection(cNode.owners));
  }
  const inEdges = (state.contextGraph?.edges ?? []).filter((e) => e.target === id);
  const outEdges = (state.contextGraph?.edges ?? []).filter((e) => e.source === id);
  if (cNode.sources?.length) {
    const srcItems = cNode.sources
      .map((s) => {
        const text = typeof s === "string" ? s : s.path;
        const filePart = String(text ?? "").split(" · ")[0].split(":")[0];
        const jumpAttr = state.wiringById.has(filePart) ? ` data-jump-id="${escapeHtml(filePart)}"` : "";
        return `<div class="insp-edge-item"${jumpAttr}><div class="insp-edge-loc">${escapeHtml(text)}</div></div>`;
      })
      .join("");
    sections.push(`<div><div class="insp-section-title">Sources (${cNode.sources.length})</div><div class="insp-edge-list">${srcItems}</div></div>`);
  }
  if (inEdges.length) sections.push(renderContextEdgeSection("← Incoming", inEdges, "source"));
  if (outEdges.length) sections.push(renderContextEdgeSection("→ Outgoing", outEdges, "target"));
  return sections;
}

function updateInspectorLocationAndActions(id, node, wNode, cNode) {
  const relFile = wNode?.path || cNode?.relFile || cNode?.file || "";
  if (relFile) {
    state.treemapFocusPath = relFile;
    if (state.activeTab === "treemap") syncTreemapFocus();
  }
  const repoUri = state.contextGraph?.meta?.repoUri || "";
  state.selectedRelFile = relFile;
  state.selectedSpan = node.span || "";
  state.selectedFileUri = (relFile && repoUri)
    ? `${repoUri.replace(/\/$/, "")}/${relFile.replace(/^\//, "").split("/").map(encodeURIComponent).join("/")}`
    : "";
  el.inspLoc.textContent = node.path ? (node.span ? `${node.path}:${node.span}` : node.path) : (relFile || id);

  const canSidecarOpen = sidecarState.active && Boolean(window.sidecar?.openFile || window.sidecar?.ui) && Boolean(state.selectedFileUri);
  const canSidecarComment = sidecarState.active && Boolean(window.sidecar?.ui?.addArtifactComment) && Boolean(state.selectedFileUri);
  el.inspOpenFile?.classList.toggle("hidden", !canSidecarOpen);
  el.inspPinPrompt?.classList.toggle("hidden", !canSidecarComment);
  el.inspPinBundle?.classList.toggle("hidden", !canSidecarComment && !wNode && !cNode);
  return relFile;
}

function populateInspectorHeaderAndBody(id, node, wNode, cNode) {
  const kind = node.kind ?? node.type ?? "node";
  el.inspKind.textContent = kind;
  el.inspKind.style.color = KIND_COLORS[kind] ?? "#93a8ff";

  const dir = node.path ? dirGroupOf(node.path) : "";
  el.inspScope.textContent = dir || "";
  el.inspScope.classList.toggle("hidden", !dir);
  el.inspTitle.textContent = node.name ?? id;

  const relFile = updateInspectorLocationAndActions(id, node, wNode, cNode);
  const previewNode = wNode ?? (relFile ? state.wiringById.get(relFile) : null);
  el.inspFocusSymbols.classList.toggle("hidden", !previewNode);
  el.inspControlsRow?.classList.remove("hidden");
  renderPathBox();

  el.inspSig.textContent = node.signature || "";
  el.inspSig.classList.toggle("hidden", !node.signature);
  el.inspSummary.textContent = node.summary || "";
  el.inspSummary.classList.toggle("hidden", !node.summary);

  if (previewNode) fetchAndRenderSource(previewNode);
  else el.inspSourceBox?.classList.add("hidden");

  const sections = wNode ? buildWiringInspectorSections(wNode) : cNode ? buildContextInspectorSections(cNode, id) : [];
  el.inspSections.innerHTML = sections.join("");
}

function openInspector(id, pushHistory = true, scrollOutline = true) {
  const selectionChanged = state.selectedId !== id;
  if (selectionChanged) {
    clearShortestPath();
    state.focusedIssue = null;
  }
  state.selectedId = id;
  const wNode = state.wiringById.get(id);
  const cNode = state.nodeById.get(id)?.raw;
  const node = wNode ?? cNode;
  if (!node) {
    setInspectorOpenState(false);
    syncOutlineSelection(null, false);
    requestDraw();
    return;
  }

  setInspectorOpenState(true);
  if (selectionChanged) {
    if (el.inspector) el.inspector.scrollTop = 0;
    triggerSelectionAnimation(id);
  }
  syncOutlineSelection(id, scrollOutline);
  populateInspectorHeaderAndBody(id, node, wNode, cNode);
  syncUrlHash(pushHistory);
  requestDraw();
}

function renderEdgeSection(title, edges, endpointKey) {
  if (edges.length === 0) {
    return `<div><div class="insp-section-title">${escapeHtml(title)} (0)</div><div class="insp-edge-loc">None</div></div>`;
  }
  const seen = new Set();
  const dedup = [];
  for (const e of edges) {
    const otherId = e[endpointKey];
    const key = `${otherId}:${e.relation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push({ otherId, relation: e.relation });
  }
  const items = dedup
    .slice(0, 60)
    .map(({ otherId, relation }) => {
      const n = state.wiringById.get(otherId);
      const name = n ? n.name : otherId;
      const loc = n ? `${n.path}:${n.span}` : "unresolved";
      return (
        `<div class="insp-edge-item" data-jump-id="${escapeHtml(otherId)}">` +
          `<div class="insp-edge-top"><span class="insp-edge-name">${escapeHtml(name)}</span><span class="insp-edge-rel">${escapeHtml(relation)}</span></div>` +
          `<div class="insp-edge-loc">${escapeHtml(loc)}</div>` +
        `</div>`
      );
    })
    .join("");
  return `<div><div class="insp-section-title">${escapeHtml(title)} (${dedup.length})</div><div class="insp-edge-list">${items}</div></div>`;
}

function screenToWorld(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return {
    x: (sx - state.cam.x) / state.cam.k,
    y: (sy - state.cam.y) / state.cam.k,
  };
}

function pointHitsNode(n, x, y, pad) {
  const r = n.radius + pad;
  const dx = x - n.x;
  if (dx > r || dx < -r) return false;
  const dy = y - n.y;
  if (dy > r || dy < -r) return false;
  return dx * dx + dy * dy <= r * r;
}

function hitTestSpatialGrid(x, y, pad) {
  const cx = Math.floor(x / SPATIAL_CELL_SIZE);
  const cy = Math.floor(y / SPATIAL_CELL_SIZE);
  let bestIdx = -1;
  for (let dxCell = -1; dxCell <= 1; dxCell++) {
    const nx = (cx + dxCell) & 0xffff;
    for (let dyCell = -1; dyCell <= 1; dyCell++) {
      const bucket = spatialGrid.get((nx << 16) | ((cy + dyCell) & 0xffff));
      if (!bucket) continue;
      for (let bi = bucket.length - 1; bi >= 0; bi--) {
        const idx = bucket[bi];
        if (idx <= bestIdx) continue;
        const n = state.nodes[idx];
        if (n && pointHitsNode(n, x, y, pad)) bestIdx = idx;
      }
    }
  }
  return bestIdx >= 0 ? state.nodes[bestIdx] : null;
}

function hitTestNode(clientX, clientY, worldPos) {
  const { x, y } = worldPos ?? screenToWorld(clientX, clientY);
  const pad = 4 / state.cam.k;

  if (spatialGrid.size > 0) {
    return hitTestSpatialGrid(x, y, pad);
  }

  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if (pointHitsNode(n, x, y, pad)) return n;
  }
  return null;
}

function zoomToScale(nextK) {
  const rect = el.canvas.getBoundingClientRect();
  const bounds = getUnobstructedViewportBounds(rect);
  const mx = bounds.centerX;
  const my = bounds.centerY;
  const baseK = state.camTarget.active ? state.camTarget.k : state.cam.k;
  const baseX = state.camTarget.active ? state.camTarget.x : state.cam.x;
  const baseY = state.camTarget.active ? state.camTarget.y : state.cam.y;
  const clampedK = Math.min(5, Math.max(0.08, nextK));
  const tx = mx - ((mx - baseX) / baseK) * clampedK;
  const ty = my - ((my - baseY) / baseK) * clampedK;
  setCameraTarget(tx, ty, clampedK, true);
}

function zoomByFactor(factor) {
  const baseK = state.camTarget.active ? state.camTarget.k : state.cam.k;
  zoomToScale(baseK * factor);
}

function resetZoomTo100() {
  zoomToScale(1.0);
}

function syncUrlHash(push = false) {
  if (state.suppressHistory || typeof history === "undefined") return;
  const params = new URLSearchParams();
  if (state.activeTab) params.set("tab", state.activeTab);
  if (state.selectedId) params.set("node", state.selectedId);
  if (state.scopeFilter) params.set("scope", state.scopeFilter);
  if (state.search) params.set("q", state.search);
  const nextHash = `#${params.toString()}`;
  if (location.hash === nextHash) return;
  try {
    if (push) history.pushState(null, "", nextHash);
    else history.replaceState(null, "", nextHash);
  } catch {
    // Ignore history security errors on restricted file:// origins
  }
}

function applyUrlHash() {
  const rawSearch = location.search.startsWith("?") ? location.search.slice(1) : "";
  const rawHash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!rawSearch && !rawHash) return false;
  const params = new URLSearchParams(rawSearch);
  if (rawHash) {
    for (const [k, v] of new URLSearchParams(rawHash)) {
      params.set(k, v);
    }
  }
  const tab = params.get("tab");
  const node = params.get("node");
  const scope = params.get("scope") ?? "";
  const q = params.get("q") ?? "";

  state.suppressHistory = true;
  try {
    state.scopeFilter = scope;
    if (el.scopeSelect) el.scopeSelect.value = scope;
    state.search = q;
    if (el.searchInput) el.searchInput.value = q;

    if (tab === "outline") {
      toggleOutlineSidebar(true);
      rebuildActiveView(true);
    } else if (tab && ["modules", "symbols", "context", "treemap"].includes(tab)) {
      const btn = el.tabs.querySelector(`[data-tab="${tab}"]`);
      if (btn && !btn.classList.contains("hidden")) {
        setActiveTab(tab, false);
      } else {
        rebuildActiveView(true);
      }
    } else {
      rebuildActiveView(true);
    }

    if (node && (state.wiringById.has(node) || state.nodeById.has(node))) {
      openInspector(node, false);
      const cn = state.nodeById.get(node);
      if (cn) centerOnNode(cn, true);
    } else {
      closeInspector(false);
    }
  } finally {
    state.suppressHistory = false;
  }
  return true;
}

function resetJumpTargetFilters(targetNode) {
  let filterReset = false;
  if (targetNode && !matchesScope(targetNode.path)) {
    state.scopeFilter = "";
    if (el.scopeSelect) el.scopeSelect.value = "";
    filterReset = true;
  }
  if (state.legendFilter) {
    state.legendFilter = null;
    filterReset = true;
  }
  return filterReset;
}

function switchTabOrZoomFileSymbols(id, targetNode, filterReset, scrollOutline) {
  const canModules = !el.tabModules || !el.tabModules.classList.contains("hidden");
  const canSymbols = !el.tabSymbols || !el.tabSymbols.classList.contains("hidden");
  if (state.activeTab === "context" && !state.nodeById.has(id) && targetNode) {
    const wantTab = targetNode.kind === "file"
      ? (canModules ? "modules" : canSymbols ? "symbols" : null)
      : (canSymbols ? "symbols" : canModules ? "modules" : null);
    if (wantTab) {
      setActiveTab(wantTab, false);
      return { switchedTab: true, handled: false };
    }
  } else if (state.activeTab === "modules" && targetNode && targetNode.kind !== "file" && canSymbols) {
    // Switch to Symbols view when clicking a specific symbol in Outline/Inspector so the symbol node itself is shown
    setActiveTab("symbols", false);
    return { switchedTab: true, handled: false };
  } else if (state.activeTab === "symbols" && targetNode?.kind === "file" && !state.nodeById.has(id)) {
    if (filterReset) rebuildActiveView(false);
    openInspector(id, true, scrollOutline);
    const syms = (state.fileSymbols.get(targetNode.path) ?? []).map((s) => state.nodeById.get(s.id)).filter(Boolean);
    if (syms.length > 0) fitNodesToScreen(syms, 1.65, true);
    return { switchedTab: false, handled: true };
  }
  return { switchedTab: false, handled: false };
}

function jumpToNodeId(id, scrollOutline = true) {
  if (!id || (!state.wiringById.has(id) && !state.nodeById.has(id))) return;
  const targetNode = state.wiringById.get(id);
  const filterReset = resetJumpTargetFilters(targetNode);
  const { switchedTab, handled } = switchTabOrZoomFileSymbols(id, targetNode, filterReset, scrollOutline);
  if (handled) return;
  if (filterReset && !switchedTab) rebuildActiveView(false);
  openInspector(id, true, scrollOutline);
  const canvasNode = state.nodeById.get(id);
  if (canvasNode) centerOnNode(canvasNode, true);
}

/**
 * When selecting a node directly on the canvas, gently glide the camera if the node
 * lies outside the comfortable central safe box of the unobstructed viewport.
 */
function ensureNodeComfortableInView(node) {
  if (!node) return;
  const rect = el.canvas.getBoundingClientRect();
  const bounds = getUnobstructedViewportBounds(rect);
  const k = state.camTarget.active ? state.camTarget.k : state.cam.k;
  const baseX = state.camTarget.active ? state.camTarget.x : state.cam.x;
  const baseY = state.camTarget.active ? state.camTarget.y : state.cam.y;
  const nx = node.targetX ?? node.x;
  const ny = node.targetY ?? node.y;
  const sx = nx * k + baseX;
  const sy = ny * k + baseY;

  const marginX = Math.max(54, (bounds.right - bounds.left) * 0.18);
  const marginY = Math.max(48, (bounds.bottom - bounds.top) * 0.18);
  const safeLeft = bounds.left + marginX;
  const safeRight = bounds.right - marginX;
  const safeTop = bounds.top + marginY;
  const safeBottom = bounds.bottom - marginY;

  if (sx < safeLeft || sx > safeRight || sy < safeTop || sy > safeBottom) {
    centerOnNode(node, true, 105);
  }
}

function toggleSet(set, key) {
  if (set.has(key)) {
    set.delete(key);
    return false;
  }
  set.add(key);
  return true;
}

function wireOutlineAndSearchEvents() {
  el.tabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".tab");
    if (!btn) return;
    setActiveTab(btn.dataset.tab, true);
  });

  el.outlineToggleBtn?.addEventListener("click", () => toggleOutlineSidebar());
  el.outlineClose?.addEventListener("click", () => toggleOutlineSidebar(false));

  el.outlineExpandAll?.addEventListener("click", () => {
    state.collapsedDirs.clear();
    state.collapsedFiles.clear();
    renderOutlineView(true);
  });

  el.outlineCollapseAll?.addEventListener("click", () => {
    const files = (state.codeGraph?.nodes ?? []).filter((n) => n.kind === "file");
    let anyExpandedFile = false;
    for (const f of files) {
      const hasSyms = (state.fileSymbols.get(f.path) ?? []).length > 0;
      const dir = dirGroupOf(f.path);
      if (hasSyms && !state.collapsedDirs.has(dir) && !state.collapsedFiles.has(f.id)) {
        anyExpandedFile = true;
        break;
      }
    }
    for (const f of files) {
      state.collapsedFiles.add(f.id);
      if (!anyExpandedFile) {
        state.collapsedDirs.add(dirGroupOf(f.path));
      }
    }
    renderOutlineView(true);
  });

  let searchTimer = 0;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = el.searchInput.value.trim();
      updateSearchMatches();
      syncUrlHash(false);
    }, 45);
  });

  el.searchInput.addEventListener("focus", () => renderQuickFilterPopover());
  el.searchInput.addEventListener("blur", () => {
    setTimeout(() => {
      if (document.activeElement !== el.searchInput) {
        el.quickFilterPopover?.classList.add("hidden");
      }
    }, 150);
  });

  el.quickFilterPopover?.addEventListener("mousedown", (ev) => {
    const chip = ev.target.closest("[data-qf-token]");
    if (chip) {
      ev.preventDefault();
      const tok = chip.dataset.qfToken;
      const parts = el.searchInput.value.trim().split(/\s+/).filter(Boolean);
      const prefix = tok.split(":")[0] + ":";
      const next = parts.filter((p) => !p.toLowerCase().startsWith(prefix.toLowerCase()));
      next.push(tok);
      el.searchInput.value = next.join(" ") + " ";
      state.search = el.searchInput.value.trim();
      updateSearchMatches();
      syncUrlHash(false);
      el.searchInput.focus();
      return;
    }
    const hit = ev.target.closest("[data-qf-jump]");
    if (hit) {
      ev.preventDefault();
      el.quickFilterPopover.classList.add("hidden");
      el.searchInput.blur();
      jumpToNodeId(hit.dataset.qfJump, true);
    }
  });

  el.searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      if (state.quickFilterHitIndex >= 0 && state.searchMatches[state.quickFilterHitIndex]) {
        const hit = state.searchMatches[state.quickFilterHitIndex];
        el.quickFilterPopover?.classList.add("hidden");
        el.searchInput.blur();
        jumpToNodeId(hit.id, true);
        return;
      }
      cycleSearchMatch(ev.shiftKey ? -1 : 1);
    } else if (ev.key === "ArrowDown") {
      ev.preventDefault();
      if (state.searchMatches.length > 0 && !el.quickFilterPopover?.classList.contains("hidden")) {
        const maxHits = Math.min(8, state.searchMatches.length);
        state.quickFilterHitIndex = (state.quickFilterHitIndex + 1) % maxHits;
        renderQuickFilterPopover();
      } else {
        cycleSearchMatch(1);
      }
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      if (state.searchMatches.length > 0 && !el.quickFilterPopover?.classList.contains("hidden")) {
        const maxHits = Math.min(8, state.searchMatches.length);
        state.quickFilterHitIndex = (state.quickFilterHitIndex - 1 + maxHits) % maxHits;
        renderQuickFilterPopover();
      } else {
        cycleSearchMatch(-1);
      }
    } else if (ev.key === "Escape") {
      if (el.searchInput.value) {
        el.searchInput.value = "";
        state.search = "";
        updateSearchMatches();
        syncUrlHash(false);
      }
      el.quickFilterPopover?.classList.add("hidden");
      el.searchInput.blur();
    }
  });
}

function openSidecarFileAt(relPath, spanText = "") {
  const repoRoot = (state.contextGraph?.meta?.repoRoot || "").replace(/\/$/, "");
  const repoUri = (state.contextGraph?.meta?.repoUri || "").replace(/\/$/, "");
  const cleanRel = String(relPath || state.selectedRelFile || "").replace(/^\//, "");
  const absPath = repoRoot && cleanRel ? `${repoRoot}/${cleanRel}` : "";
  const fileUri = repoUri && cleanRel
    ? `${repoUri}/${cleanRel.split("/").map(encodeURIComponent).join("/")}`
    : state.selectedFileUri;
  const range = parseSpanRange(spanText || state.selectedSpan || "");
  const startLine = range?.start ?? 1;
  if (absPath && typeof window.sidecar?.openFile === "function") {
    window.sidecar.openFile(absPath, startLine);
  } else if (fileUri && window.sidecar?.ui?.toggleAuxPane) {
    window.sidecar.ui.toggleAuxPane({ tabType: "fileView", uri: fileUri, line: startLine });
  }
}

function collectSidecarCallersSummary(node, limit = 8) {
  const callers = [];
  if (!node) return callers;
  const ids = new Set([node.id]);
  if (node.kind === "file") {
    for (const s of state.fileSymbols.get(node.path) ?? []) ids.add(s.id);
  }
  for (const tid of ids) {
    for (const e of state.wiringIn.get(tid) ?? []) {
      if (ids.has(e.source)) continue;
      const src = state.wiringById.get(e.source);
      callers.push(src ? `${src.name} (${src.path}:${src.span || "L1"})` : e.source);
      if (callers.length >= limit) return callers;
    }
  }
  return callers;
}

function buildSidecarContextBundle() {
  const node = state.wiringById.get(state.selectedId) ?? state.nodeById.get(state.selectedId)?.raw;
  const loc = el.inspLoc.textContent || state.selectedRelFile || state.selectedId;
  const callers = collectSidecarCallersSummary(node, 8);
  const issues = node ? getIssuesForNode({
    path: state.selectedRelFile || node.path,
    startLine: parseSpanRange(node.span)?.start ?? null,
    endLine: parseSpanRange(node.span)?.end ?? null,
  }) : [];
  const lines = [`Symbol: \`${node?.name || loc}\` (${loc})`];
  lines.push(callers.length > 0 ? `Callers: ${callers.join("; ")}` : "Callers: none");
  if (issues.length > 0) {
    lines.push("Open issues:");
    for (const iss of issues.slice(0, 8)) {
      lines.push(`- [${iss.tier} · ${iss.detector}] ${iss.span || "L1"}: ${iss.summary}`);
    }
  } else {
    lines.push("Open issues: none");
  }
  return lines.join("\n");
}

function wireToolbarAndInspectorEvents() {
  el.workspaceSelect?.addEventListener("change", () => {
    sidecarState.pinnedWs = el.workspaceSelect.value;
    sidecarState.treemapLoadedKey = "";
    sidecarState.lastRev = "";
    state.scopeFilter = "";
    state.legendFilter = null;
    state.sourceCache.clear();
    state.layoutCache.clear();
    state.lastOutlineKey = "";
    loadGraphs(false);
  });

  el.scopeSelect.addEventListener("change", () => {
    state.scopeFilter = el.scopeSelect.value;
    rebuildActiveView(true);
    syncUrlHash(false);
  });

  el.hudLegend.addEventListener("click", (ev) => {
    const cycleBtn = ev.target.closest("[data-cycle-toggle]");
    if (cycleBtn) {
      state.highlightCycles = !state.highlightCycles;
      renderLegend();
      requestDraw();
      return;
    }
    const btn = ev.target.closest("[data-legend-key]");
    if (!btn) return;
    const key = btn.dataset.legendKey;
    state.legendFilter = state.legendFilter === key ? null : key;
    rebuildActiveView(true);
  });

  el.btnFit.addEventListener("click", () => fitToScreen(true));
  el.btnRelayout.addEventListener("click", () => rebuildActiveView(true, true));

  el.zoomInBtn?.addEventListener("click", () => zoomByFactor(1.25));
  el.zoomOutBtn?.addEventListener("click", () => zoomByFactor(0.8));
  el.zoomResetBtn?.addEventListener("click", () => resetZoomTo100());
  el.zoomFitBtn?.addEventListener("click", () => fitToScreen(true));

  el.inspClose.addEventListener("click", () => {
    clearShortestPath();
    closeInspector(true);
  });

  el.inspCopy.addEventListener("click", () => {
    navigator.clipboard?.writeText(el.inspLoc.textContent ?? "");
    el.inspCopy.textContent = "Copied!";
    setTimeout(() => (el.inspCopy.textContent = "Copy"), 1200);
  });

  el.inspFocusSymbols.addEventListener("click", () => {
    if (!state.selectedId) return;
    const wTarget = state.wiringById.has(state.selectedId)
      ? state.selectedId
      : (state.selectedRelFile && state.wiringById.has(state.selectedRelFile) ? state.selectedRelFile : null);
    if (wTarget) focusInSymbolsView(wTarget);
  });

  el.inspOpenFile?.addEventListener("click", () => {
    openSidecarFileAt(state.selectedRelFile, state.selectedSpan);
  });

  el.inspPinPrompt?.addEventListener("click", () => {
    if (!state.selectedFileUri || !window.sidecar?.ui?.addArtifactComment) return;
    const loc = el.inspLoc.textContent || state.selectedRelFile;
    const repoLabel = state.contextGraph?.meta?.repoName || "plexer";
    window.sidecar.ui.addArtifactComment({
      uri: state.selectedFileUri,
      pageTitle: `${repoLabel}:${state.selectedRelFile}`,
      selection: loc,
      comment: `Inspect \`${loc}\``,
    });
    el.inspPinPrompt.textContent = "Pinned";
    setTimeout(() => {
      if (el.inspPinPrompt) el.inspPinPrompt.textContent = "Pin";
    }, 1200);
  });

  el.inspPinBundle?.addEventListener("click", () => {
    const bundle = buildSidecarContextBundle();
    const loc = el.inspLoc.textContent || state.selectedRelFile;
    const repoLabel = state.contextGraph?.meta?.repoName || "plexer";
    if (state.selectedFileUri && window.sidecar?.ui?.addArtifactComment) {
      window.sidecar.ui.addArtifactComment({
        uri: state.selectedFileUri,
        pageTitle: `${repoLabel}:${state.selectedRelFile}`,
        selection: loc,
        comment: bundle,
      });
    } else {
      navigator.clipboard?.writeText(bundle);
    }
    el.inspPinBundle.textContent = "Context pinned";
    setTimeout(() => {
      if (el.inspPinBundle) el.inspPinBundle.textContent = "Pin context";
    }, 1400);
  });

  el.inspHops?.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-hop]");
    if (!btn) return;
    const raw = btn.dataset.hop;
    state.hopDepth = raw === "all" ? Infinity : Number(raw) || 1;
    for (const pill of el.inspHops.querySelectorAll(".hop-pill")) {
      pill.classList.toggle("active", pill === btn);
    }
    state.flowUntil = performance.now() + FLOW_DURATION_MS;
    state.flowIntensity = 1;
    requestDraw();
  });

  el.inspPathBox?.addEventListener("click", (ev) => {
    if (ev.target.closest("[data-clear-path]")) {
      clearShortestPath();
      requestDraw();
      return;
    }
    const step = ev.target.closest("[data-jump-id]");
    if (step) {
      jumpToNodeId(step.dataset.jumpId);
    }
  });
}

function wireInspectorSourceAndOutlineEvents() {
  el.inspSourceBox?.addEventListener("click", (ev) => {
    const expandBtn = ev.target.closest("[data-source-expand]");
    if (expandBtn) {
      const nodeId = expandBtn.dataset.sourceExpand;
      toggleSet(state.sourceExpanded, nodeId);
      const wNode = state.wiringById.get(nodeId);
      if (wNode) fetchAndRenderSource(wNode);
      return;
    }
    const collapseBtn = ev.target.closest("[data-source-collapse]");
    if (collapseBtn) {
      state.sourceCollapsed = !state.sourceCollapsed;
      const wNode = state.wiringById.get(state.selectedId);
      if (wNode) fetchAndRenderSource(wNode);
      return;
    }
    const copyBtn = ev.target.closest("[data-source-copy]");
    if (copyBtn) {
      const codeEl = el.inspSourceBox.querySelector(".insp-source-code");
      const lines = [...(codeEl?.querySelectorAll(".insp-code-line") ?? [])].map(
        (row) => row.lastElementChild?.textContent ?? ""
      );
      navigator.clipboard?.writeText(lines.join("\n"));
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = "Copy Code"), 1200);
    }
  });

  el.inspSections.addEventListener("click", (ev) => {
    const convBtn = ev.target.closest("[data-worker-conv]");
    if (convBtn) {
      const convId = convBtn.dataset.workerConv;
      if (convId && window.sidecar?.ui?.toggleConversation) {
        window.sidecar.ui.toggleConversation(convId);
      }
      return;
    }
    const issueRow = ev.target.closest("[data-issue-span]");
    if (issueRow) {
      const path = issueRow.dataset.issuePath || state.selectedRelFile;
      const span = issueRow.dataset.issueSpan || "L1";
      if (ev.target.closest("[data-open-issue-line]")) {
        openSidecarFileAt(path, span);
        return;
      }
      state.focusedIssue = {
        path,
        span,
        detector: issueRow.dataset.issueDet || "",
        tier: issueRow.dataset.issueTier || "",
        severity: issueRow.dataset.issueSev || "",
        summary: issueRow.dataset.issueSummary || "",
      };
      const r = parseSpanRange(span);
      const contextSpan = r ? `L${Math.max(1, r.start - 5)}-L${r.end + 12}` : span;
      const wNode = state.wiringById.get(state.selectedId) ?? (path ? state.wiringById.get(path) : null);
      if (wNode) {
        fetchAndRenderSource(wNode, contextSpan);
      }
      return;
    }
    const item = ev.target.closest("[data-jump-id]");
    if (!item) return;
    jumpToNodeId(item.dataset.jumpId);
  });

  el.outlineList.addEventListener("click", (ev) => {
    const focusBtn = ev.target.closest("[data-focus-cluster]");
    if (focusBtn) {
      ev.stopPropagation();
      focusClusterByKey(focusBtn.dataset.focusCluster);
      return;
    }
    const fileChevron = ev.target.closest("[data-toggle-file]");
    if (fileChevron) {
      ev.stopPropagation();
      const fid = fileChevron.dataset.toggleFile;
      const collapsed = toggleSet(state.collapsedFiles, fid);
      fileChevron.closest(".outline-file")?.classList.toggle("collapsed", collapsed);
      return;
    }
    const dirHeader = ev.target.closest("[data-toggle-dir]");
    if (dirHeader) {
      const dir = dirHeader.dataset.toggleDir;
      const collapsed = toggleSet(state.collapsedDirs, dir);
      dirHeader.closest(".outline-dir")?.classList.toggle("collapsed", collapsed);
      return;
    }
    const row = ev.target.closest("[data-node-id]");
    if (!row) return;
    const nodeId = row.dataset.nodeId;
    if (row.classList.contains("outline-file-row")) {
      const fileWrap = row.closest(".outline-file");
      if (fileWrap && (state.fileSymbols.get(row.dataset.filePath) ?? []).length > 0) {
        fileWrap.classList.toggle("collapsed", toggleSet(state.collapsedFiles, nodeId));
      }
    }
    jumpToNodeId(nodeId, false);
  });
}

function wireOutlinePointerHoverEvents() {
  el.outlineList.addEventListener("pointerover", (ev) => {
    const row = ev.target.closest("[data-node-id]");
    if (row) {
      const nid = row.dataset.nodeId;
      const canvasId = state.nodeById.has(nid)
        ? nid
        : row.dataset.filePath && state.nodeById.has(row.dataset.filePath)
          ? row.dataset.filePath
          : null;
      const clusterKey = row.dataset.filePath ?? null;
      if (state.hoveredId !== canvasId || state.hoveredClusterKey !== clusterKey) {
        state.hoveredId = canvasId;
        state.activeHoverId = canvasId;
        state.hoveredClusterKey = clusterKey;
        requestDraw();
      }
      return;
    }
    const dirHeader = ev.target.closest("[data-toggle-dir]");
    if (dirHeader) {
      const dir = dirHeader.dataset.toggleDir;
      if (state.hoveredClusterKey !== dir) {
        state.hoveredId = null;
        state.activeHoverId = null;
        state.hoveredClusterKey = dir;
        requestDraw();
      }
    }
  });

  el.outlineList.addEventListener("pointerleave", () => {
    if (state.hoveredId || state.activeHoverId || state.hoveredClusterKey) {
      state.hoveredId = null;
      state.activeHoverId = null;
      state.hoveredClusterKey = null;
      requestDraw();
    }
  });
}

function wireCanvasPointerDownAndMoveEvents() {
  el.canvas.addEventListener("pointerdown", (ev) => {
    state.pointerDownPos = { x: ev.clientX, y: ev.clientY };
    state.dragMoved = false;
    state.clickedHullHeader = null;
    const worldPos = screenToWorld(ev.clientX, ev.clientY);
    const hit = hitTestNode(ev.clientX, ev.clientY, worldPos);
    if (hit) {
      state.draggingNode = hit;
      state.dragOffset = { x: hit.x - worldPos.x, y: hit.y - worldPos.y };
      el.canvas.setPointerCapture(ev.pointerId);
    } else {
      const hullHit = hitTestClusterHeader(ev.clientX, ev.clientY, worldPos);
      if (hullHit) {
        state.clickedHullHeader = hullHit;
      }
      state.panning = true;
      state.panStart = { x: ev.clientX, y: ev.clientY, camX: state.cam.x, camY: state.cam.y };
      el.canvas.setPointerCapture(ev.pointerId);
    }
  });

  el.canvas.addEventListener("pointermove", (ev) => {
    if (state.draggingNode) {
      const moved = Math.hypot(ev.clientX - state.pointerDownPos.x, ev.clientY - state.pointerDownPos.y);
      if (!state.dragMoved && moved < 4) return;
      if (!state.dragMoved) {
        state.dragMoved = true;
        state.camTarget.active = false;
        for (let i = 0; i < state.nodes.length; i++) {
          if (state.nodes[i].targetX !== undefined) {
            state.nodes[i].x = state.nodes[i].targetX;
            state.nodes[i].y = state.nodes[i].targetY;
            state.nodes[i].targetX = undefined;
            state.nodes[i].targetY = undefined;
          }
        }
      }
      const pos = screenToWorld(ev.clientX, ev.clientY);
      state.draggingNode.x = pos.x + (state.dragOffset?.x ?? 0);
      state.draggingNode.y = pos.y + (state.dragOffset?.y ?? 0);
      state.hullsDirty = true;
      populateSpatialGrid();
      state.alpha = Math.max(state.alpha, 0.25);
      requestDraw();
      return;
    }
    if (state.panning) {
      const moved = Math.hypot(ev.clientX - state.pointerDownPos.x, ev.clientY - state.pointerDownPos.y);
      if (!state.dragMoved && moved < 3) return;
      state.dragMoved = true;
      state.clickedHullHeader = null;
      state.camTarget.active = false;
      state.cam.x = state.panStart.camX + (ev.clientX - state.panStart.x);
      state.cam.y = state.panStart.camY + (ev.clientY - state.panStart.y);
      state.camTarget.x = state.cam.x;
      state.camTarget.y = state.cam.y;
      requestDraw();
      return;
    }
    const worldPos = screenToWorld(ev.clientX, ev.clientY);
    const hit = hitTestNode(ev.clientX, ev.clientY, worldPos);
    const nextHover = hit ? hit.id : null;
    const hullHit = !hit ? hitTestClusterHeader(ev.clientX, ev.clientY, worldPos) : null;
    const nextHullHover = hullHit ? hullHit.key : null;

    if (nextHover !== state.hoveredId || nextHullHover !== state.hoveredClusterKey) {
      state.hoveredId = nextHover;
      state.hoveredClusterKey = nextHullHover;
      el.canvas.style.cursor = nextHover || nextHullHover ? "pointer" : "grab";
      clearTimeout(state.hoverTimer);
      if (nextHover) {
        state.hoverTimer = setTimeout(() => {
          if (state.hoveredId === nextHover && state.activeHoverId !== nextHover) {
            state.activeHoverId = nextHover;
            requestDraw();
          }
        }, 65);
      } else {
        state.activeHoverId = null;
      }
      requestDraw();
    }
  });
}

function handleCanvasPointerUp(ev) {
  const wasDragged = state.dragMoved;
  state.dragMoved = false;
  if (state.draggingNode) {
    const clicked = state.draggingNode;
    state.draggingNode = null;
    if (wasDragged) {
      snapshotLayoutToCache();
    } else if (ev.shiftKey && state.selectedId && state.selectedId !== clicked.id) {
      traceShortestPathTo(clicked.id);
    } else {
      openInspector(clicked.id, true);
      ensureNodeComfortableInView(clicked);
    }
    return;
  }
  if (!state.panning) return;
  state.panning = false;
  const clickedHull = state.clickedHullHeader;
  state.clickedHullHeader = null;
  if (wasDragged) return;
  if (clickedHull) {
    focusClusterByKey(clickedHull.key);
    if (state.wiringById.has(clickedHull.key)) openInspector(clickedHull.key, true);
    return;
  }
  if (state.pathTargetId) {
    clearShortestPath();
    requestDraw();
  } else {
    closeInspector(true);
  }
}

function handleCanvasWheelZoom(ev) {
  ev.preventDefault();
  const rect = el.canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;
  const baseK = state.camTarget.active ? state.camTarget.k : state.cam.k;
  const baseX = state.camTarget.active ? state.camTarget.x : state.cam.x;
  const baseY = state.camTarget.active ? state.camTarget.y : state.cam.y;
  const nextK = Math.min(5, Math.max(0.08, baseK * Math.exp(-ev.deltaY * 0.0014)));
  const nextX = mx - ((mx - baseX) / baseK) * nextK;
  const nextY = my - ((my - baseY) / baseK) * nextK;
  setCameraTarget(nextX, nextY, nextK, true, 38);
}

function wireCanvasPointerUpAndWheelEvents() {
  el.canvas.addEventListener("pointerleave", () => {
    clearTimeout(state.hoverTimer);
    if (state.hoveredId || state.activeHoverId || state.hoveredClusterKey) {
      state.hoveredId = null;
      state.activeHoverId = null;
      state.hoveredClusterKey = null;
      el.canvas.style.cursor = "grab";
      requestDraw();
    }
  });
  el.canvas.addEventListener("pointerup", handleCanvasPointerUp);
  el.canvas.addEventListener("dblclick", (ev) => {
    const hit = hitTestNode(ev.clientX, ev.clientY);
    if (!hit) return;
    if (state.activeTab === "modules" || state.activeTab === "symbols") {
      focusInSymbolsView(hit.id);
    } else {
      openInspector(hit.id, true);
      centerOnNode(hit, true);
    }
  });
  el.canvas.addEventListener("wheel", handleCanvasWheelZoom, { passive: false });
}

function wireGlobalWindowAndKeyboardEvents() {
  window.addEventListener("resize", () => requestDraw());
  window.addEventListener("popstate", () => applyUrlHash());
  window.addEventListener("message", (ev) => {
    if (ev.source !== el.treemapFrame?.contentWindow) return;
    const msg = ev?.data;
    if (msg?.type === "plexer-treemap-select" && typeof msg.path === "string" && state.wiringById.has(msg.path)) {
      openInspector(msg.path, false, true);
    }
  });

  window.addEventListener("keydown", (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === "k") {
      ev.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
      renderQuickFilterPopover();
      return;
    }
    if (ev.target === el.searchInput || ev.target === el.scopeSelect || ev.target === el.workspaceSelect) {
      return;
    }
    if (ev.key === "/") {
      ev.preventDefault();
      el.searchInput.focus();
      el.searchInput.select();
      renderQuickFilterPopover();
    } else if (ev.key === "[" || ev.key === "o" || ev.key === "O") {
      ev.preventDefault();
      toggleOutlineSidebar();
    } else if (ev.key === "Escape") {
      if (state.pathTargetId) {
        clearShortestPath();
        requestDraw();
      } else if (state.selectedId) {
        closeInspector(true);
      } else if (state.search) {
        state.search = "";
        el.searchInput.value = "";
        updateSearchMatches();
        syncUrlHash(false);
      } else if (state.highlightCycles) {
        state.highlightCycles = false;
        renderLegend();
        requestDraw();
      } else if (state.legendFilter) {
        state.legendFilter = null;
        rebuildActiveView(true);
      }
    } else if (ev.key === "f" || ev.key === "F") {
      fitToScreen(true);
    } else if (ev.key === "r" || ev.key === "R") {
      rebuildActiveView(true, true);
    } else if (ev.key === "0") {
      resetZoomTo100();
    } else if (ev.key === "=" || ev.key === "+") {
      zoomByFactor(1.25);
    } else if (ev.key === "-" || ev.key === "_") {
      zoomByFactor(0.8);
    } else if (ev.key >= "1" && ev.key <= "4") {
      const tabOrder = ["modules", "symbols", "context", "treemap"];
      const targetTab = tabOrder[Number(ev.key) - 1];
      const btn = el.tabs.querySelector(`[data-tab="${targetTab}"]`);
      if (btn && !btn.classList.contains("hidden")) {
        setActiveTab(targetTab, true);
      }
    }
  });
}

function wireEvents() {
  wireOutlineAndSearchEvents();
  wireToolbarAndInspectorEvents();
  wireInspectorSourceAndOutlineEvents();
  wireOutlinePointerHoverEvents();
  wireCanvasPointerDownAndMoveEvents();
  wireCanvasPointerUpAndWheelEvents();
  wireGlobalWindowAndKeyboardEvents();
}

function centerOnNode(node, animate = true, tauMs = 92) {
  const rect = el.canvas.getBoundingClientRect();
  const bounds = getUnobstructedViewportBounds(rect);
  const k = state.camTarget.active ? state.camTarget.k : state.cam.k;
  const nx = node.targetX ?? node.x;
  const ny = node.targetY ?? node.y;
  const tx = bounds.centerX - nx * k;
  const ty = bounds.centerY - ny * k;
  setCameraTarget(tx, ty, k, animate, tauMs);
}

function setActiveTab(tab, pushHistory = false) {
  if (tab === "outline") {
    toggleOutlineSidebar(true);
    return;
  }
  if (state.activeTab !== tab) {
    state.legendFilter = null;
  }
  state.activeTab = tab;
  for (const btn of el.tabs.querySelectorAll(".tab")) {
    btn.classList.toggle("active", btn.dataset.tab === tab);
  }
  rebuildActiveView(true);
  syncUrlHash(pushHistory);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function applySidecarTheme() {
  if (!sidecarState.active) return;
  const root = document.documentElement;
  root.classList.add("sidecar-host");
  const style = getComputedStyle(root);
  const bg = style.getPropertyValue("--background").trim() || getComputedStyle(document.body).backgroundColor || "";
  let isLight = false;
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(bg);
  if (m) {
    const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255;
    isLight = lum > 0.55;
  } else if (/^#[0-9a-f]{6}$/i.test(bg)) {
    const r = parseInt(bg.slice(1, 3), 16);
    const g = parseInt(bg.slice(3, 5), 16);
    const b = parseInt(bg.slice(5, 7), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    isLight = lum > 0.55;
  }
  root.classList.toggle("sidecar-light", isLight);
  syncTreemapFocus();
  requestDraw();
}

function renderWorkspaceSelectOptions(uris) {
  if (!el.workspaceSelect) return;
  const list = Array.isArray(uris) ? uris.filter(Boolean) : [];
  sidecarState.workspaces = list;
  el.workspaceSelect.classList.toggle("hidden", list.length < 2);
  const activeName = state.contextGraph?.meta?.repoName || "active";
  const opts = [`<option value="">Auto (${escapeHtml(activeName)})</option>`];
  for (const uri of list) {
    const clean = String(uri).replace(/\/$/, "");
    const label = decodeURIComponent(clean.split("/").pop() || clean);
    const selected = sidecarState.pinnedWs === uri ? " selected" : "";
    opts.push(`<option value="${escapeHtml(uri)}"${selected}>${escapeHtml(label)}</option>`);
  }
  el.workspaceSelect.innerHTML = opts.join("");
  if (sidecarState.pinnedWs && !list.includes(sidecarState.pinnedWs)) {
    sidecarState.pinnedWs = "";
    el.workspaceSelect.value = "";
  }
}

async function pollSidecarRev() {
  if (!sidecarState.active || document.hidden) return;
  try {
    const res = await apiFetch("/api/rev");
    if (!res?.ok) return;
    const data = await res.json();
    const rev = String(data?.rev ?? "");
    if (!rev) return;
    if (sidecarState.lastRev && rev !== sidecarState.lastRev) {
      sidecarState.lastRev = rev;
      sidecarState.treemapLoadedKey = "";
      await loadGraphs(true);
    } else if (!sidecarState.lastRev) {
      sidecarState.lastRev = rev;
    }
  } catch {
    // Sidecar polling is best-effort.
  }
}

async function initSidecarIntegration() {
  if (!sidecarState.active) return;
  applySidecarTheme();
  if (typeof MutationObserver !== "undefined") {
    const mo = new MutationObserver(() => applySidecarTheme());
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  }
  try {
    const initialUris = await window.sidecar.getWorkspaceUris?.();
    renderWorkspaceSelectOptions(initialUris);
  } catch {
    // Ignore host workspace lookup failure.
  }
  if (typeof window.sidecar.onWorkspaceChange === "function") {
    window.sidecar.onWorkspaceChange((uris) => {
      renderWorkspaceSelectOptions(uris);
      if (!sidecarState.pinnedWs) {
        sidecarState.treemapLoadedKey = "";
        loadGraphs(false);
      }
    });
  }
  await pollSidecarRev();
  if (!sidecarState.revTimer) {
    sidecarState.revTimer = setInterval(() => {
      pollSidecarRev();
    }, 2000);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollSidecarRev();
  });
}

async function fetchOrReadEmbeddedGraphs() {
  if (window.__PLEXER_DATA__) {
    state.contextGraph = window.__PLEXER_DATA__.contextGraph ?? null;
    state.codeGraph = window.__PLEXER_DATA__.codeGraph ?? null;
    state.health = window.__PLEXER_DATA__.health ?? null;
    return;
  }
  const [ctxRes, codeRes, healthRes] = await Promise.all([
    apiFetch("/api/context-graph").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    apiFetch("/api/code-graph").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    apiFetch("/api/health").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.contextGraph = ctxRes;
  state.codeGraph = codeRes;
  state.health = healthRes;
}

function syncLoadedGraphTabVisibility(meta) {
  const hasContextNodes = (state.contextGraph?.nodes?.length ?? 0) > 0 || meta.defaultTab === "context";
  const hasCodeNodes = (state.codeGraph?.nodes?.length ?? 0) > 0;
  const allowedTabs = Array.isArray(meta.tabs) ? new Set(meta.tabs) : null;

  const showModulesTab = hasCodeNodes && (!allowedTabs || allowedTabs.has("code") || allowedTabs.has("modules"));
  const showSymbolsTab = hasCodeNodes && (!allowedTabs || allowedTabs.has("code") || allowedTabs.has("symbols"));
  const showOutline = hasCodeNodes && (!allowedTabs || allowedTabs.has("outline") || allowedTabs.has("code"));
  const showContextTab = (hasContextNodes || !hasCodeNodes || sidecarState.active) && (!allowedTabs || allowedTabs.has("context"));
  const isEmbeddedExport = Boolean(window.__PLEXER_DATA__);
  const hasEmbeddedTreemap = Boolean(window.__PLEXER_DATA__?.treemapHtml);
  const showTreemapTab = hasCodeNodes && (isEmbeddedExport ? hasEmbeddedTreemap : (!allowedTabs || allowedTabs.has("treemap") || allowedTabs.has("code")));

  el.tabModules?.classList.toggle("hidden", !showModulesTab);
  el.tabSymbols?.classList.toggle("hidden", !showSymbolsTab);
  el.tabContext?.classList.toggle("hidden", !showContextTab);
  el.tabTreemap?.classList.toggle("hidden", !showTreemapTab);
  el.outlineToggleBtn?.classList.toggle("hidden", !showOutline);
  toggleOutlineSidebar(showOutline ? state.outlineOpen : false);
  return { showModulesTab, showSymbolsTab, showContextTab, showCodeTabs: showModulesTab || showSymbolsTab, showOutline };
}

function applyInitialGraphTab(meta, flags) {
  if (applyUrlHash()) return;
  const { showModulesTab, showSymbolsTab, showContextTab, showCodeTabs, showOutline } = flags;
  if ((!showCodeTabs || meta.defaultTab === "context") && showContextTab) {
    setActiveTab("context", false);
  } else if (showModulesTab) {
    setActiveTab("modules", false);
  } else if (showSymbolsTab) {
    setActiveTab("symbols", false);
  } else if (showOutline) {
    renderOutlineView(false);
    rebuildActiveView(true);
  }
}

async function loadGraphs(isReload = false) {
  await fetchOrReadEmbeddedGraphs();
  const meta = state.contextGraph?.meta ?? {};
  el.repoName.textContent = meta.repoName ?? "repository";
  el.repoSubtitle.textContent = meta.subtitle ?? "";
  if (meta.repoName) document.title = `${meta.repoName} — plexer viz`;
  if (sidecarState.active && sidecarState.workspaces.length >= 2) {
    renderWorkspaceSelectOptions(sidecarState.workspaces);
  }
  indexWiringGraph(state.codeGraph);
  const tabFlags = syncLoadedGraphTabVisibility(meta);

  if (isReload) {
    state.sourceCache.clear();
    state.layoutCache.clear();
    state.lastOutlineKey = "";
    sidecarState.treemapLoadedKey = "";
    rebuildActiveView(false);
    if (state.selectedId) openInspector(state.selectedId, false, false);
    return;
  }
  applyInitialGraphTab(meta, tabFlags);
}

wireEvents();
if (sidecarState.active) {
  initSidecarIntegration().then(() => loadGraphs(false));
} else {
  loadGraphs(false);
}

if (!window.__PLEXER_DATA__ && !sidecarState.active && typeof EventSource !== "undefined") {
  const es = new EventSource("/events");
  es.addEventListener("message", () => loadGraphs(true));
}

