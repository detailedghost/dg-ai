import { spawn } from "node:child_process";
import {
	CHAT_PROTOCOL_VERSION,
	CHAT_START_PATH,
	CHAT_STATUS_PATH,
	type DaemonHandle,
	DgCliError,
	EXIT_PROTOCOL_MISMATCH,
	OWNER_TOKEN_HEADER,
	type SessionBootstrap,
	type SessionRole,
	validateSessionBootstrap,
} from "@dg/common";
import {
	buildCodeUrl,
	ensureDaemonRunning,
	type DgPaths,
	loopbackHostHeader,
	mintPageCode,
	requireMatchingProtocol,
	requireOwnerToken,
	resolveDgPaths,
	type OpenSeams,
	openFailedHint,
	tryOpen,
} from "@dg/common/node";
import { startNotice } from "./next-step";

export type StartSeams = {
	daemonArgv?: () => string[];
	spawn?: typeof spawn;
	tryOpen?: (url: string) => Promise<boolean>;
	openFailedHint?: () => string;
};

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

function requireFreshDaemonProtocol(handle: DaemonHandle): number {
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
	const { handle, started } = await ensureDaemonRunning(paths, {
		daemonArgv: seams.daemonArgv,
		spawn: seams.spawn,
	});
	const targetPort = started
		? requireFreshDaemonProtocol(handle)
		: await attachToRunningDaemon(handle);

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
