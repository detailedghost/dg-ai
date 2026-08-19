/**
 * The exit-code contract this slice exists for: recv --block --timeout has
 * exactly three outcomes (Testing Criteria) — delivered (0), timeout (a
 * reserved non-1 code, distinct from failure), and every other failure (1).
 *
 * [SPEC] ASSUMED: EXIT_RECV_TIMEOUT = 5 and EXIT_RECV_SESSION_CLOSED = 6,
 * the next free values after errors.ts's EXIT_PROTOCOL_MISMATCH = 4 — no
 * value is named in plan.md. See deferrals.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	sendConnectHandshake,
	waitForHealth,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";
import { runCli } from "./cli-wire";

const EXIT_RECV_TIMEOUT = 5;
const EXIT_GENERAL_FAILURE = 1;

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

async function startWithSession(extraEnv: Record<string, string> = {}) {
	dgHome = freshDgHome();
	const port = allocatePort();
	const result = await runStart(dgHome, port, extraEnv);
	await waitForHealth(port);
	const bootstrap = validateSessionBootstrap(
		decodeChatMarker(extractUrl(result.stdout)),
	);
	return { port, bootstrap };
}

async function deliverUserMessage(
	port: number,
	bootstrap: { sessionId: string; token: string },
	body: string,
): Promise<void> {
	const page = wsExtensionSocket(port);
	await waitForOpen(page);
	sendConnectHandshake(page, bootstrap, CHAT_PROTOCOL_VERSION);
	await new Promise((r) => setTimeout(r, 100));
	page.send(
		JSON.stringify({
			type: "user-message",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
			protocolVersion: CHAT_PROTOCOL_VERSION,
			messageId: randomUUID(),
			body,
		}),
	);
	await new Promise((r) => setTimeout(r, 150));
	page.close();
}

describe("recv --block --timeout", () => {
	it("returns exit 0 and the message body when a message is already queued", async () => {
		const { port, bootstrap } = await startWithSession();
		await deliverUserMessage(port, bootstrap, "hello from the human");

		const result = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"5000",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello from the human");
	});

	it("acks the delivered message — a second recv on the same session times out rather than re-delivering it", async () => {
		const { port, bootstrap } = await startWithSession();
		await deliverUserMessage(port, bootstrap, "only once please");

		const first = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"5000",
		]);
		expect(first.exitCode).toBe(0);

		const second = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"300",
		]);
		expect(second.exitCode).toBe(EXIT_RECV_TIMEOUT);
	});

	it("returns the documented timeout exit code, distinct from failure, when nothing arrives", async () => {
		const { port, bootstrap } = await startWithSession();

		const start = Date.now();
		const result = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"300",
		]);
		const elapsed = Date.now() - start;

		expect(result.exitCode).toBe(EXIT_RECV_TIMEOUT);
		expect(result.exitCode).not.toBe(EXIT_GENERAL_FAILURE);
		// Generous upper bound — proves recv doesn't hang well past its own --timeout.
		expect(elapsed).toBeLessThan(4000);
	});

	it("redelivers a claim whose lease expired without being acked", async () => {
		const { port, bootstrap } = await startWithSession({
			DG_CLAIM_LEASE_MS: "150",
		});
		await deliverUserMessage(port, bootstrap, "lease should expire");

		// Simulate a prior recv that claimed but never acked, via a direct store
		// connection — the daemon (a separate process) holds its own handle on
		// the same WAL-mode db file, so this is a real concurrent claim, not a mock.
		const { ChatStore } = await import("../../src/store");
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const probe = await ChatStore.open(paths, {
			env: { DG_KEY_SOURCE: "file" },
		});
		const claimed = probe.claimNext(bootstrap.sessionId);
		expect(claimed?.body).toBe("lease should expire");
		probe.close();

		await new Promise((r) => setTimeout(r, 300)); // past the 150ms lease

		const result = await runCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"3000",
		]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("lease should expire");
	});

	it("fails with the general-failure code (never the timeout code) against an unknown session", async () => {
		const { port } = await startWithSession();

		const result = await runCli(
			dgHome,
			port,
			[
				"recv",
				"--session",
				"not-a-real-session-id",
				"--block",
				"--timeout",
				"2000",
			],
			{ DG_SESSION_TOKEN: "not-a-real-token" },
		);

		expect(result.exitCode).toBe(EXIT_GENERAL_FAILURE);
		expect(result.exitCode).not.toBe(EXIT_RECV_TIMEOUT);
	});

	it("fails fast against a dead daemon rather than blocking for the full --timeout", async () => {
		// A raw TCP listener that accepts but never answers — connection
		// establishment must be bounded by its OWN short timeout, independent
		// of --timeout, per this slice's Engineering bullet.
		const hungServer = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {}, open() {} },
		});
		try {
			dgHome = freshDgHome();
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const { writeLockfileAtomic } = await import("../../src/server/lockfile");
			const { writeSessionToken } = await import("../../src/session/tokens");
			writeLockfileAtomic(paths, {
				// A fake, near-certainly-unused pid — never process.pid, which
				// afterEach's killDaemonByLockfile would SIGTERM (i.e. suicide).
				pid: 999999,
				port: hungServer.port,
				instanceId: "hung-instance",
				versions: { package: "0.0.0", protocol: CHAT_PROTOCOL_VERSION },
			});
			writeSessionToken(paths, "hung-session", {
				sessionId: "hung-session",
				token: "hung-token",
				cwd: process.cwd(),
				agentIdentity: "agent-1",
			});

			const start = Date.now();
			const result = await runCli(dgHome, hungServer.port, [
				"recv",
				"--session",
				"hung-session",
				"--block",
				"--timeout",
				"60000",
			]);
			const elapsed = Date.now() - start;

			expect(result.exitCode).toBe(EXIT_GENERAL_FAILURE);
			// Must fail long before the 60s --timeout — proves a distinct, short
			// connect-establishment bound is what fired, not --timeout itself.
			expect(elapsed).toBeLessThan(10000);
		} finally {
			hungServer.stop(true);
		}
	});
});
