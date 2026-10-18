import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildGraph } from '../graph/build.js';
import { readWiring, computeStats, patchStats, releaseLock, resolveContextDir } from '../util/state.js';
/** Structural `plexer build` ($0, offline). */
async function realBuild(dir) {
    const testCli = process.env.PLEXER_TEST_CLI;
    if (testCli) {
        const args = [testCli, 'build', '.'];
        if (process.env.PLEXER_DIR)
            args.push('--dir', resolveContextDir(dir));
        execFileSync(process.execPath, args, { cwd: dir, stdio: 'ignore', timeout: 120000 });
        return;
    }
    await buildGraph(dir, { contextDir: resolveContextDir(dir) });
}
export async function runSync(dir, build = realBuild) {
    try {
        await build(dir);
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
        patchStats(dir, { syncing: false }); // leave dirty=true; retry next turn
    }
    finally {
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
