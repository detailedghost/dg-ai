import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DgPaths } from "@dg/common/node";

/**
 * Generic key/value config persisted at ~/.dg/config.json — origin pinning
 * and slice 9's asset directory both live here, one file and one validator.
 */
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
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const next = { ...readConfig(paths), ...patch };
	const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 2));
	renameSync(tmp, file);
}
