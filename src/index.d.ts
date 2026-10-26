export type NodeKind =
    | "file"
    | "function"
    | "method"
    | "class"
    | "interface"
    | "type"
    | "enum"
    | "struct"
    | "constant"
    | "variable"
    | "property"
    | "module"
    | "macro";

export type EdgeRelation = "calls" | "imports" | "implements" | "extends" | "references" | "contains";

export interface GraphNode {
    id: string;
    name: string;
    kind: NodeKind;
    path: string;
    span: string;
    exported?: boolean;
    signature?: string | null;
    summary?: string | null;
    crux?: string | null;
    body_hash?: string;
    body_text?: string;
}

export interface GraphEdge {
    source: string;
    target: string;
    relation: EdgeRelation;
    confidence?: "extracted" | "inferred";
    line?: number;
}

export interface GraphScope {
    prefix: string;
    nodes: number;
}

export interface WiringGraph {
    meta: {
        generated_at: string;
        root: string;
        files: number;
        nodes: number;
        edges: number;
        languages: string[];
        config_hash?: string;
        scopes?: GraphScope[];
    };
    nodes: GraphNode[];
    edges: GraphEdge[];
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
}

export interface AskResult {
    query: string;
    mode: "lexical" | "structural" | "empty";
    hits: AskHit[];
    coverage?: number;
    coverageStrong?: number;
    scopes?: {
        federated: string[];
        alsoMatched: Array<{ scope: string; topScore: number }>;
    };
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
}

export interface ReadSpanBlock {
    spec: string;
    file?: string;
    span?: string;
    totalLines?: number;
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
}

export interface EdgeWalkHit {
    id: string;
    node?: GraphNode;
    relation: EdgeRelation;
    depth: number;
    via?: string;
    line?: number;
}

export interface CallersOptions {
    direction?: "in" | "out";
    depth?: number | "all" | string;
    in?: string;
}

export interface CallersMatch {
    symbol: GraphNode;
    hits: EdgeWalkHit[];
}

export interface RepoMapOptions {
    maxDirs?: number;
    hubsPerDir?: number;
    hotspots?: number;
}

export interface RepoMapHub {
    name: string;
    kind: NodeKind;
    path: string;
    span: string;
    inDegree: number;
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
}

export interface BlastOptions {
    contextDir?: string;
    base?: string;
    depth?: number | "all" | string;
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
    behavioral: boolean;
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
    tests: "covered" | "untouched" | "none";
    testFiles: string[];
    changedTestFiles: string[];
    reached: number;
    behavioural: number;
    unreached: string[];
    seedNames: string[];
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
}

export type VizTab = "context" | "code" | "modules" | "symbols" | "outline";

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

export interface PlexerConfig {
    contextDir?: string;
}

export class Plexer {
    constructor(config?: PlexerConfig);
    check(dir: string, opts?: CheckGraphOptions): Promise<CheckGraphResult>;
    checkGraph(dir: string, opts?: CheckGraphOptions): Promise<CheckGraphResult>;
    graph(dir: string, opts?: BuildGraphOptions): Promise<BuildGraphResult>;
    ask(dir: string, query: string, opts?: AskOptions): AskResult;
    skeleton(dir: string, file: string, opts?: SkeletonOptions): SkeletonResult;
    read(dir: string, spans: string | string[], opts?: ReadOptions): ReadSpansResult;
    blast(dir: string, opts?: BlastOptions): BlastResult;
    grep(dir: string, pattern: string, opts?: GrepOptions): GrepResult;
    callers(dir: string, symbol: string, opts?: CallersOptions): CallersMatch[];
    map(dir: string, opts?: RepoMapOptions): RepoMapResult;
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
export function ask(dir: string, query: string, opts?: AskOptions): AskResult;
export function formatAsk(result: AskResult): string;
export function skeleton(dir: string, file: string, opts?: SkeletonOptions): SkeletonResult;
export function formatSkeleton(result: SkeletonResult): string;
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
export function blastRadiusIn(
    graph: WiringGraph,
    contextDir: string,
    changed: BlastChangedFile[],
    basis?: string,
    depth?: number,
): BlastResult;
export function textReport(blast: BlastResult): string;
export function markdownReport(blast: BlastResult, opts?: { root?: string }): string;
export function mermaidDiagram(blast: BlastResult): string | null;
export function startVizServer(opts: VizServerOptions): Promise<{ url: string; port: number; close: () => Promise<void> }>;
export function exportViz(opts: ExportVizOptions): ExportVizResult;
export function startMcpServer(root?: string, dirOverride?: string, version?: string): void;

