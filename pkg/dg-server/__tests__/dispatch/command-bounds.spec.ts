/**
 * $ dispatch's resource bounds — wall clock, output cap, concurrency (per
 * session and daemon-wide), and the per-session rate ceiling — each proven
 * to reject with its own distinct, observable reason and to actually kill
 * the child's whole process group, not merely report a timeout.
 *
 * [SPEC] invented — plan.md leaves the per-entry override SHAPE unnamed
 * ("each overridable per entry but clamped to a daemon maximum"); this file
 * proposes CommandEntry.limits = { timeoutMs?, maxOutputBytes?,
 * maxConcurrentPerSession?, maxInvocationsPerMinute? }, used here only for
 * timeoutMs (a real 30s wait is untenable in a test) and
 * maxInvocationsPerMinute (the daemon's own default ceiling number is
 * unspecified, so a low override is the only deterministic way to test it
 * without guessing it). See deferrals for the full recommendation.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { runCli } from "../commands/cli-wire";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	sendConnectHandshake,
	waitForHealth,
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
// A throw skips a test's own page.close() — track every socket so afterEach
// always closes it, rather than leaking a connection past the daemon's own death.
let openSockets: WebSocket[] = [];

afterEach(() => {
	killDaemonByLockfile(dgHome);
	for (const socket of openSockets) socket.close();
	openSockets = [];
	cleanupDgHome(dgHome);
	if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
});

async function startWithSession() {
	dgHome = freshDgHome();
	const port = allocatePort();
	const result = await runStart(dgHome, port);
	await waitForHealth(port);
	const bootstrap = validateSessionBootstrap(
		decodeChatMarker(extractUrl(result.stdout)),
	);
	return { port, bootstrap };
}

async function connectedPage(
	port: number,
	credentials: DispatchCredentials,
): Promise<WebSocket> {
	const page = wsExtensionSocket(port);
	openSockets.push(page);
	await waitForOpen(page);
	sendConnectHandshake(page, credentials, CHAT_PROTOCOL_VERSION);
	await new Promise((r) => setTimeout(r, 100));
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
		// The group kill (TERM then KILL) must have actually happened, not
		// merely been reported in the failure frame.
		await waitForProcessExit(Number(pidText), 2000);
		page.close();
	}, 20_000); // several sequential waits (5s + 2s + 2s) — stay clear of bun:test's own default
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
	it("rejects a 3rd concurrent invocation on the same session with a distinct concurrency reason, and the first two still complete", async () => {
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
		page.send(commandInvocationFrame(bootstrap, "Sleep"));
		page.send(commandInvocationFrame(bootstrap, "Sleep"));
		page.send(commandInvocationFrame(bootstrap, "Sleep"));

		// Generous window on the *reject* side — the property under test is
		// "rejected before the sleep-1 admits finish", not a strict millisecond budget.
		const rejected = await waitForValue(
			() => frames.filter(isCommandResult).find((f) => f.ok === false),
			3000,
			"an immediate per-session concurrency rejection",
		);
		expect(rejected.error ?? "").toMatch(/concurrent/i);

		const succeeded = await waitForValue(
			() => {
				const done = frames.filter(isCommandResult).filter((f) => f.ok);
				return done.length >= 2 ? done : undefined;
			},
			3000,
			"the two admitted invocations to complete",
		);
		expect(succeeded.length).toBe(2);
		page.close();
	}, 15_000);

	it("rejects a 9th daemon-wide-concurrent invocation from a session with no in-flight commands of its own", async () => {
		const { port, bootstrap: main } = await startWithSession();
		scratchDir = scratchScriptDir();

		const sessions: DispatchCredentials[] = [main];
		for (let i = 0; i < 3; i++) {
			const spawned = await runCli(dgHome, port, [
				"spawn",
				"--session",
				main.sessionId,
				"--agent-identity",
				`dispatch-bound-${i}`,
			]);
			expect(spawned.exitCode).toBe(0);
			sessions.push(JSON.parse(spawned.stdout.trim()) as DispatchCredentials);
		}
		const fifth = await runCli(dgHome, port, [
			"spawn",
			"--session",
			main.sessionId,
			"--agent-identity",
			"dispatch-bound-idle",
		]);
		expect(fifth.exitCode).toBe(0);
		const idleSession = JSON.parse(fifth.stdout.trim()) as DispatchCredentials;

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

		// 4 sessions x 2 in flight each = 8, the daemon-wide cap — none of it
		// tripping any single session's own 2-concurrent bound.
		for (const session of sessions) {
			page.send(commandInvocationFrame(session, "Sleep"));
			page.send(commandInvocationFrame(session, "Sleep"));
		}
		await new Promise((r) => setTimeout(r, 200));

		// The 9th, from a session sitting at zero in-flight commands of its own.
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
	}, 30_000); // heavy setup: 4 spawns + 5 manifest publishes, each its own subprocess
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
	}, 30_000); // up to 6 sequential 3s waits in the worst case
});
