import { loadAskIndexCached, loadAskVocabCached, recordNodeCompoundVocab, stemToken, tokenize } from '../../../ask/index-file.js';
import { loadGraphCached } from '../../../context/graph-store.js';

export const PROMPT_BOILERPLATE_NOISE = new Set([
    'plexer', 'directory', 'concisely', 'exact', 'citations', 'line', 'lines',
    'investigate', 'answer', 'developer', 'notices', 'refactor', 'refactoring',
    'currently', 'implement', 'extend', 'support', 'preserve', 'existing',
    'verify', 'passes', 'pass', 'test', 'tests', 'suite', 'important', 'edit',
    'source', 'files', 'directly', 'inside', 'full', 'package', 'installations',
    'container', 'builds', 'stop', 'soon', 'applied', 'changes', 'following',
    'requirements', 'interface', 'contract', 'locations', 'codebase', 'ensure',
    'behavior', 'properly', 'without', 'when', 'what', 'where', 'which', 'lx', 'ly',
    'if', 'not', 'no', 'yes', 'true', 'false', 'nil', 'null', 'one', 'two', 'three',
    'both', 'each', 'all', 'any', 'some', 'other', 'another', 'same', 'different',
    'first', 'second', 'before', 'after', 'during', 'while', 'until', 'under',
    'over', 'across', 'through', 'also', 'still', 'only', 'already', 'yet', 'more',
    'less', 'most', 'least', 'very', 'such', 'than', 'then', 'else', 'otherwise',
    'instead', 'whether', 'because', 'since', 'would', 'should', 'could', 'must',
    'may', 'might', 'will', 'shall', 'have', 'has', 'had', 'having', 'been',
    'being', 'make', 'makes', 'made', 'take', 'takes', 'give', 'gives', 'given',
    'call', 'called', 'calling', 'return', 'returns', 'returning', 'returned',
    'function', 'functions', 'method', 'methods', 'module', 'modules', 'file',
    'type', 'types', 'value', 'values', 'object', 'objects', 'table', 'tables',
    'list', 'array', 'string', 'number', 'boolean', 'result', 'results', 'data',
    'info', 'item', 'items', 'entry', 'entries', 'part', 'parts', 'step', 'steps',
    'plan', 'system', 'code', 'state', 'check', 'checks', 'checking', 'checked',
    'evaluate', 'evaluates', 'detect', 'detects', 'expose', 'exposes', 'them',
    'their', 'they', 'defined', 'define', 'defines', 'invoke', 'invokes', 'invoked',
    'numeric', 'trigger', 'triggers', 'offending', 'exceeded', 'symbols', 'lazy',
    'small', 'large', 'medium', 'improve', 'issues', 'usage', 'spent',
    'correctness', 'possible', 'afterwards', 'progress', 'grill', 'philosophy',
    'traditional', 'differs', 'approach', 'everything', 'anything', 'performing',
    'worse', 'better', 'leverage', 'saved', 'saving', 'closer', 'slower',
    'faster', 'regress', 'regressed', 'regression',
]);

const corpusVocabCache = new Map();

function deriveVocabFromHydrated(vh) {
    const nameTokens = new Set();
    const validStems = new Set();
    for (const t of vh.nameTokens) {
        if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t)) {
            nameTokens.add(t);
            validStems.add(stemToken(t));
        }
    }
    const nameStems = new Map();
    for (const [s, c] of vh.nameStems) if (validStems.has(s)) nameStems.set(s, c);
    const pathTokens = new Set();
    for (const t of vh.pathTokens) if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t)) pathTokens.add(t);
    return {
        dfMap: vh.dfMap, stemDf: vh.stemDf, nameTokens, nameStems, pathTokens,
        compoundSymbols: vh.compoundSymbols, nDocs: vh.nDocs,
    };
}

function addGraphVocab(graph, buildDf, vocab) {
    for (const n of graph.nodes) {
        if (buildDf) {
            const docStems = new Set();
            for (const t of new Set([...tokenize(n.name ?? ''), ...tokenize(n.path ?? ''), ...tokenize(`${n.signature ?? ''} ${n.summary ?? ''} ${n.body_text ?? ''}`)])) {
                vocab.dfMap.set(t, (vocab.dfMap.get(t) ?? 0) + 1);
                docStems.add(stemToken(t));
            }
            for (const s of docStems) vocab.stemDf.set(s, (vocab.stemDf.get(s) ?? 0) + 1);
        }
        recordNodeCompoundVocab(n, vocab.compoundSymbols);
        for (const t of tokenize(n.path ?? '')) if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t)) vocab.pathTokens.add(t);
        if (n.kind === 'file') continue;
        const seenStems = new Set();
        for (const t of tokenize(n.name ?? '')) {
            if (t.length < 3 || PROMPT_BOILERPLATE_NOISE.has(t)) continue;
            vocab.nameTokens.add(t);
            const s = stemToken(t);
            if (!seenStems.has(s)) { seenStems.add(s); vocab.nameStems.set(s, (vocab.nameStems.get(s) ?? 0) + 1); }
        }
    }
}

