import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	CHAT_JOBS_PATH,
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	formatSchedule,
	isRecord,
} from "@dg/common";
import {
	autostartManages,
	credentialGrantTokenPath,
	type DgPaths,
	isJobName,
	jobStateDir,
	resolveDgPaths,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";
import { type Command, Option } from "commander";
import {
	JOB_NAME_RULE,
	JOBS_CONFIG_KEY,
	parseJobEntry,
} from "../jobs/config";
import { jobLogFile } from "../jobs/launcher";
import type { NamedRegistry, PathSourceRecord } from "../jobs/sources";
import { readConfig, readConfigStrict, writeConfig, writeJobEntry } from "../server/config-store";
import type { ServiceStatus } from "../services/supervisor";
import {
	addScheduled,
	findScheduled,
	listScheduled,
	removeScheduled,
	runScheduledNow,
	type ScheduledRow,
	setScheduledEnabled,
} from "./job-schedule";
import {
	assertDaemonAnswers,
	assertNoLiveInstance,
	callJobRoute,
	DaemonCallError,
	defaultJobVerbDeps,
	ensureMigrated,
	findLiveDaemon,
	formatStatus,
	guardConfig,
	isInTable,
	type JobVerbDeps,
	liveJobRows,
	liveJobStates,
	requireMigrated,
	resolveExecutable,
	withConfigLock,
} from "./job-support";
import type { JobSetupDeps } from "./job-setup";
import type { JobSourceDeps } from "./job-source";
import {
	aliasNote,
	announceAliases,
	assertOneMode,
	checkEntryFlags,
	duration,
	entryFromFlags,
} from "./job-entry";
import { startDaemon } from "./start";

const MODE_KEYS = ["continuous", "schedule", "every"] as const;
const LOGIN_QUESTION =
	"Start dg at login, so this job runs after a restart of the machine? [Y/n]";
const LOGIN_HINT =
	"hint: dg does not start at login — run dg autostart install";

type Paths = DgPaths;
type Mode = (typeof MODE_KEYS)[number];
type Row = Record<string, unknown>;

const fail = (message: string): never => {
	throw new DgCliError(message, EXIT_GENERAL_FAILURE);
};

const notFound = (name: string) => fail(`no job named "${name}"`);

const collect = (value: string, previous: string[] = []): string[] => [
	...previous,
	value,
];

const jobPath = (name: string, verb: "start" | "stop") =>
	`${CHAT_JOBS_PATH}/${encodeURIComponent(name)}/${verb}`;

const isActive = (state: string | undefined): boolean =>
	state === "running" || state === "backoff";

function tableEntries(
	config: Record<string, unknown>,
): [string, unknown][] {
	const table = config[JOBS_CONFIG_KEY];
	return isRecord(table) ? Object.entries(table) : [];
}

function modeOf(raw: unknown): Mode | "invalid" {
	if (!isRecord(raw)) return "invalid";
	const present = MODE_KEYS.filter((key) => Object.hasOwn(raw, key));
	return present.length === 1 ? present[0] : "invalid";
}

function tableEntry(
	paths: Paths,
	config: Record<string, unknown>,
	name: string,
): Record<string, unknown> {
	if (!isInTable(config, name)) return notFound(name);
	const entry = (config[JOBS_CONFIG_KEY] as Record<string, unknown>)[name];
	if (!isRecord(entry)) {
		return fail(`job "${name}" in ${paths.daemonConfigPath} is not an object`);
	}
	return entry;
}

function readTable(paths: Paths): Record<string, unknown> {
	return guardConfig(() => readConfigStrict(paths));
}

async function locate(
	paths: Paths,
	name: string,
	options: { migrate: boolean; scheduled: boolean },
): Promise<"table" | "scheduled"> {
	const inTable = () => isInTable(readTable(paths), name);
	const kindOfEntry = (): "table" | "scheduled" => {
		const mode = modeOf(tableEntries(readTable(paths)).find(([key]) => key === name)?.[1]);
		return mode === "every" || mode === "schedule" ? "scheduled" : "table";
	};
	if (inTable()) {
		if (options.migrate) await ensureMigrated(paths);
		return kindOfEntry();
	}
	if (options.scheduled && (await findScheduled(name))) return "scheduled";
	if (options.migrate && existsSync(paths.daemonConfigPath)) {
		await ensureMigrated(paths);
		if (inTable()) return kindOfEntry();
	}
	return notFound(name);
}

async function homeLine(): Promise<string> {
	const home = process.env.DG_HOME || "default";
	let daemon = "not running";
	try {
		const live = await findLiveDaemon(resolveDgPaths());
		if (live) daemon = `http://127.0.0.1:${live.port}`;
	} catch {
		daemon = "not running";
	}
	return `dg home: ${home}; daemon: ${daemon}`;
}

async function refuseTakenPrefix(
	paths: Paths,
	config: Record<string, unknown>,
	name: string,
): Promise<void> {
	if (isInTable(config, name)) return;
	const [{ assertPrefixFree }, { readNamedSources }] = await Promise.all([
		import("./job-source"),
		import("../jobs/sources"),
	]);
	assertPrefixFree(
		name,
		config,
		guardConfig(() => readNamedSources(paths)),
		"job add:",
	);
}

type AddOptions = {
	name?: string;
	label?: string;
	yes?: boolean;
	cwd?: string;
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
	credential?: string[];
};

async function addVerb(
	argv: string[],
	options: AddOptions,
	deps: JobVerbDeps,
): Promise<void> {
	function stop(message: string): never {
		return fail(`job add: ${message}`);
	}
	announceAliases(options);
	const flag = options.name === undefined ? "--label" : "--name";
	const name = options.name ?? options.label ?? stop("--name is required");
	assertOneMode(options, "job add");
	if (!isJobName(name)) stop(`"${flag}" ${JOB_NAME_RULE}`);
	const parts = checkEntryFlags(options, "job add");
	const { names, cronText, timeoutMs } = parts;
	if (argv.length === 0) stop("no command given — put it after a bare --");
	if (options.cwd === undefined) stop("--cwd is required");
	const cwd = resolve(options.cwd);
	if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
		stop(`--cwd: no such directory: ${options.cwd}`);
	}
	const paths = resolveDgPaths();
	let command = argv;
	if (options.continuous) {
		const [first, ...rest] = argv;
		command = [resolveExecutable(first, "job add:", deps.which), ...rest];
	}
	const credentials =
		options.credential === undefined
			? {}
			: (await import("./job-source")).credentialListFor(options.credential, name);
	const entry: Row = entryFromFlags(options, parts, { argv: command, cwd, credentials });
	const legacy = options.label !== undefined || options.cron !== undefined;
	const legacyScheduled = legacy && !options.continuous;
	const probe: Row = legacyScheduled
		? {
				...entry,
				argv: command.map((part) => part || "-"),
				...(options.notify === undefined ? {} : { feed: true }),
			}
		: entry;
	const parsed = parseJobEntry(name, probe);
	if (!parsed.ok) stop(parsed.error);
	if (existsSync(paths.daemonConfigPath) || options.continuous) {
		await ensureMigrated(paths);
	}
	const exists = () =>
		fail(`a job named "${name}" already exists`);
	if (!options.continuous) {
		await refuseTakenPrefix(paths, readTable(paths), name);
		const created = await addScheduled({
			name,
			argv,
			cwd,
			every: options.every,
			schedule: cronText,
			notify: options.notify,
			enabled: legacy,
			feed: options.feed,
			timeoutMs,
			envFile: options.envFile === undefined ? undefined : resolve(options.envFile),
			passEnv: names,
			...credentials,
		}, deps.which);
		if (legacy) {
			console.log(
				`added "${created.label}" — ${formatSchedule(created)}, first run ${created.nextRunAt}`,
			);
			return;
		}
		console.log(`added job "${name}"`);
		console.log(`next: dg job enable ${name}`);
		return;
	}
	if (await findScheduled(name)) exists();
	await withConfigLock(paths, async () => {
		const config = readTable(paths);
		requireMigrated(config);
		if (isInTable(config, name)) exists();
		await refuseTakenPrefix(paths, config, name);
		guardConfig(() => writeJobEntry(paths, name, entry));
	});
	console.log(`added job "${name}"`);
	console.log(`next: dg job enable ${name}`);
}

