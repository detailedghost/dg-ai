import {
	CHAT_SERVICES_PATH,
	type DaemonHandle,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	OWNER_TOKEN_HEADER,
	wait,
} from "@dg/common";
import {
	type DgPaths,
	ensureDaemonRunning,
	isAlive,
	isDaemonLive,
	killProcessTree,
	loopbackHostHeader,
	readOwnerToken,
	readPidFile,
	removePidFile,
	resolveDgPaths,
} from "@dg/common/node";
import { startedLine } from "./start";

const POLL_MS = 100;
const REGULAR_STOP_WAIT_MS = 255_000;
const FORCE_WAIT_MS = 5_000;

export type StopSeams = {
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
	exec?: (command: string, args: string[]) => void;
	waitMs?: number;
};

export type StopOptions = { force?: boolean };

function signalDaemon(kill: NonNullable<StopSeams["kill"]>, pid: number, signal: NodeJS.Signals): void {
	try {
		kill(pid, signal);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
		throw new DgCliError(
			`could not send ${signal} to dg-daemon (pid ${pid}): ${err instanceof Error ? err.message : String(err)}`,
			EXIT_GENERAL_FAILURE,
		);
	}
}

async function waitUntilGone(
	pids: number[],
	waitMs: number,
	probe: (pid: number, signal: 0) => void,
): Promise<boolean> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (!pids.some((pid) => isAlive(pid, probe))) return true;
		if (Date.now() >= deadline) return false;
		await wait(POLL_MS);
	}
}

async function listServicePids(paths: DgPaths, handle: DaemonHandle): Promise<number[]> {
	const owner = readOwnerToken(paths);
	const resp = await fetch(`http://127.0.0.1:${handle.port}${CHAT_SERVICES_PATH}`, {
		headers: {
			...loopbackHostHeader(handle.port),
			...(owner === undefined ? {} : { [OWNER_TOKEN_HEADER]: owner }),
		},
	});
	if (!resp.ok) throw new Error(`${resp.status} ${(await resp.text()).trim()}`);
	const { services } = (await resp.json()) as {
		services: { pid: number | null }[];
	};
	return services.flatMap((service) => (typeof service.pid === "number" ? [service.pid] : []));
}

async function liveDaemon(paths: DgPaths): Promise<DaemonHandle | undefined> {
	const handle = readPidFile(paths);
	if (!handle) {
		console.log("dg-daemon: no live daemon");
		return undefined;
	}
	if (!(await isDaemonLive(handle))) {
		removePidFile(paths);
		console.log("dg-daemon: no live daemon (stale pid file removed)");
		return undefined;
	}
	return handle;
}

async function forceStop(paths: DgPaths, handle: DaemonHandle, seams: StopSeams): Promise<void> {
	const platform = seams.platform ?? process.platform;
	const kill = seams.kill ?? process.kill.bind(process);
	let servicePids: number[] = [];
	let listFailure: string | undefined;
	try {
		servicePids = await listServicePids(paths, handle);
	} catch (err) {
		listFailure = err instanceof Error ? err.message : String(err);
	}
	if (platform === "win32") killProcessTree(handle.pid, seams);
	else signalDaemon(kill, handle.pid, "SIGKILL");
	for (const pid of servicePids) killProcessTree(pid, seams);
	const gone = await waitUntilGone([handle.pid, ...servicePids], seams.waitMs ?? FORCE_WAIT_MS, kill);
	if (!gone) {
		throw new DgCliError(
			`dg-daemon (pid ${handle.pid}) or a service did not exit after the kill${
				listFailure === undefined
					? ""
					: `; could not list the services (${listFailure}); a service process can still run`
			}`,
			EXIT_GENERAL_FAILURE,
		);
	}
	removePidFile(paths);
	if (listFailure !== undefined) {
		throw new DgCliError(
			`could not list the services (${listFailure}); a service process can still run`,
			EXIT_GENERAL_FAILURE,
		);
	}
	console.log(`dg-daemon stopped (pid ${handle.pid}, forced)`);
}

async function regularStop(paths: DgPaths, handle: DaemonHandle, seams: StopSeams): Promise<void> {
	const kill = seams.kill ?? process.kill.bind(process);
	const waitMs = seams.waitMs ?? REGULAR_STOP_WAIT_MS;
	signalDaemon(kill, handle.pid, "SIGTERM");
	if (!(await waitUntilGone([handle.pid], waitMs, kill))) {
		throw new DgCliError(
			`dg-daemon (pid ${handle.pid}) did not stop within ${Math.round(waitMs / 1000)} s — run dg-daemon stop --force`,
			EXIT_GENERAL_FAILURE,
		);
	}
	removePidFile(paths);
	console.log(`dg-daemon stopped (pid ${handle.pid})`);
}

async function stopDaemon(paths: DgPaths, options: StopOptions, seams: StopSeams): Promise<void> {
	const handle = await liveDaemon(paths);
	if (!handle) return;
	const platform = seams.platform ?? process.platform;
	if (options.force || platform === "win32") {
		await forceStop(paths, handle, seams);
		return;
	}
	await regularStop(paths, handle, seams);
}

export async function cmdStop(options: StopOptions = {}, seams: StopSeams = {}): Promise<void> {
	await stopDaemon(resolveDgPaths(), options, seams);
}

export async function cmdRestart(options: StopOptions = {}, seams: StopSeams = {}): Promise<void> {
	const paths = resolveDgPaths();
	await stopDaemon(paths, options, seams);
	const { handle, started } = await ensureDaemonRunning(paths);
	console.log(startedLine(handle, started));
}
