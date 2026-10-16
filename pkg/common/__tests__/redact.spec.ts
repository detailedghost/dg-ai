import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { buildBootstrapUrl } from "../src/node/marker";
import {
	clearNotedSecrets,
	emitRedacted,
	installRedactingConsole,
	noteSecret,
	redactText,
} from "../src/redact";
import {
	formatConnectionDrop,
	logConnectionDrop,
	logHarnessLine,
	redactSessionId,
} from "../src/connection-drop";

const TOKEN = "session-token-must-not-leak";
const EMAIL = "ada@example.com";
const API_KEY = "sk-live-abcdefghijklmnopqrst";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("redactText", () => {
	const previous = process.env.DG_SESSION_TOKEN;
	afterEach(() => {
		clearNotedSecrets();
		if (previous === undefined) delete process.env.DG_SESSION_TOKEN;
		else process.env.DG_SESSION_TOKEN = previous;
	});

	it("redacts explicit secrets of at least 8 characters and leaves shorter ones", () => {
		expect(redactText(`failed for ${TOKEN} on port 1`, [TOKEN])).toBe(
			"failed for [redacted] on port 1",
		);
		expect(redactText("code 123456", ["123456"])).toBe("code 123456");
		expect(redactText("edge 1234567", ["1234567"])).toBe("edge 1234567");
		expect(redactText("edge 12345678", ["12345678"])).toBe("edge [redacted]");
		expect(redactText("Stryker was here")).toBe("Stryker was here");
		noteSecret("1234567");
		noteSecret("12345678");
		expect(redactText("noted 1234567 and 12345678")).toBe(
			"noted 1234567 and [redacted]",
		);
		clearNotedSecrets();
		expect(redactText("cleared 12345678")).toBe("cleared 12345678");
	});

	it("redacts the longer of two overlapping secrets first", () => {
		expect(
			redactText("abcdefghijEXTRA", ["abcdefghij", "abcdefghijEXTRA"]),
		).toBe("[redacted]");
	});

	it("redacts emails, bearer tokens, auth headers, api keys, and jwts", () => {
		expect(redactText("ab@example.com")).toBe("[redacted]");
		expect(redactText("a@b.c")).toBe("a@b.c");
		expect(redactText("Bearer abcdefghij")).toBe("Bearer [redacted]");
		expect(redactText("Bearer  abcdefghij")).toBe("Bearer [redacted]");
		expect(redactText("cookie:  sessiontokenvalue")).toBe("[redacted]");
		expect(redactText("?token=abcdefgh")).toBe("?token=[redacted]");
		expect(redactText("#_xchat=secretvalue")).toBe("#_xchat=[redacted]");
		expect(redactText("XTOKEN=abcdefgh")).toBe("XTOKEN=[redacted]");
		expect(redactText("sk-abcdefgh")).toBe("[redacted]");
		expect(redactText("xoxb-abcdefgh")).toBe("[redacted]");
		expect(redactText('"token":"abcdefgh"')).toBe('"token":"[redacted]"');
		const line = redactText(
			`user ${EMAIL} Authorization: Bearer ${API_KEY} cookie: session=${TOKEN} ${JWT}`,
		);
		expect(line).not.toContain(EMAIL);
		expect(line).not.toContain(API_KEY);
		expect(line).not.toContain(TOKEN);
		expect(line).not.toContain(JWT);
		expect(line).toContain("[redacted]");
	});

	it("redacts a bootstrap url and a query token", () => {
		const url = buildBootstrapUrl(47823, {
			port: 47823,
			sessionId: "11111111-1111-1111-1111-111111111111",
			token: TOKEN,
			agentIdentity: "claude",
		});
		const line = redactText(`${url} http://127.0.0.1:9/cb?access_token=${TOKEN}`);
		expect(line).not.toContain(TOKEN);
		expect(line).toContain("#_chat=[redacted]");
		expect(line).toContain("access_token=[redacted]");
	});

	it("redacts env assignments and values that match a secret env var", () => {
		process.env.DG_SESSION_TOKEN = TOKEN;
		process.env.DG_API_KEY = "12345678";
		process.env.PLAIN_VALUE = "helloworld";
		const line = redactText(
			`DG_SESSION_TOKEN=${TOKEN} leaked ${TOKEN} API_KEY=sk-live-zzzzzzzz saw 12345678 and helloworld`,
		);
		expect(line).not.toContain(TOKEN);
		expect(line).toContain("DG_SESSION_TOKEN=[redacted]");
		expect(line).not.toContain("sk-live-zzzzzzzz");
		expect(line).toContain("saw [redacted] and helloworld");
		delete process.env.DG_API_KEY;
		delete process.env.PLAIN_VALUE;
	});
});

