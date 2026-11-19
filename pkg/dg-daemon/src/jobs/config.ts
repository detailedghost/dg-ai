import { isAbsolute } from "node:path";
import {
	CREDENTIAL_GRANT_PREFIX_PATTERN,
	describeError,
	isRecord,
	parseEvery,
	validateCredentialName,
} from "@dg/common";
import { isJobName } from "@dg/common/node";
import { ENV_KEY } from "../services/env-file";
import { nextCronRun } from "./cron";

export const JOBS_CONFIG_KEY = "jobs";

const MODE_KEYS = ["continuous", "schedule", "every"] as const;
const JOB_KEYS = new Set<string>([
	...MODE_KEYS,
	"argv",
	"cwd",
	"enabled",
	"feed",
	"notify",
	"timeoutMs",
	"credentials",
	"envFile",
	"passEnv",
	"stopTimeoutMs",
	"grant",
]);
const SCHEDULED_ONLY_KEYS = ["feed", "notify", "timeoutMs"] as const;
const MODE_RULE = 'give exactly one of "continuous", "schedule" or "every"';
const MAX_CREDENTIALS = 16;
export const DEFAULT_STOP_TIMEOUT_MS = 5_000;
export const MAX_STOP_TIMEOUT_MS = 240_000;

export type JobMode = (typeof MODE_KEYS)[number];

export type JobDecl = {
	name: string;
	mode: JobMode;
	schedule?: string;
	every?: string;
	argv: string[];
	cwd: string;
	enabled: boolean;
	feed: boolean;
	notify?: string;
	timeoutMs?: number;
	credentials: string[];
	envFile?: string;
	passEnv: string[];
	stopTimeoutMs: number;
	grant?: string;
};

export type ParsedJob =
	| ({ ok: true } & JobDecl)
	| { ok: false; name: string; error: string };

const isArgv = (value: unknown): value is string[] =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every(
		(part) =>
			typeof part === "string" && part.length > 0 && !part.includes("\0"),
	);

const modeOf = (raw: unknown): JobMode | undefined => {
	if (!isRecord(raw)) return undefined;
	const present = MODE_KEYS.filter((key) => Object.hasOwn(raw, key));
	return present.length === 1 ? present[0] : undefined;
};

/** True for an entry the continuous supervisor owns, including one too broken to tell. */
export const isContinuousEntry = (raw: unknown): boolean => {
	const mode = modeOf(raw);
	return mode === undefined || mode === "continuous";
};

function checkSchedule(value: unknown): string | undefined {
	if (typeof value !== "string") return '"schedule" must be a cron expression';
	try {
		nextCronRun(value, new Date());
		return undefined;
	} catch (err) {
		return `"schedule": ${describeError(err)}`;
	}
}

function checkEvery(value: unknown): string | undefined {
	if (typeof value !== "string")
		return '"every" must be a duration such as 15m';
	try {
		parseEvery(value, "every");
		return undefined;
	} catch (err) {
		return `"every": ${describeError(err)}`;
	}
}

function checkCredentials(
	value: unknown,
	grant: unknown,
): { error: string } | { names: string[] } {
	if (grant === undefined) return { error: '"credentials" needs "grant"' };
	if (!Array.isArray(value) || value.length > MAX_CREDENTIALS) {
		return {
			error: `"credentials" must be an array of at most ${MAX_CREDENTIALS} credential names`,
		};
	}
	const names: string[] = [];
	for (const name of value) {
		try {
			if (typeof name !== "string" || name.length === 0) throw new Error();
			if (name.split("/").some((s) => s === "" || s === "." || s === "..")) {
				throw new Error();
			}
			validateCredentialName(`${grant}/${name}`);
			names.push(name.toLowerCase());
		} catch {
			return {
				error: `"credentials" holds a name that is not valid under the grant: ${JSON.stringify(name)}`,
			};
		}
	}
	if (new Set(names).size !== names.length) {
		return { error: '"credentials" must not list a name two times' };
	}
	return { names };
}

