import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_MAX_PAYLOAD_BYTES, CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	cleanupDgHome,
	collectFrames,
	connectCli,
	frameType,
	killDaemonByPidFile,
	readDaemonLog,
	send,
	startWithSession,
	waitForClose,
	waitForValue,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

async function bootSession() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	return started;
}

describe("oversized payload", () => {
	it("rejects a frame exceeding CHAT_MAX_PAYLOAD_BYTES without processing it as valid", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);

		const oversized = "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1024);
		ws.send(oversized);

		const outcome = await Promise.race([
			waitForClose(ws, 3000).then(() => "closed" as const),
			waitForValue(
				() => frames.find((f) => frameType(f) === "error"),
				3000,
				"an oversized-payload error frame",
			).then(() => "errored" as const),
		]);
		expect(["closed", "errored"]).toContain(outcome);
		expect(frames.some((f) => frameType(f) === "ack")).toBe(false);
	});

	it("leaves the connection usable afterward — no corrupting store side effect", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		ws.send("x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1024));
		await new Promise((r) => setTimeout(r, 300));

		expect(ws.readyState).toBe(WebSocket.OPEN);
		send(ws, {
			type: "history-request",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		const reply = await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { sessionId?: string }).sessionId === bootstrap.sessionId,
				),
			2000,
			"a normal history-response after the oversized attempt",
		);
		expect(frameType(reply)).toBe("history-response");
	});
});

describe("history-response payload budget", () => {
	it("answers a transcript larger than one frame with the newest items that fit, rather than an oversized frame the client drops whole", async () => {
		const { port, bootstrap } = await bootSession();
		const { ChatStore } = await import("../../src/store");
		const writer = await ChatStore.open(
			resolveDgPaths({ env: { DG_HOME: dgHome } }),
			{ env: { DG_KEY_SOURCE: "file" } },
		);
		for (let i = 0; i < 6; i++) {
			writer.insertMessage({
				sessionId: bootstrap.sessionId,
				id: `bulk-${i}`,
				role: "user",
				body: "x".repeat(250_000),
			});
		}
		writer.close();

		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		send(ws, {
			type: "history-request",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});

		const reply = (await waitForValue(
			() => frames.find((f) => frameType(f) === "history-response"),
			5000,
			"a history-response",
		)) as { messages: { id: string }[] };

		expect(new TextEncoder().encode(JSON.stringify(reply)).length).toBeLessThan(
			CHAT_MAX_PAYLOAD_BYTES,
		);
		expect(reply.messages.length).toBeGreaterThan(0);
		expect(reply.messages.length).toBeLessThan(6);
		expect(reply.messages.at(-1)?.id).toBe("bulk-5");
		ws.close();
	}, 20_000);
});

describe("protocol-version mismatch vs. unrecognized frame type", () => {
	it("refuses each with a distinct message", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);

		send(ws, {
			type: "history-request",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION + 99,
		});
		const versionError = await waitForValue(
			() => frames.find((f) => frameType(f) === "error"),
			2000,
			"a protocol-version-mismatch error",
		);
		frames.length = 0;

		send(ws, {
			type: "future-frame-type-not-yet-ratified",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		const schemaError = await waitForValue(
			() => frames.find((f) => frameType(f) === "error"),
			2000,
			"an unrecognized-frame-type error",
		);

		expect((versionError as { message: string }).message).not.toBe(
			(schemaError as { message: string }).message,
		);
	});
});

describe("repeated invalid frames", () => {
	it("closes the connection after a small budget, without ever logging the real or a rejected token", async () => {
		const { port, bootstrap, dgHome: home } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);

		const REJECTED_TOKEN = "REJECTED-TOKEN-MARKER-9f3a1c";
		send(ws, {
			type: "session-close",
			sessionId: bootstrap.sessionId,
			token: REJECTED_TOKEN,
		});
		await waitForValue(
			() => frames.find((f) => frameType(f) === "error"),
			2000,
			"a rejection of the fabricated token",
		);

		for (let i = 0; i < 25 && ws.readyState === WebSocket.OPEN; i++) {
			ws.send(`not valid json #${i}`);
		}
		await waitForClose(ws, 5000);

		await new Promise((r) => setTimeout(r, 300));
		const log = readDaemonLog(home);
		expect(log.length).toBeGreaterThan(0);
		expect(log).not.toContain(bootstrap.token);
		expect(log).not.toContain(REJECTED_TOKEN);
	});
});
