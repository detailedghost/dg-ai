/**
 * The headline security property of Slice 2: a socket that has only ever
 * captured session A's bootstrap must never be able to act on session B,
 * even when B's real (not fabricated) token is presented — proving the
 * daemon scopes capabilities per-socket, not against the global session store.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	validateChatFrame,
	validateSessionBootstrap,
} from "@dg/common";
import {
	allocatePort,
	cleanupDgHome,
	cliSocket,
	collectFrames,
	connectCli,
	decodeChatMarker,
	extractUrl,
	freshDgHome,
	killDaemonByLockfile,
	runStart,
	runStatus,
	sendConnectHandshake,
	waitForHealth,
	waitForOpen,
	waitForValue,
	wsExtensionSocket,
} from "../utils/daemon-harness";

let dgHome: string;
let port: number;
let sessionA: ReturnType<typeof validateSessionBootstrap>;
let sessionB: ReturnType<typeof validateSessionBootstrap>;

beforeAll(async () => {
	dgHome = freshDgHome();
	port = allocatePort();
	const first = await runStart(dgHome, port);
	await waitForHealth(port);
	sessionA = validateSessionBootstrap(
		decodeChatMarker(extractUrl(first.stdout)),
	);
	const second = await runStart(dgHome, port);
	sessionB = validateSessionBootstrap(
		decodeChatMarker(extractUrl(second.stdout)),
	);
});

afterAll(() => {
	killDaemonByLockfile(dgHome);
	cleanupDgHome(dgHome);
});

function send(ws: WebSocket, frame: Record<string, unknown>): void {
	ws.send(JSON.stringify({ protocolVersion: CHAT_PROTOCOL_VERSION, ...frame }));
}

describe("cross-session escalation guard", () => {
	it("refuses a session-close for B over a socket that only captured A, even using B's real token", async () => {
		const ws = await connectCli(port, sessionA);
		const frames = collectFrames(ws);
		send(ws, {
			type: "session-close",
			sessionId: sessionB.sessionId,
			token: sessionB.token,
		});
		const rejection = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of the cross-session close",
		);
		expect(rejection).toBeDefined();
		ws.close();
	});

	it("refuses a session-close for B using a fabricated token", async () => {
		const ws = await connectCli(port, sessionA);
		const frames = collectFrames(ws);
		send(ws, {
			type: "session-close",
			sessionId: sessionB.sessionId,
			token: "not-a-real-token",
		});
		const rejection = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of the fabricated-token close",
		);
		expect(rejection).toBeDefined();
		ws.close();
	});
});

describe("session-create grants the requesting socket a new capability", () => {
	it("lets the same connection immediately act on the session it just created", async () => {
		const ws = await connectCli(port, sessionA);
		const frames = collectFrames(ws);
		send(ws, {
			type: "session-create",
			sessionId: sessionA.sessionId,
			token: sessionA.token,
			role: "agent",
		});
		const pending = await waitForValue(
			() =>
				frames.find((f) => (f as { type?: string }).type === "session-pending"),
			2000,
			"a session-pending response",
		);
		const newSession = (
			pending as { newSession: { sessionId: string; token: string } }
		).newSession;
		expect(newSession.sessionId).not.toBe(sessionA.sessionId);

		send(ws, {
			type: "history-request",
			sessionId: newSession.sessionId,
			token: newSession.token,
		});
		const reply = await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { type?: string; sessionId?: string }).sessionId ===
							newSession.sessionId &&
						(f as { type?: string }).type !== "session-pending",
				),
			2000,
			"a response to the newly-captured session's history-request",
		);
		expect((reply as { type?: string }).type).not.toBe("error");
		ws.close();
	});
});

describe("session-create authorization", () => {
	it("refuses session-create over a live socket's own capability when the token is wrong, and refuses it for a foreign session's real token — creating nothing either way", async () => {
		const ws = await connectCli(port, sessionA);
		const frames = collectFrames(ws);
		const before = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};

		send(ws, {
			type: "session-create",
			sessionId: sessionA.sessionId,
			token: "not-sessionA-real-token",
			role: "agent",
		});
		const wrongTokenRejection = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of session-create with a wrong token for A's own sessionId",
		);
		expect(wrongTokenRejection).toBeDefined();
		frames.length = 0;

		send(ws, {
			type: "session-create",
			sessionId: sessionB.sessionId,
			token: sessionB.token,
			role: "agent",
		});
		const foreignTokenRejection = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of session-create bearing B's real token over a socket that never captured B",
		);
		expect(foreignTokenRejection).toBeDefined();

		const after = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(after.sessionCount).toBe(before.sessionCount);
		ws.close();
	});

	it("refuses a session-create bearing an unknown token and creates nothing", async () => {
		const before = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};

		const bogusSessionId = "session-does-not-exist";
		const ws = cliSocket(port, {
			sessionId: bogusSessionId,
			token: "unknown-token",
		});
		let refusedAtHandshake = false;
		ws.addEventListener("error", () => {
			refusedAtHandshake = true;
		});
		try {
			await waitForOpen(ws, 1000);
		} catch {
			refusedAtHandshake = true;
		}
		expect(refusedAtHandshake).toBe(true);

		// The bogus identity must not have materialized a session either.
		const reconnect = cliSocket(port, {
			sessionId: bogusSessionId,
			token: "unknown-token",
		});
		let secondAttemptRefused = false;
		try {
			await waitForOpen(reconnect, 1000);
		} catch {
			secondAttemptRefused = true;
		}
		expect(secondAttemptRefused).toBe(true);

		const after = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(after.sessionCount).toBe(before.sessionCount);
	});

	// The test above proves only the /cli UPGRADE refusal for a bogus pair; this is
	// the frame-layer case, naming a sessionId the socket never captured at all.
	it("refuses a session-create frame naming a sessionId the socket holds no capability for", async () => {
		const before = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		const ws = await connectCli(port, sessionA);
		const frames = collectFrames(ws);
		send(ws, {
			type: "session-create",
			sessionId: "session-never-registered",
			token: "irrelevant-token",
			role: "agent",
		});
		const rejection = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of session-create naming an uncaptured sessionId",
		);
		expect(rejection).toBeDefined();

		const after = JSON.parse((await runStatus(dgHome)).stdout) as {
			sessionCount: number;
		};
		expect(after.sessionCount).toBe(before.sessionCount);
		ws.close();
	});

	it("refuses a session-create frame bearing a closed session's token", async () => {
		// Self-close B using its own (legitimate) pair, then try to reuse it.
		const closer = await connectCli(port, sessionB);
		send(closer, {
			type: "session-close",
			sessionId: sessionB.sessionId,
			token: sessionB.token,
		});
		await new Promise((r) => setTimeout(r, 200)); // let the close land server-side
		closer.close();

		const reuse = cliSocket(port, {
			sessionId: sessionB.sessionId,
			token: sessionB.token,
		});
		let refused = false;
		try {
			await waitForOpen(reuse, 1000);
			// If the handshake itself doesn't gate this, the first frame must.
			const frames = collectFrames(reuse);
			send(reuse, {
				type: "session-create",
				sessionId: sessionB.sessionId,
				token: sessionB.token,
				role: "agent",
			});
			const rejection = await waitForValue(
				() => frames.find((f) => (f as { type?: string }).type === "error"),
				2000,
				"a rejection using the closed session's token",
			);
			refused = rejection !== undefined;
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);
	});
});

describe("/ws capability capture via the post-connect handshake frame", () => {
	it("grants the capability so a subsequent frame on the same socket is not refused", async () => {
		const ws = wsExtensionSocket(port);
		await waitForOpen(ws);
		const frames = collectFrames(ws);
		sendConnectHandshake(ws, sessionA, CHAT_PROTOCOL_VERSION);
		send(ws, {
			type: "history-request",
			sessionId: sessionA.sessionId,
			token: sessionA.token,
		});
		const reply = await waitForValue(
			() =>
				frames.find(
					(f) => (f as { sessionId?: string }).sessionId === sessionA.sessionId,
				),
			2000,
			"a response to the handshake-captured session's history-request",
		);
		expect((reply as { type?: string }).type).not.toBe("error");
		ws.close();
	});

	it("does not grant a capability for a fabricated token in the handshake", async () => {
		const ws = wsExtensionSocket(port);
		await waitForOpen(ws);
		const frames = collectFrames(ws);
		sendConnectHandshake(
			ws,
			{ sessionId: sessionA.sessionId, token: "not-a-real-token" },
			CHAT_PROTOCOL_VERSION,
		);
		send(ws, {
			type: "history-request",
			sessionId: sessionA.sessionId,
			token: "not-a-real-token",
		});
		const rejection = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a rejection of the fabricated handshake token",
		);
		expect(rejection).toBeDefined();
		ws.close();
	});
});

describe("session-list echoes workset and role, round-tripped through validateChatFrame", () => {
	it("carries a worksetted orchestrator session in a session-list frame the shared validator accepts", async () => {
		const ws = wsExtensionSocket(port);
		await waitForOpen(ws);
		const frames = collectFrames(ws);
		sendConnectHandshake(ws, sessionA, CHAT_PROTOCOL_VERSION);
		send(ws, {
			type: "session-create",
			sessionId: sessionA.sessionId,
			token: sessionA.token,
			role: "orchestrator",
			workset: "chat-harness",
		});

		const pending = await waitForValue(
			() =>
				frames.find((f) => (f as { type?: string }).type === "session-pending"),
			2000,
			"a session-pending response for the worksetted orchestrator session",
		);
		const newSessionId = (pending as { newSession: { sessionId: string } })
			.newSession.sessionId;

		const sessionListFrame = await waitForValue(
			() =>
				frames.find(
					(f) =>
						(f as { type?: string }).type === "session-list" &&
						(f as { sessions?: Array<{ sessionId?: string }> }).sessions?.some(
							(entry) => entry.sessionId === newSessionId,
						),
				),
			2000,
			"a session-list frame carrying the newly-created worksetted session",
		);

		// The point is validating the RECEIVED wire frame, not a hand-written
		// shape assertion that a daemon-side field rename would sail past.
		const validated = validateChatFrame(sessionListFrame);
		if (validated.type !== "session-list") {
			throw new Error(`expected a session-list frame, got "${validated.type}"`);
		}
		const summary = validated.sessions.find(
			(entry) => entry.sessionId === newSessionId,
		);
		expect(summary).toBeDefined();
		expect(summary?.workset).toBe("chat-harness");
		expect(summary?.role).toBe("orchestrator");
		expect(summary?.agentIdentity.length).toBeGreaterThan(0);

		ws.close();
	});
});

// Placed last in the file: it closes sessionA for good, so no test above may
// depend on it staying open afterward.
describe("session-close broadcasts and revokes capability on every socket that held it", () => {
	it("notifies a second socket holding the same capability, whose subsequent frame for it is then refused", async () => {
		const closer = await connectCli(port, sessionA);
		const closerFrames = collectFrames(closer);

		const bystander = wsExtensionSocket(port);
		await waitForOpen(bystander);
		const bystanderFrames = collectFrames(bystander);
		sendConnectHandshake(bystander, sessionA, CHAT_PROTOCOL_VERSION);
		// Let the handshake capture land before the close races it.
		await waitForValue(
			() => {
				send(bystander, {
					type: "history-request",
					sessionId: sessionA.sessionId,
					token: sessionA.token,
				});
				return bystanderFrames.find(
					(f) => (f as { sessionId?: string }).sessionId === sessionA.sessionId,
				);
			},
			2000,
			"proof the bystander's handshake capability was captured",
		);
		bystanderFrames.length = 0;

		send(closer, {
			type: "session-close",
			sessionId: sessionA.sessionId,
			token: sessionA.token,
		});

		const closedOnCloser = await waitForValue(
			() =>
				closerFrames.find(
					(f) => (f as { type?: string }).type === "session-closed",
				),
			2000,
			"session-closed on the closing socket itself",
		);
		expect((closedOnCloser as { sessionId?: string }).sessionId).toBe(
			sessionA.sessionId,
		);

		const closedOnBystander = await waitForValue(
			() =>
				bystanderFrames.find(
					(f) => (f as { type?: string }).type === "session-closed",
				),
			2000,
			"session-closed broadcast to the bystander socket",
		);
		expect((closedOnBystander as { sessionId?: string }).sessionId).toBe(
			sessionA.sessionId,
		);

		bystanderFrames.length = 0;
		send(bystander, {
			type: "history-request",
			sessionId: sessionA.sessionId,
			token: sessionA.token,
		});
		const revoked = await waitForValue(
			() =>
				bystanderFrames.find((f) => (f as { type?: string }).type === "error"),
			2000,
			"a refusal proving the bystander's capability was revoked",
		);
		expect(revoked).toBeDefined();

		closer.close();
		bystander.close();
	});
});

describe("keepalive", () => {
	it("draws no reply, so a long-lived socket sees no unsolicited frames", async () => {
		// Its own session: the escalation tests above deliberately close sessionA.
		const started = await runStart(dgHome, port);
		const session = validateSessionBootstrap(
			decodeChatMarker(extractUrl(started.stdout)),
		);
		const ws = wsExtensionSocket(port);
		await waitForOpen(ws);
		const frames = collectFrames(ws);
		sendConnectHandshake(ws, session, CHAT_PROTOCOL_VERSION);

		// The handshake answers with a session-list; drain it first so the keepalive
		// assertion cannot pass merely because nothing had arrived yet.
		await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type === "session-list"),
			2000,
			"the handshake's initial session-list",
		);
		frames.length = 0;

		send(ws, {
			type: "keepalive",
			sessionId: session.sessionId,
			token: session.token,
		});

		// A history-request after the keepalive proves the socket is still live and
		// ordered, so silence reads as no reply rather than as a dead socket.
		send(ws, {
			type: "history-request",
			sessionId: session.sessionId,
			token: session.token,
		});
		const reply = await waitForValue(
			() => frames.find((f) => (f as { type?: string }).type !== undefined),
			2000,
			"the history-request reply that follows the keepalive",
		);

		expect(() => validateChatFrame(reply)).not.toThrow();
		expect((reply as { type: string }).type).toBe("history-response");
		expect(frames.map((f) => (f as { type?: string }).type)).not.toContain(
			"error",
		);
		ws.close();
	});
});
