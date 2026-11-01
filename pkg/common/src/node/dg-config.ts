import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "./fs";
import { resolveDgPaths } from "./paths";

export type DgConfig = Record<string, unknown>;
type ConfigEnv = Record<string, string | undefined>;

function configFile(env: ConfigEnv): string {
	return join(resolveDgPaths({ env }).stateDir, "config.json");
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function merge(base: DgConfig, patch: DgConfig): DgConfig {
	const out: DgConfig = { ...base };
	for (const [key, value] of Object.entries(patch)) {
		if (UNSAFE_KEYS.has(key)) continue;
		const current = out[key];
		if (isRecord(value))
			out[key] = merge(isRecord(current) ? current : {}, value);
		else out[key] = value;
	}
	return out;
}

/** Missing file reads as empty; invalid JSON throws so a write never clobbers it. */
export function readDgConfig(env: ConfigEnv = process.env): DgConfig {
	const file = configFile(env);
	if (!existsSync(file)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(
			`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
	return parsed;
}

/** Deep-merges the patch into config.json and replaces the file by atomic rename. */
export function writeDgConfig(
	patch: DgConfig,
	env: ConfigEnv = process.env,
): DgConfig {
	const next = merge(readDgConfig(env), patch);
	const file = configFile(env);
	mkdirSync(dirname(file), { recursive: true });
	writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}
