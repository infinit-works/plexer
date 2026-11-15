import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildGraph } from "../src/index.js";
import { ask } from "../src/ask/ask.js";
import { queryAskPostings } from "../src/ask/index-file.js";
import { checkGraph } from "../src/graph/check.js";
import { seedGraph } from "../src/graph/seed.js";
import { closeSqliteStores, sqliteStorePath } from "../src/storage/sqlite-store.js";
import { createTempTracker, initGitCommit } from "./helpers/git-fixture.js";

const { makeTempDir, cleanup } = createTempTracker("plexer-sqlite-cone-");

function normalizeGraphSnapshot(g) {
    const nodes = [...g.nodes]
        .map((n) => ({ id: n.id, kind: n.kind, name: n.name, path: n.path, span: n.span, exported: Boolean(n.exported) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    const edges = [...g.edges]
        .map((e) => ({ source: e.source, target: e.target, relation: e.relation, confidence: e.confidence, typeOnly: Boolean(e.typeOnly) }))
        .sort((a, b) =>
            a.source.localeCompare(b.source) ||
            a.target.localeCompare(b.target) ||
            a.relation.localeCompare(b.relation),
        );
    return { nodes, edges };
}

after(() => {
    closeSqliteStores();
    cleanup();
});

describe("SQLite WAL Persistence, Postings, Dirty-Cone Parity, & Drift/Seed Edge Cases", () => {
    it("persists index.sqlite with 0 extract.*.json files, queries O(|Q|) postings, and preserves dirty-cone parity & .md wiring stability", async () => {
        const incRepo = makeTempDir("plexer-cone-inc-");
        const coldRepo = makeTempDir("plexer-cone-cold-");

        const initialFiles = {
            "README.md": "# Service Overview\nInitial documentation section.\n",
            "src/core.ts": [
                "export function computeDiscount(price: number): number {",
                "    return price * 0.9;",
                "}",
            ].join("\n") + "\n",
            "src/billing.ts": [
                'import { computeDiscount } from "./core";',
                "export function chargeOrder(amount: number): number {",
                "    return computeDiscount(amount);",
                "}",
            ].join("\n") + "\n",
            "src/legacy.ts": "export function deprecatedHook(): number { return 0; }\n",
            "src/extraA.ts": "export const alphaConst = 1;\n",
            "src/extraB.ts": "export const betaConst = 2;\n",
            "src/extraC.ts": "export const gammaConst = 3;\n",
        };
        for (const repo of [incRepo, coldRepo]) {
            for (const [rel, content] of Object.entries(initialFiles)) {
                const full = join(repo, rel);
                mkdirSync(join(full, ".."), { recursive: true });
                writeFileSync(full, content, "utf8");
            }
            initGitCommit(repo);
        }

        await buildGraph(incRepo, { force: true });
        const cacheDir = join(incRepo, "plexer", ".cache");
        assert.equal(existsSync(sqliteStorePath(join(incRepo, "plexer"))), true, "index.sqlite must be created");
        const extractJsonFiles = readdirSync(cacheDir).filter((f) => f.startsWith("extract.") && f.endsWith(".json"));
        assert.equal(extractJsonFiles.length, 0, "legacy extract.*.json files must not exist when index.sqlite is active");

        // Verify O(|Q|) queryAskPostings direct lookup across exact_ident and stem channels
        const postings = queryAskPostings(join(incRepo, "plexer"), {
            exact_ident: ["compute", "discount", "charge", "order"],
            stem: ["discount", "order"],
        });
        assert.ok(postings && postings.docCount > 0, "queryAskPostings should return active corpus docCount");
        assert.ok(postings.docs instanceof Map && postings.docs.size >= 2, "queryAskPostings.docs must return matched documents");
        assert.ok(postings.postings.exact_ident.get("compute")?.length >= 1, "exact_ident postings must index identifier split compute");
        assert.ok(postings.postings.stem.get("discount")?.length >= 1, "stem postings must index discount");

        // .md-only doc update refreshes docs index WITHOUT touching wiring.json
        const wiringFile = join(incRepo, "plexer", ".graph", "wiring.json");
        const statBeforeMd = statSync(wiringFile);
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(
            join(incRepo, "README.md"),
            "# Service Overview\nUpdated quantum reconciliation architecture notes.\n",
            "utf8",
        );
        await buildGraph(incRepo);
        const statAfterMd = statSync(wiringFile);
        assert.equal(statAfterMd.mtimeMs, statBeforeMd.mtimeMs, ".md-only doc change must NOT rewrite wiring.json");
        assert.equal(statAfterMd.ino, statBeforeMd.ino, ".md-only doc change must preserve wiring.json inode");
        const docAsk = ask(incRepo, "quantum reconciliation architecture");
        assert.ok(
            docAsk.hits.some((h) => h.pointer?.startsWith("README.md:")),
            "ask must pick up updated markdown docs",
        );

        // Dirty-cone incremental rebuild parity vs cold build: modify 1 file, add 1 file, delete 1 file
        const updatedFiles = {
            "src/core.ts": [
                "export function computeDiscount(price: number): number {",
                "    return price * 0.85;",
                "}",
                "export function computeTax(price: number): number {",
                "    return price * 0.05;",
                "}",
            ].join("\n") + "\n",
            "src/reporting.ts": [
                'import { computeTax } from "./core";',
                "export function formatTaxLine(total: number): number {",
                "    return computeTax(total);",
                "}",
            ].join("\n") + "\n",
        };
        for (const repo of [incRepo, coldRepo]) {
            rmSync(join(repo, "src", "legacy.ts"), { force: true });
            for (const [rel, txt] of Object.entries(updatedFiles)) {
                writeFileSync(join(repo, rel), txt, "utf8");
            }
        }

        await buildGraph(incRepo); // incremental dirty-cone rebuild
        await buildGraph(coldRepo, { force: true, reuse: false }); // clean cold build

        const incWiring = normalizeGraphSnapshot(JSON.parse(readFileSync(wiringFile, "utf8")));
        const coldWiring = normalizeGraphSnapshot(JSON.parse(readFileSync(join(coldRepo, "plexer", ".graph", "wiring.json"), "utf8")));
        assert.deepEqual(incWiring, coldWiring, "dirty-cone incremental rebuild must match cold build node-for-node and edge-for-edge");
    });

    it("detects tsconfig.base.json drift, prunes .gitignore entries, tracks linked-worktree .git index mtime, and seeds file:// + # + config.json", async () => {
        const origin = makeTempDir("plexer-seed-origin-");
        mkdirSync(join(origin, "packages", "core", "src"), { recursive: true });
        mkdirSync(join(origin, "src"), { recursive: true });

        writeFileSync(
            join(origin, "tsconfig.base.json"),
            JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: { "@core/*": ["packages/core/src/*"] },
                },
            }, null, 2),
            "utf8",
        );
        writeFileSync(
            join(origin, "packages", "core", "src", "index.ts"),
            "export function sharedCoreUtil(): string { return 'v1'; }\n",
            "utf8",
        );
        writeFileSync(
            join(origin, "src", "entry.ts"),
            'import { sharedCoreUtil } from "@core/index";\nexport function runEntry() { return sharedCoreUtil(); }\n',
            "utf8",
        );
        initGitCommit(origin);
        writeFileSync(join(origin, "src", "ephemeral.ts"), "export const ephem = 1;\n", "utf8");

        // Persist custom build config inside .cache/config.json
        mkdirSync(join(origin, "plexer", ".cache"), { recursive: true });
        writeFileSync(join(origin, "plexer", ".cache", "config.json"), JSON.stringify({ includeDirs: ["generated"] }), "utf8");

        await buildGraph(origin, { force: true });
        const chkClean = await checkGraph(origin);
        assert.equal(chkClean.ok, true);

        // 1. In-place tsconfig.base.json drift detection
        await new Promise((r) => setTimeout(r, 20));
        writeFileSync(
            join(origin, "tsconfig.base.json"),
            JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: { "@core/*": ["packages/core/src/*"], "@alt/*": ["src/*"] },
                },
            }, null, 2),
            "utf8",
        );
        const chkTs = await checkGraph(origin);
        assert.equal(chkTs.ok, false, "in-place tsconfig.base.json change must mark graph stale in checkGraph");
        await buildGraph(origin);

        // 2. .gitignore pruning removes newly ignored files from graph
        writeFileSync(join(origin, ".gitignore"), "src/ephemeral.ts\n", "utf8");
        await buildGraph(origin);
        const afterIgnore = JSON.parse(readFileSync(join(origin, "plexer", ".graph", "wiring.json"), "utf8"));
        assert.equal(afterIgnore.nodes.some((n) => n.path === "src/ephemeral.ts"), false, "newly gitignored file must be pruned from graph");

        // 3. Linked-worktree `.git` index mtime + `seedGraph` with file:// origin + `#` comment + .cache/config.json
        const wtPath = makeTempDir("plexer-linked-wt-");
        rmSync(wtPath, { recursive: true, force: true });
        execFileSync("git", ["worktree", "add", "-q", "-b", "wt-branch", wtPath], { cwd: origin });
        try {
            const wtSeedRes = seedGraph(wtPath);
            assert.equal(wtSeedRes.seeded, true, "linked worktree must seed from main checkout");
            assert.equal(existsSync(join(wtPath, "plexer", ".cache", "config.json")), true, "seedGraph must copy .cache/config.json");
            assert.equal(existsSync(join(wtPath, "plexer", "INDEX.md")), false, "seedGraph must NOT copy parent INDEX.md");

            // Touch staging index inside linked worktree `.git/index` and verify checkGraph detects git-index shift
            await new Promise((r) => setTimeout(r, 20));
            writeFileSync(join(wtPath, "src", "stagedFile.ts"), "export const stagedVal = 99;\n", "utf8");
            execFileSync("git", ["add", "src/stagedFile.ts"], { cwd: wtPath });
            const wtCheck = await checkGraph(wtPath);
            assert.equal(wtCheck.ok, false, "linked worktree staged index change must be detected by checkGraph");
        } finally {
            try {
                execFileSync("git", ["worktree", "remove", "--force", wtPath], { cwd: origin });
            } catch {
                rmSync(wtPath, { recursive: true, force: true });
            }
        }

        // 4. Clone seeded via file:// URL + `#` inline comment in `.git/config`
        const cloneDir = makeTempDir("plexer-seed-fileurl-");
        rmSync(cloneDir, { recursive: true, force: true });
        execFileSync("git", ["clone", "-q", origin, cloneDir]);
        const gitCfgPath = join(cloneDir, ".git", "config");
        const origCfg = readFileSync(gitCfgPath, "utf8");
        const originUrlLine = `${pathToFileURL(origin).href} # local origin comment`;
        const rewrittenCfg = origCfg.replace(/url\s*=\s*.+/, `url = "${pathToFileURL(origin).href}" # comment`);
        assert.ok(originUrlLine.includes("file://"));
        writeFileSync(gitCfgPath, rewrittenCfg, "utf8");
        rmSync(join(cloneDir, "plexer"), { recursive: true, force: true });
        const cloneSeed = seedGraph(cloneDir);
        assert.equal(cloneSeed.seeded, true, "seedGraph must parse quoted file:// origin URL with trailing # comment");
        assert.equal(existsSync(join(cloneDir, "plexer", ".cache", "config.json")), true, "seedGraph must bring .cache/config.json");
    });
});