describe("logging paths", () => {
	afterEach(() => {
		clearNotedSecrets();
	});
	it("emitRedacted writes the daemon and agent failure line without the secret", () => {
		const lines: string[] = [];
		emitRedacted(
			(line) => lines.push(line),
			`dg-daemon: boom ${TOKEN} ${EMAIL}`,
			[TOKEN],
		);
		emitRedacted((line) => lines.push(line), `dg-agent: boom ${TOKEN}`, [TOKEN]);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toContain(TOKEN);
		expect(lines.join("\n")).not.toContain(EMAIL);
	});

	it("installRedactingConsole redacts every console method used in a test run", () => {
		noteSecret(TOKEN);
		const calls: string[] = [];
		const fake = {
			log: (...args: unknown[]) => calls.push(args.join(" ")),
			info: (...args: unknown[]) => calls.push(args.join(" ")),
			warn: (...args: unknown[]) => calls.push(args.join(" ")),
			error: (...args: unknown[]) => calls.push(args.join(" ")),
			debug: (...args: unknown[]) => calls.push(args.join(" ")),
		} as unknown as Console;
		installRedactingConsole(fake);
		fake.error(`extension ${TOKEN}`);
		fake.warn(`runner ${EMAIL}`);
		fake.error(new Error(`boom ${TOKEN}`));
		fake.log(12345);
		expect(calls.join(" ")).not.toContain(TOKEN);
		expect(calls.join(" ")).not.toContain(EMAIL);
		expect(calls.join(" ")).toContain("12345");
		expect(calls.join(" ")).toContain("boom [redacted]");
	});

	it("logHarnessLine and logConnectionDrop are the test-runner paths", () => {
		const lines: string[] = [];
		logHarnessLine(`chrome failed ${TOKEN} ${EMAIL}`, (line) => lines.push(line), [
			TOKEN,
		]);
		logConnectionDrop(
			{
				phase: "handshake",
				reason: `rejected ${TOKEN}`,
				sessionIds: ["11111111-1111-4111-8111-111111111111"],
				socket: { url: `ws://127.0.0.1:9/?token=${TOKEN}` },
				lastMessages: [
					{
						direction: "in",
						type: "error",
						at: "2026-01-01T00:00:00.000Z",
						summary: `body ${TOKEN} ${EMAIL}`,
					},
				],
				secrets: [TOKEN],
			},
			(line) => lines.push(line),
		);
		const text = lines.join("\n");
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(EMAIL);
		expect(text).not.toContain("11111111-1111-4111-8111-111111111111");
		expect(text).toContain("11111111[redacted]");
		const summary = "s".repeat(200);
		const report = JSON.parse(
			formatConnectionDrop({
				at: "2026-01-02T00:00:00.000Z",
				phase: "dropped",
				reason: "socket closed",
				sessionIds: ["sess-abc123", "22222222-2222-4222-8222-222222222222"],
				port: 47823,
				socket: { readyState: "closed", url: "ws://127.0.0.1:47823/ws" },
				sidePanel: { open: true, lifecycle: "open" },
				serviceWorker: { active: true, lifecycle: "running" },
				lastMessages: [
					{
						direction: "out",
						type: "connect",
						at: "2026-01-02T00:00:00.000Z",
						summary,
					},
				],
				timers: { keepaliveMs: 20_000, heartbeat: "armed" },
				daemon: { reachable: true, port: 47823 },
				agent: { attached: true, presence: "connected" },
			}),
		) as {
			at: string;
			sessionIds: string[];
			port: number;
			socket: { readyState: string };
			sidePanel: { open: boolean };
			serviceWorker: { lifecycle: string };
			lastMessages: { direction: string; type: string; summary: string }[];
			daemon: { reachable: boolean };
			agent: { attached: boolean };
		};
		expect(report.at).toBe("2026-01-02T00:00:00.000Z");
		expect(report.sessionIds).toEqual([
			"sess-abc123",
			"22222222[redacted]",
		]);
		expect(report.port).toBe(47823);
		expect(report.socket.readyState).toBe("closed");
		expect(report.sidePanel.open).toBe(true);
		expect(report.serviceWorker.lifecycle).toBe("running");
		expect(report.lastMessages[0]).toMatchObject({
			direction: "out",
			type: "connect",
			summary: "s".repeat(180),
		});
		expect(report.daemon.reachable).toBe(true);
		expect(report.agent.attached).toBe(true);
		const minimal = formatConnectionDrop({
			phase: "dropped",
			reason: "socket closed",
		});
		expect(minimal).toContain('"port":null');
		expect(minimal).toContain('"sessionIds":[]');
		expect(minimal).toContain('"lastMessages":[]');
		expect(
			redactSessionId("x22222222-2222-4222-8222-222222222222"),
		).toBe("x22222222-2222-4222-8222-222222222222");
		expect(
			redactSessionId("22222222-2222-4222-8222-222222222222z"),
		).toBe("22222222-2222-4222-8222-222222222222z");
	});

	it("writes harness lines through the console when no writer is passed", () => {
		const error = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			logHarnessLine("harness plain line");
			logConnectionDrop({ phase: "extension-load", reason: "missing" });
			const text = error.mock.calls.map((call) => String(call[0])).join("\n");
			expect(text).toContain("harness plain line");
			expect(text).toContain('"phase":"extension-load"');
		} finally {
			error.mockRestore();
		}
	});
});
