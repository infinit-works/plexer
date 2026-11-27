import { spawnSync } from "node:child_process";

/** Run git in `root`, or return null when git fails (not a repo, unknown ref). */
export function git(root, args, timeoutMs = 30_000) {
    const res = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotePath=false", ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
    });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string")
        return null;
    return res.stdout;
}
