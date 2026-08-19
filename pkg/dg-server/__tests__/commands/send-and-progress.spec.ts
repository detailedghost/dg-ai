/**
 * `send` (whole agent messages) and `progress` (interim running/awaiting-input
 * frames) — Testing Criteria: "send and status produce frames that
 * validateChatFrame accepts, and status carries the explicit state."
 *
 * [SPEC] ASSUMED: the CLI verb is named `progress`, not `status` — plan.md's
 * own prose says "status", but `dg-server status` already exists (slice 2's
 * daemon-status report) and the wire discriminant is ratified as `progress`,
 * not `status`. Reusing the same name for a second, unrelated meaning would
 * collide in the same commander program. See deferrals.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	validateChatFrame,
	validateSessionBootstrap,
} from "@dg/common";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	sendConnectHandshake,
	waitForHealth,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { nextParsedMessage, runCli } from "./cli-wire";

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
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

describe("dg-server send", () => {
	it("delivers an agent-message frame that validateChatFrame accepts, to a listening page", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // the session-list sent on handshake

		const cliDone = runCli(dgHome, port, [
			"send",
			"--session",
			bootstrap.sessionId,
			"the agent's whole reply",
		]);
		const frame = await nextParsedMessage(page);
		await cliDone;
		page.close();

		const validated = validateChatFrame(frame);
		expect(validated.type).toBe("agent-message");
		expect((validated as { body: string }).body).toBe(
			"the agent's whole reply",
		);
		expect(validated.sessionId).toBe(bootstrap.sessionId);
	});
});

describe("dg-server progress", () => {
	it("delivers a progress frame carrying the explicit state, accepted by validateChatFrame", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page); // session-list

		const cliDone = runCli(dgHome, port, [
			"progress",
			"--session",
			bootstrap.sessionId,
			"--state",
			"awaiting-input",
		]);
		const frame = await nextParsedMessage(page);
		await cliDone;
		page.close();

		const validated = validateChatFrame(frame);
		expect(validated.type).toBe("progress");
		expect((validated as { state: string }).state).toBe("awaiting-input");
	});

	it("rejects an unrecognized --state value before ever reaching the daemon", async () => {
		const { port, bootstrap } = await startWithSession();

		const result = await runCli(dgHome, port, [
			"progress",
			"--session",
			bootstrap.sessionId,
			"--state",
			"not-a-real-state",
		]);

		expect(result.exitCode).not.toBe(0);
	});
});
