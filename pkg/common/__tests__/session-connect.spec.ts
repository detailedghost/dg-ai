import { describe, expect, it } from "bun:test";
import {
	CHAT_ATTACH_PATH,
	CHAT_SESSIONS_CLEAR_PATH,
	CHAT_SESSIONS_PATH,
	decideAttach,
	selectWaitingSession,
	validateAttachRequest,
} from "../src/session-connect";

const TOKEN = "session-token-must-not-leak-into-errors";

describe("validateAttachRequest", () => {
	it("defaults a missing intent to attach and keeps a six digit code", () => {
		expect(validateAttachRequest({ code: "123456" })).toEqual({
			intent: "attach",
			code: "123456",
		});
	});

	it("rejects a code that is not six digits", () => {
		expect(() => validateAttachRequest({ code: "12345" })).toThrow(/six digits/);
		expect(() => validateAttachRequest({ code: "1234567" })).toThrow(/six digits/);
		expect(() => validateAttachRequest({ code: "x123456" })).toThrow(/six digits/);
	});

	it("rejects an unknown intent", () => {
		expect(() => validateAttachRequest({ intent: "hijack" })).toThrow(/intent/);
	});

	it("rejects a non-boolean all flag", () => {
		expect(() => validateAttachRequest({ all: "yes" })).toThrow(/boolean/);
	});

	it("keeps the optional fields a create request is allowed to set", () => {
		expect(
			validateAttachRequest({
				intent: "create",
				code: "654321",
				sessionId: "sess-1",
				all: false,
				workset: "app",
				agentIdentity: "claude",
				role: "agent",
			}),
		).toEqual({
			intent: "create",
			code: "654321",
			sessionId: "sess-1",
			all: false,
			workset: "app",
			agentIdentity: "claude",
			role: "agent",
		});
		expect(
			validateAttachRequest({ intent: "create", role: "orchestrator" }).role,
		).toBe("orchestrator");
	});

	it("rejects empty or mistyped optional fields", () => {
		expect(() => validateAttachRequest({ sessionId: "  " })).toThrow(/sessionId/);
		expect(() => validateAttachRequest({ workset: "" })).toThrow(/workset/);
		expect(() => validateAttachRequest({ agentIdentity: 1 })).toThrow(
			/agentIdentity/,
		);
		expect(() => validateAttachRequest({ agentIdentity: "  " })).toThrow(
			/agentIdentity/,
		);
		expect(() => validateAttachRequest({ role: "user" })).toThrow(/role/);
		expect(() => validateAttachRequest({ code: 123456 })).toThrow(/code/);
		expect(() => validateAttachRequest("nope")).toThrow(
			"attach request must be an object",
		);
	});

	it("returns only the intent when no optional field is set", () => {
		expect(Object.keys(validateAttachRequest({}))).toEqual(["intent"]);
		expect(CHAT_ATTACH_PATH).toBe("/attach");
		expect(CHAT_SESSIONS_PATH).toBe("/sessions");
		expect(CHAT_SESSIONS_CLEAR_PATH).toBe("/sessions/clear");
	});
});

describe("decideAttach", () => {
	const live = {
		sessionId: "session-live",
		token: TOKEN,
		state: "active" as const,
	};
	const closed = {
		sessionId: "session-closed",
		token: TOKEN,
		state: "closed" as const,
	};

	it("requires a pairing code until the extension origin is pinned", () => {
		const decision = decideAttach({
			intent: "attach",
			all: true,
			pinned: false,
			codeAccepted: false,
			sessions: [live],
		});
		expect(decision).toEqual({
			action: "reject",
			status: 401,
			message: "Enter the 6 digit code from dg-daemon pair.",
		});
		if (decision.action === "reject") expect(decision.message).not.toContain(TOKEN);
	});

	it("returns every active session when a code is accepted and all is set", () => {
		const decision = decideAttach({
			intent: "attach",
			all: true,
			pinned: false,
			codeAccepted: true,
			sessions: [live, closed],
		});
		expect(decision).toEqual({ action: "return", sessionIds: ["session-live"] });
	});

	it("returns one session when the caller names it", () => {
		const decision = decideAttach({
			intent: "attach",
			sessionId: "session-live",
			pinned: true,
			codeAccepted: false,
			sessions: [live, closed],
		});
		expect(decision).toEqual({ action: "return", sessionIds: ["session-live"] });
	});

	it("rejects an unknown session id", () => {
		const decision = decideAttach({
			intent: "attach",
			sessionId: "missing",
			pinned: true,
			codeAccepted: false,
			sessions: [live],
		});
		expect(decision.action).toBe("reject");
		if (decision.action === "reject") {
			expect(decision.status).toBe(404);
			expect(decision.message).toBe("That session is not active.");
			expect(decision.message).not.toContain(TOKEN);
		}
	});

	it("refuses to dump every token unless all is set", () => {
		const decision = decideAttach({
			intent: "attach",
			pinned: true,
			codeAccepted: false,
			sessions: [live],
		});
		expect(decision).toEqual({
			action: "reject",
			status: 400,
			message: "Choose a session, or attach every open session.",
		});
	});

	it("reports when nothing is open to attach", () => {
		const decision = decideAttach({
			intent: "attach",
			all: true,
			pinned: true,
			codeAccepted: false,
			sessions: [closed],
		});
		expect(decision.action).toBe("reject");
		if (decision.action === "reject") {
			expect(decision.status).toBe(404);
			expect(decision.message).toBe(
				"No CLI session is open. Create one here, or run dg-agent start.",
			);
			expect(decision.message).not.toContain(TOKEN);
		}
	});

	it("creates a waiting session once the caller is allowed to", () => {
		expect(
			decideAttach({
				intent: "create",
				pinned: true,
				codeAccepted: false,
				sessions: [],
			}),
		).toEqual({ action: "create" });
		expect(
			decideAttach({
				intent: "create",
				pinned: false,
				codeAccepted: false,
				sessions: [],
			}).action,
		).toBe("reject");
	});
});

