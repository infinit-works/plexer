export type NodeKind =
    | "file"
    | "function"
    | "method"
    | "class"
    | "interface"
    | "trait"
    | "impl"
    | "field"
    | "doc"
    | "type"
    | "enum"
    | "struct"
    | "constant"
    | "variable"
    | "property"
    | "module"
    | "macro";

export type EdgeRelation =
    | "calls"
    | "imports"
    | "implements"
    | "extends"
    | "references"
    | "contains"
    | "types"
    | "interface_dispatch"
    | "reexports";

export interface GraphNode {
    id: string;
    name: string;
    kind: NodeKind;
    path: string;
    span: string;
    owner?: string;
    origin?: string;
    chars?: number;
    exported?: boolean;
    signature?: string | null;
    summary?: string | null;
    summary_state?: string;
    crux?: string | null;
    body_hash?: string;
    body_text?: string;
}

export interface GraphEdge {
    source: string;
    target: string;
    relation: EdgeRelation;
    confidence?: "extracted" | "inferred" | "interface_dispatch";
    line?: number;
    typeOnly?: boolean;
}

export interface GraphScope {
    prefix: string;
    label?: string;
    markers?: string[];
    nodes?: number;
}

export interface WiringGraph {
    meta: {
        version?: number;
        nodeCount?: number;
        edgeCount?: number;
        root?: string;
        languages: string[];
        config_hash?: string;
        scopes?: GraphScope[];
    };
    nodes: GraphNode[];
    edges: GraphEdge[];
    _byId?: Map<string, GraphNode>;
    _nodesByPath?: Map<string, GraphNode[]>;
    _inEdges?: Map<string, GraphEdge[]>;
    _outEdges?: Map<string, GraphEdge[]>;
}

export interface BuildProgressEvent {
    phase: string;
    index: number;
    total: number;
    file: string;
}

export interface BuildGraphOptions {
    contextDir?: string;
    extensions?: string[];
    reuse?: boolean;
    onlyDirs?: string[];
    cards?: boolean;
    graphOnly?: boolean;
    onProgress?: (event: BuildProgressEvent) => void;
}

export interface BuildGraphResult {
    contextDir: string;
    graphPath: string;
    cards: number;
    files: number;
    parsed: number;
    reused: number;
    seededFrom?: string | null;
    nodes: number;
    edges: number;
    byKind: Record<string, number>;
    byRelation: Record<string, number>;
    languages: string[];
    errors: string[];
    skipped?: boolean;
}

export interface CheckGraphOptions {
    contextDir?: string;
    extensions?: string[];
}

export interface CheckGraphResult {
    ok: boolean;
    missing: boolean;
    added: string[];
    removed: string[];
    changed: string[];
    stale: string[];
    pending: number;
    pendingIds: string[];
    nodes: number;
}

export interface AskOptions {
    contextDir?: string;
    limit?: number;
    source?: boolean;
    full?: boolean;
    in?: string;
    graphRank?: boolean;
    fileFirst?: boolean;
    fileComplement?: boolean;
    fileTopLock?: boolean;
    includeRankingMetadata?: boolean;
    seenPointers?: Set<string>;
    maxSourceBytes?: number;
    maxHitsToInline?: number;
}

export interface AskHit {
    kind: "symbol" | "caller" | "callee";
    title: string;
    pointer: string;
    snippet?: string;
    relation?: EdgeRelation;
    code?: string;
    score?: number;
    scope?: string;
    related?: string[];
    callSites?: string[];
    wantsCallSites?: boolean;
    otherSymbols?: string;
    pinned?: boolean;
    alreadySeen?: boolean;
    repoLabel?: string;
    repoDir?: string;
    literals?: string[];
    callerCount?: number;
    calleeCount?: number;
}

export interface AskResult {
    query: string;
    mode: "lexical" | "structural" | "empty";
    hits: AskHit[];
    coverage?: number;
    coverageStrong?: number;
    rawTopPointer?: string | null;
    rawTopScore?: number;
    usedSourceBytes?: number;
    scopes?: {
        federated: string[];
        alsoMatched: Array<{ scope: string; bestId?: string; topScore?: number }>;
    };
    coEditPointers?: string[];
    isEditPrompt?: boolean;
    editEnvelope?: boolean;
    multiRoot?: boolean;
    federatedRepos?: string[];
    confidenceTier?: "high" | "exploratory";
    candidateMap?: AskHit[];
    note?: string;
}

