import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
	type AutostartDeps,
	checkExecutableResolves,
	defaultAutostartDeps,
	isAlive,
	isDaemonLive,
	isSignalablePid,
	loopbackHostHeader,
	readLine,
	readOwnerToken,
	readPidFile,
	type DgPaths,
	resolveDgPaths,
	withInstallLock,
} from "@dg/common/node";
import {
	CHAT_JOBS_PATH,
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	isRecord,
	OWNER_TOKEN_HEADER,
	wait,
} from "@dg/common";
import { isContinuousEntry, JOBS_CONFIG_KEY } from "../jobs/config";
import { isMigrated } from "../jobs/migrate";
import { readConfigStrict } from "../server/config-store";
import { DG_DAEMON_PACKAGE_VERSION } from "../server/status";
import { type ServiceStatus, servicePidFile } from "../services/supervisor";
import { type DaemonStartSeams, startDaemon } from "./start";

const MARK_POLL_MS = 100;
const LIVE_DAEMON_MARK_WAIT_MS = 10_000;
const STARTED_DAEMON_MARK_WAIT_MS = 2_000;
const NOT_MIGRATED =
	"the daemon config is not migrated — run dg daemon start, then run this command again";

const NO_DAEMON_TEXT =
	"no live dg daemon — jobs run inside it, so start it with dg daemon start";

export type JobVerbDeps = {
	confirm(question: string): Promise<boolean>;
	isTerminal(): boolean;
	which(name: string, env?: { PATH?: string; cwd?: string }): string | null;
	autostart: AutostartDeps;
};

export const defaultJobVerbDeps = (): JobVerbDeps => ({
	confirm: async (question) => {
		const line = await readLine(`${question} `);
		if (line === null) return false;
		const answer = line.trim().toLowerCase();
		return answer === "" || answer.startsWith("y");
	},
	isTerminal: () => Boolean(process.stdin.isTTY && process.stderr.isTTY),
	which: (name, env) => Bun.which(name, env),
	autostart: defaultAutostartDeps(),
});

export class DaemonCallError extends DgCliError {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message, EXIT_GENERAL_FAILURE);
	}
}

export function withConfigLock<T>(
	paths: DgPaths,
	fn: () => T | Promise<T>,
): Promise<T> {
	return withInstallLock(dirname(paths.daemonConfigPath), fn);
}

export function guardConfig<T>(run: () => T): T {
	try {
		return run();
	} catch (err) {
		if (err instanceof DgCliError) throw err;
		throw new DgCliError(describeError(err), EXIT_GENERAL_FAILURE);
	}
}

export function requireMigrated(config: Record<string, unknown>): void {
	if (!isMigrated(config)) {
		throw new DgCliError(NOT_MIGRATED, EXIT_GENERAL_FAILURE);
	}
}

async function waitForMark(paths: DgPaths, waitMs: number): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (isMigrated(guardConfig(() => readConfigStrict(paths)))) return true;
		if (Date.now() >= deadline) return false;
		await wait(MARK_POLL_MS);
	}
}

/** Runs before the config lock: the daemon needs that lock to write the mark. */
export async function ensureMigrated(
	paths: DgPaths,
	seams: DaemonStartSeams = {},
): Promise<void> {
	if (isMigrated(guardConfig(() => readConfigStrict(paths)))) return;
	const live = await findLiveDaemon(paths);
	if (live) {
		if (await waitForMark(paths, LIVE_DAEMON_MARK_WAIT_MS)) return;
		throw markMissing(live);
	}
	let started: Awaited<ReturnType<typeof startDaemon>>;
	try {
		started = await startDaemon(paths, seams);
	} catch (err) {
		throw new DgCliError(
			`${NOT_MIGRATED} (${describeError(err)})`,
			EXIT_GENERAL_FAILURE,
		);
	}
	if (!(await waitForMark(paths, STARTED_DAEMON_MARK_WAIT_MS))) {
		throw markMissing(started.handle);
	}
}

function markMissing(handle: { pid: number; versions: { package: string } }) {
	if (handle.versions.package === DG_DAEMON_PACKAGE_VERSION) {
		return new DgCliError(
			`the daemon config is not migrated — the dg daemon (pid ${handle.pid}) did not write the mark; see the daemon log`,
			EXIT_GENERAL_FAILURE,
		);
	}
	return new DgCliError(
		`the daemon config is not migrated — a dg daemon from before this release runs (pid ${handle.pid}); run dg daemon restart, then run this command again`,
		EXIT_GENERAL_FAILURE,
	);
}