describe("selectWaitingSession", () => {
	const waiting = {
		sessionId: "wait-1",
		cwd: "/work/app",
		awaitingAgent: true,
		token: TOKEN,
	};

	it("claims the only waiting session for this directory", () => {
		expect(selectWaitingSession([waiting], "/work/app")).toEqual({
			ok: true,
			sessionId: "wait-1",
		});
		expect(
			selectWaitingSession(
				[waiting, { ...waiting, sessionId: "busy", awaitingAgent: false }],
				"/work/app",
			),
		).toEqual({ ok: true, sessionId: "wait-1" });
	});

	it("claims the only waiting session even when its directory differs", () => {
		expect(selectWaitingSession([waiting], "/elsewhere")).toEqual({
			ok: true,
			sessionId: "wait-1",
		});
		expect(selectWaitingSession([], "/work/app").ok).toBe(false);
		const empty = selectWaitingSession([], "/work/app");
		if (!empty.ok) {
			expect(empty.reason).toBe("none");
			expect(empty.message).toBe(
				"No session is waiting for an agent in this directory.",
			);
		}
	});

	it("reports none without echoing a token when nothing is waiting", () => {
		const choice = selectWaitingSession(
			[{ ...waiting, awaitingAgent: false, token: TOKEN }],
			"/elsewhere",
		);
		expect(choice.ok).toBe(false);
		if (!choice.ok) {
			expect(choice.reason).toBe("none");
			expect(choice.message).toBe(
				"No session is waiting for an agent in this directory.",
			);
			expect(choice.message).not.toContain(TOKEN);
		}
	});

	it("claims the waiting session whose directory matches when several are waiting", () => {
		expect(
			selectWaitingSession(
				[waiting, { ...waiting, sessionId: "wait-2", cwd: "/other" }],
				"/work/app",
			),
		).toEqual({ ok: true, sessionId: "wait-1" });
	});

	it("lists every waiting id when none of them match this directory", () => {
		const choice = selectWaitingSession(
			[
				waiting,
				{ ...waiting, sessionId: "wait-2", cwd: "/other", token: TOKEN },
			],
			"/elsewhere",
		);
		expect(choice.ok).toBe(false);
		if (!choice.ok) {
			expect(choice.reason).toBe("ambiguous");
			expect(choice.message).toBe(
				"Several sessions are waiting for an agent. Pass --session. wait-1, wait-2",
			);
			expect(choice.message).not.toContain(TOKEN);
		}
	});

	it("names only the sessions in this directory when another is waiting elsewhere", () => {
		const choice = selectWaitingSession(
			[
				waiting,
				{ ...waiting, sessionId: "wait-2" },
				{ ...waiting, sessionId: "wait-3", cwd: "/other", token: TOKEN },
			],
			"/work/app",
		);
		expect(choice.ok).toBe(false);
		if (!choice.ok) {
			expect(choice.message).toBe(
				"Several sessions are waiting in this directory. Pass --session. wait-1, wait-2",
			);
			expect(choice.message).not.toContain("wait-3");
			expect(choice.message).not.toContain(TOKEN);
		}
	});

	it("names both ids when two sessions are waiting and does not include the token", () => {
		const choice = selectWaitingSession(
			[waiting, { ...waiting, sessionId: "wait-2" }],
			"/work/app",
		);
		expect(choice.ok).toBe(false);
		if (!choice.ok) {
			expect(choice.reason).toBe("ambiguous");
			expect(choice.message).toBe(
				"Several sessions are waiting in this directory. Pass --session. wait-1, wait-2",
			);
			expect(choice.message).not.toContain(TOKEN);
		}
	});

	it("claims an explicit waiting id and rejects one that is not waiting", () => {
		expect(selectWaitingSession([waiting], "/elsewhere", "wait-1")).toEqual({
			ok: true,
			sessionId: "wait-1",
		});
		const busy = selectWaitingSession(
			[{ ...waiting, awaitingAgent: false }],
			"/work/app",
			"wait-1",
		);
		expect(busy.ok).toBe(false);
		if (!busy.ok) {
			expect(busy.reason).toBe("not-waiting");
			expect(busy.message).toBe("Session wait-1 is not waiting for an agent.");
			expect(busy.message).not.toContain(TOKEN);
		}
		const missing = selectWaitingSession([waiting], "/work/app", "nope");
		expect(missing.ok).toBe(false);
		if (!missing.ok) {
			expect(missing.reason).toBe("missing");
			expect(missing.message).toBe("No session nope is registered.");
			expect(missing.message).not.toContain(TOKEN);
		}
	});
});