export interface SkeletonOptions {
    contextDir?: string;
    allMatches?: boolean;
}

export interface SkeletonEntry {
    file?: string;
    name: string;
    kind: NodeKind;
    span: string;
    exported: boolean;
    signature?: string | null;
    summary?: string | null;
}

export interface SkeletonResult {
    file?: string;
    files?: string[];
    entries: SkeletonEntry[];
    note?: string;
    error?: string;
}

export interface ReadOptions {
    contextDir?: string;
    full?: boolean;
    maxBytes?: number;
}

export interface ReadSpanBlock {
    spec: string;
    file?: string;
    span?: string;
    totalLines?: number;
    truncated?: boolean;
    code?: string;
    error?: string;
}

export interface ReadSpansResult {
    blocks: ReadSpanBlock[];
}

export interface GrepOptions {
    in?: string;
    ignoreCase?: boolean;
    fixed?: boolean;
    maxHits?: number;
    maxHitsPerSymbol?: number;
    context?: number;
    source?: boolean;
}

export interface GrepLineHit {
    line: number;
    text: string;
}

export interface GrepGroup {
    symbol: {
        id: string;
        name: string;
        kind: NodeKind;
        path: string;
        span: string;
    } | null;
    path: string;
    inDegree: number;
    hits: GrepLineHit[];
    omittedHits: number;
    contextBlocks?: Array<{ start: number; end: number; lines: Array<{ line: number; text: string; isMatch: boolean }> }>;
}

export interface GrepResult {
    pattern: string;
    groups: GrepGroup[];
    totalHits: number;
    filesSearched: number;
    truncated: {
        files: number;
        hits: number;
    };
    ignoredDirs?: string[];
    zeroHitHint?: string;
}

export interface EdgeWalkHit {
    id: string;
    node?: GraphNode | null;
    relation: EdgeRelation;
    depth: number;
    via?: GraphNode | string;
    line?: number;
}

export interface CallersOptions {
    direction?: "in" | "out";
    depth?: number | "all" | string;
    in?: string;
    includeTests?: boolean;
}

export interface CallersMatch {
    repo?: string;
    symbol: GraphNode;
    hits: EdgeWalkHit[];
    tests?: Array<{ path: string; confidence: "high" | "medium" | "low"; reason?: string }>;
}

export interface RepoMapOptions {
    maxDirs?: number;
    hubsPerDir?: number;
    hotspots?: number;
    churn?: boolean;
    since?: string;
    includeCoupling?: boolean;
    gitHistory?: Record<string, unknown>;
}

export interface RepoMapHub {
    name: string;
    kind: NodeKind;
    path: string;
    span: string;
    inDegree: number;
    churnCommits?: number;
    churnScore?: number;
}

export interface RepoMapEntry {
    path: string;
    files: number;
    symbols: number;
    languages: string[];
    hubs: RepoMapHub[];
    isFile: boolean;
}

export interface RepoMapResult {
    totals: {
        files: number;
        symbols: number;
        edges: number;
        languages: string[];
    };
    dirs: RepoMapEntry[];
    scopes?: Array<{
        scope: string;
        dirs: RepoMapEntry[];
        dropped: number;
    }>;
    hotspots: RepoMapHub[];
    dropped: number;
    churnHotspots?: Array<{ path: string; commits: number; churnCommits: number; churnScore: number; inDegree: number; score: number }>;
    coupling?: Array<{ a: string; b: string; weight: number }>;
}

export type LayerRuleInput =
    | string
    | {
          from?: string;
          source?: string;
          to?: string | string[];
          target?: string | string[];
          forbid?: string | string[];
          disallow?: string | string[];
          allowTypeOnly?: boolean;
          allow_type_only?: boolean;
          reason?: string | null;
          message?: string | null;
      };

export interface BlastOptions {
    contextDir?: string;
    base?: string;
    depth?: number | "all" | string;
    includeHistory?: boolean;
    since?: string;
    layerRules?: LayerRuleInput[];
    gitHistory?: Record<string, unknown>;
}

