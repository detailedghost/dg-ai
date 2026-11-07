import { describe, expect, it } from "bun:test";
import {
	CHAT_ATTACH_PATH,
	CHAT_SESSIONS_CLEAR_PATH,
	CHAT_SESSIONS_LOCAL_PATH,
	decideAttach,
	decideLocalAttach,
	validateAttachRequest,
} from "../src/session-connect";

const TOKEN = "session-token-must-not-leak-into-errors";

describe("session routes", () => {
	it("keeps the loopback session lookup off the public catalog path", () => {
		expect(CHAT_SESSIONS_CLEAR_PATH).toBe("/sessions/clear");
		expect(CHAT_SESSIONS_LOCAL_PATH).toBe("/sessions/local");
		expect(CHAT_ATTACH_PATH).toBe("/attach");
	});
});

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

	it("keeps the optional fields an attach request is allowed to set", () => {
		expect(
			validateAttachRequest({
				intent: "attach",
				code: "654321",
				sessionId: "sess-1",
				all: false,
			}),
		).toEqual({
			intent: "attach",
			code: "654321",
			sessionId: "sess-1",
			all: false,
		});
	});

	it('rejects the create intent with attach request.intent must be "attach"', () => {
		expect(() =>
			validateAttachRequest({ intent: "create", code: "654321" }),
		).toThrow('attach request.intent must be "attach"');
	});

	it("ignores workset, agentIdentity and role fields it no longer carries", () => {
		expect(
			Object.keys(
				validateAttachRequest({
					workset: "app",
					agentIdentity: "claude",
					role: "orchestrator",
				}),
			),
		).toEqual(["intent"]);
	});

	it("rejects empty or mistyped optional fields", () => {
		expect(() => validateAttachRequest({ sessionId: "  " })).toThrow(/sessionId/);
		expect(() => validateAttachRequest({ code: 123456 })).toThrow(/code/);
		expect(() => validateAttachRequest("nope")).toThrow(
			"attach request must be an object",
		);
	});

	it("returns only the intent when no optional field is set", () => {
		expect(Object.keys(validateAttachRequest({}))).toEqual(["intent"]);
		expect(CHAT_ATTACH_PATH).toBe("/attach");
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
				"No agent session is open. Run dg-agent start, then paste the code again.",
			);
			expect(decision.message).not.toContain(TOKEN);
		}
	});

});

describe("decideLocalAttach", () => {
	type Candidate = Parameters<typeof decideLocalAttach>[0]["registry"][number];
	const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({
		sessionId: "target",
		role: "agent",
		presence: "cli",
		state: "active",
		...overrides,
	});
	const NOT_ACTIVE = {
		action: "reject",
		status: 404,
		message: "That session is not active.",
	} as const;

	it("returns only the requested session when it is active, role agent and presence cli", () => {
		expect(
			decideLocalAttach({
				sessionId: "target",
				registry: [candidate({ sessionId: "other" }), candidate()],
			}),
		).toEqual({ action: "return", sessionIds: ["target"] });
	});

	it("rejects the caller's own session with 404", () => {
		expect(
			decideLocalAttach({
				sessionId: "target",
				callerSessionId: "target",
				registry: [candidate()],
			}),
		).toEqual(NOT_ACTIVE);
	});

	it("rejects a missing sessionId with 400 instead of listing sessions", () => {
		expect(
			decideLocalAttach({ registry: [candidate(), candidate({ sessionId: "b" })] }),
		).toMatchObject({ action: "reject", status: 400 });
	});

	it("answers 404 for an unknown id, a closed session, a non-agent role and any presence other than cli", () => {
		const cases: Partial<Candidate>[] = [
			{ state: "closed" },
			{ role: "orchestrator" },
			{ presence: "idle" },
			{ presence: "gone" },
		];
		for (const overrides of cases) {
			expect(
				decideLocalAttach({ sessionId: "target", registry: [candidate(overrides)] }),
			).toEqual(NOT_ACTIVE);
		}
		expect(decideLocalAttach({ sessionId: "missing", registry: [candidate()] })).toEqual(
			NOT_ACTIVE,
		);
	});
});
