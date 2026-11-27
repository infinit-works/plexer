#!/usr/bin/env node
/**
 * Idempotent base worktree builder (`bench/ensure-base.js`).
 *
 * Ensures `/tmp/plexer-ab-base/{clean,indexed}/<repo>` (for T1–T12) and
 * `/tmp/plexer-swebench-base/{clean,indexed}/<id>` (for S1–S8) exist so that
 * `eval-fast.js` and the live A/B runners work immediately after a `/tmp` reset.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { readFingerprint } from "../src/graph/fingerprint.js";
import { sqliteHasGraph, sqliteStoreExists } from "../src/storage/sqlite-store.js";

function isIndexedDirReady(idxDir) {
    const pDir = join(idxDir, "plexer");
    return (
        existsSync(join(pDir, ".graph", "wiring.json")) &&
        Boolean(readFingerprint(pDir)) &&
        (!sqliteStoreExists(pDir) || sqliteHasGraph(pDir))
    );
}

export const AB_BASE_DIR = "/tmp/plexer-ab-base";
export const SWEBENCH_BASE_DIR = "/tmp/plexer-swebench-base";
export const V2_BASE_DIR = "/tmp/plexer-v2-base";

const BENCH_REPOS_DIR = process.env.PLEXER_BENCH_REPOS_DIR || join(homedir(), "Projects", "roblox", "libraries");

const REPOS = [
    { name: "plexer", src: resolve(import.meta.dirname, ".."), ref: "0362ee2" },
    { name: "sert", src: join(BENCH_REPOS_DIR, "sert"), ref: "0a928ab" },
    { name: "kohls-admin", src: join(BENCH_REPOS_DIR, "kohls-admin"), ref: "a8b4b465" },
    { name: "flux", src: join(BENCH_REPOS_DIR, "flux"), ref: "75090db" },
    { name: "building-tools", src: join(BENCH_REPOS_DIR, "building-tools"), ref: "d910e7b" },
    { name: "z", src: join(BENCH_REPOS_DIR, "z"), ref: "dc76d03" },
];

const STRIP = [
    "bench",
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    "SKILL.md",
    ".claude",
    ".cursor",
    ".gemini",
    ".agents",
    ".windsurf",
    ".kiro",
    "plexer",
];

async function buildIndexedFromClean(cleanDir, idxDir, buildOpts) {
    rmSync(idxDir, { recursive: true, force: true });
    mkdirSync(join(idxDir, ".."), { recursive: true });
    execFileSync("cp", ["-a", cleanDir, idxDir]);
    const prevNoGitignore = process.env.PLEXER_NO_GITIGNORE;
    const prevNoIgnore = process.env.PLEXER_NO_IGNORE;
    process.env.PLEXER_NO_GITIGNORE = "1";
    process.env.PLEXER_NO_IGNORE = "1";
    try {
        await buildGraph(idxDir, { ...buildOpts, force: true });
    } finally {
        if (prevNoGitignore === undefined) delete process.env.PLEXER_NO_GITIGNORE;
        else process.env.PLEXER_NO_GITIGNORE = prevNoGitignore;
        if (prevNoIgnore === undefined) delete process.env.PLEXER_NO_IGNORE;
        else process.env.PLEXER_NO_IGNORE = prevNoIgnore;
    }
}

export async function ensureAbBaseRepos(onlyRepos = null, opts = {}) {
    const forceReindex = Boolean(opts?.reindex || opts?.force);
    for (const r of REPOS) {
        if (onlyRepos && !onlyRepos.has(r.name)) continue;
        const cleanDir = join(AB_BASE_DIR, "clean", r.name);
        const idxDir = join(AB_BASE_DIR, "indexed", r.name);
        let ref = "HEAD";
        if (r.ref && existsSync(r.src)) {
            try {
                execFileSync("git", ["-C", r.src, "cat-file", "-e", `${r.ref}^{commit}`], { stdio: "ignore" });
                ref = r.ref;
            } catch {}
        }
        const pinStampPath = join(idxDir, "plexer", ".pinned_ref");
        const currentPin = existsSync(pinStampPath) ? readFileSync(pinStampPath, "utf8").trim() : "";
        if (
            !forceReindex &&
            isIndexedDirReady(idxDir) &&
            existsSync(cleanDir) &&
            currentPin === ref
        ) {
            continue;
        }
        if (forceReindex && existsSync(cleanDir)) {
            await buildIndexedFromClean(cleanDir, idxDir, { graphOnly: false });
            writeFileSync(pinStampPath, `${currentPin || ref}\n`, "utf8");
            continue;
        }
        if (forceReindex && existsSync(idxDir)) {
            rmSync(join(idxDir, "plexer"), { recursive: true, force: true });
            await buildGraph(idxDir, { graphOnly: false, force: true });
            writeFileSync(pinStampPath, `${currentPin || ref}\n`, "utf8");
            continue;
        }
        if (!existsSync(r.src)) continue;
        rmSync(cleanDir, { recursive: true, force: true });
        rmSync(idxDir, { recursive: true, force: true });
        mkdirSync(cleanDir, { recursive: true });
        execFileSync("bash", ["-c", `git -C "${r.src}" archive ${ref} | tar -x -C "${cleanDir}"`]);
        for (const s of STRIP) {
            rmSync(join(cleanDir, s), { recursive: true, force: true });
        }
        if (r.name === "plexer") {
            symlinkSync(join(r.src, "node_modules"), join(cleanDir, "node_modules"));
            writeFileSync(
                join(cleanDir, "SKILL.md"),
                "---\nname: plexer\ndescription: Codebase index package.\n---\n\n# plexer\n",
                "utf8"
            );
        }
        if (existsSync(join(r.src, ".sert"))) {
            cpSync(join(r.src, ".sert"), join(cleanDir, ".sert"), { recursive: true });
            const pinnedSertSrc = r.name === "sert" ? join(cleanDir, "src") : join(AB_BASE_DIR, "clean", "sert", "src");
            const localSertSrc = join(cleanDir, ".sert", "sert", "src");
            if (existsSync(pinnedSertSrc) && existsSync(join(cleanDir, ".sert", "sert"))) {
                rmSync(localSertSrc, { recursive: true, force: true });
                cpSync(pinnedSertSrc, localSertSrc, { recursive: true });
            }
            const rootLuauRcPath = join(cleanDir, ".luaurc");
            const rootLuauRc = existsSync(rootLuauRcPath) ? readFileSync(rootLuauRcPath, "utf8") : "";
            if (rootLuauRc.includes("./.sert/pkg/")) {
                const pkgDir = join(cleanDir, ".sert", "pkg");
                mkdirSync(pkgDir, { recursive: true });
                const fluxPkgSrc = existsSync(join(AB_BASE_DIR, "clean", "flux"))
                    ? join(AB_BASE_DIR, "clean", "flux")
                    : join(r.src, "Packages", "Flux");
                if (!existsSync(join(pkgDir, "flux")) && existsSync(fluxPkgSrc)) {
                    cpSync(fluxPkgSrc, join(pkgDir, "flux"), { recursive: true });
                }
                const fluxUiPkgSrc = existsSync(join(cleanDir, ".sert", "local", "flux-ui"))
                    ? join(cleanDir, ".sert", "local", "flux-ui")
                    : join(r.src, "Packages", "FluxUI");
                if (!existsSync(join(pkgDir, "flux-ui")) && existsSync(fluxUiPkgSrc)) {
                    cpSync(fluxUiPkgSrc, join(pkgDir, "flux-ui"), { recursive: true });
                }
                const sertLuauRcPath = join(cleanDir, ".sert", ".luaurc");
                if (existsSync(sertLuauRcPath)) {
                    const parsed = JSON.parse(readFileSync(sertLuauRcPath, "utf8"));
                    if (parsed && typeof parsed.aliases === "object") {
                        if (existsSync(join(pkgDir, "flux", "src"))) parsed.aliases.flux = "./pkg/flux/src";
                        if (existsSync(join(pkgDir, "flux-ui", "src"))) parsed.aliases.fluxui = "./pkg/flux-ui/src";
                        writeFileSync(sertLuauRcPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
                    }
                }
            }
        }
        execFileSync("git", ["init", "-q"], { cwd: cleanDir });
        execFileSync("git", ["add", "-A"], { cwd: cleanDir });
        execFileSync(
            "git",
            ["-c", "commit.gpgsign=false", "-c", "user.name=plexer-bench", "-c", "user.email=bench@plexer.invalid", "commit", "-qm", "init", "--no-verify"],
            { cwd: cleanDir }
        );

        mkdirSync(join(AB_BASE_DIR, "indexed"), { recursive: true });
        execFileSync("cp", ["-a", cleanDir, idxDir]);
        const prevNoGitignore = process.env.PLEXER_NO_GITIGNORE;
        const prevNoIgnore = process.env.PLEXER_NO_IGNORE;
        process.env.PLEXER_NO_GITIGNORE = "1";
        process.env.PLEXER_NO_IGNORE = "1";
        try {
            await buildGraph(idxDir, { graphOnly: false, force: true });
            writeFileSync(pinStampPath, `${ref}\n`, "utf8");
        } finally {
            if (prevNoGitignore === undefined) delete process.env.PLEXER_NO_GITIGNORE;
            else process.env.PLEXER_NO_GITIGNORE = prevNoGitignore;
            if (prevNoIgnore === undefined) delete process.env.PLEXER_NO_IGNORE;
            else process.env.PLEXER_NO_IGNORE = prevNoIgnore;
        }
    }
}

export async function ensureSwebenchBaseRepos(onlyIds = null, opts = {}) {
    const forceReindex = Boolean(opts?.reindex || opts?.force);
    const swePath = resolve(import.meta.dirname, "swebench/tasks.json");
    const extraRepos = [
        {
            id: "pocketbase",
            repo: "pocketbase/pocketbase",
            base_commit: "a2b89d73444fe7775812bcb35b5cad3b741e1b29",
        },
    ];
    const sweTasks = existsSync(swePath) ? JSON.parse(readFileSync(swePath, "utf8")) : [];
    const tasks = [...sweTasks, ...extraRepos];
    for (const task of tasks) {
        if (onlyIds && !onlyIds.has(task.id)) continue;
        const cleanDir = join(SWEBENCH_BASE_DIR, "clean", task.id);
        const indexedDir = join(SWEBENCH_BASE_DIR, "indexed", task.id);
        if (!existsSync(cleanDir)) {
            if (forceReindex && existsSync(indexedDir)) {
                rmSync(join(indexedDir, "plexer"), { recursive: true, force: true });
                await buildGraph(indexedDir, { force: true });
                continue;
            }
            if (forceReindex) continue;
            mkdirSync(cleanDir, { recursive: true });
            execFileSync("git", ["init", "-q"], { cwd: cleanDir });
            execFileSync("git", ["remote", "add", "origin", `https://github.com/${task.repo}.git`], { cwd: cleanDir });
            execFileSync("git", ["fetch", "--depth", "1", "origin", task.base_commit], {
                cwd: cleanDir,
                stdio: "ignore",
            });
            execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: cleanDir });
        }
        if (forceReindex || !isIndexedDirReady(indexedDir)) {
            rmSync(indexedDir, { recursive: true, force: true });
            mkdirSync(join(SWEBENCH_BASE_DIR, "indexed"), { recursive: true });
            execFileSync("cp", ["-a", cleanDir, indexedDir]);
            await buildGraph(indexedDir, { force: true });
        }
    }
}

/**
 * Populate `/tmp/plexer-v2-base/{clean,indexed}/<id>` for `bench/v2-tasks.js`.
 * Reuses `ab:*` / `swe:*` local bases when mapped, and shallow-clones remote OSS
 * targets (`git fetch --depth 1`) on demand.
 */
