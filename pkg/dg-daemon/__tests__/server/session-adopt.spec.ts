import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateSessionAdopt } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { clearPinnedOrigin, getPinnedOrigin } from "../../src/server/origin";
import {
	bootServe,
	cleanupDgHome,
	closeSession,
	closeSockets,
	collectFrames,
	connectCli,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	frameType,
	ownerTokenHeader,
	registerSession,
	sendConnectHandshake,
	spawnSession,
	stopServe,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();
const sockets: WebSocket[] = [];

afterEach(async () => {
	closeSockets(sockets);
	await cleanupSlot.run();
});

async function boot() {
	const running = await bootServe();
	cleanupSlot.set(async () => {
		await stopServe(running.proc);
		cleanupDgHome(running.dgHome);
	});
	return running;
}

async function linkExtension(port: number) {
	const socket = wsExtensionSocket(port);
	sockets.push(socket);
	const frames = collectFrames(socket);
	await waitForOpen(socket);
	return { socket, frames };
}

function adoptFrames(frames: unknown[]) {
	return frames.filter((frame) => frameType(frame) === "session-adopt");
}

async function postStart(port: number) {
	return fetch(`http://127.0.0.1:${port}/start`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			...ownerTokenHeader(port),
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ cwd: process.cwd(), role: "agent" }),
	});
}

