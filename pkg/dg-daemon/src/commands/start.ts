import type { spawn } from "node:child_process";
import { type DaemonHandle, DgCliError } from "@dg/common";
import {
	type AutostartDeps,
	type AutostartName,
	autostartManages,
	autostartUnitPath,
	checkWslNetworking,
	type DgPaths,
	defaultAutostartDeps,
	ensureDaemonRunning,
	firstLine,
	isDaemonLive,
	managedRestartCommands,
	readPidFile,
	resolveDgPaths,
	STARTUP_TIMEOUT_MS,
	waitForFreshDaemon,
} from "@dg/common/node";
import { assertNotBlocked } from "@dg/common/node/layout";

const NAME: AutostartName = "dg-daemon";

export type DaemonStartSeams = {
	autostart?: AutostartDeps;
	timeoutMs?: number;
	spawn?: typeof spawn;
};

export function startedLine(handle: DaemonHandle, started: boolean): string {
	const state = started ? "started on" : "already running on";
	return `dg daemon ${state} 127.0.0.1:${handle.port} (pid ${handle.pid}, version ${handle.versions.package})`;
}

/** Returns the live daemon; starts one through the login unit when the unit is for this home, else detached. */
export async function startDaemon(
	paths: DgPaths,
	seams: DaemonStartSeams = {},
): Promise<{ handle: DaemonHandle; started: boolean }> {
	const existing = readPidFile(paths);
	if (existing && (await isDaemonLive(existing))) {
		return { handle: existing, started: false };
	}
	assertNotBlocked(paths, "daemon");
	const deps = seams.autostart ?? defaultAutostartDeps();
	const kind = autostartManages(deps, paths, NAME);
	if (!kind) {
		return ensureDaemonRunning(paths, { spawn: seams.spawn, timeoutMs: seams.timeoutMs });
	}
	await checkWslNetworking();
	const unitPath = autostartUnitPath(deps, paths, NAME);
	const deadline = Date.now() + (seams.timeoutMs ?? STARTUP_TIMEOUT_MS);
	let failure: string | undefined;
	for (const argv of managedRestartCommands(kind, deps.uid, NAME, unitPath)) {
		const result = await deps.run(argv);
		if (result.code !== 0) {
			failure = `${argv.join(" ")} failed: ${firstLine(result.stderr)}`;
		}
	}
	try {
		const handle = await waitForFreshDaemon(paths, Math.max(0, deadline - Date.now()));
		return { handle, started: true };
	} catch (err) {
		if (failure && err instanceof DgCliError) throw new DgCliError(`${err.message} (${failure})`, err.exitCode);
		throw err;
	}
}

export async function cmdStart(
	options: { json?: boolean } = {},
	seams: DaemonStartSeams = {},
): Promise<void> {
	const { handle, started } = await startDaemon(resolveDgPaths(), seams);
	if (options.json) {
		console.log(
			JSON.stringify({
				started,
				pid: handle.pid,
				port: handle.port,
				version: handle.versions.package,
			}),
		);
		return;
	}
	console.log(startedLine(handle, started));
}