export function parseJobEntry(name: string, raw: unknown): ParsedJob {
	const invalid = (error: string): ParsedJob => ({ ok: false, name, error });
	if (!isJobName(name)) {
		return invalid(
			"label must be 1-64 lowercase letters, digits or hyphens, starting with a letter or digit",
		);
	}
	if (!isRecord(raw)) return invalid("must be an object");
	const unknownKeys = Object.keys(raw).filter((key) => !JOB_KEYS.has(key));
	if (unknownKeys.length > 0) {
		return invalid(`unknown key(s): ${unknownKeys.join(", ")}`);
	}
	const modeKeys = MODE_KEYS.filter((key) => Object.hasOwn(raw, key));
	if (modeKeys.length !== 1) return invalid(MODE_RULE);
	const declared = modeKeys[0];
	if (declared === "continuous" && raw.continuous !== true) {
		return invalid('"continuous" must be true');
	}
	const modeProblem =
		declared === "schedule"
			? checkSchedule(raw.schedule)
			: declared === "every"
				? checkEvery(raw.every)
				: undefined;
	if (modeProblem) return invalid(modeProblem);
	if (!isArgv(raw.argv)) {
		return invalid('"argv" must be a non-empty array of non-empty strings');
	}
	if (typeof raw.cwd !== "string" || !isAbsolute(raw.cwd)) {
		return invalid('"cwd" must be an absolute path');
	}
	if (
		raw.envFile !== undefined &&
		(typeof raw.envFile !== "string" || !isAbsolute(raw.envFile))
	) {
		return invalid('"envFile" must be an absolute path');
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		return invalid('"enabled" must be a boolean');
	}
	if (
		raw.passEnv !== undefined &&
		!(
			Array.isArray(raw.passEnv) &&
			raw.passEnv.every(
				(entry) => typeof entry === "string" && ENV_KEY.test(entry),
			)
		)
	) {
		return invalid('"passEnv" must be an array of environment variable names');
	}
	if (declared !== "continuous" && raw.stopTimeoutMs !== undefined) {
		return invalid('"stopTimeoutMs" needs "continuous"');
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
			`"stopTimeoutMs" must be an integer from 1 to ${MAX_STOP_TIMEOUT_MS}`,
		);
	}
	if (
		raw.grant !== undefined &&
		(typeof raw.grant !== "string" ||
			!CREDENTIAL_GRANT_PREFIX_PATTERN.test(raw.grant))
	) {
		return invalid('"grant" must be a credential grant prefix');
	}
	if (declared === "continuous") {
		const stray = SCHEDULED_ONLY_KEYS.find((key) => raw[key] !== undefined);
		if (stray) return invalid(`"${stray}" needs "schedule" or "every"`);
	}
	if (raw.feed !== undefined && typeof raw.feed !== "boolean") {
		return invalid('"feed" must be a boolean');
	}
	if (raw.notify !== undefined) {
		if (typeof raw.notify !== "string" || raw.notify.length === 0) {
			return invalid('"notify" must be a string that is not empty');
		}
		if (raw.feed !== true) return invalid('"notify" needs "feed": true');
	}
	if (
		raw.timeoutMs !== undefined &&
		(typeof raw.timeoutMs !== "number" ||
			!Number.isInteger(raw.timeoutMs) ||
			raw.timeoutMs < 1)
	) {
		return invalid('"timeoutMs" must be a whole number of 1 or more');
	}
	let credentials: string[] = [];
	if (raw.credentials !== undefined) {
		const checked = checkCredentials(raw.credentials, raw.grant);
		if ("error" in checked) return invalid(checked.error);
		credentials = checked.names;
	}
	return {
		ok: true,
		name,
		mode: declared,
		...(declared === "schedule" ? { schedule: raw.schedule as string } : {}),
		...(declared === "every" ? { every: raw.every as string } : {}),
		argv: raw.argv,
		cwd: raw.cwd,
		enabled: raw.enabled === true,
		feed: raw.feed === true,
		...(raw.notify === undefined ? {} : { notify: raw.notify as string }),
		...(raw.timeoutMs === undefined
			? {}
			: { timeoutMs: raw.timeoutMs as number }),
		credentials,
		...(raw.envFile === undefined ? {} : { envFile: raw.envFile }),
		passEnv: [...new Set((raw.passEnv as string[] | undefined) ?? [])],
		stopTimeoutMs,
		...(raw.grant === undefined ? {} : { grant: raw.grant }),
	};
}

/** Reads the `jobs` table of the daemon config; an invalid entry is reported, not fatal. */
export function parseJobs(config: Record<string, unknown>): ParsedJob[] {
	const raw = config[JOBS_CONFIG_KEY];
	if (raw === undefined) return [];
	if (!isRecord(raw)) {
		return [
			{
				ok: false,
				name: JOBS_CONFIG_KEY,
				error: "must be an object keyed by name",
			},
		];
	}
	return Object.entries(raw).map(([name, entry]) => parseJobEntry(name, entry));
}

/** The rows of `parseJobs` that `service` verbs and the supervisor act on. */
export function parseContinuousJobs(
	config: Record<string, unknown>,
): ParsedJob[] {
	const table = config[JOBS_CONFIG_KEY];
	return parseJobs(config).filter(
		(row) => !isRecord(table) || isContinuousEntry(table[row.name]),
	);
}
