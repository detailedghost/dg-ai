import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	CHAT_HEALTH_PATH,
	CHAT_PROTOCOL_VERSION,
	CHAT_JOBS_PATH,
	type DaemonHandle,
} from "@dg/common";
import {
	ensureOwnerToken,
	readPidFile,
	resolveDgPaths,
	writePidFileAtomic,
} from "@dg/common/node";
import {
	allocatePort,
	bootServe,
	cleanupDgHome,
	createCleanupSlot,
	ENTRY,
	freshDgHome,
	killDaemonByPidFile,
	ownerTokenHeader,
	stopServe,
	subprocessEnv,
	waitForDaemonExit,
	waitForPidFile,
} from "../utils/daemon-harness";
import { writeConfigFile } from "../utils/service-daemon";
import { jobLogFile } from "../../src/jobs/launcher";
import { runCli as runCliOnPort } from "./service-cli-helpers";
import type { RunResult } from "./service-cli-helpers";

export { lines, readConfigFile } from "./service-cli-helpers";
export type { RunResult } from "./service-cli-helpers";

export const runCli: typeof runCliOnPort = (dgHome, args, options = {}) =>
	runCliOnPort(dgHome, args, { ...options, port: options.port ?? allocatePort() });

export const SLEEPER_ARGV = [
	process.execPath,
	"-e",
	"setTimeout(() => {}, 600000)",
];

export const pathsOf = (dgHome: string) =>
	resolveDgPaths({ env: { DG_HOME: dgHome } });

export const logFileOf = (dgHome: string, name: string): string =>
	jobLogFile(pathsOf(dgHome).logDir, name);

export function sleeperEntry(
	cwd: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return { continuous: true, argv: SLEEPER_ARGV, cwd, ...extra };
}

export function seedJobs(
	dgHome: string,
	jobs: Record<string, unknown>,
	extra: Record<string, unknown> = {},
): void {
	writeConfigFile(dgHome, {
		pinnedOrigin: "p",
		jobsVersion: 2,
		...extra,
		jobs,
	});
	chmodSync(pathsOf(dgHome).daemonDir, 0o700);
}

export const jobsTable = (
	config: unknown,
): Record<string, Record<string, unknown>> =>
	(config as { jobs: Record<string, Record<string, unknown>> }).jobs;

export type JobRow = {
	label: string;
	state: string;
	pid: number | null;
	restarts: number;
	logFile: string;
};

export async function fetchJobRows(
	dgHome: string,
	port: number,
): Promise<JobRow[]> {
	const resp = await fetch(`http://127.0.0.1:${port}${CHAT_JOBS_PATH}`, {
		headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
	});
	return ((await resp.json()) as { jobs: JobRow[] }).jobs;
}

export const postJob = (port: number, name: string, verb: "start" | "stop") =>
	fetch(`http://127.0.0.1:${port}${CHAT_JOBS_PATH}/${name}/${verb}`, {
		method: "POST",
		headers: { Host: `127.0.0.1:${port}`, ...ownerTokenHeader(port) },
	});

export async function waitUntil(
	check: () => boolean | Promise<boolean>,
	timeoutMs = 8000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(100);
	}
	throw new Error("condition not met in time");
}

/** Homes for specs whose commands may start a detached daemon; cleanup stops it first. */
export function homeTracker() {
	const homes: string[] = [];
	const slot = createCleanupSlot();
	return {
		fresh(): string {
			const dgHome = freshDgHome();
			homes.push(dgHome);
			return dgHome;
		},
		async boot(
			jobs: (dgHome: string) => Record<string, unknown> = () => ({}),
			extra: Record<string, unknown> = {},
		) {
			const { dgHome, port, proc } = await bootServe();
			slot.set(async () => {
				await stopServe(proc);
				cleanupDgHome(dgHome);
			});
			await waitForPidFile(dgHome);
			seedJobs(dgHome, jobs(dgHome), extra);
			return { dgHome, port, proc };
		},
		async cleanup(): Promise<void> {
			await slot.run();
			for (const dgHome of homes.splice(0)) {
				if (readPidFile(pathsOf(dgHome))?.pid === process.pid) {
					cleanupDgHome(dgHome);
					continue;
				}
				killDaemonByPidFile(dgHome);
				await waitForDaemonExit(dgHome).catch(() => {});
				cleanupDgHome(dgHome);
			}
		},
	};
}

export async function runCliWithoutDgHome(
	args: string[],
	dgHome: string,
): Promise<RunResult> {
	const env = subprocessEnv(dgHome, 0);
	delete env.DG_HOME;
	const proc = Bun.spawn([process.execPath, ENTRY, ...args], {
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

export type FakeDaemon = {
	port: number;
	requests: string[];
	stop: () => void;
};

/** A daemon stand-in that answers health, then each route through `answer`. */
export function startFakeDaemon(
	dgHome: string,
	answer: (method: string, path: string) => Response,
): FakeDaemon {
	const paths = pathsOf(dgHome);
	const instanceId = crypto.randomUUID();
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			const path = new URL(req.url).pathname;
			if (path === CHAT_HEALTH_PATH) return Response.json({ instanceId });
			requests.push(`${req.method} ${path}`);
			return answer(req.method, path);
		},
	});
	const handle: DaemonHandle = {
		pid: process.pid,
		port: server.port as number,
		instanceId,
		versions: { package: "9.9.9", protocol: CHAT_PROTOCOL_VERSION },
	};
	mkdirSync(dirname(paths.pidPath), { recursive: true });
	ensureOwnerToken(paths);
	writePidFileAtomic(paths, handle);
	return {
		port: server.port as number,
		requests,
		stop: () => server.stop(true),
	};
}

export function writeLog(dgHome: string, name: string, text: string): string {
	const file = logFileOf(dgHome, name);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, text);
	return file;
}
