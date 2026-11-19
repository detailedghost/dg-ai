import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import {
	CHAT_SERVICES_PATH,
	DgCliError,
	describeError,
	EXIT_GENERAL_FAILURE,
	isRecord,
	OWNER_TOKEN_HEADER,
	parseEvery,
	wait,
} from "@dg/common";
import {
	checkExecutableResolves,
	isAlive,
	isDaemonLive,
	isSignalablePid,
	loopbackHostHeader,
	readOwnerToken,
	readPidFile,
	resolveDgPaths,
	withInstallLock,
} from "@dg/common/node";
import type { Command } from "commander";
import {
	isContinuousEntry,
	JOBS_CONFIG_KEY,
	parseJobEntry,
} from "../jobs/config";
import { isMigrated } from "../jobs/migrate";
import { readConfigStrict, writeJobEntry } from "../server/config-store";
import { DG_DAEMON_PACKAGE_VERSION } from "../server/status";
import { type ServiceStatus, servicePidFile } from "../services/supervisor";
import { type DaemonStartSeams, startDaemon } from "./start";

const MARK_POLL_MS = 100;
const LIVE_DAEMON_MARK_WAIT_MS = 10_000;
const STARTED_DAEMON_MARK_WAIT_MS = 2_000;
const NOT_MIGRATED =
	"the daemon config is not migrated — run dg daemon start, then run this command again";
const RENAME_NOTE =
	'note: "dg-daemon service" is now "dg job"; this form goes away in the next major release';

export function withConfigLock<T>(
	paths: ReturnType<typeof resolveDgPaths>,
	fn: () => T | Promise<T>,
): Promise<T> {
	return withInstallLock(dirname(paths.daemonConfigPath), fn);
}

function requireMigrated(config: Record<string, unknown>): void {
	if (!isMigrated(config)) {
		throw new DgCliError(NOT_MIGRATED, EXIT_GENERAL_FAILURE);
	}
}

async function waitForMark(
	paths: ReturnType<typeof resolveDgPaths>,
	waitMs: number,
): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (isMigrated(guardConfig(() => readConfigStrict(paths)))) return true;
		if (Date.now() >= deadline) return false;
		await wait(MARK_POLL_MS);
	}
}

/** Runs before the config lock: the daemon needs that lock to write the mark. */
export async function ensureMigrated(
	paths: ReturnType<typeof resolveDgPaths>,
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
	} catch {
		throw new DgCliError(NOT_MIGRATED, EXIT_GENERAL_FAILURE);
	}
	if (!(await waitForMark(paths, STARTED_DAEMON_MARK_WAIT_MS))) {
		throw markMissing(started.handle);
	}
}

function markMissing(handle: { pid: number; versions: { package: string } }) {
	if (handle.versions.package === DG_DAEMON_PACKAGE_VERSION) {
		return new DgCliError(
			`the daemon config is not migrated — the dg-daemon (pid ${handle.pid}) did not write the mark; see the daemon log`,
			EXIT_GENERAL_FAILURE,
		);
	}
	return new DgCliError(
		`the daemon config is not migrated — a dg-daemon from before this release runs (pid ${handle.pid}); run dg daemon restart, then run this command again`,
		EXIT_GENERAL_FAILURE,
	);
}

