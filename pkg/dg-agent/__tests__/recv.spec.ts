import { afterEach, describe, expect, it } from "bun:test";
import { CHAT_PROTOCOL_VERSION } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	startWithSession as bootDaemonSession,
	cleanupDgHome,
	connectCli,
	deliverUserMessage,
	freshDgHome,
	killDaemonByPidFile,
} from "@dg/dg-daemon/test-harness";
import { runCli, spawnCli } from "./cli-wire";

const EXIT_RECV_TIMEOUT = 5;
const EXIT_RECV_SESSION_CLOSED = 6;
const EXIT_GENERAL_FAILURE = 1;

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

async function startWithSession(extraEnv: Record<string, string> = {}) {
	const started = await bootDaemonSession(extraEnv);
	dgHome = started.dgHome;
	return started;
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
		expect(elapsed).toBeLessThan(4000);
	});

	it("redelivers a claim whose lease expired without being acked", async () => {
		const { port, bootstrap } = await startWithSession({
			DG_CLAIM_LEASE_MS: "150",
		});
		await deliverUserMessage(port, bootstrap, "lease should expire");

		const { ChatStore } = await import("@dg/dg-daemon/test-harness");
		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		const probe = await ChatStore.open(paths, {
			env: { DG_KEY_SOURCE: "file" },
		});
		const claimed = probe.claimNext(bootstrap.sessionId);
		expect(claimed?.body).toBe("lease should expire");
		probe.close();

		await new Promise((r) => setTimeout(r, 300));

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

	it("exits with the reserved session-closed code, reporting the closed outcome, when the session closes while recv is genuinely blocked", async () => {
		const { port, bootstrap } = await startWithSession();

		const recv = spawnCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			"10000",
		]);

		await new Promise((r) => setTimeout(r, 200));
		expect(recv.exitCode).toBeNull();

		const closer = await connectCli(port, bootstrap);
		closer.send(
			JSON.stringify({
				type: "session-close",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);

		const [stdout, exitCode] = await Promise.all([
			new Response(recv.stdout).text(),
			recv.exited,
		]);
		closer.close();

		expect(exitCode).toBe(EXIT_RECV_SESSION_CLOSED);
		expect(JSON.parse(stdout.trim())).toEqual({
			type: "cli-recv-result",
			outcome: "closed",
		});
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
		const hungServer = Bun.listen({
			hostname: "127.0.0.1",
			port: 0,
			socket: { data() {}, open() {} },
		});
		try {
			dgHome = freshDgHome();
			const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
			const { writePidFileAtomic, writeSessionToken } = await import(
				"@dg/common/node"
			);
			writePidFileAtomic(paths, {
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
			expect(elapsed).toBeLessThan(10000);
		} finally {
			hungServer.stop(true);
		}
	});
});
