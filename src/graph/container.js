/**
 * Container tier — files that are not a language but a wrapper around one.
 *
 * A Vue SFC is the motivating case: `.vue` is HTML-shaped, and everything worth
 * indexing lives inside its `<script>` block. Registering `tree-sitter-vue` as a
 * breadth-tier language (generic.js) would not help — that grammar parses the
 * shell (`<template>` / `<script>` / `<style>`) and hands back the script body as
 * one opaque `raw_text` node, so the cards would come out empty.
 *
 * So the container grammar is used only to answer "where does the embedded
 * language start and end", and the block itself goes to the DEPTH-tier extractor
 * (extract.js). A `.vue` file therefore gets the same quality of extraction as a
 * `.ts` file — bindings, imports, resolved calls — not the signature-only output
 * the breadth tier would give.
 *
 * **The span shift is the whole risk here.** `extractFile` numbers its spans from
 * the start of the string it was handed, so every node comes back pointing at a
 * line in the script, not in the `.vue`. A span that is off by even one line is
 * worse than not indexing the file at all: plexer's promise is that its
 * `file:line` is exact, and a plausible-but-wrong line silently sends the reader
 * to the wrong place. `test/plexer.test.js` pins this against
 * fixtures whose true line numbers are known.
 */
import { spanRange } from "../util/span.js";
import { extractFile, mintId, warmDepthGrammars } from "./extract.js";
import { loadWasmLanguage, parseWasm } from "./generic.js";
import { contentHash } from "../util/id.js";
import { CONTAINER_LANGS, containerExtensions, containerLangOf } from "./languages.js";
export { CONTAINER_LANGS, containerExtensions, containerLangOf };
const loaded = new Map();
/** Warm the container grammars this repo needs. Same contract as
 * `warmGenericGrammars`: await once before the synchronous parse loop, and an
 * unavailable grammar is skipped rather than fatal (its files then extract to a
 * file node only, exactly as they do today). */
export async function warmContainerGrammars(langNames) {
    for (const name of new Set(langNames)) {
        if (loaded.has(name))
            continue;
        const row = CONTAINER_LANGS.find((l) => l.name === name);
        if (!row)
            continue;
        await warmDepthGrammars(row.warmInner ?? [row.inner]);
        const language = await loadWasmLanguage(row.wasm);
        if (language)
            loaded.set(name, language);
    }
}
/** `L12-L20` shifted by n lines. The span format is produced in exactly two
 * places (extract.js and generic.js) and is always this shape; anything else is
 * returned untouched rather than guessed at. */
function shiftSpan(span, lines) {
    const range = spanRange(span);
    if (!range)
        return span;
    return `L${range.start + lines}-L${range.end + lines}`;
}
/** The `.vue` file's own node. Deliberately describes the whole file — line
 * count, hash and size of the SFC, not of the script block — because that is
 * what a reader opening this path will see. */
