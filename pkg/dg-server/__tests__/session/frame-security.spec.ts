import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
	CHAT_MAX_PAYLOAD_BYTES,
	CHAT_PROTOCOL_VERSION,
	validateSessionBootstrap,
} from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	connectCli,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	waitForClose,
	waitForHealth,
	waitForValue,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

async function bootSession() {
	dgHome = freshDgHome();
	const port = allocatePort();
	const result = await runStart(dgHome, port);
	await waitForHealth(port);
	const bootstrap = validateSessionBootstrap(
		decodeChatMarker(extractUrl(result.stdout)),
	);
	return { dgHome, port, bootstrap };
}

describe("oversized payload", () => {
	it("rejects a frame exceeding CHAT_MAX_PAYLOAD_BYTES without processing it as valid", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);

		const oversized = "x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1024);
		ws.send(oversized);

		// A store-affecting accept would surface as a normal frame reply
		// (e.g. an ack); the oversized send must never produce one.
		const outcome = await Promise.race([
			waitForClose(ws, 3000).then(() => "closed" as const),
			waitForValue(
				() => frames.find((f) => (f as { type?: string }).type === "error"),
				3000,
				"an oversized-payload error frame",
			).then(() => "errored" as const),
		]);
		expect(["closed", "errored"]).toContain(outcome);
		expect(frames.some((f) => (f as { type?: string }).type === "ack")).toBe(
			false,
		);
	});

	it("leaves the connection usable afterward — no corrupting store side effect", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);
		ws.send("x".repeat(CHAT_MAX_PAYLOAD_BYTES + 1024));
		await new Promise((r) => setTimeout(r, 300));

		if (ws.readyState !== WebSocket.OPEN) return; // budget closed it — covered above
		ws.send(
			JSON.stringify({
				type: "history-request",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		const reply = await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { sessionId?: string }).sessionId === bootstrap.sessionId,
				),
			2000,
			"a normal history-response after the oversized attempt",
		);
		expect((reply as { type?: string }).type).not.toBe("error");
	});
});

describe("protocol-version mismatch vs. unrecognized frame type", () => {
	it("refuses each with a distinct message", async () => {
		const { port, bootstrap } = await bootSession();
		const ws = await connectCli(port, bootstrap);
		const frames = collectFrames(ws);

		ws.send(
			JSON.stringify({
				type: "history-request",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION + 99,
			}),
		);
		const versionError = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a protocol-version-mismatch error",
		);
		frames.length = 0;

		ws.send(
			JSON.stringify({
				type: "future-frame-type-not-yet-ratified",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		const schemaError = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
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

		// Drive one actual rejected-credential path so the "no rejected token in
		// logs" half of the contract has something to fail against.
		const REJECTED_TOKEN = "REJECTED-TOKEN-MARKER-9f3a1c";
		ws.send(
			JSON.stringify({
				type: "session-close",
				sessionId: bootstrap.sessionId,
				token: REJECTED_TOKEN,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of the fabricated token",
		);

		for (let i = 0; i < 25 && ws.readyState === WebSocket.OPEN; i++) {
			ws.send(`not valid json #${i}`);
		}
		await waitForClose(ws, 5000);

		await new Promise((r) => setTimeout(r, 300)); // let any log write flush
		const logPath = resolveDgPaths({ env: { DG_HOME: home } }).logPath;
		expect(existsSync(logPath)).toBe(true);
		const log = readFileSync(logPath, "utf8");
		expect(log).not.toContain(bootstrap.token);
		expect(log).not.toContain(REJECTED_TOKEN);
	});
});
