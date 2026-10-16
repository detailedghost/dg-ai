import { describe, expect, it } from "bun:test";
import {
	connectionGuidance,
	handshakeOutcome,
	reconnectDelayMs,
	redactSecrets,
	sessionControls,
	staleSessionIds,
} from "@/lib/features/chat-connection";

const TOKEN = "bootstrap-token-should-stay-out-of-ui";

describe("sessionControls", () => {
	it("offers connect for a CLI session the panel does not hold", () => {
		const [control] = sessionControls(
			[{ sessionId: "s1", agentIdentity: "claude", presence: "cli" }],
			[],
		);
		expect(control).toMatchObject({
			canConnect: true,
			canStop: false,
			canDisconnect: false,
			stale: false,
			presence: "cli",
		});
	});

	it("offers stop and disconnect for a held connected session", () => {
		const [control] = sessionControls(
			[{ sessionId: "s1", agentIdentity: "claude", presence: "cli" }],
			[{ sessionId: "s1", connected: true }],
		);
		expect(control).toMatchObject({
			held: true,
			connected: true,
			canConnect: false,
			canStop: true,
			canDisconnect: true,
			stale: false,
		});
	});

	it("treats gone and idle sessions as stale and waiting sessions as not stale", () => {
		const controls = sessionControls(
			[
				{ sessionId: "gone", agentIdentity: "claude", presence: "gone" },
				{ sessionId: "idle", agentIdentity: "claude", presence: "idle" },
				{ sessionId: "wait", agentIdentity: "claude", presence: "waiting" },
			],
			[],
		);
		expect(staleSessionIds(controls)).toEqual(["gone", "idle"]);
		expect(controls.find((item) => item.sessionId === "wait")?.stale).toBe(false);
	});

	it("defaults a missing presence to idle and includes held sessions missing from the catalog", () => {
		const controls = sessionControls(
			[
				{ sessionId: "s1", agentIdentity: "claude" },
				{ sessionId: "s1", agentIdentity: "claude", presence: "cli" },
			],
			[
				{ sessionId: "s2", connected: false },
				{ sessionId: "s3", connected: true },
			],
		);
		expect(controls.map((item) => item.sessionId)).toEqual(["s1", "s2", "s3"]);
		expect(controls[0]?.presence).toBe("idle");
		expect(controls[0]?.stale).toBe(true);
		expect(controls[1]).toMatchObject({
			agentIdentity: "session",
			presence: "idle",
			canStop: true,
			canDisconnect: false,
			stale: true,
		});
		expect(controls[2]).toMatchObject({
			presence: "cli",
			canDisconnect: true,
			stale: false,
		});
		expect(
			sessionControls(
				[],
				[
					{ sessionId: "s2", connected: false },
					{ sessionId: "s2", connected: true },
				],
			),
		).toHaveLength(1);
	});
});

describe("redactSecrets", () => {
	it("replaces a session token and leaves the rest of the message", () => {
		expect(redactSecrets(`failed for ${TOKEN} on port 1`, [TOKEN])).toBe(
			"failed for [redacted] on port 1",
		);
	});

	it("ignores secrets that are too short to be tokens", () => {
		expect(redactSecrets("code 123456", ["123456"])).toBe("code 123456");
		expect(redactSecrets("edge 1234567", ["1234567"])).toBe("edge 1234567");
		expect(redactSecrets("edge 12345678", ["12345678"])).toBe("edge [redacted]");
	});

	it("redacts emails, bootstrap urls, and auth headers through the shared redactor", () => {
		const line = redactSecrets(
			`ada@example.com Authorization: Bearer ${TOKEN} http://127.0.0.1:9/start#_chat=${TOKEN}`,
			[TOKEN],
		);
		expect(line).not.toContain(TOKEN);
		expect(line).not.toContain("ada@example.com");
		expect(line).toContain("#_chat=[redacted]");
	});

	it("replaces every copy of every secret", () => {
		expect(redactSecrets(`${TOKEN} ${TOKEN}`, [TOKEN, "other-secret-value"])).toBe(
			"[redacted] [redacted]",
		);
	});
});

describe("connectionGuidance", () => {
	it("names the next action for each side of an unconnected session", () => {
		expect(
			connectionGuidance({ daemonUp: false, paired: false, presences: [] }),
		).toBe("Start the daemon: run dg-agent start");
		expect(
			connectionGuidance({ daemonUp: true, paired: false, presences: [] }),
		).toBe("No session yet. Choose New session for CLI, then run dg-agent attach.");
		expect(
			connectionGuidance({
				daemonUp: true,
				paired: false,
				presences: ["waiting"],
			}),
		).toBe("A session is waiting for the CLI. Run dg-agent attach in the terminal.");
		expect(
			connectionGuidance({ daemonUp: true, paired: false, presences: ["cli"] }),
		).toBe("The CLI is connected. Choose Connect on that session.");
		expect(
			connectionGuidance({ daemonUp: true, paired: true, presences: ["cli"] }),
		).toBe("Paired — connection confirmed");
		expect(
			connectionGuidance({
				daemonUp: true,
				paired: false,
				presences: [],
				heldDisconnected: true,
			}),
		).toBe("Disconnected — waiting for the daemon to confirm the connection.");
		expect(
			connectionGuidance({ daemonUp: true, paired: false, presences: ["idle"] }),
		).toBe("Choose Connect on a session, or run dg-agent start.");
	});
});

describe("handshakeOutcome", () => {
	it("accepts a session-list as a completed handshake", () => {
		expect(handshakeOutcome({ type: "session-list" })).toBe("ok");
	});

	it("drops an invalid session instead of retrying it", () => {
		expect(
			handshakeOutcome({ type: "error", code: "invalid-session", message: TOKEN }),
		).toBe("drop");
	});

	it("drops a protocol mismatch and retries other errors", () => {
		expect(
			handshakeOutcome({
				type: "error",
				message: "Protocol Version Mismatch: daemon expects 1",
			}),
		).toBe("drop");
		expect(handshakeOutcome({ type: "error", message: "temporary" })).toBe("retry");
		expect(handshakeOutcome({ type: "error" })).toBe("retry");
		expect(handshakeOutcome({ type: "ack" })).toBe("retry");
		expect(
			handshakeOutcome({ type: "ack", code: "invalid-session" }),
		).toBe("retry");
	});
});

describe("reconnectDelayMs", () => {
	it("grows with the attempt and applies jitter", () => {
		expect(reconnectDelayMs(0, 100, 10_000, 0)).toBe(100);
		expect(reconnectDelayMs(1, 100, 10_000, 0)).toBe(200);
		expect(reconnectDelayMs(0, 100, 10_000, 1)).toBe(200);
	});

	it("caps both the raw delay and the jittered delay at the max", () => {
		expect(reconnectDelayMs(20, 100, 50, 0)).toBe(50);
		expect(reconnectDelayMs(1, 100, 150, 1)).toBe(150);
	});
});