export function buildCorpusVocab(outDir) {
    const cached = corpusVocabCache.get(outDir);
    const vh = loadAskVocabCached(outDir);
    if (vh?.dfMap && vh?.stemDf) {
        if (cached?.fromHydrated && cached.idxRef === vh) return cached.vocab;
        const vocab = deriveVocabFromHydrated(vh);
        corpusVocabCache.set(outDir, { idxRef: vh, graphRef: null, fromHydrated: true, vocab });
        return vocab;
    }
    const idx = loadAskIndexCached(outDir);
    if (idx?.vocabHydrated) {
        if (cached?.fromHydrated && cached.idxRef === idx) return cached.vocab;
        const vocab = deriveVocabFromHydrated(idx.vocabHydrated);
        corpusVocabCache.set(outDir, { idxRef: idx, graphRef: null, fromHydrated: true, vocab });
        return vocab;
    }
    const graph = loadGraphCached(outDir);
    if (!idx && !graph) { corpusVocabCache.delete(outDir); return null; }
    if (cached && !cached.fromHydrated && cached.idxRef === idx && cached.graphRef === graph) return cached.vocab;
    const vocab = {
        dfMap: idx ? new Map(idx.df) : new Map(), stemDf: new Map(),
        nameTokens: new Set(), nameStems: new Map(), pathTokens: new Set(),
        compoundSymbols: new Map(), nDocs: idx?.docCount || graph?.nodes?.length || 100,
    };
    if (graph) addGraphVocab(graph, !idx, vocab);
    if (idx?.docs) {
        for (const d of idx.docs) {
            const docStems = new Set();
            for (const [t] of [...(d.name ?? []), ...(d.path ?? []), ...(d.body ?? [])]) docStems.add(stemToken(t));
            for (const s of docStems) vocab.stemDf.set(s, (vocab.stemDf.get(s) ?? 0) + 1);
        }
    }
    corpusVocabCache.set(outDir, { idxRef: idx, graphRef: graph, fromHydrated: false, vocab });
    return vocab;
}

function addPhraseTokens(targetSet, phrase) {
    for (const t of tokenize(phrase)) {
        if (!PROMPT_BOILERPLATE_NOISE.has(t)) targetSet.add(t);
    }
}