function containerFileNode(rel, source, residual) {
    return {
        id: rel,
        name: rel.split("/").pop() ?? rel,
        kind: "file",
        path: rel,
        span: `L1-L${Math.max(1, source.split("\n").length)}`,
        signature: null,
        exported: true,
        // "ast", not "generic": the symbols under this file come from the depth-tier
        // extractor with real bindings and specifiers. resolve.js gates a
        // guess-by-name fallback on `origin === "generic"`, and these nodes must not
        // take it — they carry the information to resolve properly.
        origin: "ast",
        body_hash: contentHash(source),
        chars: source.length,
        body_text: residual,
        summary_state: "pending",
        summary: null,
        crux: null,
    };
}
function scriptBlockInnerLang(blockNode, defaultInner) {
    if (blockNode.type === "frontmatter")
        return "typescript";
    const startTag = blockNode.namedChildren?.find((c) => c.type === "start_tag");
    if (!startTag)
        return defaultInner;
    for (const attr of startTag.namedChildren ?? []) {
        if (attr.type !== "attribute")
            continue;
        const nameNode = attr.namedChildren?.find((c) => c.type === "attribute_name");
        if (nameNode?.text?.toLowerCase() !== "lang")
            continue;
        const quoted = attr.namedChildren?.find((c) => c.type === "quoted_attribute_value");
        const valNode = quoted?.namedChildren?.find((c) => c.type === "attribute_value") ??
            attr.namedChildren?.find((c) => c.type === "attribute_value");
        const raw = (valNode?.text ?? quoted?.text ?? "").replace(/^['"]|['"]$/g, "").trim().toLowerCase();
        if (raw === "tsx" || raw === "jsx")
            return "tsx";
        if (raw === "ts" || raw === "typescript" || raw === "js" || raw === "javascript")
            return "typescript";
    }
    return defaultInner;
}

/** Every embedded block in document order, as `{ body, innerLang }` — an SFC may legally
 * carry two (`<script>` for options/exports plus `<script setup>`), or Astro frontmatter +
 * client `<script>`, each with its own line offset and `lang` attribute. */
function blocks(root, lang) {
    const out = [];
    const n = root.namedChildCount ?? 0;
    for (let i = 0; i < n; i++) {
        const child = root.namedChild?.(i);
        if (!child)
            continue;
        const isScript = child.type === lang.block;
        const isFrontmatter = Boolean(lang.frontmatterBlock && child.type === lang.frontmatterBlock);
        if (!isScript && !isFrontmatter)
            continue;
        const targetBodyType = isFrontmatter ? lang.frontmatterBody : lang.body;
        const innerLang = scriptBlockInnerLang(child, lang.inner);
        const kids = child.namedChildCount ?? 0;
        for (let j = 0; j < kids; j++) {
            const body = child.namedChild?.(j);
            // An empty `<script></script>` has no body child at all — skipped here, so
            // the file still gets its file node and nothing else, which is the same
            // shape as a file whose grammar is missing.
            if (body && body.type === targetBodyType)
                out.push({ body, innerLang });
        }
    }
    return out;
}
function kebabToPascal(tag) {
    return tag
        .split("-")
        .filter(Boolean)
        .map((part) => part[0].toUpperCase() + part.slice(1))
        .join("");
}

const TEMPLATE_KEYWORDS = new Set([
    "true", "false", "null", "undefined", "this", "event", "arguments", "typeof", "instanceof", "return", "new",
    "if", "else", "for", "of", "in", "let", "const", "var", "await", "async", "slot", "component", "template",
]);

function collectTemplateMarkupEdges(root, rel, scriptSyms, rawEdges, importedByName = null) {
    const symByName = new Map();
    const impByName = new Map();
    for (const s of scriptSyms) {
        if (s.kind && s.name && !symByName.has(s.name))
            symByName.set(s.name, s);
    }
    if (importedByName instanceof Map) {
        for (const [localName, info] of importedByName) {
            if (info?.specifier && !impByName.has(localName)) {
                impByName.set(localName, {
                    name: info.isDefault ? localName : (info.name || localName),
                    specifier: info.specifier,
                    isDefault: info.isDefault,
                    typeOnly: info.typeOnly,
                });
            }
        }
    }
    for (const e of rawEdges) {
        if ((e.relation === "references" || e.relation === "calls") && e.name && e.specifier && !impByName.has(e.name)) {
            impByName.set(e.name, { name: e.name, specifier: e.specifier, isDefault: e.isDefault, typeOnly: e.typeOnly });
        }
    }
    const seenEdgeKeys = new Set();
    const pushRef = (name, relation = "references", viaImport = null) => {
        const imp = viaImport ?? impByName.get(name);
        const key = `${relation}\0${name}\0${imp?.specifier ?? ""}`;
        if (seenEdgeKeys.has(key))
            return;
        seenEdgeKeys.add(key);
        if (imp?.specifier) {
            rawEdges.push({
                source: rel,
                relation,
                name: imp.name || name,
                specifier: imp.specifier,
                file: rel,
                ...(imp.isDefault ? { isDefault: true } : {}),
                ...(imp.typeOnly ? { typeOnly: true } : {}),
            });
            return;
        }
        const localSym = symByName.get(name);
        if (localSym) {
            rawEdges.push({ source: rel, relation, name, file: rel, sameFileOnly: true });
        }
    };
    const inspectExpressionText = (exprText) => {
        if (!exprText)
            return;
        for (const m of exprText.matchAll(/\b([A-Za-z_$][\w$]*)(?:\s*\()?/g)) {
            const ident = m[1];
            if (!ident || TEMPLATE_KEYWORDS.has(ident))
                continue;
            const isCall = m[0].endsWith("(") || /^\s*[A-Za-z_$][\w$.]*\s*$/.test(exprText.trim());
            if (symByName.has(ident) || impByName.has(ident)) {
                pushRef(ident, isCall ? "calls" : "references");
            }
        }
    };
    const visitTemplateNode = (node, insideScriptOrStyle = false) => {
        if (!node)
            return;
        if (node.type === "script_element" || node.type === "style_element" || node.type === "frontmatter")
            return;
        if ((node.type === "start_tag" || node.type === "self_closing_tag") && !insideScriptOrStyle) {
            const tagNode = node.namedChildren?.find((c) => c.type === "tag_name");
            const rawTag = tagNode?.text?.trim();
            if (rawTag) {
                const candidate = rawTag.includes("-")
                    ? kebabToPascal(rawTag)
                    : rawTag.includes(".")
                        ? rawTag.split(".")[0]
                        : (/^[A-Z]/.test(rawTag) ? rawTag : null);
                if (candidate) {
                    pushRef(candidate, "references");
                }
            }
        }
        if (
            node.type === "attribute_value" &&
            (node.parent?.parent?.type === "directive_attribute" || node.parent?.parent?.parent?.type === "directive_attribute")
        ) {
            inspectExpressionText(node.text);
        }
        else if (node.type === "raw_text_expr" || node.type === "attribute_js_expr" || node.type === "interpolation") {
            inspectExpressionText(node.text);
        }
        for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
            visitTemplateNode(node.namedChild(i), insideScriptOrStyle);
        }
    };
    visitTemplateNode(root, false);
}

/**
 * Extract one container file. Synchronous; needs the grammar pre-warmed.
 *
 * Never throws: a missing grammar, an unparseable SFC or a script block the
 * inner extractor chokes on all degrade to "fewer nodes", because a build must
 * not fail over one component.
 */
export function extractContainer(rel, source, lang = containerLangOf(rel)) {
    const langSpec = typeof lang === "string" ? CONTAINER_LANGS.find((l) => l.name === lang) : lang;
    const nodes = [];
    const rawEdges = [];
    const residuals = [];
    const language = langSpec ? loaded.get(langSpec.name) : null;
    const root = language ? parseWasm(language, source) : null;
    if (root) {
        try {
            const minted = new Set([rel]);
            const importedByName = new Map();
            for (const { body, innerLang } of blocks(root, langSpec)) {
                const script = source.slice(body.startIndex, body.endIndex);
                let inner;
                try {
                    inner = extractFile(rel, script, innerLang, { includeImportedSymbols: importedByName });
                }
                catch {
                    continue; // one bad block, not a bad build
                }
                // `raw_text` starts immediately after the `>` of the opening tag, so its
                // row IS the tag's row and the slice begins with that line's newline.
                // Script line 1 is therefore the tail of the tag line, and script line N
                // lands on `.vue` line row + N — which is exactly "add the start row to a
                // 1-based span". Taking the row from the tag node instead would look
                // equivalent and be right only when the tag has no attributes.
                const shift = body.startPosition.row;
                // nodes[0] is the script's own file node: it describes the block, not the
                // file, so it is dropped and its residual folded into the .vue file node.
                const [scriptFile, ...symbols] = inner.nodes;
                if (scriptFile?.body_text)
                    residuals.push(scriptFile.body_text);
                const renamed = new Map();
                for (const node of symbols) {
                    const id = mintId(node.id, minted);
                    if (id !== node.id)
                        renamed.set(node.id, id);
                    nodes.push({ ...node, id, span: shiftSpan(node.span, shift) });
                }
                for (const edge of inner.rawEdges) {
                    const source_ = renamed.get(edge.source) ?? edge.source;
                    const targetId = edge.targetId === undefined ? undefined : (renamed.get(edge.targetId) ?? edge.targetId);
                    rawEdges.push({ ...edge, source: source_, ...(targetId === undefined ? {} : { targetId }) });
                }
            }
            collectTemplateMarkupEdges(root, rel, nodes, rawEdges, importedByName);
        }
        finally {
            root._tree?.delete?.();
        }
    }
    // Built last so it can carry the residual, but unshifted first so the file node
    // stays at index 0 like every other tier's output.
    nodes.unshift(containerFileNode(rel, source, residuals.join("\n")));
    return { nodes, rawEdges };
}