type SourceMark = {
	source?: string;
	ref?: string | null;
	sha?: string;
	path?: string;
	sourceState?: string;
};
type Rows = { rows: Row[]; scheduled: (ScheduledRow & SourceMark)[] };

function grantFileOf(paths: Paths, grant: unknown): string | null {
	if (typeof grant !== "string") return null;
	try {
		return credentialGrantTokenPath(paths, grant);
	} catch {
		return null;
	}
}

function stateDirOf(paths: Paths, name: string): string | null {
	try {
		return jobStateDir(paths, name);
	} catch {
		return null;
	}
}

async function sourcesOf(paths: Paths): Promise<NamedRegistry> {
	if (!existsSync(paths.jobSourcesPath)) return {};
	const { readNamedSources } = await import("../jobs/sources");
	return guardConfig(() => readNamedSources(paths));
}

async function recordOf(paths: Paths, name: string) {
	const registry = await sourcesOf(paths);
	const { findRecordByJob } = await import("../jobs/sources");
	return findRecordByJob(registry, name);
}

async function collectRows(paths: Paths): Promise<Rows> {
	const config = readTable(paths);
	const registry = await sourcesOf(paths);
	const { findRecordByJob } = await import("../jobs/sources");
	const { sourceStateOf } = await import("./job-source");
	const markOf = (job: string): SourceMark => {
		const found = findRecordByJob(registry, job);
		if (!found) return {};
		if (found.record.kind === "git") {
			return { source: found.source, ref: found.record.ref, sha: found.record.sha };
		}
		const record: PathSourceRecord = found.record;
		return {
			source: found.source,
			path: record.path,
			sourceState: sourceStateOf(paths, found.source, record),
		};
	};
	const live = await findLiveDaemon(paths);
	const daemon = live
		? ((await callJobRoute(CHAT_JOBS_PATH, "GET")) as { jobs: ServiceStatus[] })
				.jobs
		: undefined;
	const daemonUrl = live ? `http://127.0.0.1:${live.port}` : null;
	const continuous = tableEntries(config).filter(([, raw]) => {
		const mode = modeOf(raw);
		return mode !== "every" && mode !== "schedule";
	});
	const rows = continuous.map(([name, raw]): Row => {
		const entry = isRecord(raw) ? raw : {};
		const known = daemon?.find((row) => row.label === name);
		return {
			...markOf(name),
			name,
			mode: modeOf(raw),
			enabled: entry.enabled === true,
			state: daemon ? (known?.state ?? "stopped") : "daemon not running",
			pid: known?.pid ?? null,
			restarts: known?.restarts ?? 0,
			logFile: known?.logFile ?? jobLogFile(paths.logDir, name),
			stateDir: stateDirOf(paths, name),
			cwd: typeof entry.cwd === "string" ? entry.cwd : null,
			daemonUrl,
			grantFile: grantFileOf(paths, entry.grant),
		};
	});
	const scheduled = (await listScheduled()).map((row) => ({ ...row, ...markOf(row.name) }));
	return { rows, scheduled };
}

