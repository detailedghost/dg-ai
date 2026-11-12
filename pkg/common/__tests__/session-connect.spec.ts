import { describe, expect, it } from "bun:test";
import {
	CHAT_ATTACH_PATH,
	CHAT_SESSIONS_CLEAR_PATH,
	CHAT_SESSIONS_LOCAL_PATH,
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
	it("defaults a missing intent to attach and keeps the session id", () => {
		expect(validateAttachRequest({ sessionId: "sess-1" })).toEqual({
			intent: "attach",
			sessionId: "sess-1",
		});
	});

	it("rejects a code or an all flag", () => {
		expect(() => validateAttachRequest({ code: "123456" })).toThrow(/sessionId/);
		expect(() => validateAttachRequest({ all: true })).toThrow(/sessionId/);
		expect(() => validateAttachRequest({ all: false })).toThrow(/sessionId/);
	});

	it("rejects an unknown intent", () => {
		expect(() => validateAttachRequest({ intent: "hijack" })).toThrow(/intent/);
	});

	it('rejects the create intent with attach request.intent must be "attach"', () => {
		expect(() => validateAttachRequest({ intent: "create" })).toThrow(
			'attach request.intent must be "attach"',
		);
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

	it("rejects an empty session id and a non-object body", () => {
		expect(() => validateAttachRequest({ sessionId: "  " })).toThrow(/sessionId/);
		expect(() => validateAttachRequest("nope")).toThrow(
			"attach request must be an object",
		);
	});

	it("returns only the intent when no optional field is set", () => {
		expect(Object.keys(validateAttachRequest({}))).toEqual(["intent"]);
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
