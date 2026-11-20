import { resolve } from "node:path";
import { DgCliError, describeError, EXIT_GENERAL_FAILURE, parseEvery } from "@dg/common";

export type EntryFlags = {
	name?: string;
	label?: string;
	continuous?: boolean;
	schedule?: string;
	cron?: string;
	every?: string;
	timeout?: string;
	feed?: boolean;
	notify?: string;
	envFile?: string;
	env?: string[];
	passEnv?: string[];
	stopTimeout?: string;
};

export type EntryParts = {
	names: string[];
	cronText: string | undefined;
	stopTimeoutMs: number | undefined;
	timeoutMs: number | undefined;
};

const fail = (message: string): never => {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
};

export const aliasNote = (oldForm: string, newForm: string): void => {
	console.error(
		`note: "${oldForm}" is now "${newForm}"; this form goes away in the next major release`,
	);
};

export function announceAliases(options: EntryFlags): void {
	if (options.label !== undefined) aliasNote("--label", "--name");
	if (options.cron !== undefined) aliasNote("--cron", "--schedule");
	if (options.passEnv !== undefined) aliasNote("--pass-env", "--env");
}

export function duration(value: string, flag: string, prefix: string): number {
	try {
		return parseEvery(value, flag);
	} catch (err) {
		return fail(`${prefix}: ${describeError(err)}`);
	}
}

export function assertOneMode(options: EntryFlags, prefix: string): void {
	const count =
		Number(options.continuous === true) +
		Number(options.every !== undefined) +
		Number(options.schedule !== undefined) +
		Number(options.cron !== undefined);
	if (count !== 1) fail(`${prefix}: give one of --continuous, --schedule or --every`);
}

export function checkEntryFlags(options: EntryFlags, prefix: string): EntryParts {
	const names = [...new Set([...(options.env ?? []), ...(options.passEnv ?? [])])];
	if (names.some((entry) => entry.includes("="))) {
		fail(`${prefix}: --env takes a variable name — put a value in the file of --env-file`);
	}
	return {
		names,
		cronText: options.schedule ?? options.cron,
		stopTimeoutMs:
			options.stopTimeout === undefined
				? undefined
				: duration(options.stopTimeout, "--stop-timeout", prefix),
		timeoutMs:
			options.timeout === undefined ? undefined : duration(options.timeout, "--timeout", prefix),
	};
}

export function entryFromFlags(
	options: EntryFlags,
	parts: EntryParts,
	base: { argv: string[]; cwd: string; credentials: Record<string, unknown> },
): Record<string, unknown> {
	return {
		argv: base.argv,
		cwd: base.cwd,
		...(options.continuous ? { continuous: true } : {}),
		...base.credentials,
		...(parts.cronText === undefined ? {} : { schedule: parts.cronText }),
		...(options.every === undefined ? {} : { every: options.every }),
		...(options.envFile === undefined ? {} : { envFile: resolve(options.envFile) }),
		...(parts.names.length === 0 ? {} : { passEnv: parts.names }),
		...(parts.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: parts.stopTimeoutMs }),
		...(options.feed ? { feed: true } : {}),
		...(options.notify === undefined ? {} : { notify: options.notify }),
		...(parts.timeoutMs === undefined ? {} : { timeoutMs: parts.timeoutMs }),
	};
}
