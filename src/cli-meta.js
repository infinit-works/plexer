import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./util/state.js";

export function resolvePackageJsonPath(moduleUrl = import.meta.url) {
	const moduleDir = dirname(fileURLToPath(moduleUrl));
	const candidates = [
		resolve(moduleDir, "..", "package.json"),
		resolve(moduleDir, "..", "..", "package.json"),
		resolve(moduleDir, "package.json"),
	];
	for (const c of candidates) {
		if (existsSync(c)) return c;
	}
	return candidates[0];
}

export function readPackageVersion(moduleUrl = import.meta.url) {
	return readJson(resolvePackageJsonPath(moduleUrl))?.version ?? null;
}

export function readCurrentVersion(moduleUrl = import.meta.url) {
	return readPackageVersion(moduleUrl) ?? "failed to read package version";
}
