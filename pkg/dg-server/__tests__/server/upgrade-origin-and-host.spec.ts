import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import {
	allocatePort,
	BROWSER_ORIGIN,
	cleanupDgHome,
	EXTENSION_ORIGIN,
	freshDgHome,
	sendConnectHandshake,
	spawnServe,
	stopServe,
	waitForHealth,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
	await cleanup?.();
	cleanup = undefined;
});

async function bootServe() {
	const dgHome = freshDgHome();
	const port = allocatePort();
	const proc = spawnServe(dgHome, port);
	await waitForHealth(port);
	cleanup = async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	};
	return port;
}

/** POST /start directly, mirroring bootstrap.ts's registerSession — no CLI daemonize dance needed against an already-serving process. */
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

// fetch(), not WebSocket: Bun's fetch() doesn't strip Host/Upgrade/Origin, so a
// refusal shows up as the plain Response returned when srv.upgrade() is skipped.
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
	// /health deliberately bypasses this guard (its own Host/Origin check 204s
	// instead) — /status goes through the shared requireLoopbackHost 400 branch.
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
		expect(resp.status).not.toBe(101);
	});
});

describe("/cli upgrade route", () => {
	it("rejects any browser Origin regardless of the rest of the handshake", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/cli", {
			Host: `127.0.0.1:${port}`,
			Origin: BROWSER_ORIGIN,
		});
		expect(resp.status).not.toBe(101);
	});

	// Distinct from the "unknown token" capability-set.spec.ts case: this hits
	// the `!sessionId || !token` short-circuit, not registry.validate() itself.
	it("rejects an upgrade carrying neither session header at all", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/cli", {
			Host: `127.0.0.1:${port}`,
		});
		expect(resp.status).not.toBe(101);
		expect(resp.status).toBe(401);
	});
});

describe("/ws upgrade route", () => {
	it("rejects an upgrade with no Origin header at all", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
		});
		expect(resp.status).not.toBe(101);
	});

	it("rejects a non-extension-scheme Origin", async () => {
		const port = await bootServe();
		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: "https://example.com",
		});
		expect(resp.status).not.toBe(101);
	});
});

describe("trust-on-first-use origin pinning", () => {
	it("pins the first token-proven extension origin and refuses a later upgrade from a different one", async () => {
		const port = await bootServe();
		const bootstrap = await registerSession(port);

		const first = wsExtensionSocket(port); // EXTENSION_ORIGIN — see daemon-harness.ts
		await waitForOpen(first);
		sendConnectHandshake(first, bootstrap, CHAT_PROTOCOL_VERSION);
		await new Promise((r) => setTimeout(r, 300)); // let the TOFU commit land server-side
		first.close();

		const resp = await upgradeRequest(port, "/ws", {
			Host: `127.0.0.1:${port}`,
			Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		});
		expect(resp.status).not.toBe(101);
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
});
