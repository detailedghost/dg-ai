import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import {
	DISPATCH_MAX_CONCURRENT_DAEMON_WIDE,
	DISPATCH_MAX_CONCURRENT_PER_SESSION,
} from "../../src/dispatch/limits";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectPage,
	killDaemonByPidFile,
	sendConnectHandshake,
	spawnSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import {
	commandInvocationFrame,
	type DispatchCredentials,
	isCommandResult,
	publishManifest,
	scratchScriptDir,
	waitForNthCommandResult,
	waitForProcessExit,
	writeExecutableScript,
} from "./dispatch-wire";

let dgHome: string;
let scratchDir: string;
const openSockets: WebSocket[] = [];

afterEach(() => {
	killDaemonByPidFile(dgHome);
	closeSockets(openSockets);
	cleanupDgHome(dgHome);
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function startWithSession() {
	const started = await bootDaemonSession();
	dgHome = started.dgHome;
	return started;
}

async function connectedPage(
	port: number,
	credentials: DispatchCredentials,
): Promise<WebSocket> {
	const page = await connectPage(port, credentials);
	openSockets.push(page);
	return page;
}

describe("$ dispatch bounds: timeout and process-group kill", () => {
	it("kills a SIGTERM-trapping child's whole process group at the timeout, naming it and retaining partial output", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		const pidFile = join(scratchDir, "child.pid");
		const scriptPath = writeExecutableScript(
			scratchDir,
			"trap-term.sh",
			[
				"trap '' TERM",
				`echo $$ > ${pidFile}`,
				"echo partial-output-before-kill",
				"while true; do sleep 0.2; done",
			].join("\n"),
		);
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[
				{
					label: "Trap",
					argv: [scriptPath],
					params: [],
					limits: { timeoutMs: 300 },
				},
			],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "Trap"));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			5000,
			"command-result naming the timeout",
		);
		expect(result.ok).toBe(false);
		expect(result.error ?? "").toMatch(/timeout|timed out/i);
		expect(result.output ?? "").toContain("partial-output-before-kill");

		const pidText = await waitForValue(
			() => {
				try {
					return readFileSync(pidFile, "utf8").trim();
				} catch {
					return undefined;
				}
			},
			2000,
			"child pidfile",
		);
		await waitForProcessExit(Number(pidText), 2000);
		page.close();
	}, 20_000);
});

describe("$ dispatch bounds: output cap", () => {
	it("truncates combined output at the 256 KiB cap with an explicit marker and kills the group", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		const pidFile = join(scratchDir, "child.pid");
		const scriptPath = writeExecutableScript(
			scratchDir,
			"overflow.sh",
			[
				"trap '' TERM",
				`echo $$ > ${pidFile}`,
				"yes 0123456789 | head -c 400000",
				"while true; do sleep 0.2; done",
			].join("\n"),
		);
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[{ label: "Overflow", argv: [scriptPath], params: [] }],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		page.send(commandInvocationFrame(bootstrap, "Overflow"));

		const result = await waitForValue(
			() => frames.find(isCommandResult),
			5000,
			"command-result naming the output truncation",
		);
		expect(result.ok).toBe(false);
		expect((result.output ?? "") + (result.error ?? "")).toMatch(/truncat/i);

		const pid = Number(readFileSync(pidFile, "utf8").trim());
		await waitForProcessExit(pid, 2000);
		page.close();
	}, 15_000);
});

