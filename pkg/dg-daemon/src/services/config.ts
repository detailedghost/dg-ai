import { isAbsolute } from "node:path";
import { CREDENTIAL_GRANT_PREFIX_PATTERN, isRecord } from "@dg/common";
import { ENV_KEY } from "./env-file";

export const SERVICES_CONFIG_KEY = "services";

const SERVICE_LABEL = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SERVICE_KEYS = new Set([
	"argv",
	"cwd",
	"envFile",
	"autostart",
	"passEnv",
	"stopTimeoutMs",
	"grant",
]);
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;
export const MAX_STOP_TIMEOUT_MS = 240_000;

export type ServiceDecl = {
	label: string;
	argv: string[];
	cwd: string;
	envFile?: string;
	autostart: boolean;
	passEnv: string[];
	stopTimeoutMs: number;
	grant?: string;
};

export type ParsedService =
	| ({ ok: true } & ServiceDecl)
	| { ok: false; label: string; error: string };

const invalid = (label: string, error: string): ParsedService => ({
	ok: false,
	label,
	error,
});

const isArgv = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every(
		(part) =>
			typeof part === "string" && part.length > 0 && !part.includes("\0"),
	);

export function parseServiceEntry(label: string, raw: unknown): ParsedService {
	if (!SERVICE_LABEL.test(label)) {
		return invalid(
			label,
			"label must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit",
		);
	}
	if (!isRecord(raw)) return invalid(label, "must be an object");
	const unknownKeys = Object.keys(raw).filter((key) => !SERVICE_KEYS.has(key));
	if (unknownKeys.length > 0) {
		return invalid(label, `unknown key(s): ${unknownKeys.join(", ")}`);
	}
	if (!isArgv(raw.argv)) {
		return invalid(
			label,
			'"argv" must be a non-empty array of non-empty strings',
		);
	}
	if (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)) {
		return invalid(label, '"cwd" must be an absolute path');
	}
	if (
		raw.envFile !== undefined &&
		(typeof raw.envFile !== "string" || !isAbsolute(raw.envFile))
	) {
		return invalid(label, '"envFile" must be an absolute path');
	}
	if (raw.autostart !== undefined && typeof raw.autostart !== "boolean") {
		return invalid(label, '"autostart" must be a boolean');
	}
	if (
		raw.passEnv !== undefined &&
		!(
			Array.isArray(raw.passEnv) &&
			raw.passEnv.every(
				(name) => typeof name === "string" && ENV_KEY.test(name),
			)
		)
	) {
		return invalid(
			label,
			'"passEnv" must be an array of environment variable names',
		);
	}
	const stopTimeoutMs =
		raw.stopTimeoutMs === undefined
			? DEFAULT_STOP_TIMEOUT_MS
			: raw.stopTimeoutMs;
	if (
		typeof stopTimeoutMs !== "number" ||
		!Number.isInteger(stopTimeoutMs) ||
		stopTimeoutMs < 1 ||
		stopTimeoutMs > MAX_STOP_TIMEOUT_MS
	) {
		return invalid(
			label,
			`"stopTimeoutMs" must be an integer from 1 to ${MAX_STOP_TIMEOUT_MS}`,
		);
	}
	if (
		raw.grant !== undefined &&
		(typeof raw.grant !== "string" ||
			!CREDENTIAL_GRANT_PREFIX_PATTERN.test(raw.grant))
	) {
		return invalid(label, '"grant" must be a credential grant prefix');
	}
	return {
		ok: true,
		label,
		argv: raw.argv,
		cwd: raw.cwd,
		...(raw.envFile === undefined ? {} : { envFile: raw.envFile }),
		autostart: raw.autostart ?? false,
		passEnv: [...new Set((raw.passEnv as string[] | undefined) ?? [])],
		stopTimeoutMs,
		...(raw.grant === undefined ? {} : { grant: raw.grant }),
	};
}

/** Reads the `services` table of the daemon config; an invalid entry is reported, not fatal. */
export function parseServices(
	config: Record<string, unknown>,
): ParsedService[] {
	const raw = config[SERVICES_CONFIG_KEY];
	if (raw === undefined) return [];
	if (!isRecord(raw)) {
		return [invalid(SERVICES_CONFIG_KEY, "must be an object keyed by label")];
	}
	return Object.entries(raw).map(([label, entry]) =>
		parseServiceEntry(label, entry),
	);
}