function sourceText(row: SourceMark): string {
	if (row.source === undefined) return "";
	if (row.path !== undefined) return `${row.source} (${row.path})`;
	return row.sha === undefined ? "" : `${row.source}@${row.sha.slice(0, 12)}`;
}

function sourceStateText(name: string, row: SourceMark): string {
	if (row.sourceState === "changed") return `source changed — run dg job update ${name}`;
	if (row.sourceState === "missing") return `source missing: ${row.path}`;
	return row.sourceState === "invalid" ? `source invalid: ${row.path}` : "";
}

function rowLine(row: Row): string {
	return [
		row.name,
		row.mode,
		row.enabled ? "enabled" : "disabled",
		row.state,
		row.pid === null ? "" : `pid ${row.pid}`,
		`restarts ${row.restarts}`,
		sourceText(row),
		sourceStateText(row.name as string, row),
	]
		.filter((part) => part !== "")
		.join("  ");
}

function scheduledLine(row: ScheduledRow & SourceMark): string {
	return [
		row.name,
		row.renamedFrom ? `was "${row.renamedFrom}"` : "",
		row.mode === "schedule" ? `cron "${row.schedule}"` : `every ${row.schedule}`,
		row.enabled ? "enabled" : "disabled",
		`last ${row.lastRunAt ?? "never"}`,
		`next ${row.nextRunAt ?? "-"}`,
		row.invalid ? `invalid: ${row.invalid}` : "",
		sourceText(row),
		sourceStateText(row.name, row),
	]
		.filter((part) => part !== "")
		.join("  ");
}

