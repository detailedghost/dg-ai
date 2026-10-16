import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHAT_SESSIONS_PATH, DgCliError } from "@dg/common";
import { resolveDgPaths, writeSessionToken } from "@dg/common/node";
import {
	claimWaitingSession,
	interpretWaitingChoice,
	listWaitingSessions,
} from "../src/attach";

const TOKEN = "agent-token-must-not-appear";

describe("interpretWaitingChoice", () => {
	const waiting = {
		sessionId: "wait-1",
		cwd: "/work/app",
		awaitingAgent: true,
		agentIdentity: "claude",
		token: TOKEN,
	};

	it("lets start create a session when nothing is waiting", () => {
		expect(interpretWaitingChoice([], "/other", "start")).toBeUndefined();
	});

	it("makes attach fail when nothing is waiting, without the token", () => {
		expect(() => interpretWaitingChoice([], "/other", "attach")).toThrow(
			DgCliError,
		);
		try {
			interpretWaitingChoice([], "/other", "attach");
		} catch (error) {
			expect(error).toBeInstanceOf(DgCliError);
			expect((error as Error).message).toBe(
				"No session is waiting for an agent in this directory.",
			);
			expect((error as Error).message).not.toContain(TOKEN);
		}
	});

	it("claims the only waiting session from another directory", () => {
		expect(interpretWaitingChoice([waiting], "/other", "start")).toEqual({
			sessionId: "wait-1",
			agentIdentity: "claude",
		});
		expect(interpretWaitingChoice([waiting], "/other", "attach")).toEqual({
			sessionId: "wait-1",
			agentIdentity: "claude",
		});
	});

	it("claims the waiting session for start and for attach", () => {
		expect(interpretWaitingChoice([waiting], "/work/app", "start")).toEqual({
			sessionId: "wait-1",
			agentIdentity: "claude",
		});
		expect(interpretWaitingChoice([waiting], "/work/app", "attach")).toEqual({
			sessionId: "wait-1",
			agentIdentity: "claude",
		});
	});

	it("uses the waiting session's identity, or agent when it has none", () => {
		expect(
			interpretWaitingChoice(
				[{ ...waiting, agentIdentity: "a" }],
				"/work/app",
				"attach",
			)?.agentIdentity,
		).toBe("a");
		expect(
			interpretWaitingChoice(
				[{ ...waiting, agentIdentity: "" }],
				"/work/app",
				"start",
			)?.agentIdentity,
		).toBe("agent");
		const { agentIdentity: _dropped, ...unnamed } = waiting;
		expect(
			interpretWaitingChoice([unnamed], "/work/app", "attach")?.agentIdentity,
		).toBe("agent");
	});

	it("throws when start names a session that is missing or not waiting", () => {
		expect(() =>
			interpretWaitingChoice([waiting], "/other", "start", "missing"),
		).toThrow(/No session missing is registered/);
		expect(() =>
			interpretWaitingChoice(
				[{ ...waiting, awaitingAgent: false }],
				"/work/app",
				"start",
				"wait-1",
			),
		).toThrow(/not waiting/);
	});

	it("claims an explicit waiting id even from another directory", () => {
		expect(
			interpretWaitingChoice([waiting], "/other", "start", "wait-1"),
		).toEqual({ sessionId: "wait-1", agentIdentity: "claude" });
		expect(
			interpretWaitingChoice(
				[waiting, { ...waiting, sessionId: "wait-2", agentIdentity: "other" }],
				"/other",
				"attach",
				"wait-2",
			),
		).toEqual({ sessionId: "wait-2", agentIdentity: "other" });
	});

	it("treats a symlink to the session directory as the same cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "dg-attach-"));
		const real = join(root, "app");
		const link = join(root, "link");
		mkdirSync(real);
		symlinkSync(real, link);
		const sessionLink = join(root, "session-link");
		symlinkSync(real, sessionLink);
		try {
			expect(
				interpretWaitingChoice(
					[{ ...waiting, cwd: real }],
					link,
					"attach",
				),
			).toEqual({ sessionId: "wait-1", agentIdentity: "claude" });
			expect(
				interpretWaitingChoice(
					[{ ...waiting, cwd: sessionLink }],
					real,
					"attach",
				),
			).toEqual({ sessionId: "wait-1", agentIdentity: "claude" });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses several waiting sessions in other directories for both modes", () => {
		const sessions = [
			waiting,
			{ ...waiting, sessionId: "wait-2", cwd: "/elsewhere" },
		];
		expect(() => interpretWaitingChoice(sessions, "/other", "start")).toThrow(
			/wait-1/,
		);
		try {
			interpretWaitingChoice(sessions, "/other", "attach");
		} catch (error) {
			expect((error as Error).message).toBe(
				"Several sessions are waiting for an agent. Pass --session. wait-1, wait-2",
			);
			expect((error as Error).message).not.toContain(TOKEN);
		}
	});

	it("refuses an ambiguous directory for both modes", () => {
		const sessions = [waiting, { ...waiting, sessionId: "wait-2" }];
		expect(() => interpretWaitingChoice(sessions, "/work/app", "start")).toThrow(
			/wait-1/,
		);
		try {
			interpretWaitingChoice(sessions, "/work/app", "attach");
		} catch (error) {
			expect((error as Error).message).toContain("wait-2");
			expect((error as Error).message).toBe(
				"Several sessions are waiting in this directory. Pass --session. wait-1, wait-2",
			);
			expect((error as Error).message).not.toContain(TOKEN);
		}
	});
});