describe("zero-touch extension link", () => {
	it("pins the first extension origin on upgrade and refuses a second origin", async () => {
		const { port, dgHome } = await boot();
		await linkExtension(port);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(getPinnedOrigin(paths)).toBe(EXTENSION_ORIGIN);

		const second = await fetch(`http://127.0.0.1:${port}/ws`, {
			headers: {
				Host: `127.0.0.1:${port}`,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
				Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
		});
		expect(second.status).toBe(400);
	});

	it("refuses a foreign chrome extension origin while nothing is pinned", async () => {
		const { port, dgHome } = await boot();

		const refused = await fetch(`http://127.0.0.1:${port}/ws`, {
			headers: {
				Host: `127.0.0.1:${port}`,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
				Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
		});

		expect(refused.status).toBe(400);
		expect(
			getPinnedOrigin(resolveDgPaths({ env: { DG_HOME: dgHome } })),
		).toBeUndefined();
	});

	it("pins the first firefox extension origin on first contact", async () => {
		const { port, dgHome } = await boot();
		const Ctor = WebSocket as unknown as new (
			url: string,
			options: Bun.WebSocketOptions,
		) => WebSocket;
		const socket = new Ctor(`ws://127.0.0.1:${port}/ws`, {
			headers: { Origin: "moz-extension://11111111-2222-3333-4444-555555555555" },
		});
		sockets.push(socket);
		await waitForOpen(socket);

		expect(getPinnedOrigin(resolveDgPaths({ env: { DG_HOME: dgHome } }))).toBe(
			"moz-extension://11111111-2222-3333-4444-555555555555",
		);
	});

	it("stops pushing session-adopt to a socket whose origin is no longer pinned", async () => {
		const { port, dgHome } = await boot();
		const { frames } = await linkExtension(port);
		clearPinnedOrigin(resolveDgPaths({ env: { DG_HOME: dgHome } }));

		await registerSession(port);
		await Bun.sleep(200);

		expect(adoptFrames(frames)).toEqual([]);
	});

	it("replies extensionLinked true on /start while an extension socket is admitted", async () => {
		const { port } = await boot();
		await linkExtension(port);

		const body = await (await postStart(port)).json();

		expect(body).toMatchObject({ extensionLinked: true });
	});

	it("replies extensionLinked false on /start with no extension socket", async () => {
		const { port } = await boot();

		const body = await (await postStart(port)).json();

		expect(body).toMatchObject({ extensionLinked: false });
	});

	it("pushes session-adopt with the session bootstrap when /start registers a session", async () => {
		const { port } = await boot();
		const { frames } = await linkExtension(port);

		const credentials = await registerSession(port, {
			agentIdentity: "print-agent",
		});
		const frame = await waitForValue(
			() => adoptFrames(frames)[0],
			3000,
			"session-adopt after /start",
		);

		const adopted = validateSessionAdopt(frame);
		expect(adopted.bootstrap).toMatchObject({
			port,
			sessionId: credentials.sessionId,
			token: credentials.token,
			agentIdentity: "print-agent",
		});
		const health = await (await fetch(`http://127.0.0.1:${port}/healthz`, {
			headers: { Host: `127.0.0.1:${port}` },
		})).json();
		expect(adopted.bootstrap.daemonId).toBe(
			(health as { daemonId: string }).daemonId,
		);
	});

	it("pushes session-adopt when a /cli session-create frame makes a session", async () => {
		const { port, dgHome } = await boot();
		const parent = await registerSession(port);
		const { socket, frames } = await linkExtension(port);
		socket.send(JSON.stringify({ type: "link-ready" }));
		await waitForValue(() => adoptFrames(frames)[0], 3000, "replay push");
		frames.length = 0;

		const child = await spawnSession(dgHome, port, parent.sessionId, {
			agentIdentity: "child-agent",
		});
		const frame = await waitForValue(
			() => adoptFrames(frames)[0],
			3000,
			"session-adopt after session-create",
		);

		expect(validateSessionAdopt(frame).bootstrap).toMatchObject({
			sessionId: child.sessionId,
			token: child.token,
			agentIdentity: "child-agent",
		});
	});

	it("does not replay active sessions when an extension socket opens", async () => {
		const { port } = await boot();
		await registerSession(port);

		const { frames } = await linkExtension(port);
		await Bun.sleep(200);

		expect(adoptFrames(frames)).toEqual([]);
	});

	it("replays one session-adopt per active session after link-ready", async () => {
		const { port } = await boot();
		const first = await registerSession(port);
		const second = await registerSession(port);

		const { socket, frames } = await linkExtension(port);
		socket.send(JSON.stringify({ type: "link-ready" }));
		await waitForValue(
			() => (adoptFrames(frames).length >= 2 ? true : undefined),
			3000,
			"two session-adopt frames",
		);
		await Bun.sleep(100);

		const adopted = adoptFrames(frames).map(
			(frame) => validateSessionAdopt(frame).bootstrap.sessionId,
		);
		expect(adopted.sort()).toEqual([first.sessionId, second.sessionId].sort());
	});

	it("accepts link-ping on an extension socket without replying or closing it", async () => {
		const { port } = await boot();
		await registerSession(port);
		const { socket, frames } = await linkExtension(port);

		socket.send(JSON.stringify({ type: "link-ping" }));
		await Bun.sleep(200);

		expect(frames).toEqual([]);
		expect(socket.readyState).toBe(WebSocket.OPEN);
	});

	it("ignores link-ready from a /cli socket", async () => {
		const { port } = await boot();
		const credentials = await registerSession(port);
		const cli = await connectCli(port, credentials);
		sockets.push(cli);
		const cliFrames = collectFrames(cli);

		cli.send(JSON.stringify({ type: "link-ready" }));
		await Bun.sleep(200);

		expect(adoptFrames(cliFrames)).toEqual([]);
	});

	it("never pushes session-adopt to a /cli socket", async () => {
		const { port } = await boot();
		const credentials = await registerSession(port);
		const cli = await connectCli(port, credentials);
		sockets.push(cli);
		const cliFrames = collectFrames(cli);
		const { frames } = await linkExtension(port);

		await registerSession(port);
		await waitForValue(() => adoptFrames(frames)[0], 3000, "extension push");
		await Bun.sleep(100);

		expect(adoptFrames(cliFrames)).toEqual([]);
	});

	it("never pushes session-adopt to a local-page socket", async () => {
		const { port } = await boot();
		const credentials = await registerSession(port);
		const Ctor = WebSocket as unknown as new (
			url: string,
			options: Bun.WebSocketOptions,
		) => WebSocket;
		const page = new Ctor(
			`ws://127.0.0.1:${port}/ws?token=${credentials.token}`,
			{ headers: { Origin: `http://127.0.0.1:${port}` } },
		);
		sockets.push(page);
		const pageFrames = collectFrames(page);
		await waitForOpen(page);
		const { frames } = await linkExtension(port);

		await registerSession(port);
		await waitForValue(() => adoptFrames(frames)[0], 3000, "extension push");
		await Bun.sleep(100);

		expect(adoptFrames(pageFrames)).toEqual([]);
	});

	it("sends session-closed to a link socket that holds no capability for the session", async () => {
		const { port, dgHome } = await boot();
		const { frames } = await linkExtension(port);
		const credentials = await registerSession(port);
		await waitForValue(() => adoptFrames(frames)[0], 3000, "session-adopt push");

		await closeSession(dgHome, port, credentials.sessionId);

		const closed = await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-closed"),
			3000,
			"session-closed on the link socket",
		);
		expect((closed as { sessionId?: string }).sessionId).toBe(credentials.sessionId);
	});

	it("sends session-closed once to an extension socket that also holds the session", async () => {
		const { port, dgHome } = await boot();
		const credentials = await registerSession(port);
		const socket = wsExtensionSocket(port);
		sockets.push(socket);
		const frames = collectFrames(socket);
		await waitForOpen(socket);
		sendConnectHandshake(socket, credentials, CHAT_PROTOCOL_VERSION);
		await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-list"),
			3000,
			"session-list after the handshake",
		);

		await closeSession(dgHome, port, credentials.sessionId);
		await waitForValue(
			() => frames.find((frame) => frameType(frame) === "session-closed"),
			3000,
			"session-closed on the holding socket",
		);
		await Bun.sleep(100);

		expect(frames.filter((frame) => frameType(frame) === "session-closed")).toHaveLength(1);
	});
});