async function listVerb(
	name: string | undefined,
	options: { json?: boolean },
): Promise<void> {
	const paths = resolveDgPaths();
	const all = await collectRows(paths);
	const rows = all.rows.filter((row) => name === undefined || row.name === name);
	const scheduled = all.scheduled.filter(
		(row) => name === undefined || row.name === name,
	);
	if (name !== undefined && rows.length + scheduled.length === 0) {
		notFound(name);
	}
	if (options.json) {
		console.log(JSON.stringify({ jobs: [...rows, ...scheduled] }));
		return;
	}
	if (rows.length + scheduled.length === 0) {
		console.log("no jobs — add one with `dg job add`");
		return;
	}
	for (const row of rows) console.log(rowLine(row));
	for (const row of scheduled) console.log(scheduledLine(row));
}

async function startVerb(name: string): Promise<void> {
	const paths = resolveDgPaths();
	const kind = await locate(paths, name, { migrate: false, scheduled: true });
	if (kind === "scheduled") {
		const status = await runScheduledNow(name);
		console.log(`${status.label}  ${status.state}`);
		return;
	}
	console.log(
		formatStatus(
			(await callJobRoute(jobPath(name, "start"), "POST")) as ServiceStatus,
		),
	);
}

async function stopVerb(name: string): Promise<void> {
	await locate(resolveDgPaths(), name, { migrate: false, scheduled: false });
	console.log(
		formatStatus(
			(await callJobRoute(jobPath(name, "stop"), "POST")) as ServiceStatus,
		),
	);
}

async function restartVerb(name: string): Promise<void> {
	await locate(resolveDgPaths(), name, { migrate: false, scheduled: false });
	await callJobRoute(jobPath(name, "stop"), "POST");
	console.log(
		formatStatus(
			(await callJobRoute(jobPath(name, "start"), "POST")) as ServiceStatus,
		),
	);
}

async function offerLoginUnit(paths: Paths, deps: JobVerbDeps): Promise<void> {
	if (autostartManages(deps.autostart, paths, "dg-daemon")) return;
	if (!deps.isTerminal()) {
		console.error(LOGIN_HINT);
		return;
	}
	if (readConfig(paths).loginUnitAsked === true) return;
	if (await deps.confirm(LOGIN_QUESTION)) {
		try {
			assertNotBlocked(paths, "daemon");
			const { installDaemonAutostart } = await import("./autostart");
			const { kind } = await installDaemonAutostart(deps.autostart, paths);
			console.log(`autostart installed (${kind}): dg-daemon starts at login`);
		} catch (err) {
			console.error(`warning: ${describeError(err)}`);
			return;
		}
	}
	try {
		writeConfig(paths, { loginUnitAsked: true });
	} catch (err) {
		console.error(`warning: could not record the answer: ${describeError(err)}`);
	}
}

function listedCredentials(paths: Paths, name: string): string[] {
	if (!existsSync(paths.daemonConfigPath)) return [];
	const config = readTable(paths);
	if (!isInTable(config, name)) return [];
	const entry = (config[JOBS_CONFIG_KEY] as Record<string, unknown>)[name];
	const listed = isRecord(entry) ? entry.credentials : undefined;
	return Array.isArray(listed) ? listed.filter((item) => typeof item === "string") : [];
}

async function startAndReport(paths: Paths, name: string, deps: JobVerbDeps): Promise<void> {
	if (!(await findLiveDaemon(paths))) {
		try {
			await startDaemon(paths, { autostart: deps.autostart });
		} catch (err) {
			if (err instanceof DgCliError) throw err;
			fail(describeError(err));
		}
	}
	const rowOf = async () =>
		(await liveJobRows(paths))?.find((row) => row.label === name);
	let status = await rowOf();
	if (status?.state === "stopped") {
		try {
			status = (await callJobRoute(jobPath(name, "start"), "POST")) as ServiceStatus;
		} catch (err) {
			if (!(err instanceof DaemonCallError && err.status === 409)) throw err;
			status = await rowOf();
		}
	}
	if (!status) return fail(`job "${name}" is not loaded by the daemon — see the daemon log`);
	console.log(formatStatus(status));
}