export function extractBacktickPhrases(cleaned) {
    const backtickPhrases = [];
    const backticked = new Set();
    for (const m of cleaned.matchAll(/`([^`\n]{2,80})`/g)) {
        const inner = m[1].trim().replace(/^\/app\//, '');
        if (/^(?:\/tmp\/|\/home\/|\/var\/)/i.test(inner)) continue;
        if (inner.includes('@') && !inner.startsWith('@')) continue;
        if (/^(?:src|bin|test|pkg|internal|lib)\/?$/i.test(inner)) continue;
        const fnCall = inner.match(/^([A-Za-z_][A-Za-z0-9_.:]*)\s*\(/);
        const cliCmd = !fnCall ? inner.match(/^plexer\s+([a-z][a-z0-9_-]*)\b/i) : null;
        const phrase = fnCall?.[1] ?? cliCmd?.[1] ?? inner;
        if (!fnCall && !cliCmd && inner.includes(' ') && !/^[A-Za-z0-9_.:/-]+\s+[A-Za-z0-9_.:/-]+$/.test(inner)) continue;
        backtickPhrases.push(phrase);
        addPhraseTokens(backticked, phrase);
    }
    return { backtickPhrases, backticked };
}

function matchBigramCompound(w1, w2, w3, compoundSymbols) {
    const bi = `${w1}${w2}`;
    const fwdStem = `${stemToken(w1)}${stemToken(w2)}`;
    const revStem = `${stemToken(w2)}${stemToken(w1)}`;
    const nextIsNeg = w3 === 'not' || w3 === 'never';
    const fwdSym = fwdStem.length >= 8 ? compoundSymbols.get(fwdStem) : undefined;
    const direct = (bi.length >= 8 && compoundSymbols.get(bi))
        || (fwdSym?.includes('.') ? fwdSym : undefined)
        || (!nextIsNeg && revStem.length >= 7 ? compoundSymbols.get(revStem) : undefined);
    if (direct) return direct;
    const roots = w2.endsWith('ing') && w2.length > 5
        ? [w2.slice(0, -3), `${w2.slice(0, -3)}e`]
        : /(?:ate|ite|ete|ove|ore|ule|ile|ise|ize)s$/.test(w2) ? [w2.slice(0, -1)] : [];
    for (const v of roots) {
        if (v.length + w1.length >= 8 && compoundSymbols.has(`${v}${w1}`)) return compoundSymbols.get(`${v}${w1}`);
    }
    return null;
}

export function extractCamelAndCompoundPhrases(cleaned, compoundSymbols) {
    const camelOrCodePhrases = [];
    const camelOrCode = new Set();
    const codeRe = /\b([a-z]+[A-Z][A-Za-z0-9_]*|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9_]*|[a-z0-9_]+(?:_[a-z0-9_]+)+|[A-Za-z0-9_/-]+\.(?:py|go|js|ts|tsx|jsx|luau|rs))\b/g;
    for (const m of cleaned.matchAll(codeRe)) {
        if (cleaned[(m.index ?? 0) + m[0].length] === '@') continue;
        const phrase = m[1].replace(/^\/app\//, '');
        if (/^(?:tmp|plexer_swebench|plexer_ab|pr_description)\b/i.test(phrase)) continue;
        camelOrCodePhrases.push(phrase);
        addPhraseTokens(camelOrCode, phrase);
    }
    if (!compoundSymbols?.size) return { camelOrCodePhrases, camelOrCode };
    const words = [...cleaned.matchAll(/\b([A-Za-z]{3,})\b/g)].map((m) => m[1].toLowerCase());
    for (let i = 0; i < words.length - 1; i++) {
        const [w1, w2, w3 = ''] = [words[i], words[i + 1], words[i + 2]];
        if (PROMPT_BOILERPLATE_NOISE.has(w1)) continue;
        const tri = w3 && !PROMPT_BOILERPLATE_NOISE.has(w3) ? `${w1}${w2}${w3}` : '';
        if (tri && compoundSymbols.has(tri)) {
            camelOrCodePhrases.push(compoundSymbols.get(tri));
            camelOrCode.add(w1); camelOrCode.add(w2); camelOrCode.add(w3);
            i += 2; continue;
        }
        if (PROMPT_BOILERPLATE_NOISE.has(w2)) continue;
        const sym = matchBigramCompound(w1, w2, w3, compoundSymbols);
        if (sym) { camelOrCodePhrases.push(sym); camelOrCode.add(w1); camelOrCode.add(w2); }
    }
    return { camelOrCodePhrases, camelOrCode };
}

export function selectTopCompounds(vocab, rawCompounds, maxCompounds) {
    const { dfMap, stemDf, nameTokens, nameStems, pathTokens, nDocs } = vocab;
    const scored = rawCompounds.map((c) => {
        const subToks = tokenize(c).filter((t) => !PROMPT_BOILERPLATE_NOISE.has(t));
        let score = /\.(?:py|go|js|ts|tsx|jsx|luau|rs)$/i.test(c) ? 18 : 0;
        for (const st of subToks) {
            const s = stemToken(st);
            const df = dfMap.get(st) ?? stemDf.get(s) ?? 0;
            const idf = df > 0 ? Math.log(1 + nDocs / Math.max(2, df)) : 1.0;
            const inSym = nameTokens.has(st) || nameStems.has(s);
            const inPath = pathTokens.has(st);
            score += idf * (inSym && inPath ? 3.5 : inSym ? 2.8 : inPath ? 2.2 : 0.8);
        }
        return { c, score };
    }).sort((a, b) => b.score - a.score);
    const compounds = [];
    for (const x of scored) {
        if (compounds.length >= maxCompounds) break;
        if (!compounds.some((prev) => prev.endsWith(`.${x.c}`))) compounds.push(x.c);
    }
    const exactSingleCompounds = new Set(compounds.map((c) => c.toLowerCase()));
    for (const c of compounds) {
        const parts = c.toLowerCase().split('.');
        if (parts.length >= 3) for (const dp of parts) exactSingleCompounds.add(dp);
    }
    return { compounds, exactSingleCompounds };
}
