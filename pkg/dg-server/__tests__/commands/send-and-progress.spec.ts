import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateChatFrame } from "@dg/common";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	killDaemonByPidFile,
	sendConnectHandshake,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { nextParsedMessage, runCli } from "./cli-wire";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

async function startWithSession() {
	const started = await bootDaemonSession();
	dgHome = started.dgHome;
	return started;
}

describe("dg-server send", () => {
	it("delivers an agent-message frame that validateChatFrame accepts, to a listening page", async () => {
		const { port, bootstrap } = await startWithSession();
		const page = wsExtensionSocket(port);
		await waitForOpen(page);
		sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
		await nextParsedMessage(page);

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
		await nextParsedMessage(page);

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