export interface BlastSeed {
    id: string;
    name: string;
    kind: NodeKind;
    path: string;
    span: string;
    wholeFile?: boolean;
}

export interface BlastChangedFile {
    path: string;
    status: string;
    ranges: Array<{ start: number; end: number }>;
    hunks?: Array<{ start: number; count: number; lines: string[] }>;
}

export interface BlastImpactedSymbol {
    id: string;
    name: string;
    kind: NodeKind;
    path: string;
    span: string;
    relation: EdgeRelation;
    depth: number;
    behavioral?: boolean;
    typeOnly?: boolean;
}

export interface BlastModuleGroup {
    label: string;
    labelSource: "concept" | "symbol";
    key: string;
    files: string[];
    symbols: BlastImpactedSymbol[];
    from: string[];
}

export interface BlastArea {
    label: string;
    labelSource: "concept" | "symbol";
    key: string;
    files: string[];
    seeds: number;
    tests: "na" | "changed" | "stale" | "none" | "covered" | "untouched";
    companionTestFiles?: string[];
    testFiles: string[];
    changedTestFiles: string[];
    reached: number;
    behavioural: number;
    unreached: string[];
    seedNames: string[];
}

export interface BlastCoChange {
    file: string;
    with?: string;
    count?: number;
    weight?: number;
    confidence?: number;
}

export interface BlastTestLink {
    sourceFile?: string;
    testFile: string;
    confidence: "high" | "medium" | "low";
    reason?: string;
}

export interface BlastLayerViolation {
    sourceFile: string;
    targetFile: string;
    relation: EdgeRelation;
    ruleFrom: string;
    ruleTo: string;
    reason: string | null;
}

export interface BlastHealthHotspot {
    file: string;
    role: "changed" | "impacted";
    count: number;
    max_tier: string;
    issues: Array<{
        id: string;
        detector: string;
        tier?: string;
        severity?: string;
        span?: string | null;
        summary?: string;
    }>;
}

export interface BlastResult {
    basis: string;
    depth: number;
    changed: BlastChangedFile[];
    unindexed: string[];
    deleted: string[];
    seeds: BlastSeed[];
    impacted: BlastImpactedSymbol[];
    modules: BlastModuleGroup[];
    testModules: BlastModuleGroup[];
    areas: BlastArea[];
    owners?: Array<{ name: string; commits: number }>;
    coChanges?: BlastCoChange[];
    untouchedCoChanges?: BlastCoChange[];
    testLinks?: BlastTestLink[];
    layerViolations?: BlastLayerViolation[];
    healthHotspots?: BlastHealthHotspot[];
    reviewers?: Array<{ name: string; email?: string; commits: number; score?: number }>;
    history?: Record<string, unknown>;
}

export type VizTab = "context" | "modules" | "symbols" | "treemap";

export interface VizServerOptions {
    root?: string;
    contextDir: string;
    viewerDir: string;
    port?: number;
    repoName?: string;
}

export interface ExportVizOptions {
    contextDir: string;
    viewerDir: string;
    outDir: string;
    repoName?: string;
    subtitle?: string;
    tabs?: VizTab[];
    contextGraph?: {
        nodes: unknown[];
        edges: unknown[];
        meta?: Record<string, unknown>;
    };
}

export interface ExportVizResult {
    file: string;
    bytes: number;
    contextNodes: number;
    codeNodes: number;
    defaultTab: string;
    tabs: VizTab[];
}

export interface HealthOptions {
    contextDir?: string;
    action?: string;
    detector?: string;
    scanPath?: string;
    only?: string | string[];
    skip?: string | string[];
    count?: number;
    readOnly?: boolean;
    noBadge?: boolean;
    profile?: string;
    [key: string]: unknown;
}

export interface HealthDimensionScore {
    score: number;
    tier?: number;
    open?: number;
    checks?: number;
    stale?: boolean;
}

export interface HealthScoreSnapshot {
    overall: number;
    objective: number;
    strict: number;
    verified: number;
    dimensions?: Record<string, HealthDimensionScore>;
    ignore_integrity?: {
        suppressed?: number;
        total?: number;
        pct?: number;
    };
}

