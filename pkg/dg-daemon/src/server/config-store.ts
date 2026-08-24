import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DgPaths } from "@dg/common/node";
import { ensurePrivateDir, writeFileAtomic } from "../utils/fs";

export function readConfig(paths: DgPaths): Record<string, unknown> {
	const file = paths.configPath;
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
	const file = paths.configPath;
	ensurePrivateDir(dirname(file));
	const next = { ...readConfig(paths), ...patch };
	writeFileAtomic(file, JSON.stringify(next, null, 2));
}
