import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	clearNotedSecrets,
	emitRedacted,
	installRedactingConsole,
	noteSecret,
	redactLiterals,
	redactSecrets,
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
		const payload = Buffer.from(
			JSON.stringify({
				port: 47823,
				sessionId: "11111111-1111-1111-1111-111111111111",
				token: TOKEN,
				agentIdentity: "claude",
			}),
		).toString("base64url");
		const url = `http://127.0.0.1:47823/chat#_chat=${payload}`;
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
		expect(report).not.toHaveProperty("sidePanel");
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

describe("redactText without a process global", () => {
	it("still redacts in an extension service worker", () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalThis, "process");
		Object.defineProperty(globalThis, "process", {
			configurable: true,
			value: undefined,
		});
		let output: string;
		try {
			output = redactText("token ghp_abcdefghijklmnop");
		} finally {
			if (descriptor) Object.defineProperty(globalThis, "process", descriptor);
		}
		expect(output).toBe("token [redacted]");
	});
});

describe("email pattern", () => {
	it("masks an email and scans a long run without an at sign in linear time", () => {
		expect(redactText("to a.b+c@clinic.test now")).toBe("to [redacted] now");
		expect(redactText("a@b.co,c@d.co")).toBe("[redacted],[redacted]");
		const started = performance.now();
		redactText(`${"a".repeat(200_000)} token=abcdefgh`);
		expect(performance.now() - started).toBeLessThan(1000);
	});
});

describe("token prefixes", () => {
	it("masks GitHub app and GitLab personal tokens", () => {
		expect(redactText("a ghs_abcdefgh12345678 b glpat-abcdefgh12345678")).toBe("a [redacted] b [redacted]");
		expect(redactSecrets("ghs_abcdefgh12345678")).toBe("[redacted]");
	});
});

describe("redactSecrets", () => {
	it("keeps email addresses but masks tokens, keys and literal secrets", () => {
		const text = "user ada@example.test token=abc123def456 key sk-abcdefgh12345678 pass Hunter2-secret";
		const out = redactSecrets(text, ["Hunter2-secret"]);
		expect(out).toContain("ada@example.test");
		expect(out).not.toContain("sk-abcdefgh12345678");
		expect(out).not.toContain("Hunter2-secret");
		expect(redactText(text)).not.toContain("ada@example.test");
	});
});

describe("redactLiterals", () => {
	it("masks the form serializer's form of a secret", () => {
		const secret = "s3cr3t!~ ('x')";
		const form = new URLSearchParams({ q: secret }).toString();
		expect(redactLiterals(form, [secret])).toBe("q=[redacted]");
	});

	it("masks the URL-encoded and form-encoded forms of a secret", () => {
		const secret = "Tr0ub4dor&3 x/y";
		const text = `a=${encodeURIComponent(secret)} b=${encodeURIComponent(secret).replace(/%20/g, "+")} c=${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (hex) => hex.toLowerCase())}`;
		expect(redactLiterals(text, [secret])).toBe("a=[redacted] b=[redacted] c=[redacted]");
	});

	it("masks a given secret of any length, and ignores an empty one", () => {
		expect(redactLiterals("cvv 123 ok 123", ["123", ""])).toBe("cvv [redacted] ok [redacted]");
		expect(redactLiterals("plain", [])).toBe("plain");
	});

	it("masks the whitespace-collapsed form of a secret", () => {
		expect(redactLiterals("pw orchid maple lantern", ["orchid  maple\tlantern"])).toBe("pw [redacted]");
	});

	it("masks the JSON-escaped form of a secret", () => {
		const secret = 'pa"ss\\word';
		expect(redactLiterals(JSON.stringify({ value: secret }), [secret])).toBe('{"value":"[redacted]"}');
	});

	it("masks the clipped start of a secret before an ellipsis", () => {
		expect(redactLiterals(`${"x".repeat(10)}739…`, ["739123"])).toBe(`${"x".repeat(10)}[redacted]…`);
		expect(redactLiterals("code 739 ok", ["739123"])).toBe("code 739 ok");
	});

	it("leaves a clipped start shorter than 3 characters", () => {
		expect(redactLiterals("code 73…", ["739123"])).toBe("code 73…");
		expect(redactLiterals("code 739…", ["739123"])).toBe("code [redacted]…");
		expect(redactLiterals("code 739123 73…", ["739123"])).toBe("code [redacted] 73…");
	});
});

describe("redactText with literals", () => {
	it("masks a whole literal that holds a token-shaped part", () => {
		const secret = "sk-abcdefgh12345678 tail-passphrase";
		expect(redactText(`title ${secret} end`, [], { literals: [secret] })).toBe("title [redacted] end");
	});

	it("keeps a credential label masked when a literal is part of the label", () => {
		const out = redactText("password=opensesame-value", [], {
			literals: ["pass"],
			extraPatterns: [{ pattern: /\b(password)(=)\S+/gi, replacement: "$1$2[redacted]" }],
		});
		expect(out).not.toContain("opensesame");
		expect(out).not.toContain("pass");
	});

	it("masks the line-break-free form of a literal", () => {
		expect(redactText("value orchidmaple", [], { literals: ["orchid\nmaple"] })).toBe("value [redacted]");
		expect(redactLiterals("value orchidmaple", ["orchid\r\nmaple"])).toBe("value [redacted]");
	});
});
