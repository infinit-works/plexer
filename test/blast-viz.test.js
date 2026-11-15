import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGraph } from "../src/index.js";
import { health } from "../src/health/health.js";
import { exportViz } from "../src/viz/export.js";
import { createTempTracker, initGitCommit, runPlexerCli as runCli } from "./helpers/git-fixture.js";

const VIEWER_DIR = new URL("../src/viewer/", import.meta.url).pathname;
const { makeTempDir, cleanup } = createTempTracker("plexer-blast-viz-");

after(cleanup);

describe("Blast Pre-Image Deletion/Rename & Static ExportViz Treemap Sandbox", () => {
    it("resolves callers of pre-image deleted/renamed symbol and deleted barrel file on `plexer blast` post-refresh", async () => {
        const repo = makeTempDir("plexer-blast-preimg-");
        mkdirSync(join(repo, "src"), { recursive: true });
        mkdirSync(join(repo, "test"), { recursive: true });

        writeFileSync(
            join(repo, "src", "tax.ts"),
            [
                "export function computeLegacyTax(cents: number): number {",
                "    return Math.round(cents * 0.08);",
                "}",
                "export function keepStableFee(cents: number): number {",
                "    return cents + 50;",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "barrel.ts"),
            'export { computeLegacyTax, keepStableFee } from "./tax";\n',
            "utf8",
        );
        writeFileSync(
            join(repo, "src", "checkout.ts"),
            [
                'import { computeLegacyTax } from "./barrel";',
                "export function finalizeCheckout(subtotal: number): number {",
                "    return subtotal + computeLegacyTax(subtotal);",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        writeFileSync(
            join(repo, "test", "checkout.test.ts"),
            [
                'import { finalizeCheckout } from "../src/checkout";',
                "finalizeCheckout(1000);",
            ].join("\n") + "\n",
            "utf8",
        );
        initGitCommit(repo, "initial baseline");
        await buildGraph(repo, { force: true });

        // Mutate working tree: delete barrel.ts and rename computeLegacyTax -> computeModernTax
        rmSync(join(repo, "src", "barrel.ts"), { force: true });
        writeFileSync(
            join(repo, "src", "tax.ts"),
            [
                "export function computeModernTax(cents: number): number {",
                "    return Math.round(cents * 0.08);",
                "}",
                "export function keepStableFee(cents: number): number {",
                "    return cents + 50;",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );

        // Run `plexer blast` WITHOUT `--no-refresh`: graph refreshes on working tree,
        // yet pre-image seeding must still trace deleted barrel + renamed symbol callers!
        const blastRes = runCli(repo, ["blast", "--json"]);
        assert.equal(blastRes.status, 0, blastRes.stderr);
        const report = JSON.parse(blastRes.stdout);
        const affectedPaths = new Set([
            ...(report.impacted || []).map((i) => i.path),
            ...(report.modules || []).flatMap((m) => (m.symbols || []).map((s) => s.path)),
            ...(report.testModules || []).flatMap((m) => (m.symbols || []).map((s) => s.path)),
        ]);
        assert.ok(affectedPaths.has("src/checkout.ts"), `expected pre-image caller src/checkout.ts, got ${[...affectedPaths]}`);
        assert.ok(affectedPaths.has("test/checkout.test.ts"), `expected pre-image test caller test/checkout.test.ts, got ${[...affectedPaths]}`);

        // `--export-viz` writes standalone interactive HTML for the PR blast radius
        const exportOut = makeTempDir("plexer-blast-export-");
        const vizBlast = runCli(repo, ["blast", "--export-viz", exportOut, "--title", "PR Tax Migration"]);
        assert.equal(vizBlast.status, 0, vizBlast.stderr);
        const htmlPath = join(exportOut, "index.html");
        assert.equal(existsSync(htmlPath), true, "plexer blast --export-viz must create index.html");
        const exportedHtml = readFileSync(htmlPath, "utf8");
        assert.ok(exportedHtml.includes("window.__PLEXER_DATA__"), "exported page must embed __PLEXER_DATA__");
        assert.ok(exportedHtml.includes("PR Tax Migration"), "exported page must include subtitle");
    });

    it("embeds Treemap srcdoc payload and strict sandbox=\"allow-scripts\" on #treemap-frame in static exportViz", async () => {
        const repo = makeTempDir("plexer-export-treemap-");
        mkdirSync(join(repo, "src"), { recursive: true });
        writeFileSync(
            join(repo, "src", "worker.ts"),
            [
                "export function dispatchTask(id: string): string {",
                "    return id.trim();",
                "}",
            ].join("\n") + "\n",
            "utf8",
        );
        initGitCommit(repo, "init");
        await buildGraph(repo, { force: true });
        health(repo, { action: "scan" });

        const outDir = makeTempDir("plexer-viz-out-");
        const res = exportViz({
            contextDir: join(repo, "plexer"),
            viewerDir: VIEWER_DIR,
            outDir,
            repoName: "treemap-demo",
            tabs: ["context", "code", "treemap"],
        });
        const page = readFileSync(res.file, "utf8");

        // Verify iframe markup in exported page uses sandbox="allow-scripts" ONLY (no allow-same-origin)
        const iframeMatch = page.match(/<iframe[^>]*id="treemap-frame"[^>]*>/i);
        assert.ok(iframeMatch, "exported HTML must include #treemap-frame iframe");
        assert.match(iframeMatch[0], /sandbox="allow-scripts"/, '#treemap-frame must enforce sandbox="allow-scripts"');
        assert.equal(/allow-same-origin/i.test(iframeMatch[0]), false, "#treemap-frame must NOT include allow-same-origin");

        // Verify viewer app wires treemapHtml into el.treemapFrame.srcdoc & payload embeds real treemap HTML
        assert.ok(page.includes("treemapHtml:"), "__PLEXER_DATA__ must embed treemapHtml");
        assert.ok(page.includes("el.treemapFrame.srcdoc = window.__PLEXER_DATA__.treemapHtml"), "exported app JS must hydrate #treemap-frame via srcdoc");
        assert.ok(page.includes("plexer-treemap-select"), "embedded treemapHtml must contain interactive treemap selector script");
    });
});