async function enableVerb(
	name: string,
	options: { setup?: string },
	deps: JobVerbDeps,
	setupDeps: () => Promise<JobSetupDeps>,
): Promise<void> {
	if (options.setup !== undefined && options.setup.trimStart().startsWith("{")) {
		fail("--setup takes a file path or -");
	}
	const paths = resolveDgPaths();
	if (listedCredentials(paths, name).length > 0) {
		const { runEnableWizard } = await import("./job-setup");
		await runEnableWizard(paths, name, { setup: options.setup }, await setupDeps());
		console.log(`enabled job "${name}"`);
		await offerLoginUnit(paths, deps);
		await startAndReport(paths, name, deps);
		return;
	}
	await locate(paths, name, { migrate: true, scheduled: false });
	if (options.setup !== undefined) {
		fail(`job enable: job "${name}" lists no credential, so --setup has nothing to answer`);
	}
	await assertDaemonAnswers(paths, name, "job");
	await withConfigLock(paths, () => {
		const config = readTable(paths);
		requireMigrated(config);
		const entry = tableEntry(paths, config, name);
		if (entry.enabled !== true) {
			guardConfig(() => writeJobEntry(paths, name, { ...entry, enabled: true }));
		}
	});
	console.log(`enabled job "${name}"`);
	await offerLoginUnit(paths, deps);
	await startAndReport(paths, name, deps);
}

async function disableVerb(name: string): Promise<void> {
	const paths = resolveDgPaths();
	const kind = await locate(paths, name, { migrate: true, scheduled: false });
	const live = await assertDaemonAnswers(paths, name, "job");
	if (kind === "scheduled") {
		await setScheduledEnabled(name, false);
	} else {
		await withConfigLock(paths, () => {
			const config = readTable(paths);
			requireMigrated(config);
			const entry = tableEntry(paths, config, name);
			if (Object.hasOwn(entry, "enabled")) {
				const rest = Object.fromEntries(
					Object.entries(entry).filter(([key]) => key !== "enabled"),
				);
				guardConfig(() => writeJobEntry(paths, name, rest));
			}
		});
	}
	console.log(`disabled job "${name}"`);
	if (!live) return;
	const states = await liveJobStates(paths);
	if (isActive(states?.get(name))) {
		console.log(
			formatStatus(
				(await callJobRoute(jobPath(name, "stop"), "POST")) as ServiceStatus,
			),
		);
	}
}

async function dropRecord(paths: Paths, name: string): Promise<void> {
	if (!existsSync(paths.jobSourcesPath)) return;
	const { removeJobFromSource } = await import("./job-source");
	guardConfig(() => removeJobFromSource(paths, name));
}

async function dropCommandRecord(paths: Paths, name: string): Promise<void> {
	await withConfigLock(paths, () => dropRecord(paths, name));
}

async function removeVerb(name: string): Promise<void> {
	const paths = resolveDgPaths();
	const found = await recordOf(paths, name);
	let kind: "table" | "scheduled" = "table";
	if (found) {
		if (existsSync(paths.daemonConfigPath)) await ensureMigrated(paths);
	} else {
		kind = await locate(paths, name, { migrate: true, scheduled: true });
	}
	const live = await assertDaemonAnswers(paths, name, "job");
	if (live) {
		const state = (await liveJobStates(paths))?.get(name);
		if (isActive(state)) {
			fail(`job "${name}" is ${state} — stop it first with dg job stop ${name}`);
		}
	}
	if (kind === "scheduled") {
		await dropCommandRecord(paths, name);
		await removeScheduled(name);
		console.log(`removed job "${name}"`);
		return;
	}
	let listsCredentials = false;
	await withConfigLock(paths, async () => {
		const config = readTable(paths);
		requireMigrated(config);
		if (!found && !isInTable(config, name)) notFound(name);
		assertNoLiveInstance(paths, name, "job");
		if (isInTable(config, name)) {
			const entry = tableEntry(paths, config, name);
			listsCredentials =
				Array.isArray(entry.credentials) && entry.credentials.length > 0;
			guardConfig(() => writeJobEntry(paths, name, undefined));
		}
		await dropRecord(paths, name);
	});
	console.log(`removed job "${name}"`);
	if (!found) {
		if (listsCredentials) console.log(`kept credentials below ${name}/`);
		return;
	}
	console.log(`kept state: ${stateDirOf(paths, name)}`);
	if (listsCredentials) console.log(`kept credentials below ${found.source}/`);
}

