import { basename } from 'node:path';
import { stemToken, tokenize } from '../../../ask/tokenize.js';
import { loadGraphCached } from '../../../context/graph-store.js';
import { contextDirFor } from '../../../util/paths.js';
import { cleanPromptBoilerplate } from './intent.js';
import {
    PROMPT_BOILERPLATE_NOISE, buildCorpusVocab, extractBacktickPhrases,
    extractCamelAndCompoundPhrases, selectTopCompounds,
} from './vocab.js';

const TMP_PREFIX_RE = /^\/tmp\/[A-Za-z0-9._-]+\/(?:(?:clean|indexed)\/)?[A-Za-z0-9._-]+\//;
const stripBenchTmpPrefix = (p) => p.replace(TMP_PREFIX_RE, '');

function scoreToken(t, tokCounts, vocab, backticked, camelOrCode) {
    const { dfMap, stemDf, nameTokens, nameStems, pathTokens, nDocs } = vocab;
    const s = stemToken(t);
    const df = dfMap.get(t) ?? stemDf.get(s) ?? 0;
    if (df === 0 && !backticked.has(t) && !camelOrCode.has(t)) return null;
    const inSymExact = nameTokens.has(t), inSymStem = nameStems.has(s), inPath = pathTokens.has(t);
    const symDf = nameStems.get(s) ?? df;
    const idf = (inSymExact || inSymStem)
        ? Math.log(1 + nDocs / Math.max(2, symDf))
        : Math.min(3.5, df > 0 ? Math.log(1 + nDocs / Math.max(3, df)) : 0.5);
    let fieldMult = 1.0;
    if (inSymExact && inPath) fieldMult = 5.2;
    else if (inSymExact) fieldMult = 4.0;
    else if (inSymStem && inPath) fieldMult = 4.2;
    else if (inSymStem) fieldMult = 3.2;
    else if (inPath) fieldMult = 2.2;
    else if (df >= 1 && df <= Math.max(10, Math.floor(nDocs * 0.015))) fieldMult = 2.4;
    const codeMult = backticked.has(t) ? 3.0 : camelOrCode.has(t) ? 2.5 : 1.0;
    const tfMult = 1 + 0.35 * Math.min(2, (tokCounts.get(t) ?? 1) - 1);
    return { t, score: idf * fieldMult * codeMult * tfMult };
}

export function distillSegment(vocab, text, maxWords = 10, maxCompounds = 4) {
    const cleaned = cleanPromptBoilerplate(text);
    if (!vocab) return cleaned;
    const { backtickPhrases, backticked } = extractBacktickPhrases(cleaned);
    const { camelOrCodePhrases, camelOrCode } = extractCamelAndCompoundPhrases(cleaned, vocab.compoundSymbols);
    const rawCompounds = [...new Set([...backtickPhrases, ...camelOrCodePhrases])];
    const { compounds, exactSingleCompounds } = selectTopCompounds(vocab, rawCompounds, maxCompounds);
    const rawToks = tokenize(cleaned);
    const tokCounts = new Map();
    for (const t of rawToks) tokCounts.set(t, (tokCounts.get(t) ?? 0) + 1);
    const scored = [];
    for (const t of [...new Set(rawToks)]) {
        if (PROMPT_BOILERPLATE_NOISE.has(t) || t.length < 3 || exactSingleCompounds.has(t)) continue;
        const s = scoreToken(t, tokCounts, vocab, backticked, camelOrCode);
        if (s) scored.push(s);
    }
    if (scored.length === 0 && compounds.length === 0) return cleaned;
    scored.sort((a, b) => b.score - a.score);
    return [...compounds, ...scored.slice(0, maxWords).map((x) => x.t)].join(' ');
}

function collectFileSymTokens(graph, fRel, base) {
    const symToks = new Set();
    const recordNodes = (list) => {
        for (const n of list) {
            if (n.kind === 'file') continue;
            for (const t of tokenize(n.name ?? '')) {
                if (t.length >= 3 && !PROMPT_BOILERPLATE_NOISE.has(t)) { symToks.add(t); symToks.add(stemToken(t)); }
            }
        }
    };
    if (graph?._nodesByPath) {
        for (const [p, nodes] of graph._nodesByPath) {
            if (p === fRel || p.endsWith(`/${base}`)) recordNodes(nodes);
        }
        return symToks;
    }
    for (const n of graph?.nodes ?? []) {
        if (n.path && (n.path === fRel || n.path.endsWith(`/${base}`))) recordNodes([n]);
    }
    return symToks;
}

