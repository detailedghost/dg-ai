import { spawn } from "node:child_process";
import { wait } from "../async";
import { DgCliError, EXIT_GENERAL_FAILURE } from "../errors";
import type { DaemonHandle } from "../index";
import type { DgPaths } from "./dg-paths";
import { isDaemonLive, readPidFile } from "./pidfile";
import { programCommand } from "./program";
import { checkWslNetworking } from "./wsl-guard";

const POLL_MS = 100;
const STARTUP_TIMEOUT_MS = 15_000;

export type EnsureDaemonSeams = {
	daemonArgv?: () => string[];
	spawn?: typeof spawn;
	timeoutMs?: number;
};

async function waitForFreshDaemon(
	paths: DgPaths,
	timeoutMs: number,
): Promise<DaemonHandle> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const handle = readPidFile(paths);
		if (handle && (await isDaemonLive(handle))) return handle;
		await wait(POLL_MS);
	}
	throw new DgCliError(
		"dg-daemon did not become healthy within the startup timeout",
		EXIT_GENERAL_FAILURE,
	);
}

/** Returns the live daemon, spawning one when none runs; `started` marks a spawn by this call. */
export async function ensureDaemonRunning(
	paths: DgPaths,
	seams: EnsureDaemonSeams = {},
): Promise<{ handle: DaemonHandle; started: boolean }> {
	const existing = readPidFile(paths);
	if (existing && (await isDaemonLive(existing))) {
		return { handle: existing, started: false };
	}
	await checkWslNetworking();
	const argv = seams.daemonArgv?.() ?? programCommand("dg-daemon", ["serve"]);
	const child = (seams.spawn ?? spawn)(argv[0], argv.slice(1), {
		detached: true,
		stdio: "ignore",
		windowsHide: process.platform === "win32",
		env: process.env,
	});
	child.unref();
	const handle = await waitForFreshDaemon(
		paths,
		seams.timeoutMs ?? STARTUP_TIMEOUT_MS,
	);
	return { handle, started: true };
}
