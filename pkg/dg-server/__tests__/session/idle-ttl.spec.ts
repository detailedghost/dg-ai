/**
 * Idle-TTL: zero sessions AND zero open connections, for the whole window.
 * Slice 7 promotes the "blocking recv parked" half — its live /cli socket
 * already pins isIdle()'s connection-count check with no special-casing.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import { spawnCli } from "../commands/cli-wire";
import {
	allocatePort,
	cleanupDgHome,
	connectCli,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	spawnServe,
	waitForHealth,
	waitForOpen,
	wsExtensionSocket,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

// Startup alone (spawn, health-poll, register) can take several hundred ms
// before anything notes activity, so this must clear that latency with room to spare.
const IDLE_TTL_MS = 1000;

describe("idle-TTL does not fire while a page is connected but idle", () => {
	it("holds the daemon alive across a full idle-TTL window while a /ws socket stays open with no traffic, even with zero registered sessions", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const result = await runStart(dgHome, port, {
			DG_IDLE_TTL_MS: String(IDLE_TTL_MS),
		});
		await waitForHealth(port);
		const bootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(result.stdout)),
		);

		// Close the one session `start` auto-registers, so the idle /ws
		// connection below is the ONLY thing that could still pin the daemon.
		const closer = await connectCli(port, bootstrap);
		closer.send(
			JSON.stringify({
				type: "session-close",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		await new Promise((r) => setTimeout(r, 100)); // let the close land server-side
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
	it("holds the daemon alive across a full idle-TTL window while a recv --block stays genuinely parked (not exited) on its session", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const result = await runStart(dgHome, port, {
			DG_IDLE_TTL_MS: String(IDLE_TTL_MS),
		});
		await waitForHealth(port);
		const bootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(result.stdout)),
		);

		const recv = spawnCli(dgHome, port, [
			"recv",
			"--session",
			bootstrap.sessionId,
			"--block",
			"--timeout",
			String(IDLE_TTL_MS * 8),
		]);

		try {
			await new Promise((r) => setTimeout(r, IDLE_TTL_MS * 4));

			// Must still be blocked, not exited early — else this passes vacuously
			// off the session's own registration, without recv doing anything.
			expect(recv.exitCode).toBeNull();

			const resp = await fetch(`http://127.0.0.1:${port}/health`, {
				headers: { Host: `127.0.0.1:${port}` },
			});
			expect(resp.status).toBe(200);
		} finally {
			recv.kill();
			await recv.exited;
		}
	});
});

// Complements the negative case above: a predicate that silently never fires
// would still pass it, so this proves the daemon actually self-exits.
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