function scoreClauseForTargetFile(c, fRel, base, stem, symToks, targetFiles) {
    if (targetFiles.some((of) => of !== fRel && c.includes(basename(of)))) return 0;
    let score = c.includes(base) ? 16 : 0;
    const cToks = [...new Set(tokenize(c))].filter((t) => !PROMPT_BOILERPLATE_NOISE.has(t));
    for (let i = 0; i < cToks.length - 1; i++) if (`${cToks[i]}${cToks[i + 1]}` === stem) score += 12;
    for (const t of cToks) {
        if (t.length < 3) continue;
        if (symToks.has(t) || symToks.has(stemToken(t))) score += 3;
        else if (t.length >= 4 && [...symToks].some((s) => s.length >= 6 && (s.startsWith(t) || s.endsWith(t)))) score += 2;
    }
    return score;
}

export function distillMultiFileReqQueries(vocab, outDir, cleaned, uniqueFiles, ifaceTypeNames) {
    const graph = loadGraphCached(outDir);
    const targetFiles = uniqueFiles.slice(0, 4).map(stripBenchTmpPrefix);
    let src = cleaned.replace(/\n##+\s+New Interfaces[\s\S]*$/i, '');
    for (const tn of ifaceTypeNames) src = src.replaceAll(tn, '');
    const clauses = src.split(/\n+/).map((s) => s.trim()).filter((s) => s.length > 15 && !s.startsWith('#') && !s.startsWith('<') && s.length < 220);
    const pairs = [];
    for (const fRel of targetFiles) {
        const base = basename(fRel), stem = base.replace(/\.[a-z0-9]+$/i, '').toLowerCase();
        const symToks = collectFileSymTokens(graph, fRel, base);
        clauses.forEach((c, idx) => {
            const score = scoreClauseForTargetFile(c, fRel, base, stem, symToks, targetFiles);
            if (score > 0) pairs.push({ fRel, idx, c, score });
        });
    }
    pairs.sort((a, b) => b.score - a.score);
    const assigned = new Map(), usedIdx = new Set();
    for (const p of pairs) if (!assigned.has(p.fRel) && !usedIdx.has(p.idx)) { assigned.set(p.fRel, p.c); usedIdx.add(p.idx); }
    const sharedHint = (cleaned.slice(0, 320).match(/`([A-Za-z_][A-Za-z0-9_]{2,18})`/g) ?? [])
        .map((x) => x.slice(1, -1)).filter((x) => !x.includes('/') && !x.includes('.')).slice(0, 2).join(' ');
    const queries = [];
    for (const fRel of targetFiles) {
        const sub = distillSegment(vocab, `\`${fRel}\` ${assigned.get(fRel) ?? ''} ${sharedHint}`, 6, 2);
        if (sub && !queries.includes(sub)) queries.push(sub);
    }
    return queries.slice(0, 4);
}

function distillIfaceSplitBullets(vocab, bullets, uniqueFiles, headSection, ifaceText, ifaceTypeNames, helpers) {
    const { stripNewTypes, stripUsedCompounds, recordCompounds, usedCompounds } = helpers;
    const ifaceStem = basename(stripBenchTmpPrefix(uniqueFiles[0])).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const ifaceBullets = bullets.filter((b) => [...ifaceTypeNames].some((tn) => b.includes(tn)));
    const otherBullets = bullets.filter((b) => ![...ifaceTypeNames].some((tn) => b.includes(tn)));
    if (ifaceBullets.length < 2 || otherBullets.length < 2) return null;
    const queries = [];
    const g1 = distillSegment(vocab, stripNewTypes(`${ifaceText}\n${ifaceBullets.join('\n')}`), 8, 4);
    if (g1) { queries.push(g1); recordCompounds(g1); }
    for (const ob of otherBullets) {
        const andIdx = ob.search(/\band\s+[a-z]+-[a-z]+/i);
        const cleanedOb = (andIdx > 0 && ob.slice(0, andIdx).toLowerCase().includes(ifaceStem))
            ? ob.slice(andIdx + 4).replace(new RegExp(`\\b${ifaceStem}\\s+validation\\b`, 'gi'), '').replace(/\bvalidation(?:\s+helpers)?\b/gi, '')
            : ob;
        const sub = distillSegment(vocab, stripUsedCompounds(cleanedOb), 7, 3);
        const lead = (sub || '').split(/\s+/)[0] ?? '';
        if (sub && (/[a-z][A-Z]|\./.test(lead) || cleanedOb !== ob) && !queries.includes(sub)) {
            queries.push(sub); recordCompounds(sub);
        }
    }
    const headSub = distillSegment(vocab, stripUsedCompounds(headSection.replace(new RegExp(`\\b${ifaceStem}\\b`, 'gi'), '')), 5, 2);
    const headLead = (headSub || '').split(/\s+/)[0] ?? '';
    if (headSub && /[a-z][A-Z]/.test(headLead) && !usedCompounds.has(headLead) && !queries.includes(headSub)) queries.push(headSub);
    return queries.slice(0, 4);
}

export function distillMultiBulletReqQueries(vocab, bullets, uniqueFiles, headSection, ifaceText, ifaceTypeNames) {
    const stripNewTypes = (text) => {
        let out = text;
        for (const tn of ifaceTypeNames) out = out.replace(new RegExp(`[A-Za-z0-9_.]*${tn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'), '');
        return out;
    };
    const usedCompounds = new Set();
    const stripUsedCompounds = (text) => {
        let out = stripNewTypes(text).replace(/`([^`\n]+)`/g, (m, inner) => {
            const base = inner.replace(/\(\)$/, '');
            for (const c of usedCompounds) if (base === c || base.startsWith(`${c}.`) || c.startsWith(`${base}.`)) return '';
            return m;
        });
        for (const c of usedCompounds) {
            const toks = tokenize(c).filter((t) => !/^(?:get|set|is|on|handle)$/.test(t));
            if (toks.length === 2) {
                out = out.replace(new RegExp(`\\b${toks[0]}\\w*\\s+${toks[1]}\\w*\\b`, 'gi'), '').replace(new RegExp(`\\b${toks[1]}\\w*\\s+${toks[0]}\\w*\\b`, 'gi'), '');
            }
        }
        return out;
    };
    const recordCompounds = (qStr) => { for (const w of (qStr || '').split(/\s+/).slice(0, 3)) if (w) usedCompounds.add(w.replace(/\(\)$/, '')); };
    if (ifaceTypeNames.size >= 2 && bullets.length >= 5 && uniqueFiles.length === 1) {
        const splitRes = distillIfaceSplitBullets(vocab, bullets, uniqueFiles, headSection, ifaceText, ifaceTypeNames, { stripNewTypes, stripUsedCompounds, recordCompounds, usedCompounds });
        if (splitRes) return splitRes;
    }
    const third = Math.ceil(bullets.length / 3), twoThirds = Math.ceil((bullets.length * 2) / 3);
    const g1 = distillSegment(vocab, stripNewTypes(`${headSection.slice(0, 350)}\n${ifaceText}\n${bullets.slice(0, third).join('\n')}`), 8, 4);
    recordCompounds(g1);
    const g2 = distillSegment(vocab, stripUsedCompounds(bullets.slice(third, twoThirds).join('\n')), 8, 4);
    recordCompounds(g2);
    const g3 = distillSegment(vocab, stripUsedCompounds(bullets.slice(twoThirds).join('\n')), 8, 4);
    return [...new Set([g1, g2, g3].filter(Boolean))].slice(0, 3);
}

function distillStructuredReqQueries(vocab, outDir, cleaned) {
    const strippedRepro = cleaned.replace(/(?:^|\n)(?:##+\s*|\*\*)Steps\s+to\s+Reproduce([\s\S]*?)(?=\n(?:##+\s+|\*\*[A-Z]))/i, (_m, body) => {
        const bt = [...String(body).matchAll(/`([^`\n]{3,60})`/g)].map((x) => `\`${x[1]}\``).join(' ');
        return bt ? `\n${bt}\n` : '\n';
    });
    const reqMatch = /(?:^|\n)##+\s+Requirements\b([\s\S]*?)(?=\n##+\s+|$)/i.exec(strippedRepro);
    const ifaceMatch = /(?:^|\n)##+\s+New Interfaces\b([\s\S]*?)(?=\n##+\s+|$)/i.exec(strippedRepro);
    const headSection = strippedRepro.split(/\n##+\s+Requirements\b/i)[0] ?? strippedRepro;
    const reqText = reqMatch ? reqMatch[1].trim() : '';
    const ifaceText = ifaceMatch && !/no new interfaces/i.test(ifaceMatch[1]) ? ifaceMatch[1].trim() : '';
    const ifaceTypeNames = new Set([
        ...[...ifaceText.matchAll(/\b(?:New\s+(?:error\s+)?(?:class|type|interface|struct)\s+)([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1]),
        ...[...ifaceText.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`\s+added\s+to\s+`([A-Za-z_][A-Za-z0-9_]*)`/gi)].flatMap((m) => [m[1], m[2]]),
        ...[...ifaceText.matchAll(/(?:^|\n)\s*[-*]\s*Name:\s*`?([A-Za-z_][A-Za-z0-9_]*)`?/gi)].map((m) => m[1]),
    ]);
    const queries = [];
    if (reqText) {
        const bullets = reqText.split(/\n(?=\s*[-*]\s+)/).map((b) => b.trim()).filter(Boolean);
        const uniqueFiles = [...new Set([...strippedRepro.matchAll(/\b([A-Za-z0-9_/-]+\.(?:py|go|js|ts|tsx|jsx|luau|rs))\b/g)].map((m) => m[1].replace(/^\/app\//, '')))];
        if (uniqueFiles.length >= 2) return distillMultiFileReqQueries(vocab, outDir, cleaned, uniqueFiles, ifaceTypeNames);
        if (bullets.length >= 3) return distillMultiBulletReqQueries(vocab, bullets, uniqueFiles, headSection, ifaceText, ifaceTypeNames);
        if (bullets.length === 2) {
            let [b1Text, b2Text] = bullets;
            for (const tn of ifaceTypeNames) { b1Text = b1Text.replaceAll(tn, ''); b2Text = b2Text.replaceAll(tn, ''); }
            for (const g of [distillSegment(vocab, `${ifaceText}\n${b1Text}`, 8, 4), distillSegment(vocab, b2Text, 8, 4)]) if (g && !queries.includes(g)) queries.push(g);
            for (const bText of [b1Text, b2Text]) {
                const sub = distillSegment(vocab, bText.replace(/`[^`\n]+`/g, ''), 6, 2), lead = (sub || '').split(/\s+/)[0];
                if (lead && lead.length >= 12 && /[a-z][A-Z]/.test(lead) && !queries.some((q) => q.startsWith(lead))) { queries.push(sub); break; }
            }
            return queries.slice(0, 3);
        }
    }
    const q1 = distillSegment(vocab, `${headSection}\n${ifaceText}\n${reqText}`, 10, 5);
    if (q1) queries.push(q1);
    return queries.slice(0, 3);
}

export function distillPromptQueries(root, contextDir, prompt) {
    const cleaned = cleanPromptBoilerplate(prompt);
    if (tokenize(cleaned).length <= 16) return [cleaned || prompt];
    const vocab = buildCorpusVocab(contextDir ?? contextDirFor(root));
    if (!vocab) return [cleaned];
    if (/(?:^|\n)##+\s+(?:Requirements|New Interfaces|Problem|Description)\b/i.test(cleaned)) {
        return distillStructuredReqQueries(vocab, contextDir ?? contextDirFor(root), cleaned);
    }
    const parts = cleaned.split(/\n(?=\s*\d+\.\s+)/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
        const hasNumberedHeader = /^\d+\.\s/.test(parts[0]);
        const leadWords = hasNumberedHeader ? '' : distillSegment(vocab, (parts[0] ?? '').replace(/\balongside\b[^)\n]*/gi, ''), 2, 1);
        const rawSubItems = hasNumberedHeader ? parts : parts.slice(1);
        return rawSubItems.slice(0, rawSubItems.length >= 4 ? 4 : 3).map((item, idx) => {
            const sub = distillSegment(vocab, item, 7, 3);
            if (!leadWords || (idx > 0 && /`[A-Za-z0-9_]+\/[A-Za-z0-9_/-]*`/.test(item))) return sub;
            const subToks = new Set(sub.split(/\s+/).filter(Boolean));
            const hasSubComp = /[a-z][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/.test(sub);
            const leadExtra = leadWords.split(/\s+/).filter((w) => w && !subToks.has(w) && !(hasSubComp && /[a-z][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/.test(w)) && (idx === 0 || !/^(?:insert|remove|move)$/.test(w))).join(' ');
            return leadExtra ? `${sub} ${leadExtra}`.trim() : sub;
        });
    }
    return [distillSegment(vocab, cleaned, 12, 5)];
}
