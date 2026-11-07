import { afterEach, describe, expect, it } from "bun:test";
import { validateSessionAdopt } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { getPinnedOrigin } from "../../src/server/origin";
import {
	bootServe,
	cleanupDgHome,
	closeSockets,
	collectFrames,
	connectCli,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	frameType,
	ownerTokenHeader,
	registerSession,
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
		const { frames } = await linkExtension(port);
		await waitForValue(() => adoptFrames(frames)[0], 3000, "connect push");
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

	it("pushes one session-adopt per active session when an extension socket connects", async () => {
		const { port } = await boot();
		const first = await registerSession(port);
		const second = await registerSession(port);

		const { frames } = await linkExtension(port);
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
});
