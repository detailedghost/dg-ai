import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_START_PATH } from "@dg/common";
import {
	bootServe as bootDaemonServe,
	cleanupDgHome,
	createCleanupSlot,
	stopServe,
} from "../utils/daemon-harness";

const cleanupSlot = createCleanupSlot();

afterEach(() => cleanupSlot.run());

async function bootServe(
	extraEnv: Record<string, string> = {},
): Promise<number> {
	const { dgHome, port, proc } = await bootDaemonServe(extraEnv);
	cleanupSlot.set(async () => {
		await stopServe(proc);
		cleanupDgHome(dgHome);
	});
	return port;
}

function registerRequest(port: number): Promise<Response> {
	return fetch(`http://127.0.0.1:${port}${CHAT_START_PATH}`, {
		method: "POST",
		headers: {
			Host: `127.0.0.1:${port}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ cwd: process.cwd(), role: "agent" }),
	});
}

describe("registered-session cap", () => {
	it("admits sessions up to DG_MAX_SESSIONS and refuses the next one with 429, naming the cap", async () => {
		const port = await bootServe({ DG_MAX_SESSIONS: "2" });

		expect((await registerRequest(port)).status).toBe(200);
		expect((await registerRequest(port)).status).toBe(200);

		const refused = await registerRequest(port);
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("2");
	});

	it("keeps refusing new registrations while at capacity, without corrupting the registry", async () => {
		const port = await bootServe({ DG_MAX_SESSIONS: "1" });

		expect((await registerRequest(port)).status).toBe(200);
		expect((await registerRequest(port)).status).toBe(429);
		expect((await registerRequest(port)).status).toBe(429);
	});
});
