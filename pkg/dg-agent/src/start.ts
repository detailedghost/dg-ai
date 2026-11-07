import { spawn } from "node:child_process";
import {
	CHAT_CODE_PATH,
	CHAT_PROTOCOL_VERSION,
	CHAT_START_PATH,
	CHAT_STATUS_PATH,
	type DaemonHandle,
	DgCliError,
	EXIT_GENERAL_FAILURE,
	EXIT_PROTOCOL_MISMATCH,
	OWNER_TOKEN_HEADER,
	type SessionBootstrap,
	type SessionRole,
	validateSessionBootstrap,
	wait,
} from "@dg/common";
import {
	buildCodeUrl,
	checkWslNetworking,
	type DgPaths,
	isDaemonLive,
	loopbackHostHeader,
	readPidFile,
	requireMatchingProtocol,
	requireOwnerToken,
	resolveDgPaths,
	type OpenSeams,
	openFailedHint,
	tryOpen,
} from "@dg/common/node";
import { programCommand } from "@dg/common/node/program";
import { startNotice } from "./next-step";

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

async function registerSession(
	port: number,
	paths: DgPaths,
	input: RegisterInput,
) {
	const owner = requireOwnerToken(paths);
	const resp = await fetch(`http://127.0.0.1:${port}${CHAT_START_PATH}`, {
		method: "POST",
		headers: {
			...loopbackHostHeader(port),
			"Content-Type": "application/json",
			[OWNER_TOKEN_HEADER]: owner,
		},
		body: JSON.stringify(input),
	});
	if (!resp.ok) {
		throw new DgCliError(
			`session registration failed: ${resp.status} ${await resp.text()}`,
		);
	}
	const body: unknown = await resp.json();
	return {
		bootstrap: validateSessionBootstrap(body),
		extensionLinked:
			(body as { extensionLinked?: unknown }).extensionLinked === true,
	};
}

/** Trade the owner token for a one-time page code, so no URL carries the session token. */
export async function mintPageCode({
	port,
	sessionId,
}: Pick<SessionBootstrap, "port" | "sessionId">): Promise<string> {
	const resp = await fetch(`http://127.0.0.1:${port}${CHAT_CODE_PATH}`, {
		method: "POST",
		headers: {
			...loopbackHostHeader(port),
			"Content-Type": "application/json",
			[OWNER_TOKEN_HEADER]: requireOwnerToken(resolveDgPaths()),
		},
		body: JSON.stringify({ sessionId }),
	});
	if (!resp.ok) {
		throw new DgCliError(
			`page code request failed: ${resp.status} ${await resp.text()}`,
		);
	}
	const { code } = (await resp.json()) as { code?: unknown };
	if (typeof code !== "string" || code.length === 0) {
		throw new DgCliError("dg-daemon did not issue a page code");
	}
	return code;
}

export type StartOptions = {
	workset?: string;
	role?: SessionRole;
	agentIdentity?: string;
	open?: boolean;
	printSessionId?: boolean;
	json?: boolean;
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

	const { bootstrap, extensionLinked } = await registerSession(
		targetPort,
		paths,
		{
			cwd: process.cwd(),
			role: options.role ?? "agent",
			workset: options.workset,
			agentIdentity: options.agentIdentity,
		},
	);
	console.error(startNotice(bootstrap, extensionLinked));
	printSession(bootstrap.sessionId, targetPort, extensionLinked, options);
	if (options.open) {
		const code = await mintPageCode(bootstrap);
		await openUrlOrHint(buildCodeUrl(targetPort, code), seams);
	}
}

function printSession(
	sessionId: string,
	port: number,
	extensionLinked: boolean,
	options: StartOptions,
): void {
	if (options.json) {
		console.log(JSON.stringify({ sessionId, port, extensionLinked }));
		return;
	}
	if (options.printSessionId) console.log(sessionId);
}
