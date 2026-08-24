import { afterEach, describe, expect, it } from "bun:test";
import { networkInterfaces } from "node:os";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import {
	bootServe as bootDaemonServe,
	cleanupDgHome,
	createCleanupSlot,
	freshDgHome,
	spawnServe,
	stopServe,
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

describe("GET /health", () => {
	it("returns exactly the three published fields, matching CHAT_PROTOCOL_VERSION", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(Object.keys(body).sort()).toEqual(
			["daemon", "instanceId", "protocolVersion"].sort(),
		);
		expect(body.protocolVersion).toBe(CHAT_PROTOCOL_VERSION);
		expect(typeof body.instanceId).toBe("string");
		expect((body.instanceId as string).length).toBeGreaterThan(0);
	});

	it("204s a caller whose Host header is not the loopback authority", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { Host: "evil.example:9999" },
		});
		expect(resp.status).toBe(204);
	});

	it("204s a browser-Origin caller even with a correct Host header", async () => {
		const { port } = await bootServe();
		const resp = await fetch(`http://127.0.0.1:${port}/health`, {
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
				fetch(`http://${externalIp}:${port}/health`, {
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
