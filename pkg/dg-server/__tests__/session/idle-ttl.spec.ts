/**
 * Idle-TTL self-exit predicate: "zero registered sessions AND zero open
 * connections for the whole window; an open socket or an in-flight blocking
 * recv pins the daemon." `DG_IDLE_TTL_MS` (Code Structure's transport
 * ratification) makes the "connected but idle" half boundable in CI time.
 * "Blocking recv" is Slice 7's verb and does not exist yet — that half stays
 * `it.todo`, ratified to stay that way until slice 7 can park one.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { CHAT_PROTOCOL_VERSION, validateSessionBootstrap } from "@dg/common";
import { resolveDgPaths } from "@dg/common/node";
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
	it.todo("holds the daemon alive across a full idle-TTL window while a recv is parked — Slice 7's `recv --block` verb does not exist yet to park one", () => {});
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