export interface HealthIssueItem {
    id: string;
    detector: string;
    tier?: string;
    severity?: string;
    confidence?: string;
    status?: string;
    file?: string;
    span?: string | null;
    identifier?: string | null;
    summary?: string;
}

export interface HealthHeadline {
    open_count: number;
    target_score?: number;
    delta_to_target?: number;
    next_id?: string | null;
}

export interface HealthResult {
    action: string;
    verbose?: boolean;
    scores?: HealthScoreSnapshot;
    headline?: HealthHeadline;
    queue?: {
        items?: HealthIssueItem[];
        all_items?: HealthIssueItem[];
        total?: number;
    };
    items?: HealthIssueItem[];
    reminders?: Array<{ type: string; message: string; priority?: number }>;
    tree_text?: string;
    detector?: string;
    count?: number;
    scan_count?: number;
    last_scan_at?: string | null;
}

export interface WorkspaceSpec {
    version: 1;
    children: string[];
}

export interface LoadedWorkspaceGraphs {
    loaded: Array<{ child: string; graph: WiringGraph }>;
    missing: string[];
}

export interface CodeWorkspaceFolder {
    label: string;
    dir: string;
}

export interface CodeWorkspaceSpec {
    file: string;
    repos: CodeWorkspaceFolder[];
}

export interface FederatedCheckResult {
    text: string;
    ok: boolean;
    repos: Record<string, CheckGraphResult | null>;
    missing: string[];
}

export interface FederatedMapJsonResult {
    repos: Array<RepoMapResult & { repo: string }>;
    missing: string[];
    note?: string;
}

export interface PlexerConfig {
    contextDir?: string;
}

export class Plexer {
    readonly cfg: PlexerConfig;
    constructor(config?: PlexerConfig);
    check(dir: string, opts?: CheckGraphOptions): Promise<CheckGraphResult>;
    checkGraph(dir: string, opts?: CheckGraphOptions): Promise<CheckGraphResult>;
    graph(dir: string, opts?: BuildGraphOptions): Promise<BuildGraphResult>;
    ask(dir: string, query: string, opts?: AskOptions): AskResult;
    ask(dir: string, query: string[], opts?: AskOptions): AskResult[];
    ask(dir: string, query: string | string[], opts?: AskOptions): AskResult | AskResult[];
    skeleton(dir: string, file: string, opts?: SkeletonOptions): SkeletonResult;
    skeleton(dir: string, file: string[], opts?: SkeletonOptions): SkeletonResult[];
    skeleton(dir: string, file: string | string[], opts?: SkeletonOptions): SkeletonResult | SkeletonResult[];
    read(dir: string, spans: string | string[], opts?: ReadOptions): ReadSpansResult;
    blast(dir: string, opts?: BlastOptions): BlastResult;
    grep(dir: string, pattern: string, opts?: GrepOptions): GrepResult;
    grep(dir: string, pattern: string[], opts?: GrepOptions): GrepResult[];
    grep(dir: string, pattern: string | string[], opts?: GrepOptions): GrepResult | GrepResult[];
    callers(dir: string, symbol: string | string[], opts?: CallersOptions): CallersMatch[];
    map(dir: string, opts?: RepoMapOptions): RepoMapResult;
    health(dir: string, opts?: HealthOptions): HealthResult | Promise<HealthResult>;
    healthAsync(dir: string, opts?: HealthOptions): Promise<HealthResult>;
}

