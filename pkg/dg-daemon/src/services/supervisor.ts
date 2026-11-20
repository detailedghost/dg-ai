import {
	chmodSync,
	closeSync,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describeError } from "@dg/common";
import {
	checkExecutableResolves,
	credentialGrantTokenPath,
	type DgPaths,
	ensurePrivateDir,
	isAlive,
	jobStateDir,
	rotateLogIfLarge,
	writeFileAtomic,
} from "@dg/common/node";
import type { Subprocess } from "bun";
import { killProcessGroup } from "../dispatch/exec";
import {
	type JobDecl,
	type ParsedJob,
	parseContinuousJobs,
} from "../jobs/config";
import {
	jobLogFile,
	type LauncherDeps,
	launchJob,
	readBoundCredentials,
} from "../jobs/launcher";
import type { Logger } from "../server/log";
import { loadEnvFile } from "./env-file";

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const STABLE_RUN_MS = 60_000;
export const LOG_CHECK_MS = 30_000;
export const MAX_LOG_BYTES = 5_000_000;

export type ServiceState = "running" | "backoff" | "stopped" | "invalid";

export type ServiceStatus = {
	label: string;
	state: ServiceState;
	pid: number | null;
	restarts: number;
	startedAt: string | null;
	lastExit: string | null;
	logFile: string;
	error: string | null;
};

export type ServiceAction =
	| { ok: true; status: ServiceStatus }
	| { ok: false; kind: "unknown" | "invalid" | "conflict"; error: string };

export type Supervisor = {
	start(label: string): ServiceAction;
	stop(label: string): Promise<ServiceAction>;
	stopAll(): Promise<void>;
	autostart(): void;
	status(): ServiceStatus[];
	runningCount(): number;
};

export type SupervisorDeps = {
	paths: Pick<DgPaths, "daemonDir" | "logDir" | "grantsDir" | "jobStateRoot">;
	daemonUrl: () => string;
	loadConfig: () => Record<string, unknown>;
	logger: Pick<Logger, "info" | "warn">;
	readCredential: LauncherDeps["readCredential"];
	backoffMs?: (failures: number) => number;
	logCheckMs?: number;
	maxLogBytes?: number;
};

type LiveState = Exclude<ServiceState, "invalid">;

type Entry = {
	decl: JobDecl;
	state: LiveState;
	proc?: Subprocess;
	pid?: number;
	restarts: number;
	startedAt?: Date;
	lastExit?: string;
	termination?: Promise<void>;
	abort: AbortController;
	loop: Promise<void>;
};

export const exponentialBackoffMs = (failures: number): number =>
	Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);

function ensureRealPrivateDir(path: string): void {
	try {
		mkdirSync(path, { mode: 0o700 });
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			return ensureRealPrivateDir(path);
		}
		if (code !== "EEXIST") throw err;
		const found = lstatSync(path);
		if (found.isSymbolicLink()) throw new Error("it is a symbolic link");
		if (!found.isDirectory()) throw new Error("it is not a folder");
	}
	chmodSync(path, 0o700);
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

function describeExit(proc: Subprocess): string {
	return proc.signalCode
		? `killed by ${proc.signalCode}`
		: `exit ${proc.exitCode}`;
}

