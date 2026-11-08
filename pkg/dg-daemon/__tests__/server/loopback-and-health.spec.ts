import { afterEach, describe, expect, it } from "bun:test";
import { networkInterfaces } from "node:os";
import {
	CHAT_HEALTH_PATH,
	CHAT_LEGACY_HEALTH_PATH,
	CHAT_MAX_ASSET_BYTES,
	CHAT_PROTOCOL_VERSION,
} from "@dg/common";
import {
	bootServe as bootDaemonServe,
	cleanupDgHome,
	createCleanupSlot,
	freshDgHome,
	ownerTokenHeader,
	spawnServe,
	stopServe,
	waitForDaemonExit,
	waitForHealth,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function bootServe() {
	const { dgHome, port, proc } = await bootDaemonServe();
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return { dgHome, port };
}

describe("request bodies the daemon refuses at the socket layer", () => {
	it("refuses a POST /start body larger than CHAT_MAX_ASSET_BYTES without parsing it", async () => {
		const { port } = await bootServe();
		const bloated = `{"cwd":"/tmp","pad":"${"a".repeat(CHAT_MAX_ASSET_BYTES + 1024)}"}`;

		const resp = await fetch(`http://127.0.0.1:${port}/start`, {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				...ownerTokenHeader(port),
				"Content-Type": "application/json",
			},
			body: bloated,
		});

		expect(resp.status).toBe(413);
	});

	it("still accepts an ordinary POST /start body", async () => {
		const { port } = await bootServe();

		const resp = await fetch(`http://127.0.0.1:${port}/start`, {
			method: "POST",
			headers: {
				Host: `127.0.0.1:${port}`,
				...ownerTokenHeader(port),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ cwd: process.cwd() }),
		});

		expect(resp.status).toBe(200);
	});
});

describe("GET /healthz", () => {
	it("still answers the legacy /health path, for an extension the user has not reloaded", async () => {
		const { port } = await bootServe();

		const legacy = await fetch(
			`http://127.0.0.1:${port}${CHAT_LEGACY_HEALTH_PATH}`,
			{ headers: { Host: `127.0.0.1:${port}` } },
		);
		const current = await fetch(`http://127.0.0.1:${port}${CHAT_HEALTH_PATH}`, {
			headers: { Host: `127.0.0.1:${port}` },
		});

		expect(legacy.status).toBe(200);
		expect(await legacy.json()).toEqual(await current.json());
	});

	it("returns exactly the four published fields, matching CHAT_PROTOCOL_VERSION", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/healthz`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Object.keys(body).sort()).toEqual(
			["daemon", "daemonId", "instanceId", "protocolVersion"].sort(),
		);
		expect(body.protocolVersion).toBe(CHAT_PROTOCOL_VERSION);
		expect(typeof body.instanceId).toBe("string");
		expect((body.instanceId as string).length).toBeGreaterThan(0);
		expect((body.daemonId as string).length).toBeGreaterThan(0);
	});

	it("keeps daemonId across a restart while instanceId changes", async () => {
		const { dgHome, port, proc } = await bootDaemonServe();
		const health = async () =>
			(await (
				await fetch(`http://127.0.0.1:${port}${CHAT_HEALTH_PATH}`, {
					headers: { Host: `127.0.0.1:${port}` },
				})
			).json()) as { daemonId: string; instanceId: string };
		const first = await health();
		await stopServe(proc);
		await waitForDaemonExit(dgHome);
		const second = spawnServe(dgHome, port);
		cleanupSlot.set(async () => {
			await stopServe(second);
			cleanupDgHome(dgHome);
		});
		await waitForHealth(port);

		const restarted = await health();

		expect(first.daemonId).toBeString();
		expect(restarted.daemonId).toBe(first.daemonId);
		expect(restarted.instanceId).not.toBe(first.instanceId);
	});

	it("204s a caller whose Host header is not the loopback authority", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/healthz`, {
			headers: { Host: "evil.example:9999" },
		});
		expect(resp.status).toBe(204);
	});

	it("204s a browser-Origin caller even with a correct Host header", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/healthz`, {
			headers: {
				Host: `127.0.0.1:${port}`,
				Origin: "https://evil.example",
			},
		});
		expect(resp.status).toBe(204);
	});
});

const externalIp = Object.values(networkInterfaces())
	.flat()
	.find((addr) => addr?.family === "IPv4" && !addr.internal)?.address;

describe("loopback-only binding", () => {
	it.skipIf(!externalIp)(
		"is unreachable on this machine's non-loopback address",
		async () => {
			const { port } = await bootServe();
			await expect(
				fetch(`http://${externalIp}:${port}/healthz`, {
					signal: AbortSignal.timeout(1500),
				}),
			).rejects.toBeDefined();
		},
	);

	it("never sets reusePort — a second process cannot bind the same port", async () => {
		const { port } = await bootServe();
		const dgHomeB = freshDgHome();
		try {
			const second = spawnServe(dgHomeB, port);
			const exitCode = await second.exited;
			expect(exitCode).not.toBe(0);
		} finally {
			cleanupDgHome(dgHomeB);
		}
	});
});
