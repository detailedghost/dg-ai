import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import {
	CHAT_PROTOCOL_VERSION,
	CHAT_START_PATH,
	CHAT_STATUS_PATH,
	type DaemonHandle,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	EXIT_PROTOCOL_MISMATCH,
	type SessionRole,
	validateSessionBootstrap,
} from "@dg/common";
import {
	buildBootstrapUrl,
	checkWslNetworking,
	type DgPaths,
	isDaemonLive,
	loopbackHostHeader,
	readPidFile,
	requireMatchingProtocol,
	resolveDgPaths,
	tryOpen,
} from "@dg/common/node";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function siblingDaemonArgv(): string[] {
	const name = process.platform === "win32" ? "dg-daemon.exe" : "dg-daemon";
	return [join(dirname(process.execPath), name), "__serve"];
}

export type StartSeams = { daemonArgv?: () => string[] };

function spawnDaemonProcess(seams: StartSeams): void {
	const argv = seams.daemonArgv?.() ?? siblingDaemonArgv();
	const child = spawn(argv[0], argv.slice(1), {
		detached: true,
		stdio: "ignore",
		windowsHide: process.platform === "win32",
		env: process.env,
	});
	child.unref();
}

async function waitForFreshDaemon(paths: DgPaths, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const handle = readPidFile(paths);
		if (handle && (await isDaemonLive(handle))) return handle;
		await sleep(100);
	}
	throw new DgCliError(
		"dg-daemon did not become healthy within the startup timeout",
		EXIT_GENERAL_FAILURE,
	);
}

type RegisterInput = {
	cwd: string;
	role: SessionRole;
	workset?: string;
	agentIdentity?: string;
};

async function registerSession(port: number, input: RegisterInput) {
	const resp = await fetch(`http://127.0.0.1:${port}${CHAT_START_PATH}`, {
		method: "POST",
		headers: {
			...loopbackHostHeader(port),
			"Content-Type": "application/json",
		},
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw new DgCliError(
			`session registration failed: ${resp.status} ${await resp.text()}`,
		);
	}
	return validateSessionBootstrap(await resp.json());
}

export type StartOptions = {
	workset?: string;
	role?: SessionRole;
	agentIdentity?: string;
	open?: boolean;
};

async function fetchStatus(port: number) {
	try {
		const resp = await fetch(`http://127.0.0.1:${port}${CHAT_STATUS_PATH}`, {
			headers: loopbackHostHeader(port),
		});
		if (!resp.ok) return undefined;
		return (await resp.json()) as { sessionCount?: number };
	} catch {
		return undefined;
	}
}

async function attachToRunningDaemon(existing: DaemonHandle): Promise<number> {
	if (existing.versions.protocol !== CHAT_PROTOCOL_VERSION) {
		const status = await fetchStatus(existing.port);
		throw new DgCliError(
			`dg-daemon: the running daemon speaks protocol v${existing.versions.protocol}, ` +
				`this CLI speaks v${CHAT_PROTOCOL_VERSION}. Refusing to attach — stopping it would ` +
				`end ${status?.sessionCount ?? "an unknown number of"} live session(s); dg-daemon ` +
				"never auto-restarts a shared daemon. Stop it yourself once nothing depends on it.",
			EXIT_PROTOCOL_MISMATCH,
		);
	}
	return existing.port;
}

async function bootstrapFreshDaemon(
	paths: DgPaths,
	seams: StartSeams,
): Promise<number> {
	await checkWslNetworking();
	spawnDaemonProcess(seams);
	const handle = await waitForFreshDaemon(paths);
	requireMatchingProtocol(
		handle,
		"The dg-daemon binary beside this dg-agent is from another release. " +
			'Run "dg-skills install" so both come from the same one, then stop the ' +
			`daemon this command started (pid ${handle.pid}).`,
	);
	return handle.port;
}

export async function cmdStart(
	options: StartOptions = {},
	seams: StartSeams = {},
): Promise<void> {
	const paths = resolveDgPaths();
	const existing = readPidFile(paths);
	const existingLive = existing ? await isDaemonLive(existing) : false;

	const targetPort =
		existing && existingLive
			? await attachToRunningDaemon(existing)
			: await bootstrapFreshDaemon(paths, seams);

	const bootstrap = await registerSession(targetPort, {
		cwd: process.cwd(),
		role: options.role ?? "agent",
		workset: options.workset,
		agentIdentity: options.agentIdentity,
	});
	const url = buildBootstrapUrl(targetPort, bootstrap);
	console.log(url);
	if (options.open) {
		await tryOpen(url);
	}
}