export async function ensureV2BaseRepos(onlyTaskIds = null, opts = {}) {
    const forceReindex = Boolean(opts?.reindex || opts?.force);
    const { ALL_V2_TASKS, V2_SCALE_REPOS } = await import("./v2-tasks.js");
    const scaleByRepo = new Map(V2_SCALE_REPOS.map((r) => [r.id, r]));

    const abNeeded = new Set();
    const sweNeeded = new Set();
    const v2Tasks = ALL_V2_TASKS.filter((t) => !onlyTaskIds || onlyTaskIds.has(t.id));

    for (const t of v2Tasks) {
        if (typeof t.baseId === "string" && t.baseId.startsWith("ab:")) {
            abNeeded.add(t.baseId.slice(3));
        } else if (typeof t.baseId === "string" && t.baseId.startsWith("swe:")) {
            sweNeeded.add(t.baseId.slice(4));
        } else if (t.baseId === "pocketbase") {
            sweNeeded.add("pocketbase");
        }
    }
    if (abNeeded.size > 0) {
        await ensureAbBaseRepos(abNeeded, opts);
    }
    if (sweNeeded.size > 0) {
        await ensureSwebenchBaseRepos(sweNeeded, opts);
    }

    const prepared = new Map();
    for (const t of v2Tasks) {
        let cleanDir;
        let indexedDir;
        if (typeof t.baseId === "string" && t.baseId.startsWith("ab:")) {
            const name = t.baseId.slice(3);
            cleanDir = join(AB_BASE_DIR, "clean", name);
            indexedDir = join(AB_BASE_DIR, "indexed", name);
        } else if (typeof t.baseId === "string" && t.baseId.startsWith("swe:")) {
            const id = t.baseId.slice(4);
            cleanDir = join(SWEBENCH_BASE_DIR, "clean", id);
            indexedDir = join(SWEBENCH_BASE_DIR, "indexed", id);
        } else if (t.baseId === "pocketbase") {
            cleanDir = join(SWEBENCH_BASE_DIR, "clean", "pocketbase");
            indexedDir = join(SWEBENCH_BASE_DIR, "indexed", "pocketbase");
        } else {
            const spec = scaleByRepo.get(t.baseId || t.repo) || t;
            const slug = spec.id || t.id;
            cleanDir = join(V2_BASE_DIR, "clean", slug);
            indexedDir = join(V2_BASE_DIR, "indexed", slug);
            if (!existsSync(cleanDir) && spec.repoUrl && spec.baseCommit) {
                mkdirSync(cleanDir, { recursive: true });
                execFileSync("git", ["init", "-q"], { cwd: cleanDir });
                execFileSync("git", ["remote", "add", "origin", spec.repoUrl], { cwd: cleanDir });
                execFileSync("git", ["fetch", "--depth", "1", "origin", spec.baseCommit], {
                    cwd: cleanDir,
                    stdio: "ignore",
                });
                execFileSync("git", ["checkout", "-q", "FETCH_HEAD"], { cwd: cleanDir });
            }
            if (
                existsSync(cleanDir) &&
                (forceReindex || !isIndexedDirReady(indexedDir))
            ) {
                await buildIndexedFromClean(cleanDir, indexedDir, { graphOnly: true });
            }
        }
        prepared.set(t.id, { cleanDir, indexedDir });
    }
    return prepared;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
    const t0 = performance.now();
    await ensureAbBaseRepos();
    if (!process.argv.includes("--ab-only")) {
        await ensureSwebenchBaseRepos();
    }
    console.log(`Base repositories ready in ${((performance.now() - t0) / 1000).toFixed(1)}s.`);
}