type UpdateOptions = {
	continuous?: boolean;
	schedule?: string;
	every?: string;
	timeout?: string;
	feed?: boolean;
	notify?: string;
	yes?: boolean;
	credential?: string[];
};

const UPDATE_FLAG_KEYS = [
	"continuous",
	"schedule",
	"every",
	"timeout",
	"feed",
	"notify",
	"credential",
];

async function updateVerb(
	name: string,
	options: UpdateOptions,
	command: Command,
	sourceDeps: () => JobSourceDeps,
): Promise<void> {
	const stop = (message: string): never => fail(`job update: ${message}`);
	const record = (await recordOf(resolveDgPaths(), name))?.record;
	const folder = record?.kind === "path" && record.declarationHash !== undefined;
	if (record && (record.kind === "git" || folder)) {
		if (UPDATE_FLAG_KEYS.some((key) => command.getOptionValueSource(key) === "cli")) {
			stop(
				`the ${record.kind === "git" ? "repository" : "folder"} declares this in its "dg" block`,
			);
		}
		if (record.kind === "git") {
			const { updateSource } = await import("./job-update");
			await updateSource(name, { yes: options.yes }, sourceDeps());
		} else {
			const { updateLocal } = await import("./job-local");
			await updateLocal(name, sourceDeps());
		}
		return;
	}
	const modes: [Mode, unknown][] = [
		["continuous", options.continuous ? true : undefined],
		["schedule", options.schedule],
		["every", options.every],
	];
	const given = modes.filter(([, value]) => value !== undefined);
	if (given.length > 1) stop("give one of --continuous, --schedule or --every");
	const credentials =
		options.credential === undefined
			? undefined
			: (await import("./job-source")).credentialListFor(options.credential, name);
	const changes: [string, unknown][] = [
		...given,
		["feed", options.feed ? true : undefined],
		["notify", options.notify],
		[
			"timeoutMs",
			options.timeout === undefined
				? undefined
				: duration(options.timeout, "--timeout", "job update"),
		],
	].filter(([, value]) => value !== undefined) as [string, unknown][];
	const paths = resolveDgPaths();
	if (existsSync(paths.daemonConfigPath)) await ensureMigrated(paths);
	if (!isInTable(readTable(paths), name)) {
		notFound(name);
	}
	if (changes.length === 0 && credentials === undefined) {
		if (options.yes === true) {
			console.log("nothing to change");
			return;
		}
		stop("give a flag to change");
	}
	await withConfigLock(paths, async () => {
		const config = readTable(paths);
		requireMigrated(config);
		const entry = tableEntry(paths, config, name);
		const base =
			given.length === 0
				? entry
				: Object.fromEntries(
						Object.entries(entry).filter(
							([key]) => !(MODE_KEYS as readonly string[]).includes(key),
						),
					);
		const listed = Array.isArray(entry.credentials) ? (entry.credentials as string[]) : [];
		if (credentials !== undefined) {
			if (typeof entry.grant === "string" && entry.grant !== name) {
				stop(`the job uses the credential prefix "${entry.grant}", not its own name`);
			}
			const { assertPrefixFree } = await import("./job-source");
			const { readNamedSources } = await import("../jobs/sources");
			const others = Object.fromEntries(
				Object.entries(config[JOBS_CONFIG_KEY] as Record<string, unknown>).filter(([key]) => key !== name),
			);
			assertPrefixFree(
				name,
				{ ...config, [JOBS_CONFIG_KEY]: others },
				Object.fromEntries(
					Object.entries(guardConfig(() => readNamedSources(paths))).filter(
						([key, source]) => !(key === name && source.kind === "path"),
					),
				),
				"job update:",
			);
		}
		const known = isRecord(entry.credentialEnv) ? (entry.credentialEnv as Record<string, string>) : {};
		const bound = { ...known, ...credentials?.credentialEnv };
		for (const [variable, credential] of Object.entries(credentials?.credentialEnv ?? {})) {
			if (Object.hasOwn(known, variable) && known[variable] !== credential) {
				stop(`environment variable ${JSON.stringify(variable)} is bound to two credentials`);
			}
		}
		const next = {
			...base,
			...Object.fromEntries(changes),
			...(Object.keys(bound).length === 0 ? {} : { credentialEnv: bound }),
			...(credentials?.credentials === undefined
				? {}
				: {
						credentials: [
							...listed,
							...credentials.credentials.filter((item) => !listed.includes(item)),
						],
						grant: entry.grant ?? credentials.grant,
					}),
		};
		const parsed = parseJobEntry(name, next);
		if (!parsed.ok) stop(parsed.error);
		guardConfig(() => writeJobEntry(paths, name, next));
	});
	console.log(`updated job "${name}"`);
	console.log(
		`changed ${[...changes.map(([key]) => key), ...(credentials === undefined ? [] : ["credentials"])].join(", ")}`,
	);
	if (credentials !== undefined) console.log(`next: dg job setup ${name}`);
	const states = await liveJobStates(paths).catch(() => undefined);
	if (isActive(states?.get(name))) {
		console.log(`next: dg job restart ${name}`);
	}
}

