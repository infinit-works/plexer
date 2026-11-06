#!/usr/bin/env node
/**
 * Offline head-to-head vs `@trailhq/trail-code@0.25.0` (formerly `@nanonets/graft`) (`bench/graft-arm.js`, $0).
 *
 * Runs trail (`@trailhq/trail-code@0.25.0`, bin `trail`) on the same task prompts
 * and scores its Turn-0 output with the same yardsticks as `eval-fast.js`:
 *  - trail-hook: what Trail's UserPromptSubmit hook injects (`trail ask - . --json -n 3`,
 *                pointers + 140-char snippets, no inlined code — see `dist/claude/prompt-hook.js`).
 *  - trail-push: the "push" bundle its README benchmark used (`trail ask <prompt> --source`).
 *  - plexer:     our hook (`queryPromptContext` + `relevantRetrieval`).
 *
 * trail has no Luau parser, so only S1–S8, T4 (`z`, Rust), and the plexer-repo tasks (T5, T9) run.
 *
 * Setup (once):
 *   npm i --prefix /tmp/trail-eval @trailhq/trail-code@0.25.0 --ignore-scripts
 *   HOME=/tmp/trail-eval/home /tmp/trail-eval/node_modules/.bin/trail telemetry disable
 *   for each repo: cp -r <clean repo> /tmp/trail-repos/<id> && (cd … && trail build .)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOOK_BUDGETS, queryPromptContext } from "../src/claude/hooks.js";
import { relevantRetrieval } from "../src/claude/format.js";
import { loadGraphCached } from "../src/graph/load.js";
import { resolveContextDir } from "../src/util/state.js";
import { TASKS } from "./tasks.js";
import { needCoverage } from "./needcov.js";
import { dot, fitFamily, loadRows, predict } from "./cost-model.js";

void HOOK_BUDGETS;
const TRAIL = process.env.TRAIL_BIN || process.env.GRAFT_BIN || (existsSync("/tmp/trail-eval/node_modules/.bin/trail") ? "/tmp/trail-eval/node_modules/.bin/trail" : "/tmp/graft-eval/node_modules/.bin/graft");
const TRAIL_HOME = process.env.TRAIL_HOME || process.env.GRAFT_HOME || "/tmp/trail-eval/home";
const REPOS = process.env.TRAIL_REPOS || process.env.GRAFT_REPOS || (existsSync("/tmp/trail-repos") ? "/tmp/trail-repos" : "/tmp/graft-repos");
const NEEDED = JSON.parse(readFileSync(resolve(import.meta.dirname, "needed-spans.json"), "utf8")).tasks;
const TURN_MODEL = JSON.parse(readFileSync(resolve(import.meta.dirname, "turn-model.json"), "utf8"));
const SWE = JSON.parse(readFileSync(resolve(import.meta.dirname, "swebench/tasks.json"), "utf8"));
const tok = (s) => Math.ceil(Buffer.byteLength(s || "", "utf8") / 2.05);

function trail(args, cwd, input = undefined) {
    try {
        return execFileSync(TRAIL, args, {
            cwd,
            input,
            encoding: "utf8",
            env: { ...process.env, HOME: TRAIL_HOME, TRAIL_TELEMETRY: "0", GRAFT_TELEMETRY: "0", DO_NOT_TRACK: "1" },
            stdio: [input !== undefined ? "pipe" : "ignore", "pipe", "ignore"],
            timeout: 60000,
            maxBuffer: 32 << 20,
        });
    } catch (e) {
        return e.stdout || "";
    }
}

/** Render trail's JSON ask result the way Trail's prompt hook does: pointers + snippets, no code. */
function renderHook(json) {
    let j;
    try {
        j = JSON.parse(json.slice(json.indexOf("{")));
    } catch {
        return "";
    }
    const hits = (j.hits || []).slice(0, 3);
    if (!hits.length) return "";
    return ["[trail] relevant code for this prompt:", ...hits.map((h, i) => ` ${i + 1}. ${h.title}: ${h.pointer}\n    ${(h.snippet || "").slice(0, 140)}`)].join("\n");
}

/**
 * graft's --source blocks carry no line numbers. Re-number each fenced block by locating
 * its lines inside the hit's span, so NeedCov can score it like plexer's `L<n>:` blocks.
 */
