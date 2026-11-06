#!/usr/bin/env node
/**
 * Generates clean, self-contained, dual-theme (light/dark) SVG benchmark charts
 * inspired by https://github.com/kohltastrophe/luau-reactivity-benchmark:
 *   - `bench/chart-small.svg` — compact hero overview for `README.md`
 *   - `bench/chart.svg`       — full multi-suite breakdown for `bench/README.md`
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Monaco, Consolas, monospace";

function esc(str) {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function buildStyles() {
    return `  <style>
    svg { color-scheme: light dark; }
    .font { font-family: ${FONT}; font-variant-numeric: tabular-nums; }
    .mono { font-family: ${MONO}; font-variant-numeric: tabular-nums; }
    .bg { fill: #ffffff; }
    .card { fill: #f8fafc; stroke: #e2e8f0; stroke-width: 1; }
    .track { fill: #f1f5f9; }
    .divider { stroke: #e2e8f0; stroke-width: 1; }
    .grid { stroke: #cbd5e1; stroke-width: 0.75; stroke-dasharray: 2,3; }
    .title { fill: #0f172a; font-size: 16px; font-weight: 700; }
    .subtitle { fill: #64748b; font-size: 11.5px; font-weight: 400; }
    .sec-title { fill: #0f172a; font-size: 12.5px; font-weight: 700; }
    .sec-sub { fill: #64748b; font-size: 10.5px; font-weight: 500; }
    .row-label { fill: #0f172a; font-size: 11.5px; font-weight: 600; }
    .row-sub { fill: #64748b; font-size: 10px; font-weight: 400; }
    .val-plexer { fill: #0f172a; font-size: 10.5px; font-weight: 700; }
    .val-other { fill: #64748b; font-size: 10px; font-weight: 500; }
    .badge-bg { fill: #ecfdf5; stroke: #10b981; stroke-width: 0.8; stroke-opacity: 0.55; }
    .badge-txt { fill: #047857; font-size: 10px; font-weight: 700; }
    .bar-plexer { fill: #059669; }
    .bar-trail { fill: #3b82f6; }
    .bar-cold { fill: #94a3b8; }
    .legend-txt { fill: #334155; font-size: 11px; font-weight: 600; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: #0d1117; }
      .card { fill: #161b22; stroke: #30363d; }
      .track { fill: #21262d; }
      .divider { stroke: #30363d; }
      .grid { stroke: #30363d; }
      .title { fill: #f0f6fc; }
      .subtitle { fill: #8b949e; }
      .sec-title { fill: #f0f6fc; }
      .sec-sub { fill: #8b949e; }
      .row-label { fill: #f0f6fc; }
      .row-sub { fill: #8b949e; }
      .val-plexer { fill: #f0f6fc; }
      .val-other { fill: #8b949e; }
      .badge-bg { fill: #064e3b; stroke: #34d399; stroke-opacity: 0.5; }
      .badge-txt { fill: #6ee7b7; }
      .bar-plexer { fill: #10b981; }
      .bar-trail { fill: #60a5fa; }
      .bar-cold { fill: #64748b; }
      .legend-txt { fill: #c9d1d9; }
    }
  </style>`;
}

function renderLegend(x, y, includeTrail = true) {
    const items = [
        { label: "plexer", cls: "bar-plexer", w: 62 },
        ...(includeTrail ? [{ label: "trail (@trailhq/trail-code)", cls: "bar-trail", w: 172 }] : []),
        { label: "cold baseline", cls: "bar-cold", w: 96 },
    ];
    let cx = x;
    const out = [];
    for (const it of items) {
        out.push(
            `  <rect x="${cx}" y="${y - 9}" width="10" height="10" rx="2.5" class="${it.cls}"/>`,
            `  <text x="${cx + 15}" y="${y}" class="font legend-txt">${esc(it.label)}</text>`
        );
        cx += it.w;
    }
    return out.join("\n");
}

function renderGridLines(x0, w, yTop, yBottom, steps = [0.25, 0.5, 0.75, 1.0]) {
    const out = [];
    for (const f of steps) {
        const gx = (x0 + w * f).toFixed(1);
        out.push(`  <line x1="${gx}" y1="${yTop}" x2="${gx}" y2="${yBottom}" class="grid"/>`);
    }
    return out.join("\n");
}

function renderPairRow({ y, label, sub, plexerRatio, coldRatio = 1.0, plexerText, coldText, badge, labelX = 32, barX = 232, maxBarW = 350, badgeX }) {
    const pW = Math.max(4, plexerRatio * maxBarW).toFixed(1);
    const cW = Math.max(4, coldRatio * maxBarW).toFixed(1);
    const bX = badgeX ?? (barX + maxBarW + 166);
    return [
        `  <text x="${labelX}" y="${y + 11}" class="font row-label">${esc(label)}</text>`,
        sub ? `  <text x="${labelX}" y="${y + 24}" class="font row-sub">${esc(sub)}</text>` : "",
        `  <rect x="${barX}" y="${y + 1}" width="${pW}" height="11" rx="2.5" class="bar-plexer"/>`,
        `  <text x="${(barX + Number(pW) + 6).toFixed(1)}" y="${y + 10}" class="font val-plexer">${esc(plexerText)}</text>`,
        `  <rect x="${barX}" y="${y + 15}" width="${cW}" height="10" rx="2.5" class="bar-cold"/>`,
        `  <text x="${(barX + Number(cW) + 6).toFixed(1)}" y="${y + 23.5}" class="font val-other">${esc(coldText)}</text>`,
        badge
            ? [
                  `  <rect x="${bX}" y="${y + 3}" width="108" height="20" rx="10" class="badge-bg"/>`,
                  `  <text x="${bX + 54}" y="${y + 16.5}" text-anchor="middle" class="font badge-txt">${esc(badge)}</text>`,
              ].join("\n")
            : "",
    ]
        .filter(Boolean)
        .join("\n");
}

function renderTripleRow({
    y,
    label,
    sub,
    plexerRatio,
    trailRatio,
    coldRatio,
    plexerText,
    trailText,
    coldText,
    badge,
    labelX = 32,
    barX = 232,
    maxBarW = 350,
    badgeX,
}) {
    const pW = Math.max(4, plexerRatio * maxBarW).toFixed(1);
    const tW = Math.max(4, trailRatio * maxBarW).toFixed(1);
    const cW = coldRatio !== null ? Math.max(4, coldRatio * maxBarW).toFixed(1) : null;
    const bX = badgeX ?? (barX + maxBarW + 166);
    const lines = [
        `  <text x="${labelX}" y="${y + 12}" class="font row-label">${esc(label)}</text>`,
        sub ? `  <text x="${labelX}" y="${y + 25}" class="font row-sub">${esc(sub)}</text>` : "",
        `  <rect x="${barX}" y="${y}" width="${pW}" height="9.5" rx="2" class="bar-plexer"/>`,
        `  <text x="${(barX + Number(pW) + 6).toFixed(1)}" y="${y + 8.5}" class="font val-plexer">${esc(plexerText)}</text>`,
        `  <rect x="${barX}" y="${y + 11.5}" width="${tW}" height="9" rx="2" class="bar-trail"/>`,
        `  <text x="${(barX + Number(tW) + 6).toFixed(1)}" y="${y + 19.5}" class="font val-other">${esc(trailText)}</text>`,
    ];
    if (cW !== null) {
        lines.push(
            `  <rect x="${barX}" y="${y + 22.5}" width="${cW}" height="9" rx="2" class="bar-cold"/>`,
            `  <text x="${(barX + Number(cW) + 6).toFixed(1)}" y="${y + 30.5}" class="font val-other">${esc(coldText)}</text>`
        );
    }
    if (badge) {
        lines.push(
            `  <rect x="${bX}" y="${y + 6}" width="108" height="20" rx="10" class="badge-bg"/>`,
            `  <text x="${bX + 54}" y="${y + 19.5}" text-anchor="middle" class="font badge-txt">${esc(badge)}</text>`
        );
    }
    return lines.filter(Boolean).join("\n");
}

function generateSmallSvg() {
    const W = 880;
    const H = 560;
    const barX = 228;
    const maxBarW = 352;
    const badgeX = 740;

    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%">`,
        buildStyles(),
        `  <rect width="${W}" height="${H}" rx="10" class="bg"/>`,
        `  <text x="24" y="30" class="font title">plexer Benchmark Summary</text>`,
        `  <text x="24" y="48" class="font subtitle">80 paired A/B evaluations (Gemini 4 Argon, Claude Opus 5.5, Claude Sonnet 5.5) + 3-arm live &amp; retrieval suites</text>`,
        renderLegend(520, 32, true),

        // Card 1: 12-Task Suite (T1-T12)
        `  <rect x="16" y="62" width="${W - 32}" height="184" rx="8" class="card"/>`,
        `  <text x="32" y="84" class="font sec-title">12-Task Engineering Suite (T1–T12 · 48 Task-Model Pairs · 384/384 Correctness)</text>`,
        `  <text x="${badgeX + 54}" y="84" text-anchor="middle" class="font sec-sub">plexer vs. cold</text>`,
        renderGridLines(barX, maxBarW, 92, 236),
        renderPairRow({
            y: 96,
            label: "Tool Output Tokens",
            sub: "Read / grep / CLI stdout volume",
            plexerRatio: 234386 / 626369,
            plexerText: "234.4k tok",
            coldText: "626.4k tok",
            badge: "-62.6% (48W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 132,
            label: "Cumulative Input Tokens",
            sub: "Total prompt + cached tokens billed",
            plexerRatio: 3.91 / 9.41,
            plexerText: "3.91M tok",
            coldText: "9.41M tok",
            badge: "-58.5% input",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 168,
            label: "Total Tool Calls",
            sub: "File reads, greps, and edits",
            plexerRatio: 198 / 449,
            plexerText: "198 calls",
            coldText: "449 calls",
            badge: "-55.9% calls",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 204,
            label: "Search Wall Time",
            sub: "Time to localize targets before edit",
            plexerRatio: 1826.1 / 2779.7,
            plexerText: "1,826s",
            coldText: "2,780s",
            badge: "-34.3% faster",
            barX,
            maxBarW,
            badgeX,
        }),

        // Card 2: SWE-bench Pro V2 (S1-S8)
        `  <rect x="16" y="258" width="${W - 32}" height="114" rx="8" class="card"/>`,
        `  <text x="32" y="280" class="font sec-title">ScaleAI/SWE-bench_Pro V2 (S1–S8 · 32 Pairs · Python, Go, JavaScript, TypeScript)</text>`,
        renderGridLines(barX, maxBarW, 288, 362),
        renderPairRow({
            y: 292,
            label: "Tool Output Tokens",
            sub: "qutebrowser, flipt, NodeBB, tutanota",
            plexerRatio: 402.3 / 573.0,
            plexerText: "402.3k tok",
            coldText: "573.0k tok",
            badge: "-29.8% tok",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 328,
            label: "Cumulative Input & Calls",
            sub: "438 vs. 616 calls (-28.9%)",
            plexerRatio: 14.29 / 20.3,
            plexerText: "14.29M (438 calls)",
            coldText: "20.30M (616 calls)",
            badge: "-29.6% input",
            barX,
            maxBarW,
            badgeX,
        }),

        // Card 3: 3-Arm Live & Retrieval vs. trail
        `  <rect x="16" y="384" width="${W - 32}" height="160" rx="8" class="card"/>`,
        `  <text x="32" y="406" class="font sec-title">3-Arm Comparison vs. @trailhq/trail-code@0.25.0 &amp; Cold Baseline</text>`,
        renderGridLines(barX, maxBarW, 414, 534),
        renderTripleRow({
            y: 416,
            label: "Live 3-Arm Tool Output",
            sub: "T4, T5, T9 + S1–S8 across 4 models",
            plexerRatio: 572.8 / 829.5,
            trailRatio: 780.9 / 829.5,
            coldRatio: 1.0,
            plexerText: "572.8k (884 calls)",
            trailText: "780.9k (1,112 calls)",
            coldText: "829.5k (1,168 calls)",
            badge: "-26.6% vs trail",
            barX,
            maxBarW,
            badgeX,
        }),
        renderTripleRow({
            y: 458,
            label: "Live 3-Arm Cum. Input",
            sub: "Score: plexer 339/352 vs. 337",
            plexerRatio: 39.92 / 54.56,
            trailRatio: 1.0,
            coldRatio: 51.27 / 54.56,
            plexerText: "39.92M tok",
            trailText: "54.56M tok",
            coldText: "51.27M tok",
            badge: "-26.8% vs trail",
            barX,
            maxBarW,
            badgeX,
        }),
        renderTripleRow({
            y: 500,
            label: "Retrieval Recall@1",
            sub: "24 queries across 6 repos (5–24ms)",
            plexerRatio: 1.0,
            trailRatio: 0.208,
            coldRatio: null,
            plexerText: "100.0% (24/24 · 1.000 MRR)",
            trailText: "20.8% all repos (62.5% non-Luau)",
            coldText: "",
            badge: "24/24 Recall@1",
            barX,
            maxBarW,
            badgeX,
        }),
        `</svg>`,
    ];
    return `${parts.join("\n")}\n`;
}

function generateFullSvg() {
    const W = 920;
    const H = 980;
    const barX = 236;
    const maxBarW = 352;
    const badgeX = 776;

    const parts = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%">`,
        buildStyles(),
        `  <rect width="${W}" height="${H}" rx="10" class="bg"/>`,
        `  <text x="24" y="30" class="font title">plexer Multi-Suite Benchmark Breakdown</text>`,
        `  <text x="24" y="48" class="font subtitle">Per-model live A/B results (T1–T12 &amp; SWE-bench Pro V2 S1–S8), 3-arm trail comparison, and engine compaction</text>`,
        renderLegend(555, 32, true),

        // Panel 1: Per-Model T1-T12 Tool Output & Calls
        `  <rect x="16" y="62" width="${W - 32}" height="254" rx="8" class="card"/>`,
        `  <text x="32" y="84" class="font sec-title">1. Per-Model Live A/B Evaluation on T1–T12 (Tool Output Tokens &amp; Tool Calls · 12 Tasks Each)</text>`,
        `  <text x="${badgeX + 54}" y="84" text-anchor="middle" class="font sec-sub">Savings vs. cold</text>`,
        renderGridLines(barX, maxBarW, 92, 306),
        renderPairRow({
            y: 96,
            label: "Claude Sonnet 5.5",
            sub: "94/96 → 96/96 · 96.7s → 62.0s (-35.9%)",
            plexerRatio: 12368 / 45198,
            plexerText: "12.4k tok · 25 calls (-67.1%)",
            coldText: "45.2k tok · 76 calls",
            badge: "-72.6% (12W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 138,
            label: "Claude Opus 5.5",
            sub: "94/96 → 96/96 · 248.9s → 93.1s (-62.6%)",
            plexerRatio: 18287 / 63696,
            plexerText: "18.3k tok · 28 calls (-65.4%)",
            coldText: "63.7k tok · 81 calls",
            badge: "-71.3% (12W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 180,
            label: "Antigravity argon-medium",
            sub: "96/96 · 1,417s → 710s (-49.9%)",
            plexerRatio: 95399 / 253993,
            plexerText: "95.4k tok · 65 calls (-55.5%)",
            coldText: "254.0k tok · 146 calls",
            badge: "-62.4% (12W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 222,
            label: "Antigravity argon-low",
            sub: "96/96 · 3.19M → 1.70M input (-46.6%)",
            plexerRatio: 108332 / 263482,
            plexerText: "108.3k tok · 80 calls (-45.2%)",
            coldText: "263.5k tok · 146 calls",
            badge: "-58.9% (12W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 264,
            label: "4-Model Total (48 Pairs)",
            sub: "384/384 (100%) · 9.41M → 3.91M (-58.5%)",
            plexerRatio: 234386 / 626369,
            plexerText: "234.4k tok · 198 calls (-55.9%)",
            coldText: "626.4k tok · 449 calls",
            badge: "-62.6% (48W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),

        // Panel 2: SWE-bench Pro V2 (S1-S8) Per-Model
        `  <rect x="16" y="328" width="${W - 32}" height="212" rx="8" class="card"/>`,
        `  <text x="32" y="350" class="font sec-title">2. ScaleAI/SWE-bench_Pro V2 Per-Model Breakdown (S1–S8 · Python, Go, JS, TS · 100% Gold File Recall)</text>`,
        renderGridLines(barX, maxBarW, 358, 530),
        renderPairRow({
            y: 362,
            label: "Claude Sonnet 5.5 (S1–S8)",
            sub: "55/64 → 57/64 · 120.1s → 81.5s (-32.1%)",
            plexerRatio: 12040 / 19344,
            plexerText: "12.0k tok · 29 calls (-55.4%)",
            coldText: "19.3k tok · 65 calls",
            badge: "-37.8% (8W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 404,
            label: "Antigravity argon-medium (S1–S8)",
            sub: "11.32M → 7.45M cum. input (-34.2%)",
            plexerRatio: 190595 / 295513,
            plexerText: "190.6k tok · 195 calls (-28.6%)",
            coldText: "295.5k tok · 273 calls",
            badge: "-35.5% (8W/0L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 446,
            label: "Claude Opus 5.5 (S1–S8)",
            sub: "58/64 score · 193.1s → 155.4s (-19.5%)",
            plexerRatio: 16638 / 24253,
            plexerText: "16.6k tok · 34 calls (-12.8%)",
            coldText: "24.3k tok · 39 calls",
            badge: "-31.4% (7W/1L)",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 488,
            label: "Antigravity argon-low (S1–S8)",
            sub: "7.70M → 5.77M cum. input (-25.1%)",
            plexerRatio: 183048 / 233849,
            plexerText: "183.0k tok · 180 calls (-24.7%)",
            coldText: "233.8k tok · 239 calls",
            badge: "-21.7% (6W/2L)",
            barX,
            maxBarW,
            badgeX,
        }),

        // Panel 3: 3-Arm Live & Offline vs. trail
        `  <rect x="16" y="552" width="${W - 32}" height="198" rx="8" class="card"/>`,
        `  <text x="32" y="574" class="font sec-title">3. Head-to-Head vs. @trailhq/trail-code@0.25.0 (Live 3-Arm + Offline Turn-0 Coverage)</text>`,
        renderGridLines(barX, maxBarW, 582, 740),
        renderTripleRow({
            y: 584,
            label: "Live 3-Arm Tool Output",
            sub: "T4, T5, T9 + S1–S8 across 4 models",
            plexerRatio: 572.8 / 829.5,
            trailRatio: 780.9 / 829.5,
            coldRatio: 1.0,
            plexerText: "572.8k tok (884 calls · 5,697s)",
            trailText: "780.9k tok (1,112 calls)",
            coldText: "829.5k tok (1,168 calls)",
            badge: "-26.6% vs trail",
            barX,
            maxBarW,
            badgeX,
        }),
        renderTripleRow({
            y: 626,
            label: "Live 3-Arm Cum. Input",
            sub: "Total input tokens across 44 sessions/arm",
            plexerRatio: 39.92 / 54.56,
            trailRatio: 1.0,
            coldRatio: 51.27 / 54.56,
            plexerText: "39.92M tok (339/352 score)",
            trailText: "54.56M tok (337/352 score)",
            coldText: "51.27M tok (337/352 score)",
            badge: "-26.8% vs trail",
            barX,
            maxBarW,
            badgeX,
        }),
        renderTripleRow({
            y: 668,
            label: "Turn-0 Gold File Recall",
            sub: "11 shared tasks (T4, T5, T9, S1–S8)",
            plexerRatio: 1.0,
            trailRatio: 0.606,
            coldRatio: 0.416,
            plexerText: "100.0% (Need 28.7% · Loc 49.8%)",
            trailText: "60.6% graft-push (NeedCov 3.9%)",
            coldText: "41.6% graft-hook (NeedCov 0.0%)",
            badge: "11/11 task wins",
            barX,
            maxBarW,
            badgeX,
        }),
        renderTripleRow({
            y: 710,
            label: "Engine Retrieval Recall@1",
            sub: "24 intent queries across 6 repos",
            plexerRatio: 1.0,
            trailRatio: 0.208,
            coldRatio: null,
            plexerText: "100.0% (24/24 · 1.000 MRR)",
            trailText: "20.8% all repos (62.5% non-Luau)",
            coldText: "",
            badge: "100% Recall@1",
            barX,
            maxBarW,
            badgeX,
        }),

        // Panel 4: Engine Compaction & Latency by Repo
        `  <rect x="16" y="762" width="${W - 32}" height="202" rx="8" class="card"/>`,
        `  <text x="32" y="784" class="font sec-title">4. Engine Source Compaction (ask --source Tokens vs. Raw Target Files · 14,197 Nodes / 29,020 Edges)</text>`,
        renderGridLines(barX, maxBarW, 792, 954),
        renderPairRow({
            y: 794,
            label: "flux & z",
            sub: "ask --source: 5.1ms (flux) · 24.0ms (z)",
            plexerRatio: (1448 + 1376) / (26234 + 20675),
            plexerText: "1,448 tok (flux) · 1,376 tok (z)",
            coldText: "26.2k raw (flux) · 20.7k (z)",
            badge: "-94% / -93% tok",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 834,
            label: "plexer & sert",
            sub: "ask --source: 13.5ms (plexer) · 10.7ms (sert)",
            plexerRatio: (1367 + 1186) / (15477 + 10757),
            plexerText: "1,367 tok (plexer) · 1,186 tok (sert)",
            coldText: "15.5k raw (plexer) · 10.8k (sert)",
            badge: "-91% / -89% tok",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 874,
            label: "kohls-admin & building-tools",
            sub: "ask --source: 10.4ms (ka) · 7.1ms (btools)",
            plexerRatio: (1280 + 1445) / (10566 + 5306),
            plexerText: "1,280 tok (ka) · 1,445 tok (btools)",
            coldText: "10.6k raw (ka) · 5.3k (btools)",
            badge: "-88% / -73% tok",
            barX,
            maxBarW,
            badgeX,
        }),
        renderPairRow({
            y: 914,
            label: "Turn-0 Offline Readiness",
            sub: "20-task eval-fast.js (T1–T12 + S1–S8)",
            plexerRatio: 1 - 0.338,
            plexerText: "100% file recall · 83.4% TokCov · -33.8% EstCum",
            coldText: "Cold baseline (100% EstCum)",
            badge: "-28.1% EstWall",
            barX,
            maxBarW,
            badgeX,
        }),
        `</svg>`,
    ];
    return `${parts.join("\n")}\n`;
}

const smallPath = resolve(import.meta.dirname, "chart-small.svg");
const fullPath = resolve(import.meta.dirname, "chart.svg");
writeFileSync(smallPath, generateSmallSvg(), "utf8");
writeFileSync(fullPath, generateFullSvg(), "utf8");
console.log(`Wrote ${smallPath} and ${fullPath}`);
