import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { describeError } from "@dg/common";
import {
	checkExecutableResolves,
	type DgPaths,
	ensurePrivateDir,
	writeFileAtomic,
} from "@dg/common/node";
import type { Subprocess } from "bun";
import { buildAllowedEnv } from "../dispatch/env-allowlist";
import { killProcessGroup } from "../dispatch/exec";
import type { Logger } from "../server/log";
import { loadEnvFile } from "./env-file";
import { type ParsedService, parseServices, type ServiceDecl } from "./config";

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
export const STABLE_RUN_MS = 60_000;
export const STOP_GRACE_MS = 5_000;
const MAX_LOG_BYTES = 5_000_000;

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
	paths: Pick<DgPaths, "daemonDir" | "logDir">;
	loadConfig: () => Record<string, unknown>;
	logger: Pick<Logger, "info" | "warn">;
	backoffMs?: (failures: number) => number;
	stopGraceMs?: number;
};

type LiveState = Exclude<ServiceState, "invalid">;

type Entry = {
	decl: ServiceDecl;
	state: LiveState;
	proc?: Subprocess;
	pid?: number;
	restarts: number;
	startedAt?: Date;
	lastExit?: string;
	abort: AbortController;
	loop: Promise<void>;
};

export const exponentialBackoffMs = (failures: number): number =>
	Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);

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

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function describeExit(proc: Subprocess): string {
	return proc.signalCode
		? `killed by ${proc.signalCode}`
		: `exit ${proc.exitCode}`;
}

function openLog(logDir: string, logFile: string): number {
	ensurePrivateDir(logDir);
	if (existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) {
		renameSync(logFile, `${logFile}.1`);
	}
	return openSync(logFile, "a", 0o600);
}

export function createSupervisor(deps: SupervisorDeps): Supervisor {
	const { logger } = deps;
	const backoffMs = deps.backoffMs ?? exponentialBackoffMs;
	const stopGraceMs = deps.stopGraceMs ?? STOP_GRACE_MS;
	const pidDir = join(deps.paths.daemonDir, "services");
	const entries = new Map<string, Entry>();

	const logFileFor = (label: string) =>
		join(deps.paths.logDir, `service-${label}.log`);
	const pidFileFor = (label: string) => join(pidDir, `${label}.pid`);

	function launch(decl: ServiceDecl): Subprocess {
		const fd = openLog(deps.paths.logDir, logFileFor(decl.label));
		try {
			return Bun.spawn(decl.argv, {
				cwd: decl.cwd,
				env: {
					...buildAllowedEnv(),
					...(decl.envFile ? loadEnvFile(decl.envFile) : {}),
				},
				stdin: "ignore",
				stdout: fd,
				stderr: fd,
				detached: true,
			});
		} finally {
			closeSync(fd);
		}
	}

	async function runOnce(entry: Entry): Promise<number | undefined> {
		const { decl } = entry;
		let proc: Subprocess;
		try {
			proc = launch(decl);
		} catch (err) {
			entry.lastExit = `failed to start: ${describeError(err)}`;
			return undefined;
		}
		ensurePrivateDir(pidDir);
		writeFileAtomic(pidFileFor(decl.label), String(proc.pid));
		entry.proc = proc;
		entry.pid = proc.pid;
		entry.state = "running";
		entry.startedAt = new Date();
		logger.info(`service ${decl.label} started (pid ${proc.pid})`);
		const code = await proc.exited;
		killProcessGroup(proc.pid, stopGraceMs);
		entry.proc = undefined;
		entry.pid = undefined;
		rmSync(pidFileFor(decl.label), { force: true });
		entry.lastExit = describeExit(proc);
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
				`service ${entry.decl.label}: ${entry.lastExit}; restarting in ${delay}ms`,
			);
			await sleepUnlessAborted(delay, signal);
			entry.restarts += 1;
		}
		entry.state = "stopped";
		logger.info(
			`service ${entry.decl.label} stopped (${entry.lastExit ?? "stopped"})`,
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

	function preflight(decl: ServiceDecl): string | undefined {
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
		return checkExecutableResolves(decl.argv[0]);
	}

	function statusOf(label: string, parsed?: ParsedService): ServiceStatus {
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

	const declared = () => parseServices(deps.loadConfig());

	function start(label: string): ServiceAction {
		const parsed = declared().find((service) => service.label === label);
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
			const known = declared().some((service) => service.label === label);
			return known
				? { ok: true, status: statusOf(label) }
				: {
						ok: false,
						kind: "unknown",
						error: `no service labelled "${label}"`,
					};
		}
		entry.abort.abort();
		if (entry.pid !== undefined) killProcessGroup(entry.pid, stopGraceMs);
		entry.proc?.kill();
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
			for (const service of declared()) {
				if (!service.ok || !service.autostart) continue;
				const result = start(service.label);
				if (!result.ok) {
					logger.warn(
						`service ${service.label} not autostarted: ${result.error}`,
					);
				}
			}
		},
		status: () => {
			const parsed = declared();
			const labels = new Set([
				...parsed.map((service) => service.label),
				...entries.keys(),
			]);
			return [...labels].map((label) =>
				statusOf(
					label,
					parsed.find((service) => service.label === label),
				),
			);
		},
		runningCount: () =>
			[...entries.values()].filter((entry) => entry.state !== "stopped").length,
	};
}