function numberGraftSource(text, repo) {
    const out = [];
    let ptr = null;
    let inCode = false;
    let fileLines = null;
    let cursor = 0;
    for (const line of text.split("\n")) {
        const pm = /^\s+([\w./@-]+\.[A-Za-z]+):L(\d+)-L(\d+)\s*$/.exec(line);
        if (!inCode && pm) {
            ptr = { file: pm[1], a: Number(pm[2]), b: Number(pm[3]) };
            try {
                fileLines = readFileSync(resolve(repo, ptr.file), "utf8").split("\n");
            } catch {
                fileLines = null;
            }
            cursor = ptr.a - 1;
            out.push(` 0. ${ptr.file}: ${ptr.file}:L${ptr.a}-L${ptr.b}`);
            continue;
        }
        if (/^```/.test(line)) {
            inCode = !inCode;
            out.push(line);
            continue;
        }
        if (inCode && fileLines && ptr) {
            const t = line.trim();
            let found = -1;
            if (t) for (let k = cursor; k < Math.min(fileLines.length, ptr.b + 5); k++) if (fileLines[k].trim() === t) { found = k; break; }
            if (found >= 0) {
                out.push(`L${found + 1}: ${line}`);
                cursor = found + 1;
            } else out.push(line);
            continue;
        }
        out.push(line);
    }
    return out.join("\n");
}

const GOLD_OVERRIDE = {
    T4: ["compiler/src/resolve.rs"],
    T5: ["src/graph/refresh.js", "bin/plexer.js", "src/mcp/server.js"],
    T9: ["src/ask/ask.js", "bin/plexer.js"],
    S1: ["qutebrowser/browser/webkit/network/networkreply.py"],
    S4: ["internal/storage/cache/cache.go", "internal/storage/storage.go"],
    S6: ["src/posts/queue.js", "src/topics/merge.js"],
};
const GRAFT_RECORDED_0_23_1 = {
    T4: { "graft-hook": { t0: 158, rec: 0.0, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 5420, rec: 0.0, needCov: 0.0, locCov: 0.0 } },
    T5: { "graft-hook": { t0: 134, rec: 1.0, needCov: 0.0, locCov: 0.01 }, "graft-push": { t0: 3585, rec: 1.0, needCov: 0.03, locCov: 0.03 } },
    T9: { "graft-hook": { t0: 91, rec: 1.0, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 3608, rec: 1.0, needCov: 0.08, locCov: 0.14 } },
    S1: { "graft-hook": { t0: 170, rec: 1.0, needCov: 0.0, locCov: 0.38 }, "graft-push": { t0: 7402, rec: 1.0, needCov: 0.25, locCov: 0.38 } },
    S2: { "graft-hook": { t0: 164, rec: 0.25, needCov: 0.0, locCov: 0.09 }, "graft-push": { t0: 11445, rec: 1.0, needCov: 0.05, locCov: 0.32 } },
    S3: { "graft-hook": { t0: 110, rec: 0.33, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 5989, rec: 0.67, needCov: 0.02, locCov: 0.02 } },
    S4: { "graft-hook": { t0: 161, rec: 0.0, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 9329, rec: 0.5, needCov: 0.0, locCov: 0.01 } },
    S5: { "graft-hook": { t0: 90, rec: 0.5, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 1928, rec: 0.5, needCov: 0.0, locCov: 0.0 } },
    S6: { "graft-hook": { t0: 95, rec: 0.5, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 1687, rec: 1.0, needCov: 0.0, locCov: 0.0 } },
    S7: { "graft-hook": { t0: 92, rec: 0.0, needCov: 0.0, locCov: 0.01 }, "graft-push": { t0: 4633, rec: 0.0, needCov: 0.0, locCov: 0.01 } },
    S8: { "graft-hook": { t0: 225, rec: 0.0, needCov: 0.0, locCov: 0.0 }, "graft-push": { t0: 8122, rec: 0.0, needCov: 0.0, locCov: 0.0 } },
};
function tasks() {
    const out = [];
    for (const t of TASKS.filter((x) => x.repo === "plexer" || x.repo === "z")) {
        const dir = `/tmp/plexer-ab-base/indexed/${t.repo}`;
        out.push({ id: t.id, plexerDir: dir, graftDir: `${REPOS}/${t.repo}`, prompt: t.prompt(dir), isEdit: t.category === "code-edit", gold: GOLD_OVERRIDE[t.id] || [] });
    }
    for (const st of SWE) {
        const dir = `/tmp/plexer-swebench-base/indexed/${st.id}`;
        const prompt = [`Working directory: ${dir}`, "", st.instruction_md.replace(/\/app\b/g, dir).replace(/\/testbed\b/g, dir).trim()].join("\n");
        const gold = (GOLD_OVERRIDE[st.id] || st.gold_files || []).filter((f) => !/test/i.test(f));
        out.push({ id: st.id, plexerDir: dir, graftDir: `${REPOS}/${st.id}`, prompt, isEdit: true, gold });
    }
    return out.filter((t) => existsSync(t.plexerDir));
}

const rows = loadRows();
const costByFam = {};
for (const fam of ["opus", "sonnet"]) costByFam[fam] = fitFamily(rows.filter((r) => r.family === fam), () => 0);
function estimate(f, t0) {
    let wall = 0;
    let cum = 0;
    let unc = 0;
    let cost = 0;
    for (const fam of ["opus", "sonnet"]) {
        const tc = TURN_MODEL[fam];
        const turns = Math.max(0, dot(tc, [1, 1 - f.needCov, 1 - f.locCov, f.isEdit ? 1 : 0]));
        const p = predict(costByFam[fam], turns, t0);
        wall += p.wallMs;
        cum += p.cumIn;
        unc += p.uncIn;
        cost += p.cost;
    }
    return { wall, cum, unc, cost };
}

const arms = ["plexer", "graft-hook", "graft-push"];
const tot = Object.fromEntries(arms.map((a) => [a, { t0: 0, need: 0, loc: 0, rec: 0, wall: 0, cum: 0, unc: 0, cost: 0, n: 0 }]));
console.log("Task | arm        |  T0tok | GoldRec | Need | Loc  | EstWall(o+s) | EstUnc(o+s) | EstCost(o+s) | EstCum(o+s)");
for (const t of tasks()) {
    const g = loadGraphCached(resolveContextDir(t.plexerDir));
    const ask = queryPromptContext(t.plexerDir, t.prompt);
    const hasLiveGraft = existsSync(TRAIL) && (existsSync(`${t.graftDir}/graft`) || existsSync(`${t.graftDir}/trail`));
    const ctxs = {
        plexer: (ask && relevantRetrieval(ask, {})) || "",
        "graft-hook": hasLiveGraft ? renderHook(trail(["ask", "-", ".", "--json", "-n", "3", "--no-refresh"], t.graftDir, t.prompt)) : null,
        "graft-push": hasLiveGraft ? numberGraftSource(trail(["ask", "-", ".", "--source", "--no-refresh"], t.graftDir, t.prompt).split("\n").filter((l) => !/^· /.test(l)).join("\n"), t.graftDir) : null,
    };
    for (const arm of arms) {
        const ctx = ctxs[arm];
        let nc, t0, rec;
        if (ctx !== null) {
            nc = needCoverage(ctx, g, NEEDED[t.id]);
            t0 = tok(ctx);
            rec = t.gold.length ? t.gold.filter((x) => ctx.includes(x)).length / t.gold.length : 1;
        } else {
            const recArm = GRAFT_RECORDED_0_23_1[t.id]?.[arm] || { t0: 0, rec: 0, needCov: 0, locCov: 0 };
            nc = { needCov: recArm.needCov, locCov: recArm.locCov };
            t0 = recArm.t0;
            rec = recArm.rec;
        }
        const f = { ...nc, isEdit: t.isEdit };
        const est = estimate(f, t0);
        const T = tot[arm];
        T.t0 += t0;
        T.need += nc.needCov;
        T.loc += nc.locCov;
        T.rec += rec;
        T.wall += est.wall;
        T.cum += est.cum;
        T.unc += est.unc;
        T.cost += est.cost;
        T.n++;
        console.log(
            `${t.id.padEnd(4)} | ${arm.padEnd(10)} | ${String(t0).padStart(6)} | ${(rec * 100).toFixed(0).padStart(6)}% | ${(nc.needCov * 100).toFixed(0).padStart(3)}% | ${(nc.locCov * 100).toFixed(0).padStart(3)}% | ` +
                `${(est.wall / 1000).toFixed(1).padStart(10)}s | ${(est.unc / 1000).toFixed(1).padStart(10)}k | ${(est.cost / 1000).toFixed(1).padStart(11)}k | ${(est.cum / 1000).toFixed(0).padStart(9)}k`
        );
    }
}
console.log("\nTOTALS (mean per task; EstWall/EstUncached/EstCost/EstCum summed over opus+sonnet per task)");
for (const arm of arms) {
    const T = tot[arm];
    if (!T.n) continue;
    console.log(
        `${arm.padEnd(10)} T0=${Math.round(T.t0 / T.n)} tok | GoldRec=${((T.rec / T.n) * 100).toFixed(1)}% | NeedCov=${((T.need / T.n) * 100).toFixed(1)}% | ` +
            `LocCov=${((T.loc / T.n) * 100).toFixed(1)}% | EstWall=${(T.wall / T.n / 1000).toFixed(1)}s | EstUncached=${(T.unc / T.n / 1000).toFixed(1)}k | EstCost=${(T.cost / T.n / 1000).toFixed(1)}k | EstCum=${(T.cum / T.n / 1000).toFixed(0)}k`
    );
}
