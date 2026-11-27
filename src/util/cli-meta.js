import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./state.js";

function resolvePackageJsonPath(moduleUrl = import.meta.url) {
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	const candidates = [
		fileURLToPath(new URL("../../package.json", import.meta.url)),
		resolve(moduleDir, "..", "package.json"),
		resolve(moduleDir, "..", "..", "package.json"),
		resolve(moduleDir, "package.json"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return candidates[0];
}

const PKG_VERSION_CACHE = new Map();

export function readPackageVersion(moduleUrl = import.meta.url) {
	const key = String(moduleUrl || "");
	if (PKG_VERSION_CACHE.has(key))
		return PKG_VERSION_CACHE.get(key);
	const version = readJson(resolvePackageJsonPath(moduleUrl))?.version ?? null;
	PKG_VERSION_CACHE.set(key, version);
	return version;
}

export function readCurrentVersion(moduleUrl = import.meta.url) {
	return readPackageVersion(moduleUrl) ?? "failed to read package version";
}