async function logsVerb(
	name: string,
	options: { lines?: string; follow?: boolean },
): Promise<void> {
	const paths = resolveDgPaths();
	await locate(paths, name, { migrate: false, scheduled: false });
	const { runJobLogs } = await import("./job-logs");
	await runJobLogs(paths, name, options);
}

const SOURCE_OPTION_KEYS = [
	"continuous",
	"schedule",
	"cron",
	"every",
	"timeout",
	"feed",
	"notify",
	"cwd",
	"env",
	"envFile",
	"passEnv",
	"stopTimeout",
	"credential",
];

function positionalSource(
	argv: string[],
	command: Command,
): { argument: string; rest: string[] } | undefined {
	let root = command;
	while (root.parent) root = root.parent;
	const { rawArgs } = root as Command & { rawArgs: string[] };
	const dash = rawArgs.indexOf("--");
	const afterDash = dash < 0 ? 0 : rawArgs.length - dash - 1;
	return argv.length - afterDash === 1
		? { argument: argv[0], rest: argv.slice(1) }
		: undefined;
}

export function registerJobCommands(
	program: Command,
	given: Partial<JobSourceDeps & JobSetupDeps> = {},
): void {
	const deps = (): JobVerbDeps => ({ ...defaultJobVerbDeps(), ...given });
	const setupDeps = async (): Promise<JobSetupDeps> => ({
		...(await import("./job-setup")).defaultJobSetupDeps(),
		...given,
	});
	const job = program
		.command("job")
		.description("run and manage the jobs the daemon runs")
		.hook("preAction", async () => {
			console.error(await homeLine());
		});

	job
		.command("add")
		.description(
			"add a job from a repository URL, a local file or folder, or a command: " +
				"continuous, on a cron schedule, or at an interval",
		)
		.option("--name <name>", "unique name for the job")
		.addOption(new Option("--label <name>").hideHelp())
		.option("--cwd <path>", "working directory for the command")
		.option("--continuous", "keep the job running")
		.option("--schedule <cron>", 'a cron expression, e.g. "0 9 * * 1-5"')
		.addOption(new Option("--cron <cron>").hideHelp())
		.option("--every <duration>", "how often to run it, e.g. 15m")
		.option("--timeout <duration>", "stop a run that takes longer, e.g. 5m")
		.option("--feed", "read one JSON object per item from the output")
		.option("--notify <identity>", "agent identity to queue new items to")
		.option("--env-file <path>", "env file to load")
		.option(
			"--env <NAME>",
			"environment variable to pass through (repeatable)",
			collect,
		)
		.addOption(new Option("--pass-env <NAME>").argParser(collect).hideHelp())
		.option("--stop-timeout <duration>", "grace period on stop, e.g. 30s")
		.option("--yes", "approve the jobs of a repository without asking")
		.option(
			"--credential <name[=ENV_NAME]>",
			"credential the job needs, with an optional variable name for its value (repeatable)",
			collect,
		)
		.argument("[command...]", "the command to run, after a bare --")
		.action(async (argv: string[], options: AddOptions, command: Command) => {
			const source = positionalSource(argv, command);
			if (!source) {
				await addVerb(argv, options, deps());
				return;
			}
			const { addSource, classifySource, defaultJobSourceDeps } = await import("./job-source");
			const flags = SOURCE_OPTION_KEYS.filter(
				(key) => command.getOptionValueSource(key) === "cli",
			);
			const sourceDeps = { ...defaultJobSourceDeps(), ...given };
			if (classifySource(source.argument) === "path") {
				const { addLocal } = await import("./job-local");
				await addLocal(source.argument, source.rest, flags, options, sourceDeps);
				return;
			}
			await addSource(source.argument, source.rest, flags, options, sourceDeps);
		});

	job
		.command("list")
		.description("show every job")
		.option("--json", "print one JSON line")
		.action((options: { json?: boolean }) => listVerb(undefined, options));

	job
		.command("status")
		.description("show every job, or one by name")
		.argument("[name]")
		.option("--json", "print one JSON line")
		.action(listVerb);

	job
		.command("enable")
		.description("start the job now and at each daemon start")
		.argument("<name>")
		.option("--setup <file>", "answers for the credentials: a file path, or - for stdin")
		.action((name: string, options: { setup?: string }) =>
			enableVerb(name, options, deps(), setupDeps),
		);

	job
		.command("setup")
		.description("store the credentials of a job, or fetch them again")
		.argument("<name>")
		.option("--refresh", "fetch each credential that has a source again")
		.option("--rotate-token", "make a new token for the credential prefix of the job")
		.action(async (name: string, options: { refresh?: boolean; rotateToken?: boolean }) => {
			const { runSetup } = await import("./job-setup");
			await runSetup(resolveDgPaths(), name, options, await setupDeps());
		});

	job
		.command("disable")
		.description("stop the job and keep it from starting at daemon start")
		.argument("<name>")
		.action(disableVerb);

	job
		.command("start")
		.description("run the job now")
		.argument("<name>")
		.action(startVerb);

	for (const alias of ["run", "exec"]) {
		job
			.command(alias, { hidden: true })
			.argument("<name>")
			.action(async (name: string) => {
				aliasNote(`job ${alias}`, "job start");
				await startVerb(name);
			});
	}

	job
		.command("stop")
		.description("stop the job now")
		.argument("<name>")
		.action(stopVerb);

	job
		.command("restart")
		.description("stop the job, then start it again")
		.argument("<name>")
		.action(restartVerb);

	job
		.command("update")
		.description("change the mode or the settings of a job")
		.argument("<name>")
		.option("--continuous", "keep the job running")
		.option("--schedule <cron>", "a cron expression")
		.option("--every <duration>", "how often to run it, e.g. 15m")
		.option("--timeout <duration>", "stop a run that takes longer")
		.option("--feed", "read one JSON object per item from the output")
		.option("--notify <identity>", "agent identity to queue new items to")
		.option("--yes", "approve a repository update without asking")
		.option(
			"--credential <name[=ENV_NAME]>",
			"add a credential the job needs, with an optional variable name for its value (repeatable)",
			collect,
		)
		.action(async (name: string, options: UpdateOptions, command: Command) => {
			const { defaultJobSourceDeps } = await import("./job-source");
			await updateVerb(name, options, command, () => ({ ...defaultJobSourceDeps(), ...given }));
		});

	job
		.command("remove")
		.description("remove a job")
		.argument("<name>")
		.action(removeVerb);

	job
		.command("rm", { hidden: true })
		.argument("<name>")
		.action(async (name: string) => {
			aliasNote("job rm", "job remove");
			await removeVerb(name);
		});

	job
		.command("logs")
		.description("print the last lines of the job log")
		.argument("<name>")
		.option("-n, --lines <n>", "how many lines to print", "40")
		.option("-f, --follow", "keep printing new lines")
		.action(logsVerb);
}
