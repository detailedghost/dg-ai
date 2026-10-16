import { describe, expect, it } from "bun:test";
import { projectLocalSessions } from "../../src/session/local-sessions";

const TOKEN = "fixture-session-token-value";

const sessions = [
	{
		sessionId: "alpha",
		cwd: "/work/alpha",
		agentIdentity: "claude",
		token: TOKEN,
	},
	{
		sessionId: "beta",
		cwd: "/work/beta",
		agentIdentity: "reviewer",
		token: "fixture-other-token-value",
	},
];

describe("projectLocalSessions", () => {
	it("omits every token when the caller did not name a session", () => {
		const projected = projectLocalSessions(sessions, null);
		expect(projected.status).toBe(200);
		expect(projected.sessions).toEqual([
			{ sessionId: "alpha", cwd: "/work/alpha", agentIdentity: "claude" },
			{ sessionId: "beta", cwd: "/work/beta", agentIdentity: "reviewer" },
		]);
		expect(JSON.stringify(projected)).not.toContain(TOKEN);
	});

	it("treats an empty session query as a listing", () => {
		expect(projectLocalSessions(sessions, "").sessions).toHaveLength(2);
		expect(JSON.stringify(projectLocalSessions(sessions, ""))).not.toContain(TOKEN);
	});

	it("returns the one named session, including its token", () => {
		expect(projectLocalSessions(sessions, "beta")).toEqual({
			status: 200,
			sessions: [sessions[1]],
		});
	});

	it("returns nothing for an unknown session id", () => {
		expect(projectLocalSessions(sessions, "missing")).toEqual({
			status: 404,
			sessions: [],
		});
	});
});
