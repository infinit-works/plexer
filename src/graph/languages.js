/**
 * Pure language extension registries and cross-language reachability helpers.
 * Kept free of AST/WASM/SQLite imports so graph consumers load in <1ms.
 */
export const DEPTH_EXTENSIONS = [
    { ext: ".tsx", grammar: "tsx", label: "tsx" },
    { ext: ".jsx", grammar: "tsx", label: "jsx" },
    { ext: ".mts", grammar: "typescript", label: "typescript" },
    { ext: ".cts", grammar: "typescript", label: "typescript" },
    { ext: ".ts", grammar: "typescript", label: "typescript" },
    { ext: ".mjs", grammar: "typescript", label: "javascript" },
    { ext: ".cjs", grammar: "typescript", label: "javascript" },
    { ext: ".js", grammar: "typescript", label: "javascript" },
    { ext: ".pyi", grammar: "python", label: "python" },
    { ext: ".py", grammar: "python", label: "python" },
    { ext: ".go", grammar: "go", label: "go" },
    { ext: ".java", grammar: "java", label: "java" },
    { ext: ".kt", grammar: "kotlin", label: "kotlin" },
    { ext: ".kts", grammar: "kotlin", label: "kotlin" },
    { ext: ".swift", grammar: "swift", label: "swift" },
    { ext: ".php", grammar: "php", label: "php" },
    { ext: ".r", grammar: "r", label: "r" },
];

function depthEntryFor(path) {
    const p = path.toLowerCase();
    return DEPTH_EXTENSIONS.find((e) => p.endsWith(e.ext));
}

export function depthExtensions() {
    return DEPTH_EXTENSIONS.map((e) => e.ext);
}

export function languageOf(path) {
    return depthEntryFor(path)?.grammar ?? null;
}

export const GENERIC_LANGS = [
    { name: "rust", exts: [".rs"], wasm: "rust" },
    { name: "c", exts: [".c", ".h"], wasm: "c" },
    { name: "cpp", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx", ".h++", ".c++", ".inl", ".ipp", ".tpp", ".ixx"], wasm: "cpp" },
    { name: "ruby", exts: [".rb"], wasm: "ruby" },
    { name: "c_sharp", exts: [".cs"], wasm: "c_sharp" },
    { name: "scala", exts: [".scala", ".sc"], wasm: "scala" },
    { name: "elixir", exts: [".ex", ".exs"], wasm: "elixir" },
    { name: "solidity", exts: [".sol"], wasm: "solidity" },
    { name: "ocaml", exts: [".ml"], wasm: "ocaml" },
    { name: "ocaml_interface", exts: [".mli"], wasm: "ocaml_interface" },
    { name: "zig", exts: [".zig"], wasm: "zig" },
    { name: "dart", exts: [".dart"], wasm: "dart" },
    { name: "clojure", exts: [".clj", ".cljs", ".cljc", ".bb"], wasm: "clojure" },
    { name: "nix", exts: [".nix"], wasm: "nix" },
    { name: "lua", exts: [".lua"], wasm: "lua" },
    { name: "luau", exts: [".luau"], wasm: "luau" },
    { name: "bash", exts: [".sh", ".bash", ".zsh"], wasm: "bash" },
    { name: "sql", exts: [".sql"], wasm: "sql" },
    { name: "hcl", exts: [".tf", ".tfvars", ".hcl"], wasm: "hcl" },
    { name: "proto", exts: [".proto"], wasm: "proto" },
    { name: "graphql", exts: [".graphql", ".gql"], wasm: "graphql" },
    { name: "objc", exts: [".m", ".mm"], wasm: "objc" },
    { name: "haskell", exts: [".hs"], wasm: "haskell" },
    { name: "gleam", exts: [".gleam"], wasm: "gleam" },
    { name: "cuda", exts: [".cu", ".cuh"], wasm: "cuda" },
];

const genericByExt = new Map();
for (const l of GENERIC_LANGS)
    for (const e of l.exts)
        genericByExt.set(e, l);
const GENERIC_EXTS_SORTED = [...genericByExt.entries()].sort((a, b) => b[0].length - a[0].length);

export function genericLangOf(path) {
    const lower = path.toLowerCase();
    for (const [ext, l] of GENERIC_EXTS_SORTED)
        if (lower.endsWith(ext))
            return l;
    return null;
}

export function genericExtensions() {
    return GENERIC_LANGS.flatMap((l) => l.exts);
}

export const CONTAINER_LANGS = [
    { name: "vue", exts: [".vue"], wasm: "vue", block: "script_element", body: "raw_text", inner: "typescript", warmInner: ["typescript", "tsx"] },
    { name: "svelte", exts: [".svelte"], wasm: "svelte", block: "script_element", body: "raw_text", inner: "typescript", warmInner: ["typescript", "tsx"] },
    { name: "astro", exts: [".astro"], wasm: "astro", block: "script_element", body: "raw_text", frontmatterBlock: "frontmatter", frontmatterBody: "frontmatter_js_block", inner: "typescript", warmInner: ["typescript", "tsx"] },
];

const containerByExt = new Map();
for (const l of CONTAINER_LANGS)
    for (const e of l.exts)
        containerByExt.set(e, l);

export function containerLangOf(path) {
    const lower = path.toLowerCase();
    for (const [ext, l] of containerByExt)
        if (lower.endsWith(ext))
            return l;
    return null;
}

export function containerExtensions() {
    return CONTAINER_LANGS.flatMap((l) => l.exts);
}

export function languageLabelOf(path) {
    const p = path.toLowerCase();
    const containerLabel = p.endsWith(".vue") ? "vue" : p.endsWith(".svelte") ? "svelte" : p.endsWith(".astro") ? "astro" : null;
    const genName = genericLangOf(path)?.name;
    const normGenLabel = genName === "ocaml_interface" ? "ocaml" : genName;
    return depthEntryFor(path)?.label ?? containerLabel ?? normGenLabel ?? null;
}

const FAMILIES = [
    ["typescript", "tsx"],
    ["java", "kotlin", "scala", "clojure"],
    ["c", "cpp", "objc", "cuda"],
    ["lua", "luau"],
    ["ocaml", "ocaml_interface"],
];
const FAMILY_OF = new Map();
for (const group of FAMILIES)
    for (const lang of group)
        FAMILY_OF.set(lang, group[0]);

export function familyOf(path) {
    const lang = languageOf(path) ?? containerLangOf(path)?.inner ?? genericLangOf(path)?.name ?? null;
    if (!lang)
        return null;
    return FAMILY_OF.get(lang) ?? lang;
}

export function reachable(file, candidatePath) {
    const from = familyOf(file);
    if (from === null)
        return true;
    const to = familyOf(candidatePath);
    return to === null || from === to;
}
