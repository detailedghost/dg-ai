import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { CHAT_PROTOCOL_VERSION, PW_EXT_MIN_EXTENSION_VERSION } from "@dg/common";
import {
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	frameType,
	killDaemonByPidFile,
	send,
	startWithSession,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

type Frame = Record<string, unknown>;
const sockets: WebSocket[] = [];
let dgHome: string | undefined;

afterEach(() => {
	closeSockets(sockets);
	if (dgHome) {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	}
	dgHome = undefined;
});

async function boot() {
	const started = await startWithSession();
	dgHome = started.dgHome;
	const cli = await connectCli(started.port, started.bootstrap);
	sockets.push(cli);
	const cliFrames = collectFrames(cli);
	const socket = wsExtensionSocket(started.port);
	sockets.push(socket);
	const extensionFrames = collectFrames(socket);
	await waitForOpen(socket);
	send(socket, { type: "connect", ...started.bootstrap, extensionVersion: PW_EXT_MIN_EXTENSION_VERSION.join(".") });
	await waitForValue(() => extensionFrames.find((frame) => frameType(frame) === "session-list"), 700, "extension handshake");
	return { ...started, cli, cliFrames, socket, extensionFrames };
}

function request(cli: WebSocket): string {
	const requestId = randomUUID();
	send(cli, { type: "cli-pw-ext-request", requestId, request: { verb: "tabs" }, timeoutMs: 3000 });
	return requestId;
}

const stopFrame = (credentials: { sessionId: string; token: string }) => ({
	type: "pw-ext-stop",
	protocolVersion: CHAT_PROTOCOL_VERSION,
	sessionId: credentials.sessionId,
	token: credentials.token,
});

const refusalOf = (cliFrames: unknown[], id: string) =>
	cliFrames.find((f) => (f as Frame).type === "cli-pw-ext-result" && (f as Frame).requestId === id && (f as Frame).ok === false) as Frame | undefined;

const errorFrames = (frames: unknown[]) => frames.filter((f) => frameType(f) === "error");

describe("pw --ext Stop revoke", () => {
	it("relays a request before the extension reports a Stop", async () => {
		const { cli, extensionFrames } = await boot();
		const id = request(cli);
		await waitForValue(() => extensionFrames.find((f) => (f as Frame).requestId === id), 1500, "relayed");
	});

	it("refuses every later request of a stopped session", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		send(socket, stopFrame(bootstrap));
		request(cli);
		const result = await waitForValue(
			() => {
				const refusal = cliFrames.find((f) => (f as Frame).type === "cli-pw-ext-result" && (f as Frame).ok === false) as Frame | undefined;
				if (!refusal) request(cli);
				return refusal;
			},
			3000,
			"refusal",
		);
		expect(String(result.error)).toContain("Stop");
		expect(extensionFrames.some((f) => (f as Frame).requestId === result.requestId)).toBe(false);
	});

	it("ignores a Stop that comes from a socket that is not the extension", async () => {
		const { cli, cliFrames, extensionFrames, bootstrap } = await boot();
		send(cli, stopFrame(bootstrap));
		const id = request(cli);
		await waitForValue(() => extensionFrames.find((f) => (f as Frame).requestId === id), 1500, "relayed");
		expect(refusalOf(cliFrames, id)).toBeUndefined();
	});

	it("ignores a Stop with a wrong session token", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		send(socket, { ...stopFrame(bootstrap), token: "wrong" });
		await waitForValue(() => errorFrames(extensionFrames)[0], 1500, "rejection of the Stop");
		const id = request(cli);
		await waitForValue(() => extensionFrames.find((f) => (f as Frame).requestId === id), 1500, "relayed");
		expect(refusalOf(cliFrames, id)).toBeUndefined();
	});

	it("ignores a Stop that pairs the session token with another session id", async () => {
		const { cli, cliFrames, socket, extensionFrames, bootstrap } = await boot();
		send(socket, stopFrame({ sessionId: randomUUID(), token: bootstrap.token }));
		await waitForValue(() => errorFrames(extensionFrames)[0], 1500, "rejection of the Stop");
		const id = request(cli);
		await waitForValue(() => extensionFrames.find((f) => (f as Frame).requestId === id), 1500, "relayed");
		expect(refusalOf(cliFrames, id)).toBeUndefined();
	});
});