describe("$ dispatch bounds: concurrency", () => {
	it("rejects the invocation past DISPATCH_MAX_CONCURRENT_PER_SESSION on the same session with a distinct concurrency reason, and the admitted ones still complete", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[{ label: "Sleep", argv: ["sleep", "1"], params: [] }],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);
		for (let i = 0; i < DISPATCH_MAX_CONCURRENT_PER_SESSION + 1; i++) {
			page.send(commandInvocationFrame(bootstrap, "Sleep"));
		}

		const rejected = await waitForValue(
			() => frames.filter(isCommandResult).find((f) => f.ok === false),
			3000,
			"an immediate per-session concurrency rejection",
		);
		expect(rejected.error ?? "").toMatch(/concurrent/i);

		const succeeded = await waitForValue(
			() => {
				const done = frames.filter(isCommandResult).filter((f) => f.ok);
				return done.length >= DISPATCH_MAX_CONCURRENT_PER_SESSION
					? done
					: undefined;
			},
			3000,
			"the admitted invocations to complete",
		);
		expect(succeeded.length).toBe(DISPATCH_MAX_CONCURRENT_PER_SESSION);
		page.close();
	}, 15_000);

	it("rejects the invocation past DISPATCH_MAX_CONCURRENT_DAEMON_WIDE from a session with no in-flight commands of its own", async () => {
		const { port, bootstrap: main } = await startWithSession();
		scratchDir = scratchScriptDir();

		const activeSessionCount =
			DISPATCH_MAX_CONCURRENT_DAEMON_WIDE / DISPATCH_MAX_CONCURRENT_PER_SESSION;
		const sessions: DispatchCredentials[] = [main];
		for (let i = 0; i < activeSessionCount - 1; i++) {
			const spawned = await spawnSession(dgHome, port, main.sessionId, {
				agentIdentity: `dispatch-bound-${i}`,
			});
			sessions.push(spawned);
		}
		const idleSession = await spawnSession(dgHome, port, main.sessionId, {
			agentIdentity: "dispatch-bound-idle",
		});

		for (const session of [...sessions, idleSession]) {
			await publishManifest(
				dgHome,
				port,
				session.sessionId,
				[{ label: "Sleep", argv: ["sleep", "2"], params: [] }],
				scratchDir,
			);
		}

		const page = wsExtensionSocket(port);
		openSockets.push(page);
		await waitForOpen(page);
		for (const session of [...sessions, idleSession]) {
			sendConnectHandshake(page, session, CHAT_PROTOCOL_VERSION);
			await new Promise((r) => setTimeout(r, 30));
		}
		const frames = collectFrames(page);

		for (const session of sessions) {
			for (let i = 0; i < DISPATCH_MAX_CONCURRENT_PER_SESSION; i++) {
				page.send(commandInvocationFrame(session, "Sleep"));
			}
		}
		await new Promise((r) => setTimeout(r, 200));

		page.send(commandInvocationFrame(idleSession, "Sleep"));

		const rejected = await waitForValue(
			() => frames.filter(isCommandResult).find((f) => f.ok === false),
			3000,
			"an immediate daemon-wide concurrency rejection",
		);
		expect(rejected.error ?? "").toMatch(/daemon|capacity|too many/i);

		const succeeded = await waitForValue(
			() => {
				const done = frames.filter(isCommandResult).filter((f) => f.ok);
				return done.length >= 8 ? done : undefined;
			},
			4000,
			"all 8 admitted invocations to complete",
		);
		expect(succeeded.length).toBe(8);
		page.close();
	}, 30_000);
});

describe("$ dispatch bounds: per-session rate ceiling", () => {
	it("rejects further invocations once a low per-entry maxInvocationsPerMinute override is exceeded, with a reason distinct from concurrency", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishManifest(
			dgHome,
			port,
			bootstrap.sessionId,
			[
				{
					label: "Echo",
					argv: ["echo", "hi"],
					params: [],
					limits: { maxInvocationsPerMinute: 3 },
				},
			],
			scratchDir,
		);

		const page = await connectedPage(port, bootstrap);
		const frames = collectFrames(page);

		let rejection: { ok: boolean; error?: string } | undefined;
		for (let i = 0; i < 6 && !rejection; i++) {
			page.send(commandInvocationFrame(bootstrap, "Echo"));
			const result = await waitForNthCommandResult(frames, i, 3000);
			if (!result.ok) rejection = result;
		}

		expect(rejection).toBeDefined();
		expect(rejection?.error ?? "").toMatch(/rate|per minute|too many/i);
		page.close();
	}, 30_000);
});
