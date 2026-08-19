/**
 * Idle-TTL: zero sessions AND zero open connections, for the whole window.
 * The "blocking recv parked" case closes recv's OWN session (unblocking it)
 * so registry.activeCount() hits zero, then leaves recv's /cli socket open —
 * only the connection-count half of isIdle() can still be pinning the daemon.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	collectFrames,
	connectCli,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	spawnServe,
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
	it("holds the daemon alive across a full idle-TTL window on a parked recv's /cli connection, even after its session closes and zero sessions remain registered", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const result = await runStart(dgHome, port, {
			DG_IDLE_TTL_MS: String(IDLE_TTL_MS),
		});
		await waitForHealth(port);
		const bootstrap = validateSessionBootstrap(
			decodeChatMarker(extractUrl(result.stdout)),
		);

		// /cli's upgrade requires an ACTIVE session, so the parked recv's own
		// connection has to open before the session below is closed.
		const recvSocket = await connectCli(port, bootstrap);
		const recvFrames = collectFrames(recvSocket);
		recvSocket.send(
			JSON.stringify({
				type: "cli-recv",
				block: true,
				timeoutMs: IDLE_TTL_MS * 8,
			}),
		);
		await new Promise((r) => setTimeout(r, 100)); // let it genuinely park

		// Close the ONLY registered session from a SEPARATE connection, exactly
		// like the sibling test — only the still-open recv connection can pin it now.
		const closer = await connectCli(port, bootstrap);
		closer.send(
			JSON.stringify({
				type: "session-close",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		await new Promise((r) => setTimeout(r, 100));
		closer.close();

		// The parked cli-recv unblocks once its session closes, proving it was
		// genuinely live — recvSocket itself stays open on purpose (see header doc).
		const closedResult = await waitForValue(
			() =>
				recvFrames.find(
					(f) =>
						typeof f === "object" &&
						f !== null &&
						(f as { type?: string }).type === "cli-recv-result",
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
