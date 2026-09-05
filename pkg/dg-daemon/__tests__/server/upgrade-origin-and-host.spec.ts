import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { clearPinnedOrigin } from "../../src/server/origin";
import {
	BROWSER_ORIGIN,
	bootServe as bootDaemonServe,
	cleanupDgHome,
	createCleanupSlot,
	EXTENSION_ORIGIN,
	sendConnectHandshake,
	stopServe,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function bootServe() {
	const { dgHome, port, proc } = await bootDaemonServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return port;
}

async function bootServeWithHome() {
	const { dgHome, port, proc } = await bootDaemonServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return { port, dgHome };
}

async function registerSession(port: number) {
	const resp = await fetch(`http://127.0.0.1:${port}/start`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ cwd: process.cwd(), role: "agent" }),
	});
	return validateSessionBootstrap(await resp.json());
}

function upgradeRequest(
	port: number,
	path: string,
	headers: Record<string, string>,
) {
	return fetch(`http://127.0.0.1:${port}${path}`, {
		headers: {
			Connection: "Upgrade",
			Upgrade: "websocket",
			"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			"Sec-WebSocket-Version": "13",
			...headers,
		},
	});
}

describe("Host header — DNS-rebinding defense", () => {
	it("refuses a plain request whose Host header is not the loopback authority", async () => {
		const port = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/status`, {
			headers: { Host: "attacker.example:1234" },
		});
		expect(resp.status).toBe(400);
	});

	it("refuses an upgrade whose Host header names the wrong port", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port + 1}`,
			Origin: EXTENSION_ORIGIN,
		});
		expect(resp.status).toBe(400);
	});
});

describe("/cli upgrade route", () => {
	it("rejects any browser Origin regardless of the rest of the handshake", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/cli", {
			Host: `127.0.0.1:${port}`,
			Origin: BROWSER_ORIGIN,
		});
		expect(resp.status).toBe(400);
	});

	it("rejects an upgrade carrying neither session header at all", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/cli", {
			Host: `127.0.0.1:${port}`,
		});
		expect(resp.status).toBe(401);
	});
});

describe("/ws upgrade route", () => {
	it("rejects an upgrade with no Origin header at all", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
		});
		expect(resp.status).toBe(400);
	});

	it("rejects a non-extension-scheme Origin", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: "https://example.com",
		});
		expect(resp.status).toBe(400);
	});
});

describe("trust-on-first-use origin pinning", () => {
	it("pins the first token-proven extension origin and refuses a later upgrade from a different one", async () => {
		const port = await bootServe();
		const bootstrap = await registerSession(port);

		const first = wsExtensionSocket(port);
		await waitForOpen(first);
		sendConnectHandshake(first, bootstrap, CHAT_PROTOCOL_VERSION);
		await new Promise((r) => setTimeout(r, 300));
		first.close();

		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		});
		expect(resp.status).toBe(400);
	});

	it("still accepts the pinned origin itself on a second, independent upgrade", async () => {
		const port = await bootServe();
		const bootstrap = await registerSession(port);

		const first = wsExtensionSocket(port);
		await waitForOpen(first);
		sendConnectHandshake(first, bootstrap, CHAT_PROTOCOL_VERSION);
		await new Promise((r) => setTimeout(r, 300));
		first.close();

		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: EXTENSION_ORIGIN,
		});
		expect(resp.status).toBe(101);
	});

	it("names the recovery command in the mismatch refusal, instead of dead-ending the operator", async () => {
		const port = await bootServe();
		const bootstrap = await registerSession(port);

		const first = wsExtensionSocket(port);
		await waitForOpen(first);
		sendConnectHandshake(first, bootstrap, CHAT_PROTOCOL_VERSION);
		await new Promise((r) => setTimeout(r, 300));
		first.close();

		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		});
		expect(resp.status).toBe(400);
		expect(await resp.text()).toContain("dg-daemon origin clear");
	});

	it("lets a different origin pin once the previous pin is cleared", async () => {
		const { port, dgHome } = await bootServeWithHome();
		const bootstrap = await registerSession(port);

		const first = wsExtensionSocket(port);
		await waitForOpen(first);
		sendConnectHandshake(first, bootstrap, CHAT_PROTOCOL_VERSION);
		await new Promise((r) => setTimeout(r, 300));
		first.close();

		const otherOrigin = "chrome-extension://cccccccccccccccccccccccccccccccc";
		const stillRefused = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: otherOrigin,
		});
		expect(stillRefused.status).toBe(400);

		clearPinnedOrigin(resolveDgPaths({ env: { DG_HOME: dgHome } }));

		const nowAccepted = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: otherOrigin,
		});
		expect(nowAccepted.status).toBe(101);
	});
});
