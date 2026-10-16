import { afterEach, describe, expect, it } from "bun:test";
import { readSessionToken, resolveDgPaths } from "@dg/common/node";
import {
	allocatePort,
	cleanupDgHome,
	cliSocket,
	collectFrames,
	connectPage,
	freshDgHome,
	killDaemonByPidFile,
	registerSession,
	runStatus,
	send,
	spawnServe,
	waitForHealth,
	waitForOpen,
} from "../utils/daemon-harness";

let dgHome: string;

afterEach(() => {
	killDaemonByPidFile(dgHome);
	cleanupDgHome(dgHome);
});

const SESSION_TTL_MS = 400;

/** These sleep for whole TTL multiples, then spawn a CLI to read the result. */
const WALL_CLOCK_BUDGET_MS = 20_000;

describe("a session left active with no CLI or page ever attached to it", () => {
	it("gets reaped past DG_SESSION_TTL_MS, which unblocks the idle timer and lets the daemon self-exit", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const proc = spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(SESSION_TTL_MS),
			DG_IDLE_TTL_MS: String(SESSION_TTL_MS),
		});
		await waitForHealth(port);
		await registerSession(port);

		const exitCode = await Promise.race([
			proc.exited,
			new Promise<never>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error(
								"daemon stayed alive: the zombie session never unblocked isIdle()",
							),
						),
					SESSION_TTL_MS * 15,
				),
			),
		]);
		expect(exitCode).toBe(0);
	}, WALL_CLOCK_BUDGET_MS);

	it("has its capability token removed from disk once reaped, and refuses that token on a fresh /cli upgrade", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(SESSION_TTL_MS),
			DG_IDLE_TTL_MS: String(SESSION_TTL_MS * 200),
		});
		await waitForHealth(port);
		const bootstrap = await registerSession(port);

		await new Promise((r) => setTimeout(r, SESSION_TTL_MS * 6));

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(() => readSessionToken(paths, bootstrap.sessionId)).toThrow();

		const reuse = cliSocket(port, {
			sessionId: bootstrap.sessionId,
			token: bootstrap.token,
		});
		let refused = false;
		try {
			await waitForOpen(reuse, 1000);
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);

		const status = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(status.sessionCount).toBe(0);
	}, WALL_CLOCK_BUDGET_MS);
});

describe("a session with a live page socket holding its capability", () => {
	it("is still reaped past DG_SESSION_TTL_MS when the only traffic is extension keepalives", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(SESSION_TTL_MS),
			DG_IDLE_TTL_MS: String(SESSION_TTL_MS * 200),
		});
		await waitForHealth(port);
		const bootstrap = await registerSession(port);
		const page = await connectPage(port, bootstrap);

		for (let beat = 0; beat < 8; beat++) {
			send(page, {
				type: "keepalive",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
			});
			await new Promise((r) => setTimeout(r, SESSION_TTL_MS / 2));
		}

		const status = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(status.sessionCount).toBe(0);

		const paths = resolveDgPaths({ env: { DG_HOME: dgHome } });
		expect(() => readSessionToken(paths, bootstrap.sessionId)).toThrow();

		page.close();
	}, WALL_CLOCK_BUDGET_MS);
});

describe("a session whose CLI has disconnected", () => {
	it("is reaped after DG_AGENT_GONE_MS even while the page keeps sending keepalives", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const goneMs = SESSION_TTL_MS;
		spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(SESSION_TTL_MS),
			DG_AGENT_GONE_MS: String(goneMs),
			DG_CLI_REATTACH_GRACE_MS: "0",
			DG_IDLE_TTL_MS: String(SESSION_TTL_MS * 200),
		});
		await waitForHealth(port);
		const bootstrap = await registerSession(port);
		const cli = cliSocket(port, bootstrap);
		await waitForOpen(cli);
		cli.close();
		const page = await connectPage(port, bootstrap);

		for (let beat = 0; beat < 8; beat++) {
			send(page, {
				type: "keepalive",
				sessionId: bootstrap.sessionId,
				token: bootstrap.token,
			});
			await new Promise((r) => setTimeout(r, goneMs / 2));
		}

		const status = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(status.sessionCount).toBe(0);
		page.close();
	}, WALL_CLOCK_BUDGET_MS);
});

describe("a claimed session between short-lived CLI commands", () => {
	it("stays alive across a gap longer than DG_AGENT_GONE_MS and does not broadcast agent-gone", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		const goneMs = 250;
		const gapMs = goneMs * 3;
		spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(SESSION_TTL_MS),
			DG_AGENT_GONE_MS: String(goneMs),
			DG_CLI_REATTACH_GRACE_MS: String(gapMs * 4),
			DG_IDLE_TTL_MS: String(SESSION_TTL_MS * 200),
		});
		await waitForHealth(port);
		const bootstrap = await registerSession(port);
		const page = await connectPage(port, bootstrap);
		const frames = collectFrames(page);

		const first = cliSocket(port, bootstrap);
		await waitForOpen(first);
		first.close();
		await Bun.sleep(gapMs);

		const during = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(during.sessionCount).toBe(1);
		const catalog = await fetch(`http://127.0.0.1:${port}/sessions`, {
			headers: { Host: `127.0.0.1:${port}` },
		});
		const listed = (await catalog.json()) as {
			sessions: { presence: string }[];
		};
		expect(listed.sessions[0]?.presence).toBe("cli");

		const second = cliSocket(port, bootstrap);
		await waitForOpen(second);
		second.close();
		await Bun.sleep(200);

		const after = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(after.sessionCount).toBe(1);
		const gone = frames.filter(
			(frame) =>
				typeof frame === "object" &&
				frame !== null &&
				(frame as { type?: string }).type === "progress" &&
				(frame as { state?: string }).state === "agent-gone",
		);
		expect(gone).toEqual([]);
		page.close();
	}, WALL_CLOCK_BUDGET_MS);
});

describe("a session an agent keeps using", () => {
	it("survives well past DG_SESSION_TTL_MS, because every CLI frame refreshes its activity", async () => {
		dgHome = freshDgHome();
		const port = allocatePort();
		spawnServe(dgHome, port, {
			DG_SESSION_TTL_MS: String(SESSION_TTL_MS),
			DG_IDLE_TTL_MS: String(SESSION_TTL_MS * 200),
		});
		await waitForHealth(port);
		const bootstrap = await registerSession(port);

		const socket = cliSocket(port, bootstrap);
		await waitForOpen(socket);
		try {
			for (let beat = 0; beat < 8; beat++) {
				socket.send(JSON.stringify({ type: "cli-progress", state: "running" }));
				await Bun.sleep(SESSION_TTL_MS / 2);
			}

			const status = JSON.parse((await runStatus(dgHome)).stdout) as {
				sessionCount: number;
			};
			expect(status.sessionCount).toBe(1);
		} finally {
			socket.close();
		}
	}, WALL_CLOCK_BUDGET_MS);
});
