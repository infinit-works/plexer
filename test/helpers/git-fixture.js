import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI_PATH = new URL("../../bin/plexer.js", import.meta.url).pathname;

export function createTempTracker(defaultPrefix = "plexer-test-") {
    const dirs = [];
    const makeTempDir = (prefix = defaultPrefix) => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        dirs.push(dir);
        return dir;
    };
    const cleanup = () => {
        for (const d of dirs) {
            try {
                rmSync(d, { recursive: true, force: true });
            } catch {
                // Best-effort cleanup.
            }
        }
    };
    return { makeTempDir, cleanup };
}

export function initGitCommit(cwd, msg = "init") {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-qm", msg], { cwd });
}

export function writeFilesAndCommit(repoDir, filesMap, msg = "init") {
    for (const [rel, content] of Object.entries(filesMap)) {
        const full = join(repoDir, rel);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, content, "utf8");
    }
    initGitCommit(repoDir, msg);
}

export function runPlexerCli(cwd, args) {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PLEXER_NO_DAEMON: "1" },
    });
}
