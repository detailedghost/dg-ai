import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { ensurePrivateDir, writeFileAtomic } from "../utils/fs";

function configPath(paths: DgPaths): string {
	return `${paths.stateDir}/config.json`;
}

export function readConfig(paths: DgPaths): Record<string, unknown> {
	const file = configPath(paths);
	if (!existsSync(file)) return {};
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return typeof parsed === "object" &&
			parsed !== null &&
			!Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function writeConfig(
	paths: DgPaths,
	patch: Record<string, unknown>,
): void {
	const file = configPath(paths);
	ensurePrivateDir(dirname(file));
	const next = { ...readConfig(paths), ...patch };
	writeFileAtomic(file, JSON.stringify(next, null, 2));
}
