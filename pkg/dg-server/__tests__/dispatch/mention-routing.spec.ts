/**
 * @ mention resolution on user-message: an @ anywhere in the body is
 * resolved against the session's published subagent list and carried on the
 * queued message via the already-ratified resolved-subagent-name field; an
 * unresolved mention still delivers, unchanged, with that field absent —
 * never refusing the whole message over a typo.
 *
 * [SPEC] invented — ChatStore's insertMessage/ClaimedMessage/PeekedMessage
 * (ratified in Code Structure's layer-2 subsection) carry no field for this
 * yet. Proposed: subagentName?: string, mirroring the already-shipped
 * attachmentId?: string shape, populated from the wire frame's own
 * already-ratified user-message.subagentName. See deferrals.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { runCli } from "../commands/cli-wire";
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
import {
	type DispatchCredentials,
	publishSubagents,
	scratchScriptDir,
} from "./dispatch-wire";

let dgHome: string;
let scratchDir: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
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

async function deliverUserMessage(
	port: number,
	credentials: DispatchCredentials,
	body: string,
): Promise<void> {
	const page = wsExtensionSocket(port);
	await waitForOpen(page);
	sendConnectHandshake(page, credentials, CHAT_PROTOCOL_VERSION);
	await new Promise((r) => setTimeout(r, 100));
	page.send(
		JSON.stringify({
			type: "user-message",
			sessionId: credentials.sessionId,
			token: credentials.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			messageId: randomUUID(),
			body,
		}),
	);
	await new Promise((r) => setTimeout(r, 150));
	page.close();
}

describe("@ mention resolution", () => {
	it("resolves an inline @mention against the published subagent list and carries it on the queued message recv delivers", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishSubagents(
			dgHome,
			port,
			bootstrap.sessionId,
			["reviewer", "planner"],
			scratchDir,
		);

		// No recv is parked when this arrives — the "no reader" case, which
		// rides slice 3's ordinary claim-lease queue with no new mechanism.
		const body = "could @reviewer take a look at this";
		await deliverUserMessage(port, bootstrap, body);

		const recv = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"3000",
		]);
		expect(recv.exitCode).toBe(0);
		const parsed = JSON.parse(recv.stdout.trim());
		expect(parsed.message.body).toBe(body);
		expect(parsed.message.subagentName).toBe("reviewer");
	}, 10_000);

	it("passes an unresolved mention through as ordinary prose, delivered unchanged with no resolved-name field", async () => {
		const { port, bootstrap } = await startWithSession();
		scratchDir = scratchScriptDir();
		await publishSubagents(
			dgHome,
			port,
			bootstrap.sessionId,
			["reviewer"],
			scratchDir,
		);

		const body = "hey @totallyunregistered can you help";
		await deliverUserMessage(port, bootstrap, body);

		const recv = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"3000",
		]);
		expect(recv.exitCode).toBe(0);
		const parsed = JSON.parse(recv.stdout.trim());
		expect(parsed.message.body).toBe(body);
		expect(parsed.message.subagentName).toBeUndefined();
	}, 10_000);
});
