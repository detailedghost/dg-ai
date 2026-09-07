import { afterEach, describe, expect, it } from "bun:test";
import { CLI_RECV_BACKSTOP_POLL_MS } from "../../src/server/frame-handlers";
import {
	cleanupDgHome,
	deliverUserMessage,
	killDaemonByPidFile,
	recvMessage,
	startWithSession,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

describe("a blocked cli-recv wakes on insert instead of waiting for the backstop poll", () => {
	it("delivers a message landed mid-block well before the next backstop tick", async () => {
		const { dgHome: home, port, bootstrap } = await startWithSession();
		dgHome = home;

		const recvPromise = recvMessage(dgHome, port, bootstrap.sessionId, {
			block: true,
			timeoutMs: 20_000,
		});
		await new Promise((r) => setTimeout(r, 150));

		const start = Date.now();
		await deliverUserMessage(port, bootstrap, "hello from the page");
		const result = await recvPromise;
		const elapsedMs = Date.now() - start;

		expect(result.outcome).toBe("delivered");
		expect(result.message?.body).toBe("hello from the page");
		expect(elapsedMs).toBeLessThan(CLI_RECV_BACKSTOP_POLL_MS / 2);
	});
});
