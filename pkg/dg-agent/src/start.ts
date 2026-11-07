import { spawn } from "node:child_process";
import {
	CHAT_PROTOCOL_VERSION,
	CHAT_START_PATH,
	CHAT_STATUS_PATH,
	type DaemonHandle,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	EXIT_PROTOCOL_MISMATCH,
	type SessionBootstrap,
	type SessionRole,
	validateSessionBootstrap,
	wait,
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
	type OpenSeams,
	openFailedHint,
	tryOpen,
} from "@dg/common/node";
import { programCommand } from "@dg/common/node/program";
import { claimWaitingSession } from "./attach";
import { cliNextStep } from "./next-step";

function siblingDaemonArgv(): string[] {
	return programCommand("dg-daemon", ["__serve"]);
}

export type StartSeams = {
	daemonArgv?: () => string[];
	spawn?: typeof spawn;
	tryOpen?: (url: string) => Promise<boolean>;
	openFailedHint?: () => string;
};

function spawnDaemonProcess(seams: StartSeams): void {
	const argv = seams.daemonArgv?.() ?? siblingDaemonArgv();
	const child = (seams.spawn ?? spawn)(argv[0], argv.slice(1), {
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
		await wait(100);
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
	fresh?: boolean;
	sessionId?: string;
	printSessionId?: boolean;
	json?: boolean;
	ext?: boolean;
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

function sessionUrl(port: number, bootstrap: SessionBootstrap): string {
	return buildBootstrapUrl(port, bootstrap, "/chat");
}

async function openIfRequested(
	url: string,
	options: StartOptions,
	seams: StartSeams,
): Promise<void> {
	if (options.open) await openUrlOrHint(url, seams);
}

/** Open a dg-agent URL; on WSL the Windows browser needs DG_OPEN_WINDOWS=1. */
export function tryOpenAgentUrl(
	url: string,
	seams: OpenSeams = {},
): Promise<boolean> {
	return tryOpen(url, { ...seams, requireWindowsOptIn: true });
}

/** Open a URL in a browser, or write the stderr hint when no launcher ran. */
export async function openUrlOrHint(
	url: string,
	seams: Pick<StartSeams, "tryOpen" | "openFailedHint"> = {},
): Promise<void> {
	if (await (seams.tryOpen ?? tryOpenAgentUrl)(url)) return;
	console.error((seams.openFailedHint ?? openFailedHint)());
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

	if (!options.fresh) {
		const claimed = await claimWaitingSession(
			targetPort,
			process.cwd(),
			"start",
			options.sessionId,
		);
		if (claimed) {
			console.error(cliNextStep("claimed", claimed.sessionId));
			const url = sessionUrl(targetPort, claimed);
			printSession(targetPort, claimed.sessionId, url, options);
			await openIfRequested(url, options, seams);
			return;
		}
	}

	const bootstrap = await registerSession(targetPort, {
		cwd: process.cwd(),
		role: options.role ?? "agent",
		workset: options.workset,
		agentIdentity: options.agentIdentity,
	});
	const url = sessionUrl(targetPort, bootstrap);
	console.error(cliNextStep("registered", bootstrap.sessionId));
	printSession(targetPort, bootstrap.sessionId, url, options);
	await openIfRequested(url, options, seams);
}

function printSession(
	port: number,
	sessionId: string,
	url: string,
	options: StartOptions,
): void {
	if (options.json) {
		console.log(JSON.stringify({ sessionId, port, url }));
		return;
	}
	if (options.printSessionId) console.log(sessionId);
	console.log(url);
}
