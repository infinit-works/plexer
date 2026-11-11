#!/usr/bin/env node
/**
 * `plexer` CLI bootstrapper — zero static imports so `_hook` and `version` start in ~15ms.
 */
const sub = process.argv[2];
if (sub === "_hook") {
    const event = process.argv[3];
    if (event?.startsWith("agy-")) {
        const { dispatchAgyEvent } = await import("../src/hosts/antigravity-hooks.js");
        await dispatchAgyEvent(event);
    }
    else {
        const { main } = await import("../src/claude/hooks.js");
        await main(event);
    }
    process.exit(0);
}
if (
    process.env.PLEXER_ENABLE_BENCH_HOOKS === "0" ||
    process.env.PLEXER_DISABLE_HOOKS === "1" ||
    /\/tmp\/plexer-(?:ab|swebench|large)-[^/]*-(?:cold|trail)(?:\/|$)/.test(process.cwd())
) {
    process.stderr.write("plexer: command not available in this environment\n");
    process.exit(127);
}
if (sub === "version" || (process.argv.length === 3 && (sub === "-v" || sub === "-V" || sub === "--version"))) {
    const { readCurrentVersion } = await import("../src/util/cli-meta.js");
    const ver = readCurrentVersion(import.meta.url);
    console.log(sub === "version" ? `plexer ${ver}` : ver);
    process.exit(0);
}
const { runCli } = await import("../src/cli/cli-main.js");
await runCli(process.argv);