export function buildGraph(dir: string, opts?: BuildGraphOptions): Promise<BuildGraphResult>;
export function listSourceFiles(
    root: string,
    outDir: string,
    repoFiles?: string[],
    onlyDirs?: Set<string>,
    extensions?: string[],
): string[];
export function checkGraph(dir: string, opts?: CheckGraphOptions): Promise<CheckGraphResult>;
export function formatGraphCheckReport(report: CheckGraphResult): string;
export function readCodeWorkspace(dirOrFile: string): CodeWorkspaceSpec | null;
export function readWorkspace(root: string, override?: string): WorkspaceSpec | null;
export function loadWorkspaceGraphs(root: string, override?: string): LoadedWorkspaceGraphs;
export function federateAsk(root: string, override: string | undefined, query: string, opts?: AskOptions): AskResult;
export function federateSkeleton(root: string, override: string | undefined, file: string, opts?: SkeletonOptions): SkeletonResult;
export function federateGrep(
    root: string,
    override: string | undefined,
    pattern: string,
    opts?: GrepOptions,
): { result: GrepResult; coverage: string };
export function federateCallers(
    root: string,
    override: string | undefined,
    symbol: string | string[],
    opts?: CallersOptions & { source?: boolean; full?: boolean },
): { text: string; found: boolean; matches: Array<Record<string, unknown>>; coverage: string };
export function federateRead(
    root: string,
    override: string | undefined,
    spanSpecs: string | string[],
    opts?: ReadOptions,
): ReadSpansResult;
export function federateMap(
    root: string,
    override: string | undefined,
    opts?: RepoMapOptions & {
        json?: false;
        analyzeGitHistory?: (root: string, contextDir?: string, opts?: { since?: string }) => Record<string, unknown>;
    },
): string;
export function federateMap(
    root: string,
    override: string | undefined,
    opts: RepoMapOptions & {
        json: true;
        analyzeGitHistory?: (root: string, contextDir?: string, opts?: { since?: string }) => Record<string, unknown>;
    },
): FederatedMapJsonResult;
export function federateCheck(root: string, override?: string, opts?: CheckGraphOptions): Promise<FederatedCheckResult>;
export function ask(dir: string, query: string, opts?: AskOptions): AskResult;
export function formatAsk(result: AskResult): string;
export function skeleton(dir: string, file: string, opts?: SkeletonOptions): SkeletonResult;
export function formatSkeleton(result: SkeletonResult, opts?: { compact?: boolean; summaryOnly?: boolean }): string;
export function readSpans(dir: string, spanSpecs: string | string[], opts?: ReadOptions): ReadSpansResult;
export function formatReadSpans(result: ReadSpansResult): string;
export function grepGraph(graph: WiringGraph, root: string, pattern: string, opts?: GrepOptions): GrepResult;
export function formatGrepResult(result: GrepResult): string;
export function runGrepCommand(pattern: string, dir: string, opts?: GrepOptions & { globalDir?: string; json?: boolean }): void;
export function resolveSymbol(graph: WiringGraph, query: string, opts?: { in?: string }): GraphNode[];
export function edgeWalk(graph: WiringGraph, start: GraphNode, direction?: "in" | "out", maxDepth?: number): EdgeWalkHit[];
export function runCallersCommand(query: string, dir: string, opts?: CallersOptions & { globalDir?: string; json?: boolean }): void;
export function buildRepoMap(graph: WiringGraph, opts?: RepoMapOptions): RepoMapResult;
export function formatRepoMap(map: RepoMapResult): string;
export function blastRadius(
    dirOrGraph: string | WiringGraph,
    optsOrChanged?: BlastOptions | BlastChangedFile[],
    basis?: string,
    opts?: { depth?: number; modules?: unknown },
): BlastResult;
export interface BlastInOptions {
    basis?: string;
    depth?: number | "all" | string;
    rootDir?: string;
    layerRules?: LayerRuleInput[];
    gitHistory?: Record<string, unknown>;
    includeHistory?: boolean;
    since?: string;
}

export function blastRadiusIn(
    graph: WiringGraph,
    contextDir: string,
    changed: BlastChangedFile[],
    opts?: BlastInOptions,
): BlastResult;
export function blastRadiusIn(
    graph: WiringGraph,
    contextDir: string,
    changed: BlastChangedFile[],
    basis?: string,
    depth?: number | "all" | string,
    opts?: BlastInOptions,
): BlastResult;
export function textReport(blast: BlastResult): string;
export function markdownReport(blast: BlastResult, opts?: { root?: string }): string;
export function mermaidDiagram(blast: BlastResult): string | null;
export function startVizServer(opts: VizServerOptions): Promise<{ url: string; port: number; close: () => Promise<void> }>;
export function exportViz(opts: ExportVizOptions): ExportVizResult;
export function startMcpServer(root?: string, dirOverride?: string, version?: string): void;
export function health(dir: string, opts?: HealthOptions): HealthResult | Promise<HealthResult>;
export function healthAsync(dir: string, opts?: HealthOptions): Promise<HealthResult>;
export function formatHealthText(report: HealthResult): string;
export function formatHealthMarkdown(report: HealthResult): string;