/** Pid file the supervisor writes for a running service. */
export function servicePidFile(daemonDir: string, label: string): string {
	return join(daemonDir, "services", `${label}.pid`);
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
	const { logger } = deps;
	const backoffMs = deps.backoffMs ?? exponentialBackoffMs;
	const logCheckMs = deps.logCheckMs ?? LOG_CHECK_MS;
	const maxLogBytes = deps.maxLogBytes ?? MAX_LOG_BYTES;
	const pidDir = join(deps.paths.daemonDir, "services");
	const entries = new Map<string, Entry>();

	const logFileFor = (label: string) => jobLogFile(deps.paths.logDir, label);
	const pidFileFor = (label: string) =>
		servicePidFile(deps.paths.daemonDir, label);

	const launcherDeps = {
		paths: deps.paths,
		daemonUrl: deps.daemonUrl,
		logger,
		maxLogBytes,
		readCredential: deps.readCredential,
	};

	async function runOnce(entry: Entry): Promise<number | undefined> {
		const { decl } = entry;
		let proc: Subprocess;
		entry.termination = undefined;
		try {
			proc = launchJob(decl, launcherDeps);
		} catch (err) {
			entry.lastExit = `failed to start: ${describeError(err)}`;
			return undefined;
		}
		ensurePrivateDir(pidDir);
		writeFileAtomic(pidFileFor(decl.name), String(proc.pid));
		entry.proc = proc;
		entry.pid = proc.pid;
		entry.state = "running";
		entry.startedAt = new Date();
		logger.info(`service ${decl.name} started (pid ${proc.pid})`);
		const rotation = setInterval(() => {
			try {
				rotateLogIfLarge(logFileFor(decl.name), maxLogBytes);
			} catch (err) {
				logger.warn(
					`service ${decl.name}: log rotation failed: ${describeError(err)}`,
				);
			}
		}, logCheckMs);
		const code = await proc.exited.finally(() => clearInterval(rotation));
		entry.lastExit = describeExit(proc);
		if (process.platform !== "win32") {
			entry.termination ??= killProcessGroup(proc.pid, decl.stopTimeoutMs);
		}
		await entry.termination;
		entry.proc = undefined;
		entry.pid = undefined;
		rmSync(pidFileFor(decl.name), { force: true });
		return code;
	}

	async function supervise(entry: Entry): Promise<void> {
		const { signal } = entry.abort;
		let failures = 0;
		while (!signal.aborted) {
			const ranFrom = Date.now();
			const code = await runOnce(entry);
			if (signal.aborted || code === 0) break;
			failures = Date.now() - ranFrom >= STABLE_RUN_MS ? 1 : failures + 1;
			const delay = backoffMs(failures);
			entry.state = "backoff";
			logger.warn(
				`service ${entry.decl.name}: ${entry.lastExit}; restarting in ${delay}ms`,
			);
			await sleepUnlessAborted(delay, signal);
			if (!signal.aborted) entry.restarts += 1;
		}
		entry.state = "stopped";
		logger.info(
			`service ${entry.decl.name} stopped (${entry.lastExit ?? "stopped"})`,
		);
	}

	function staleInstance(label: string): string | undefined {
		const file = pidFileFor(label);
		if (!existsSync(file)) return undefined;
		const pid = Number.parseInt(readFileSync(file, "utf8"), 10);
		if (!Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) {
			rmSync(file, { force: true });
			return undefined;
		}
		return `an earlier instance (pid ${pid}) is still running; stop it, or delete ${file} if that pid is not the service`;
	}

	function preflight(decl: JobDecl): string | undefined {
		try {
			if (!statSync(decl.cwd).isDirectory())
				return `cwd is not a directory: ${decl.cwd}`;
		} catch {
			return `cwd does not exist: ${decl.cwd}`;
		}
		try {
			if (decl.envFile) loadEnvFile(decl.envFile);
		} catch (err) {
			return describeError(err);
		}
		if (decl.grant) {
			let tokenPath = `<grantsDir>/${decl.grant}.token`;
			try {
				tokenPath = credentialGrantTokenPath(deps.paths, decl.grant);
				if (!statSync(tokenPath).isFile()) throw new Error("not a file");
			} catch {
				return `grant token file not found: ${tokenPath} — create it with dg-skills credentials grant ${decl.grant}`;
			}
		}
		const bound = readBoundCredentials(decl, deps.readCredential);
		if (!bound.ok) return bound.error;
		let stateDir = `<jobStateRoot>/${decl.name}`;
		try {
			stateDir = jobStateDir(deps.paths, decl.name);
			ensureRealPrivateDir(stateDir);
		} catch (err) {
			return `cannot create the state folder ${stateDir}: ${describeError(err)}`;
		}
		return checkExecutableResolves(decl.argv[0]);
	}

	function statusOf(label: string, parsed?: ParsedJob): ServiceStatus {
		const entry = entries.get(label);
		const base = {
			label,
			logFile: logFileFor(label),
			pid: entry?.pid ?? null,
			restarts: entry?.restarts ?? 0,
			startedAt: entry?.startedAt?.toISOString() ?? null,
			lastExit: entry?.lastExit ?? null,
		};
		if (entry) return { ...base, state: entry.state, error: null };
		if (parsed && !parsed.ok) {
			return { ...base, state: "invalid", error: parsed.error };
		}
		return { ...base, state: "stopped", error: null };
	}

	const declared = () => parseContinuousJobs(deps.loadConfig());

	function start(label: string): ServiceAction {
		const parsed = declared().find((job) => job.name === label);
		if (!parsed) {
			return {
				ok: false,
				kind: "unknown",
				error: `no service labelled "${label}"`,
			};
		}
		if (!parsed.ok) return { ok: false, kind: "invalid", error: parsed.error };
		const current = entries.get(label);
		if (current && current.state !== "stopped") {
			return {
				ok: false,
				kind: "conflict",
				error: `"${label}" is already ${current.state}`,
			};
		}
		const stale = staleInstance(label);
		if (stale) return { ok: false, kind: "conflict", error: stale };
		const problem = preflight(parsed);
		if (problem) return { ok: false, kind: "invalid", error: problem };

		const entry: Entry = {
			decl: parsed,
			state: "running",
			restarts: 0,
			abort: new AbortController(),
			loop: Promise.resolve(),
		};
		entries.set(label, entry);
		entry.loop = supervise(entry).catch((err: unknown) => {
			entry.state = "stopped";
			entry.lastExit = `supervisor failed: ${describeError(err)}`;
			logger.warn(`service ${label}: ${entry.lastExit}`);
		});
		return { ok: true, status: statusOf(label) };
	}

	async function stop(label: string): Promise<ServiceAction> {
		const entry = entries.get(label);
		if (!entry) {
			const known = declared().some((job) => job.name === label);
			return known
				? { ok: true, status: statusOf(label) }
				: {
						ok: false,
						kind: "unknown",
						error: `no service labelled "${label}"`,
					};
		}
		entry.abort.abort();
		if (entry.pid !== undefined) {
			entry.termination ??= killProcessGroup(
				entry.pid,
				entry.decl.stopTimeoutMs,
			);
		}
		await entry.loop;
		return { ok: true, status: statusOf(label) };
	}

	return {
		start,
		stop,
		stopAll: async () => {
			await Promise.all([...entries.keys()].map(stop));
		},
		autostart: () => {
			for (const job of declared()) {
				if (!job.ok || !job.enabled) continue;
				const result = start(job.name);
				if (!result.ok) {
					logger.warn(`service ${job.name} not autostarted: ${result.error}`);
				}
			}
		},
		status: () => {
			const parsed = declared();
			const labels = new Set([
				...parsed.map((job) => job.name),
				...[...entries]
					.filter(([, entry]) => entry.state !== "stopped")
					.map(([label]) => label),
			]);
			return [...labels].map((label) =>
				statusOf(
					label,
					parsed.find((job) => job.name === label),
				),
			);
		},
		runningCount: () =>
			[...entries.values()].filter((entry) => entry.state !== "stopped").length,
	};
}
