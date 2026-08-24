import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { validateSessionBootstrap } from "@dg/common";
import {
	allocatePort,
	cleanupDgHome,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	spawnServe,
	waitForHealth,
} from "../utils/daemon-harness";

describe("GET /start", () => {
	let dgHome: string;
	let port: number;
	let bootstrap: ReturnType<typeof validateSessionBootstrap>;

	afterAll(() => {
		killDaemonByPidFile(dgHome);
		cleanupDgHome(dgHome);
	});

	beforeAll(async () => {
		dgHome = freshDgHome();
		port = allocatePort();
		spawnServe(dgHome, port);
		await waitForHealth(port);
		bootstrap = await registerSession(port);
	});

	it("carries no session data in its response body", async () => {
		const resp = await fetch(`http://127.0.0.1:${port}/start`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(resp.status).toBe(200);
		const body = await resp.text();
		expect(body).not.toContain(bootstrap.sessionId);
		expect(body).not.toContain(bootstrap.token);
	});
});
