import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { buildGraph } from '../graph/build.js';
import { contextDirFor } from '../util/paths.js';
import { readWiring, computeStats, patchStats, releaseLock } from '../util/state.js';
/** Structural `plexer build` ($0, offline). */
async function realBuild(dir) {
    const testCli = process.env.PLEXER_TEST_CLI;
    if (testCli) {
        const args = [testCli, 'build', '.'];
        if (process.env.PLEXER_DIR)
            args.push('--dir', contextDirFor(dir));
        execFileSync(process.execPath, args, { cwd: dir, stdio: 'ignore', timeout: 120000 });
        return;
    }
    await buildGraph(dir, { contextDir: contextDirFor(dir) });
}
export async function runSync(dir, build = realBuild) {
    const ctxDir = contextDirFor(dir);
    if (!existsSync(dir) || !existsSync(ctxDir))
        return;
    try {
        await build(dir);
        if (!existsSync(dir) || !existsSync(ctxDir))
            return;
        const w = readWiring(dir);
        if (!w) {
            patchStats(dir, { syncing: false });
            return;
        } // build ran but output unreadable — stay dirty, retry
        patchStats(dir, {
            dirty: false, staleCount: 0, syncing: false, syncedAt: new Date().toISOString(),
            ...computeStats(w),
        });
    }
    catch {
        if (existsSync(dir) && existsSync(ctxDir))
            patchStats(dir, { syncing: false }); // leave dirty=true; retry next turn
    }
    finally {
        if (existsSync(dir) && existsSync(ctxDir))
            releaseLock(dir);
    }
}
export async function main() {
    const dir = process.argv[2];
    if (dir)
        await runSync(dir);
}
// Run only when executed directly (node src/claude/sync-run.js <dir>), not on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
    main();