describe("listWaitingSessions", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("asks the daemon for waiting sessions and drops rows that are not a catalog entry", async () => {
		let requested = "";
		let host = "";
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			requested = String(input);
			host = String((init?.headers as { Host?: string } | undefined)?.Host);
			return Response.json({
				sessions: [
					{
						sessionId: "wait-1",
						cwd: "/work/app",
						awaitingAgent: true,
						agentIdentity: "claude",
					},
					{ sessionId: "bad" },
					{ awaitingAgent: true },
					{ sessionId: "no-flag", cwd: "/work/app" },
					{ sessionId: 1, cwd: "/work/app", awaitingAgent: true },
					{ sessionId: "no-cwd", awaitingAgent: true },
					null,
				],
			});
		}) as unknown as typeof fetch;
		const sessions = await listWaitingSessions(47823);
		expect(requested).toBe("http://127.0.0.1:47823/sessions?waiting=1");
		expect(CHAT_SESSIONS_PATH).toBe("/sessions");
		expect(host).toBe("127.0.0.1:47823");
		expect(sessions).toEqual([
			{
				sessionId: "wait-1",
				cwd: "/work/app",
				awaitingAgent: true,
				agentIdentity: "claude",
			},
		]);
	});

	it("returns no sessions when the catalog is missing, and does not echo a failed body", async () => {
		globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
		expect(await listWaitingSessions(9)).toEqual([]);

		globalThis.fetch = (async () =>
			new Response(`secret ${TOKEN}`, { status: 500 })) as unknown as typeof fetch;
		try {
			await listWaitingSessions(9);
			throw new Error("expected listWaitingSessions to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(DgCliError);
			expect((error as Error).message).toBe(
				"could not list sessions the extension is waiting on",
			);
			expect((error as Error).message).not.toContain(TOKEN);
		}
	});
});

describe("claimWaitingSession", () => {
	const originalFetch = globalThis.fetch;
	const originalHome = process.env.DG_HOME;
	let home: string | undefined;

	afterEach(() => {
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.DG_HOME;
		else process.env.DG_HOME = originalHome;
		if (home) rmSync(home, { recursive: true, force: true });
		home = undefined;
	});

	it("returns the claimed bootstrap, including the token read from disk", async () => {
		home = mkdtempSync(join(tmpdir(), "dg-claim-"));
		process.env.DG_HOME = home;
		writeSessionToken(resolveDgPaths(), "wait-1", {
			sessionId: "wait-1",
			token: TOKEN,
			cwd: "/work/app",
			agentIdentity: "claude",
		});
		globalThis.fetch = (async () =>
			Response.json({
				sessions: [
					{
						sessionId: "wait-1",
						cwd: "/work/app",
						awaitingAgent: true,
						agentIdentity: "claude",
					},
				],
			})) as unknown as typeof fetch;
		const claimed = await claimWaitingSession(47823, "/not/the/daemon/cwd", "attach");
		expect(claimed).toEqual({
			port: 47823,
			sessionId: "wait-1",
			token: TOKEN,
			agentIdentity: "claude",
		});
	});

	it("lets start create a session when the catalog has nothing waiting", async () => {
		globalThis.fetch = (async () =>
			Response.json({ sessions: [] })) as unknown as typeof fetch;
		expect(await claimWaitingSession(47823, "/work/app", "start")).toBeUndefined();
	});
});
