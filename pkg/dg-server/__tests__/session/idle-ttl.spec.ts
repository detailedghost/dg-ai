import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	connectCli,
	frameType,
	freshDgHome,
	killDaemonByLockfile,
	send,
	spawnServe,
	startWithSession,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

const IDLE_TTL_MS = 1000;

describe("idle-TTL does not fire while a page is connected but idle", () => {
	it("holds the daemon alive across a full idle-TTL window while a /ws socket stays open with no traffic, even with zero registered sessions", async () => {
		const {
			dgHome: home,
			port,
			bootstrap,
		} = await startWithSession({
			DG_IDLE_TTL_MS: String(IDLE_TTL_MS),
		});
		dgHome = home;

		const closer = await connectCli(port, bootstrap);
		send(closer, {
			type: "session-close",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		await new Promise((r) => setTimeout(r, 100));
		closer.close();

		const idlePage = wsExtensionSocket(port);
		await waitForOpen(idlePage);

		await new Promise((r) => setTimeout(r, IDLE_TTL_MS * 4));

		const resp = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(resp.status).toBe(200);
		idlePage.close();
	});
});

describe("idle-TTL does not fire while a blocking recv is parked", () => {
	it("holds the daemon alive across a full idle-TTL window on a parked recv's /cli connection, even after its session closes and zero sessions remain registered", async () => {
		const {
			dgHome: home,
			port,
			bootstrap,
		} = await startWithSession({
			DG_IDLE_TTL_MS: String(IDLE_TTL_MS),
		});
		dgHome = home;

		const recvSocket = await connectCli(port, bootstrap);
		const recvFrames = collectFrames(recvSocket);
		recvSocket.send(
			JSON.stringify({
				type: "cli-recv",
				block: true,
				timeoutMs: IDLE_TTL_MS * 8,
			}),
		);
		await new Promise((r) => setTimeout(r, 100));

		const closer = await connectCli(port, bootstrap);
		send(closer, {
			type: "session-close",
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		await new Promise((r) => setTimeout(r, 100));
		closer.close();

		const closedResult = await waitForValue(
			() =>
				recvFrames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						frameType(f) === "cli-recv-result",
				),
			3000,
			"cli-recv-result",
		);
		expect(closedResult).toEqual({
			type: "cli-recv-result",
			outcome: "closed",
		});

		await new Promise((r) => setTimeout(r, IDLE_TTL_MS * 4));

		const resp = await fetch(`http://127.0.0.1:${port}/health`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		expect(resp.status).toBe(200);
		recvSocket.close();
	});
});

describe("idle-TTL self-exit", () => {
	it("exits the process and removes the lockfile once the idle window elapses with nothing pinning it", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const proc = spawnServe(dgHome, port, {
			DG_IDLE_TTL_MS: String(IDLE_TTL_MS),
		});
		await waitForHealth(port);

		const exitCode = await Promise.race([
			proc.exited,
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error("daemon did not self-exit within the idle window"),
						),
					IDLE_TTL_MS * 15,
				),
			),
		]);
		expect(exitCode).toBe(0);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(existsSync(paths.lockfilePath)).toBe(false);
	});
});