export function readInstancePid(file: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		return isSignalablePid(pid) && isAlive(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

export async function findLiveDaemon(
	paths: DgPaths,
): Promise<ReturnType<typeof readPidFile>> {
	const handle = readPidFile(paths);
	return handle && (await isDaemonLive(handle)) ? handle : undefined;
}

export async function callDaemon(
	path: string,
	method: "GET" | "POST",
): Promise<unknown> {
	const paths = resolveDgPaths();
	const handle = await findLiveDaemon(paths);
	if (!handle) {
		throw new DgCliError(NO_DAEMON_TEXT, EXIT_GENERAL_FAILURE);
	}
	const owner = readOwnerToken(paths);
	const resp = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
		method,
		headers: {
			...loopbackHostHeader(handle.port),
			...(owner === undefined ? {} : { [OWNER_TOKEN_HEADER]: owner }),
		},
	});
	if (!resp.ok) {
		throw new DaemonCallError((await resp.text()).trim(), resp.status);
	}
	return resp.json();
}

export function isInTable(
	config: Record<string, unknown>,
	name: string,
): boolean {
	const table = config[JOBS_CONFIG_KEY];
	return isRecord(table) && Object.hasOwn(table, name);
}

export function isDeclared(
	config: Record<string, unknown>,
	name: string,
): boolean {
	const table = config[JOBS_CONFIG_KEY];
	return (
		isRecord(table) &&
		Object.hasOwn(table, name) &&
		isContinuousEntry(table[name])
	);
}

export function resolveExecutable(
	command: string,
	prefix: string,
	which: JobVerbDeps["which"] = Bun.which,
): string {
	const fail = (message: string): never => {
		throw new DgCliError(message, EXIT_GENERAL_FAILURE);
	};
	if (command.includes(sep)) {
		const executable = resolve(command);
		if (!existsSync(executable) || !statSync(executable).isFile()) {
			fail(`${prefix} executable not found: ${executable}`);
		}
		if (checkExecutableResolves(executable)) {
			fail(`${prefix} file is not executable: ${executable}`);
		}
		return executable;
	}
	const problem = checkExecutableResolves(command);
	if (problem) fail(`${prefix} ${problem}`);
	return (
		which(command) ??
		fail(`${prefix} executable "${command}" does not resolve on PATH`)
	);
}

export function formatStatus(
	service: ServiceStatus & { nextRunAt?: string | null },
): string {
	const parts = [
		service.label,
		service.state,
		service.pid === null ? "" : `pid ${service.pid}`,
		`restarts ${service.restarts}`,
		service.lastExit ? `last ${service.lastExit}` : "",
		`log ${service.logFile}`,
		service.nextRunAt ? `next ${service.nextRunAt}` : "",
		service.error ?? "",
	];
	return parts.filter((part) => part.length > 0).join("  ");
}

/** Refuses when a daemon pid is alive but silent; returns the live handle otherwise. */
export async function assertDaemonAnswers(
	paths: DgPaths,
	name: string,
): Promise<ReturnType<typeof readPidFile>> {
	const pidHandle = readPidFile(paths);
	const live = await findLiveDaemon(paths);
	if (!live && pidHandle && isAlive(pidHandle.pid)) {
		throw new DgCliError(
			`dg daemon (pid ${pidHandle.pid}) does not answer, so the state of job "${name}" is unknown — run dg daemon stop --force first`,
			EXIT_GENERAL_FAILURE,
		);
	}
	return live;
}

const OLDER_DAEMON =
	"this dg daemon is older than the CLI — run dg daemon restart";

/** A 404 whose body does not name a job means the daemon has no such route. */
export async function callJobRoute(
	path: string,
	method: "GET" | "POST",
): Promise<unknown> {
	try {
		return await callDaemon(path, method);
	} catch (err) {
		if (
			err instanceof DaemonCallError &&
			err.status === 404 &&
			!err.message.includes("no job named")
		) {
			throw new DgCliError(OLDER_DAEMON, EXIT_GENERAL_FAILURE);
		}
		throw err;
	}
}

export async function liveJobRows(
	paths: DgPaths,
): Promise<ServiceStatus[] | undefined> {
	if (!(await findLiveDaemon(paths))) return undefined;
	const body = (await callJobRoute(CHAT_JOBS_PATH, "GET")) as {
		jobs: ServiceStatus[];
	};
	return body.jobs;
}

export async function liveJobStates(
	paths: DgPaths,
): Promise<Map<string, ServiceStatus["state"]> | undefined> {
	const rows = await liveJobRows(paths);
	return rows && new Map(rows.map((row) => [row.label, row.state]));
}

export function assertNoLiveInstance(
	paths: DgPaths,
	name: string,
): void {
	const instance = servicePidFile(paths.daemonDir, name);
	const instancePid = readInstancePid(instance);
	if (instancePid !== undefined) {
		throw new DgCliError(
			`job "${name}" still runs as pid ${instancePid} — stop it, or delete ${instance} if that pid is not the job`,
			EXIT_GENERAL_FAILURE,
		);
	}
}