function readInstancePid(file: string): number | undefined {
	try {
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		return isSignalablePid(pid) && isAlive(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

async function findLiveDaemon(
	paths: ReturnType<typeof resolveDgPaths>,
): Promise<ReturnType<typeof readPidFile>> {
	const handle = readPidFile(paths);
	return handle && (await isDaemonLive(handle)) ? handle : undefined;
}

async function callDaemon(
	path: string,
	method: "GET" | "POST",
): Promise<unknown> {
	const paths = resolveDgPaths();
	const handle = await findLiveDaemon(paths);
	if (!handle) {
		throw new DgCliError(
			"no live dg-daemon — services run inside it, so start it with dg-daemon start",
			EXIT_GENERAL_FAILURE,
		);
	}
	const owner = readOwnerToken(paths);
	const resp = await fetch(`http://127.0.0.1:${handle.port}${path}`, {
		method,
		headers: {
			...loopbackHostHeader(handle.port),
			...(owner === undefined ? {} : { [OWNER_TOKEN_HEADER]: owner }),
		},
	});
	if (!resp.ok)
		throw new DgCliError((await resp.text()).trim(), EXIT_GENERAL_FAILURE);
	return resp.json();
}

function isInTable(config: Record<string, unknown>, name: string): boolean {
	const table = config[JOBS_CONFIG_KEY];
	return isRecord(table) && Object.hasOwn(table, name);
}

function isDeclared(config: Record<string, unknown>, name: string): boolean {
	const table = config[JOBS_CONFIG_KEY];
	return (
		isRecord(table) &&
		Object.hasOwn(table, name) &&
		isContinuousEntry(table[name])
	);
}

function resolveExecutable(command: string): string {
	const fail = (message: string): never => {
		throw new DgCliError(message, EXIT_GENERAL_FAILURE);
	};
	if (command.includes(sep)) {
		const executable = resolve(command);
		if (!existsSync(executable) || !statSync(executable).isFile()) {
			fail(`service add: executable not found: ${executable}`);
		}
		if (checkExecutableResolves(executable)) {
			fail(`service add: file is not executable: ${executable}`);
		}
		return executable;
	}
	const problem = checkExecutableResolves(command);
	if (problem) fail(`service add: ${problem}`);
	return (
		Bun.which(command) ??
		fail(`service add: executable "${command}" does not resolve on PATH`)
	);
}

function nextStepLine(
	live: boolean,
	autostart: boolean,
	label: string,
): string {
	if (live) return `next: dg-daemon service start ${label}`;
	if (autostart) return "next: dg-daemon start";
	return `next: dg-daemon start, then dg-daemon service start ${label}`;
}

function guardConfig<T>(run: () => T): T {
	try {
		return run();
	} catch (err) {
		if (err instanceof DgCliError) throw err;
		throw new DgCliError(describeError(err), EXIT_GENERAL_FAILURE);
	}
}

function formatStatus(service: ServiceStatus): string {
	const parts = [
		service.label,
		service.state,
		service.pid === null ? "" : `pid ${service.pid}`,
		`restarts ${service.restarts}`,
		service.lastExit ? `last ${service.lastExit}` : "",
		`log ${service.logFile}`,
		service.error ?? "",
	];
	return parts.filter((part) => part.length > 0).join("  ");
}

const servicePath = (label: string, verb?: "start" | "stop") =>
	[CHAT_SERVICES_PATH, encodeURIComponent(label), verb]
		.filter((segment) => segment !== undefined)
		.join("/");

export function registerServiceCommands(program: Command): void {
	const service = program
		.command("service")
		.description(
			"run the long-lived scripts declared under `services` in the daemon config",
		)
		.hook("preAction", () => {
			console.error(RENAME_NOTE);
		});

	service
		.command("add")
		.description("declare a service in the daemon config")
		.argument("<label>")
		.argument("[command...]", "the command to run, after a bare --")
		.requiredOption("--cwd <path>", "working directory for the service")
		.option("--autostart", "start it when the daemon starts")
		.option("--env-file <path>", "env file to load")
		.option(
			"--pass-env <NAME>",
			"environment variable to pass through (repeatable)",
			(value: string, previous: string[] = []) => [...previous, value],
		)
		.option("--stop-timeout <duration>", "grace period on stop, e.g. 30s")
		.option("--grant <prefix>", "credential grant prefix")
		.action(
			async (
				label: string,
				argv: string[],
				options: {
					cwd: string;
					autostart?: boolean;
					envFile?: string;
					passEnv?: string[];
					stopTimeout?: string;
					grant?: string;
				},
			) => {
				const fail = (message: string): never => {
					throw new DgCliError(message, EXIT_GENERAL_FAILURE);
				};
				if (argv.length === 0) {
					fail("service add: no command given — put it after a bare --");
				}
				const paths = resolveDgPaths();
				const cwd = resolve(options.cwd);
				if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
					fail(`--cwd: no such directory: ${options.cwd}`);
				}
				const stopTimeoutMs =
					options.stopTimeout === undefined
						? undefined
						: parseEvery(options.stopTimeout, "--stop-timeout");
				const [command, ...rest] = argv;
				const executable = resolveExecutable(command);
				const entry = {
					argv: [executable, ...rest],
					cwd,
					continuous: true,
					...(options.autostart ? { enabled: true } : {}),
					...(options.envFile === undefined
						? {}
						: { envFile: resolve(options.envFile) }),
					...(options.passEnv === undefined
						? {}
						: { passEnv: options.passEnv }),
					...(stopTimeoutMs === undefined ? {} : { stopTimeoutMs }),
					...(options.grant === undefined ? {} : { grant: options.grant }),
				};
				const parsed = parseJobEntry(label, entry);
				if (!parsed.ok) fail(`service add: ${parsed.error}`);
				await ensureMigrated(paths);
				await withConfigLock(paths, () => {
					const config = guardConfig(() => readConfigStrict(paths));
					requireMigrated(config);
					if (isInTable(config, label)) {
						fail(`a service labelled "${label}" already exists`);
					}
					guardConfig(() => writeJobEntry(paths, label, entry));
				});
				console.log(`added service "${label}"`);
				console.log(
					nextStepLine(
						Boolean(await findLiveDaemon(paths)),
						Boolean(options.autostart),
						label,
					),
				);
			},
		);

	service
		.command("rm")
		.description("remove a service declaration")
		.argument("<label>")
		.action(async (label: string) => {
			const paths = resolveDgPaths();
			const requireDeclared = () => {
				const config = guardConfig(() => readConfigStrict(paths));
				requireMigrated(config);
				if (!isDeclared(config, label)) {
					throw new DgCliError(
						`no service labelled "${label}"`,
						EXIT_GENERAL_FAILURE,
					);
				}
			};
			if (!existsSync(paths.daemonConfigPath)) {
				throw new DgCliError(
					`no service labelled "${label}"`,
					EXIT_GENERAL_FAILURE,
				);
			}
			await ensureMigrated(paths);
			requireDeclared();
			const pidHandle = readPidFile(paths);
			const live = await findLiveDaemon(paths);
			if (!live && pidHandle && isAlive(pidHandle.pid)) {
				throw new DgCliError(
					`dg-daemon (pid ${pidHandle.pid}) does not answer, so the state of service "${label}" is unknown — run dg-daemon stop --force first`,
					EXIT_GENERAL_FAILURE,
				);
			}
			if (live) {
				const { services } = (await callDaemon(CHAT_SERVICES_PATH, "GET")) as {
					services: ServiceStatus[];
				};
				const state = services.find((entry) => entry.label === label)?.state;
				if (state === "running" || state === "backoff") {
					throw new DgCliError(
						`service "${label}" is ${state} — stop it first with dg-daemon service stop ${label}`,
						EXIT_GENERAL_FAILURE,
					);
				}
			}
			await withConfigLock(paths, () => {
				requireDeclared();
				const instance = servicePidFile(paths.daemonDir, label);
				const instancePid = readInstancePid(instance);
				if (instancePid !== undefined) {
					throw new DgCliError(
						`service "${label}" still runs as pid ${instancePid} — stop it, or delete ${instance} if that pid is not the service`,
						EXIT_GENERAL_FAILURE,
					);
				}
				guardConfig(() => writeJobEntry(paths, label, undefined));
			});
			console.log(`removed service "${label}"`);
		});

	service
		.command("status")
		.description("show every declared service, or one by label")
		.argument("[label]")
		.option("--json", "print one JSON line")
		.action(async (label: string | undefined, options: { json?: boolean }) => {
			const { services } = (await callDaemon(CHAT_SERVICES_PATH, "GET")) as {
				services: ServiceStatus[];
			};
			const shown = services.filter((entry) => !label || entry.label === label);
			if (label && shown.length === 0) {
				throw new DgCliError(
					`no service labelled "${label}"`,
					EXIT_GENERAL_FAILURE,
				);
			}
			if (options.json) {
				console.log(JSON.stringify({ services: shown }));
				return;
			}
			if (shown.length === 0) {
				throw new DgCliError("no services declared", EXIT_GENERAL_FAILURE);
			}
			for (const entry of shown) console.log(formatStatus(entry));
		});

	for (const verb of ["start", "stop"] as const) {
		service
			.command(verb)
			.description(`${verb} a declared service`)
			.argument("<label>")
			.action(async (label: string) => {
				const status = (await callDaemon(
					servicePath(label, verb),
					"POST",
				)) as ServiceStatus;
				console.log(formatStatus(status));
			});
	}
}
