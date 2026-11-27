import { parentPort, workerData } from "node:worker_threads";
import { contentHash } from "../util/id.js";
import { readSourceFile } from "../util/source.js";
import { containerLangOf, extractContainer, warmContainerGrammars } from "./container.js";
import { extractFile, warmDepthGrammars } from "./extract.js";
import { extractGeneric, genericLangOf, warmGenericGrammars } from "./generic.js";

async function runWorkerBatch(rawItems) {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const depthLangs = new Set();
    const genericLangs = new Set();
    const containerLangs = new Set();

    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.lang)
            depthLangs.add(it.lang);
        if (it.genericName)
            genericLangs.add(it.genericName);
        if (it.luauMode)
            genericLangs.add("luau");
        if (it.containerName)
            containerLangs.add(it.containerName);
    }

    await Promise.all([
        depthLangs.size ? warmDepthGrammars(depthLangs) : Promise.resolve(),
        genericLangs.size ? warmGenericGrammars(genericLangs) : Promise.resolve(),
        containerLangs.size ? warmContainerGrammars(containerLangs) : Promise.resolve(),
    ]);

    const results = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        let source = null;
        try {
            source = readSourceFile(it.abs);
        }
        catch (err) {
            results[i] = {
                rel: it.rel,
                size: it.size,
                mtimeMs: it.mtimeMs,
                hash: "",
                label: it.label,
                nodes: [],
                rawEdges: [],
                error: `${it.rel}: ${err instanceof Error ? err.message : String(err)}`,
            };
            continue;
        }
        if (source === null) {
            results[i] = {
                rel: it.rel,
                size: it.size,
                mtimeMs: it.mtimeMs,
                hash: "",
                label: it.label,
                nodes: [],
                rawEdges: [],
                error: null,
            };
            continue;
        }
        const hash = contentHash(source);
        try {
            let extracted = null;
            if (it.lang) {
                extracted = extractFile(it.rel, source, it.lang);
            }
            else if (it.containerName) {
                extracted = extractContainer(it.rel, source, containerLangOf(it.rel));
            }
            else if (it.genericName) {
                extracted = extractGeneric(
                    it.rel,
                    source,
                    genericLangOf(it.rel)?.name ?? it.genericName,
                    it.luauMode ? { luauMode: true } : null,
                );
            }
            results[i] = {
                rel: it.rel,
                size: it.size,
                mtimeMs: it.mtimeMs,
                hash,
                label: it.label,
                nodes: extracted?.nodes ?? [],
                rawEdges: extracted?.rawEdges ?? [],
                error: null,
            };
        }
        catch (err) {
            results[i] = {
                rel: it.rel,
                size: it.size,
                mtimeMs: it.mtimeMs,
                hash,
                label: it.label,
                nodes: [],
                rawEdges: [],
                error: `${it.rel}: parse failed — ${err instanceof Error ? err.message : String(err)}`,
            };
        }
    }
    return results;
}

if (parentPort && workerData) {
    runWorkerBatch(workerData.items)
        .then((results) => parentPort.postMessage({ results }))
        .catch((err) => {
            parentPort.postMessage({
                fatal: err instanceof Error ? err.stack || err.message : String(err),
            });
        });
}
else if (typeof process.send === "function") {
    process.once("message", (msg) => {
        runWorkerBatch(msg?.items)
            .then((results) => {
                process.send({ results }, () => process.exit(0));
            })
            .catch((err) => {
                process.send(
                    { fatal: err instanceof Error ? err.stack || err.message : String(err) },
                    () => process.exit(1),
                );
            });
    });
}
