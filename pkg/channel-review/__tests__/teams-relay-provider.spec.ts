import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { retryAfterMs } from "../src/providers/teams-relay/client";
import type { EnvName } from "../src/config";
import { loadConfig, resolveEnv } from "../src/config";
import {
	createTeamsRelayProvider,
	RelayAuthError,
} from "../src/providers/teams-relay";
import type { AdaptiveCard, ChatEvent } from "../src/providers/types";
import {
	APP_NAME,
	RELAY_SECRET,
	BOT_NAME,
	CHAT_ID,
	createEngineHarness,
	createRecordedLog,
	createTempHome,
	minimalConfigJson,
	PR_URL,
	SENDER_EMAIL,
	type TempHome,
	waitUntil,
	writeConfigFile,
} from "./support/fakes";

const SECRET = "s3cret-VALUE-9f2c";
const WATCHDOG_MS = 45_000;
const RESPONSE_BODY_LEAK = "BODY-LEAK-MARKER";
const encoder = new TextEncoder();

type Recorded = {
	url: string;
	method: string;
	headers: Headers;
	body: string | undefined;
	signal: AbortSignal | undefined;
	redirect: RequestRedirect | undefined;
	at: number;
};

type Handler = (request: Recorded) => Response | Promise<Response>;

let home: TempHome;
beforeEach(() => {
	home = createTempHome();
});
afterEach(() => {
	home.cleanup();
});

function stalledResponse(request: Recorded): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				const fail = () =>
					controller.error(new DOMException("aborted", "AbortError"));
				if (request.signal?.aborted) fail();
				else request.signal?.addEventListener("abort", fail, { once: true });
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function sseResponse(
	chunks: (string | Uint8Array)[],
	options: { end?: boolean } = {},
): Handler {
	const end = options.end ?? true;
	return (request) =>
		new Response(
			new ReadableStream({
				start(controller) {
					for (const chunk of chunks) {
						controller.enqueue(
							typeof chunk === "string" ? encoder.encode(chunk) : chunk,
						);
					}
					if (end) {
						controller.close();
						return;
					}
					const fail = () =>
						controller.error(new DOMException("aborted", "AbortError"));
					if (request.signal?.aborted) fail();
					else request.signal?.addEventListener("abort", fail, { once: true });
				},
			}),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
}

const status =
	(code: number, headers: Record<string, string> = {}): Handler =>
	() =>
		new Response(code === 204 ? null : RESPONSE_BODY_LEAK, {
			status: code,
			headers,
		});

const rawBody =
	(code: number, body: string): Handler =>
	() =>
		new Response(body, { status: code });

const LEAK_HTML = "LEAKMARK <html>";
const API_CODE = Buffer.from(`${APP_NAME}:${SECRET}`).toString("base64");
const SECRET_SLICE = SECRET.slice(2, 12);
const API_CODE_SLICE = API_CODE.slice(4, 16);

function expectNoCredentialOrBody(text: string) {
	expect(text).not.toContain(SECRET);
	expect(text).not.toContain(SECRET_SLICE);
	expect(text).not.toContain(API_CODE);
	expect(text).not.toContain(API_CODE_SLICE);
	expect(text).not.toContain(RESPONSE_BODY_LEAK);
	expect(text).not.toContain("LEAKMARK");
}

const json =
	(code: number, body: unknown): Handler =>
	() =>
		new Response(JSON.stringify(body), {
			status: code,
			headers: { "content-type": "application/json" },
		});

function frame(
	event: string,
	options: { id?: string; data?: string } = {},
): string {
	const lines = [`event: ${event}`];
	if (options.id !== undefined) lines.push(`id: ${options.id}`);
	if (options.data !== undefined) lines.push(`data: ${options.data}`);
	return `${lines.join("\n")}\n\n`;
}

function messageData(id: string, text: string | null = "hello"): string {
	return JSON.stringify({
		id,
		chatId: CHAT_ID,
		from: { aadObjectId: "aad-1", name: "Owner", isBot: false },
		text,
		timestamp: "2026-10-14T12:00:00.000Z",
	});
}

const messageFrame = (
	eventId: string,
	id = `m-${eventId}`,
	text: string | null = "hello",
) => frame("message", { id: eventId, data: messageData(id, text) });

function reactionData(
	id: string,
	type: string,
	action: "added" | "removed" = "added",
) {
	return JSON.stringify({
		id,
		chatId: CHAT_ID,
		messageId: "m-target",
		from: { aadObjectId: "aad-2", name: "Owner", isBot: false },
		type,
		action,
		timestamp: "2026-10-14T12:00:01.000Z",
	});
}

type Options = {
	handlers?: Handler[];
	chat?: Record<string, unknown>;
	envName?: EnvName;
	watchdogHeld?: boolean;
	holdBackoff?: boolean;
	streamIdleSeconds?: number;
};

function createHarness(options: Options = {}) {
	const configPath = writeConfigFile(
		home.dir,
		minimalConfigJson({
			...(options.chat ? { chat: options.chat } : {}),
			...(options.streamIdleSeconds === undefined
				? {}
				: { relay: { appName: APP_NAME, secret: RELAY_SECRET, streamIdleSeconds: options.streamIdleSeconds } }),
		}),
	);
	const config = loadConfig(configPath);
	const env = resolveEnv(config, options.envName);
	const requests: Recorded[] = [];
	const queue = [...(options.handlers ?? [])];
	let clock = 1_000_000;
	const sleeps: number[] = [];
	const pendingWatchdogs: (() => void)[] = [];
	const heldBackoffs: (() => void)[] = [];
	const log = createRecordedLog();

	const fetchFake = (async (input: unknown, init: RequestInit = {}) => {
		const request: Recorded = {
			url: String(input),
			method: init.method ?? "GET",
			headers: new Headers(init.headers),
			body: typeof init.body === "string" ? init.body : undefined,
			signal: init.signal ?? undefined,
			redirect: init.redirect,
			at: clock,
		};
		requests.push(request);
		const handler = queue.shift();
		if (handler) return handler(request);
		if (request.url.endsWith("/events")) return stalledResponse(request);
		throw new Error(`unscripted request ${request.method} ${request.url}`);
	}) as unknown as typeof fetch;

	const provider = createTeamsRelayProvider(config, env, {
		fetch: fetchFake,
		secret: SECRET,
		now: () => clock,
		random: () => 0.5,
		log,
		sleep: (ms: number, signal?: AbortSignal) => {
			sleeps.push(ms);
			if (ms === WATCHDOG_MS || ms === (options.streamIdleSeconds ?? 45) * 1000) {
				return new Promise<void>((resolve) => {
					pendingWatchdogs.push(resolve);
					signal?.addEventListener(
						"abort",
						() => {
							const at = pendingWatchdogs.indexOf(resolve);
							if (at >= 0) pendingWatchdogs.splice(at, 1);
							resolve();
						},
						{ once: true },
					);
				});
			}
			if (options.holdBackoff) {
				return new Promise<void>((resolve) => heldBackoffs.push(resolve));
			}
			clock += ms;
			return Promise.resolve();
		},
	});

	return {
		config,
		env,
		provider,
		requests,
		sleeps,
		log,
		fireWatchdog: () => {
			for (const resolve of pendingWatchdogs.splice(0)) resolve();
		},
		heldBackoffs,
		pendingWatchdogCount: () => pendingWatchdogs.length,
		backoffs: () => sleeps.filter((ms) => ms !== WATCHDOG_MS),
		url: (path: string) => `${env.baseUrl}${path}`,
		lines: () => log.lines.map((line) => line.message),
	};
}

type Harness = ReturnType<typeof createHarness>;

function startDrain(harness: Harness, resumeId?: string, chatId = CHAT_ID) {
	const controller = new AbortController();
	const events: ChatEvent[] = [];
	const done = (async (): Promise<unknown> => {
		try {
			for await (const event of harness.provider.subscribe({
				chatId,
				resumeId,
				signal: controller.signal,
			})) {
				events.push(event);
			}
		} catch (error) {
			return error;
		}
		return undefined;
	})();
	return {
		events,
		done,
		stop: () => {
			controller.abort();
			return done;
		},
	};
}

const eventsPath = (chatId = CHAT_ID) =>
	`/chat/${encodeURIComponent(chatId)}/events`;

describe("createTeamsRelayProvider subscribe", () => {
	test("requests the encoded events path with event-stream accept and the api code header", async () => {
		const harness = createHarness({
			handlers: [sseResponse([messageFrame("e1")], { end: false })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		const [first] = harness.requests;
		expect(first?.url).toBe(harness.url(eventsPath()));
		expect(first?.method).toBe("GET");
		expect(first?.headers.get("accept")).toContain("text/event-stream");
		expect(first?.headers.get("x-api-code")).toBe(
			Buffer.from(`${APP_NAME}:${SECRET}`).toString("base64"),
		);
		expect(first?.headers.get("last-event-id")).toBeNull();
	});

	test("yields message events mapped from the camelCase wire shape", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([messageFrame("e1", "m-1", "hi there")], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		expect(drain.events[0]).toEqual({
			type: "message",
			eventId: "e1",
			message: {
				id: "m-1",
				chatId: CHAT_ID,
				from: { id: "aad-1", name: "Owner", isBot: false },
				text: "hi there",
				timestamp: "2026-10-14T12:00:00.000Z",
			},
		});
	});

	test.each(['href="', 'href = "'])(
		"preserves a titled HTML link (%s) from SSE through scheduling and replay protection",
		async (attribute) => {
			const text = `<p>!owner $review <a ${attribute}${PR_URL}?a=1&amp;b=2">Fix the linked records (owner's follow-up)…</a> ~agent codex ~model Codex-Model</p>`;
			const harness = createHarness({
				handlers: [sseResponse([messageFrame("e-link", "m-link", text)], { end: false })],
			});
			const engine = createEngineHarness();
			const drain = startDrain(harness);
			try {
				await waitUntil(() => drain.events.length === 1);
				await drain.stop();
				const event = drain.events[0];
				if (event?.type !== "message") throw new Error("expected a message event");
				expect(event.message.text).toBe(text);
				await engine.engine.handle(event.message);
				await engine.engine.idle();
				await engine.engine.handle(event.message);
				await engine.engine.idle();
				await engine.engine.handle({
					...event.message,
					id: "m-no-gate",
					text: text.replace("!owner", ""),
				});
				await engine.engine.handle({
					...event.message,
					id: "m-bot",
					from: { isBot: true },
				});
				await engine.engine.idle();
				expect(engine.runners.codex.runs).toHaveLength(1);
				expect(engine.runners.codex.runs[0]).toMatchObject({
					url: PR_URL,
					model: "Codex-Model",
				});
				expect(engine.state.get().handled["m-link"]?.status).toBe("done");
				expect(engine.trail("m-link")).toContain("+approved");
				expect(harness.requests.every((request) => request.method === "GET")).toBe(true);
			} finally {
				await drain.stop();
				engine.cleanup();
			}
		},
	);

	test("maps a null text to an empty string", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([messageFrame("e1", "m-1", null)], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		const event = drain.events[0];
		expect(event?.type === "message" && event.message.text).toBe("");
	});

	test("yields a reaction event with its type and action intact", async () => {
		const reactionType = "1f44d_like";
		const harness = createHarness({
			handlers: [
				sseResponse(
					[
						frame("reaction", {
							id: "abc:added:0",
							data: reactionData("abc:added:0", reactionType, "added"),
						}),
					],
					{ end: false },
				),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		expect(drain.events[0]).toEqual({
			type: "reaction",
			eventId: "abc:added:0",
			reaction: {
				id: "abc:added:0",
				chatId: CHAT_ID,
				messageId: "m-target",
				from: { id: "aad-2", name: "Owner", isBot: false },
				type: reactionType,
				action: "added",
				timestamp: "2026-10-14T12:00:01.000Z",
			},
		});
	});

	test("sends the reaction event id as Last-Event-ID on the next reconnect", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([
					frame("reaction", {
						id: "abc:added:0",
						data: reactionData("abc:added:0", "x_y"),
					}),
				]),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 2);
		await drain.stop();
		expect(harness.requests[1]?.headers.get("last-event-id")).toBe(
			"abc:added:0",
		);
	});

	test("ignores an event with an unknown name", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse(
					[
						frame("something-new", { id: "x1", data: '{"a":1}' }),
						messageFrame("e2"),
					],
					{ end: false },
				),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length >= 1);
		await drain.stop();
		expect(drain.events.map((event) => event.type)).toEqual(["message"]);
	});

	test.each([
		["no data line", ""],
		["an empty data line", "data:\n"],
		["data null", "data: null\n"],
	])(
		"ping with %s yields nothing and gap yields only a gap",
		async (_name, dataLines) => {
			const harness = createHarness({
				handlers: [
					sseResponse(
						[
							`event: ping\n${dataLines}\n`,
							`event: gap\n${dataLines}\n`,
							messageFrame("e9"),
						],
						{ end: false },
					),
				],
			});
			const drain = startDrain(harness);
			await waitUntil(() => drain.events.length >= 2);
			await drain.stop();
			expect(drain.events.map((event) => event.type)).toEqual([
				"gap",
				"message",
			]);
		},
	);

	test("joins multi-line data, skips comment lines, and handles a chunk boundary inside an event", async () => {
		const payload = JSON.parse(messageData("m-multi", "multi")) as Record<
			string,
			unknown
		>;
		const pretty = JSON.stringify(payload, null, 1).split("\n");
		const wire = [
			": keep-alive comment\n",
			"event: message\n",
			"id: e-multi\n",
			...pretty.map((line) => `data: ${line}\n`),
			"\n",
		].join("");
		const cut = Math.floor(wire.length / 2);
		const harness = createHarness({
			handlers: [
				sseResponse([wire.slice(0, cut), wire.slice(cut)], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		const event = drain.events[0];
		expect(event?.type === "message" && event.message.id).toBe("m-multi");
		expect(event?.type === "message" && event.message.text).toBe("multi");
	});

	test("decodes a multi-byte emoji split across two chunks", async () => {
		const emoji = "\u{1F6A7}";
		const bytes = encoder.encode(
			messageFrame("e-emoji", "m-emoji", `go ${emoji} now`),
		);
		const emojiStart = bytes.indexOf(0xf0);
		const cut = emojiStart + 2;
		const harness = createHarness({
			handlers: [
				sseResponse([bytes.slice(0, cut), bytes.slice(cut)], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		const event = drain.events[0];
		expect(event?.type === "message" && event.message.text).toBe(
			`go ${emoji} now`,
		);
	});

	test.each([
		["CRLF", "\r\n"],
		["CR", "\r"],
		["LF", "\n"],
	])("splits lines on %s", async (_name, eol) => {
		const wire = `event: message${eol}id: e-eol${eol}data: ${messageData("m-eol")}${eol}${eol}`;
		const harness = createHarness({
			handlers: [sseResponse([wire], { end: false })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		const event = drain.events[0];
		expect(event?.type === "message" && event.eventId).toBe("e-eol");
	});

	test("treats a CR and LF split across two chunks as one line break", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse(
					[
						`event: message\r\nid: e-split\r`,
						`\ndata: ${messageData("m-split")}\r\n\r`,
						"\n",
					],
					{ end: false },
				),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length >= 1);
		await drain.stop();
		expect(drain.events).toHaveLength(1);
		const event = drain.events[0];
		expect(event?.type === "message" && event.eventId).toBe("e-split");
	});

	test("skips a frame with unreadable JSON, warns without the payload, and keeps reading", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse(
					[
						frame("message", { id: "bad", data: "{not json PAYLOAD-MARKER" }),
						messageFrame("e-good"),
					],
					{ end: false },
				),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length >= 1);
		await drain.stop();
		expect(drain.events.map((event) => event.type)).toEqual(["message"]);
		expect(
			harness.lines().some((line) => line.includes("PAYLOAD-MARKER")),
		).toBe(false);
	});

	test("ignores a reaction frame with an unknown action", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse(
					[
						frame("reaction", {
							id: "r1",
							data: JSON.stringify({
								id: "abc:flipped:0",
								chatId: CHAT_ID,
								messageId: "m-target",
								type: "like",
								action: "flipped",
							}),
						}),
						messageFrame("e-after"),
					],
					{ end: false },
				),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length >= 1);
		await drain.stop();
		expect(drain.events.map((event) => event.type)).toEqual(["message"]);
	});

	test("retries after an HTTP 500 on events with the first backoff step", async () => {
		const harness = createHarness({
			handlers: [
				status(500),
				sseResponse([messageFrame("e-ok")], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length >= 1);
		await drain.stop();
		expect(harness.requests.length).toBeGreaterThanOrEqual(2);
		expect(harness.backoffs()[0]).toBe(1000);
	});

	test("sends the resume id as Last-Event-ID on the first request", async () => {
		const harness = createHarness({});
		const drain = startDrain(harness, "resume-7");
		await waitUntil(() => harness.requests.length === 1);
		await drain.stop();
		expect(harness.requests[0]?.headers.get("last-event-id")).toBe("resume-7");
	});

	test("reconnects with the last seen id and yields each message once", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([messageFrame("e1")]),
				sseResponse([messageFrame("e2")], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 2);
		await drain.stop();
		expect(harness.requests[0]?.headers.get("last-event-id")).toBeNull();
		expect(harness.requests[1]?.headers.get("last-event-id")).toBe("e1");
		expect(
			drain.events.map((event) =>
				event.type === "message" ? event.eventId : event.type,
			),
		).toEqual(["e1", "e2"]);
	});

	test("logs each reconnect", async () => {
		const harness = createHarness({
			handlers: [sseResponse([messageFrame("e1")]), sseResponse([messageFrame("e2")], { end: false })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 2);
		await drain.stop();
		expect(harness.lines().some((line) => line.startsWith("events stream reconnecting in"))).toBe(true);
	});

	test("yields gap and keeps the last known id until a replayed event updates it", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([messageFrame("e1"), frame("gap")]),
				sseResponse([messageFrame("e2")]),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 3);
		await drain.stop();
		expect(drain.events.map((event) => event.type)).toEqual([
			"message",
			"gap",
			"message",
		]);
		expect(harness.requests[1]?.headers.get("last-event-id")).toBe("e1");
		expect(harness.requests[2]?.headers.get("last-event-id")).toBe("e2");
	});

	test("reconnects after a clean end of stream with doubling backoff reset by a message", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([messageFrame("e1")]),
				sseResponse([]),
				sseResponse([]),
				sseResponse([messageFrame("e4")]),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 5);
		await drain.stop();
		const [first, second, third, fourth] = harness.backoffs();
		const within = (value: number | undefined, base: number) => {
			expect(value).toBeGreaterThanOrEqual(base * 0.8);
			expect(value).toBeLessThanOrEqual(base * 1.2);
		};
		within(first, 1000);
		within(second, 2000);
		within(third, 4000);
		within(fourth, 1000);
	});

	test("aborts and reconnects after 45 s of silence", async () => {
		const harness = createHarness({
			handlers: [
				sseResponse([], { end: false }),
				sseResponse([messageFrame("e1")], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 1);
		await waitUntil(() => harness.sleeps.includes(WATCHDOG_MS));
		harness.fireWatchdog();
		await waitUntil(() => harness.requests.length === 2);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		expect(harness.requests[0]?.signal?.aborted).toBe(true);
	});

	test.each([
		["a line", () => `data: ${"x".repeat(1_000_001)}`],
		["a data field split across lines", () => `data: ${"x".repeat(600_000)}\ndata: ${"y".repeat(600_000)}\n`],
	])("aborts and reconnects when %s passes 1 MB", async (_name, oversized) => {
		const harness = createHarness({
			handlers: [
				sseResponse([oversized()], { end: false }),
				sseResponse([messageFrame("e1")], { end: false }),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 2);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		expect(harness.requests[0]?.signal?.aborted).toBe(true);
	});

	test("stops without error and without another request when the signal aborts", async () => {
		const harness = createHarness({});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 1);
		const outcome = await drain.stop();
		expect(outcome).toBeUndefined();
		expect(harness.requests).toHaveLength(1);
	});

	test.each([
		["404", status(404)],
		["429", status(429)],
	])(
		"stops without another request when the signal aborts during the backoff after %s",
		async (_name, handler) => {
			const harness = createHarness({ handlers: [handler], holdBackoff: true });
			const drain = startDrain(harness);
			await waitUntil(() => harness.heldBackoffs.length === 1);
			const outcome = await Promise.race([
				drain.stop(),
				new Promise<string>((resolve) => setTimeout(resolve, 200, "hung")),
			]);
			expect(outcome).toBeUndefined();
			expect(harness.heldBackoffs).toHaveLength(1);
			expect(harness.requests).toHaveLength(1);
		},
	);

	test.each([
		["a comment line", ": ping\n\n"],
		["an event: ping frame", "event: ping\ndata:\n\n"],
	])("%s resets the idle timer and is never yielded", async (_name, keepAlive) => {
		let push: (text: string) => void = () => undefined;
		const harness = createHarness({
			handlers: [
				(request) =>
					new Response(
						new ReadableStream({
							start(controller) {
								push = (text) => controller.enqueue(encoder.encode(text));
								request.signal?.addEventListener(
									"abort",
									() => controller.error(new DOMException("aborted", "AbortError")),
									{ once: true },
								);
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.pendingWatchdogCount() === 1);
		const before = harness.sleeps.filter((ms) => ms === WATCHDOG_MS).length;
		push(keepAlive);
		await waitUntil(() => harness.sleeps.filter((ms) => ms === WATCHDOG_MS).length === before + 1);
		expect(harness.pendingWatchdogCount()).toBe(1);
		expect(harness.requests).toHaveLength(1);
		expect(drain.events).toEqual([]);
		push(messageFrame("e1"));
		await waitUntil(() => drain.events.length === 1);
		expect(harness.requests).toHaveLength(1);
		await drain.stop();
	});

	test("logs the idle limit, aborts the fetch and reconnects with the last event id", async () => {
		const harness = createHarness({
			handlers: [sseResponse([messageFrame("e1")], { end: false }), sseResponse([], { end: false })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await waitUntil(() => harness.pendingWatchdogCount() === 1);
		harness.fireWatchdog();
		await waitUntil(() => harness.requests.length === 2);
		expect(harness.requests[0]?.signal?.aborted).toBe(true);
		expect(harness.requests[1]?.headers.get("last-event-id")).toBe("e1");
		expect(harness.lines()).toContain("events stream idle for 45 s, reconnecting");
		expect(harness.backoffs()).toHaveLength(1);
		await drain.stop();
		expect(harness.pendingWatchdogCount()).toBe(0);
	});

	test("uses relay.streamIdleSeconds as the idle limit", async () => {
		const harness = createHarness({
			streamIdleSeconds: 90,
			handlers: [sseResponse([], { end: false })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.sleeps.includes(90_000));
		expect(harness.sleeps).not.toContain(WATCHDOG_MS);
		await drain.stop();
	});

	test("keeps at most one idle timer pending while chunks arrive", async () => {
		const frames = [messageFrame("e1"), messageFrame("e2"), messageFrame("e3")];
		const harness = createHarness({
			handlers: [sseResponse(frames, { end: false })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 3);
		expect(harness.pendingWatchdogCount()).toBeLessThanOrEqual(1);
		await drain.stop();
		expect(harness.pendingWatchdogCount()).toBe(0);
	});

	test("honors a numeric Retry-After on 429 from events", async () => {
		const harness = createHarness({
			handlers: [status(429, { "Retry-After": "7" })],
		});
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 2);
		await drain.stop();
		expect(harness.sleeps).toContain(7000);
	});

	test("waits the 30 s default on 429 without Retry-After and blames a stale daemon connection", async () => {
		const harness = createHarness({ handlers: [status(429)] });
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 2);
		await drain.stop();
		expect(harness.sleeps).toContain(30_000);
		expect(harness.lines().some((line) => /stale/i.test(line))).toBe(true);
	});

	test("logs the membership hint on 404 and retries at the 60 s cap", async () => {
		const harness = createHarness({ handlers: [status(404)] });
		const drain = startDrain(harness);
		await waitUntil(() => harness.requests.length === 2);
		await drain.stop();
		expect(
			harness
				.lines()
				.some((line) =>
					line.includes(
						"Review Bot is not a member of this chat, or the chat id is wrong",
					),
				),
		).toBe(true);
		const [wait] = harness.backoffs();
		expect(wait).toBeGreaterThanOrEqual(60_000 * 0.8);
		expect(wait).toBeLessThanOrEqual(60_000 * 1.2);
	});

	test.each([401, 403])(
		"throws RelayAuthError for %i and makes exactly one request",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			const drain = startDrain(harness);
			const outcome = await drain.done;
			expect(outcome).toBeInstanceOf(RelayAuthError);
			expect((outcome as RelayAuthError).status).toBe(code);
			expect(harness.requests).toHaveLength(1);
		},
	);

	test("never leaks the secret or the api code into logs or errors", async () => {
		const harness = createHarness({
			handlers: [status(429), status(404), status(401)],
		});
		const drain = startDrain(harness);
		const outcome = (await drain.done) as Error;
		const header = Buffer.from(`${APP_NAME}:${SECRET}`).toString("base64");
		const everything = [outcome.message, ...harness.lines()].join("\n");
		expect(everything).not.toContain(SECRET);
		expect(everything).not.toContain(header);
	});
});

describe("createTeamsRelayProvider react and unreact", () => {
	const reactionId = "custom_one;0-cus-d1-0123456789abcdef0123456789abcdef";
	const reactionPath = (chatId = CHAT_ID, id = reactionId) =>
		`/message/teams/${encodeURIComponent(chatId)}/react/${encodeURIComponent(id)}`;

	test("react sends PUT to the encoded path with the messageId body", async () => {
		const harness = createHarness({ handlers: [status(204)] });
		await harness.provider.react({
			chatId: CHAT_ID,
			messageId: "m-1",
			reactionId,
		});
		const [request] = harness.requests;
		expect(request?.method).toBe("PUT");
		expect(request?.url).toBe(harness.url(reactionPath()));
		expect(JSON.parse(request?.body ?? "null")).toEqual({ messageId: "m-1" });
		expect(request?.headers.get("x-api-code")).toBe(
			Buffer.from(`${APP_NAME}:${SECRET}`).toString("base64"),
		);
	});

	test("unreact sends DELETE to the same path", async () => {
		const harness = createHarness({ handlers: [status(204)] });
		await harness.provider.unreact({
			chatId: CHAT_ID,
			messageId: "m-1",
			reactionId,
		});
		expect(harness.requests[0]?.method).toBe("DELETE");
		expect(harness.requests[0]?.url).toBe(harness.url(reactionPath()));
	});

	test("unreact treats 404 as success", async () => {
		const harness = createHarness({ handlers: [status(404)] });
		await expect(
			harness.provider.unreact({
				chatId: CHAT_ID,
				messageId: "m-1",
				reactionId,
			}),
		).resolves.toBeUndefined();
	});

	test("react throws on 404", async () => {
		const harness = createHarness({ handlers: [status(404)] });
		await expect(
			harness.provider.react({ chatId: CHAT_ID, messageId: "m-1", reactionId }),
		).rejects.toThrow("404");
	});

	test("spaces three calls at least 500 ms apart", async () => {
		const harness = createHarness({
			handlers: [status(204), status(204), status(204)],
		});
		await Promise.all(
			["m-1", "m-2", "m-3"].map((messageId) =>
				harness.provider.react({ chatId: CHAT_ID, messageId, reactionId }),
			),
		);
		const times = harness.requests.map((request) => request.at);
		const [first = 0, second = 0, third = 0] = times;
		expect(second - first).toBeGreaterThanOrEqual(500);
		expect(third - second).toBeGreaterThanOrEqual(500);
	});

	test("sleeps Retry-After seconds on 429 and retries", async () => {
		const harness = createHarness({
			handlers: [status(429, { "Retry-After": "2" }), status(204)],
		});
		await harness.provider.react({
			chatId: CHAT_ID,
			messageId: "m-1",
			reactionId,
		});
		expect(harness.requests).toHaveLength(2);
		expect(harness.sleeps).toContain(2000);
	});

	test("gives up after three attempts of 429", async () => {
		const harness = createHarness({
			handlers: [status(429), status(429), status(429), status(204)],
		});
		await expect(
			harness.provider.react({ chatId: CHAT_ID, messageId: "m-1", reactionId }),
		).rejects.toThrow("429");
		expect(harness.requests).toHaveLength(3);
	});

	test("throws with the status code and never the body on 500", async () => {
		const harness = createHarness({ handlers: [status(500)] });
		const failure = await harness.provider
			.react({ chatId: CHAT_ID, messageId: "m-1", reactionId })
			.catch((error: Error) => error);
		expect((failure as Error).message).toContain("500");
		expect((failure as Error).message).not.toContain(RESPONSE_BODY_LEAK);
		expect((failure as Error).message).not.toContain(SECRET);
	});

	test.each([401, 403, 404, 500])(
		"react error %i carries no secret, api code, or body",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			const failure = await harness.provider
				.react({ chatId: CHAT_ID, messageId: "m-1", reactionId })
				.catch((error: Error) => error);
			expect(failure).toBeInstanceOf(Error);
			expectNoCredentialOrBody((failure as Error).message);
			expect(harness.lines().join("\n")).not.toContain(SECRET);
			expect(harness.lines().join("\n")).not.toContain(API_CODE);
		},
	);

	test.each([401, 403])("throws RelayAuthError on %i", async (code) => {
		const harness = createHarness({ handlers: [status(code)] });
		const failure = await harness.provider
			.react({ chatId: CHAT_ID, messageId: "m-1", reactionId })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RelayAuthError);
		expect((failure as RelayAuthError).status).toBe(code);
	});

	test("encodes the chat id in the path", async () => {
		const chatId = "19:abc@thread.v2";
		const harness = createHarness({ handlers: [status(204)] });
		await harness.provider.react({
			chatId,
			messageId: "m-1",
			reactionId: "plain_id",
		});
		expect(harness.requests[0]?.url).toBe(
			harness.url(reactionPath(chatId, "plain_id")),
		);
	});
});

describe("createTeamsRelayProvider resolveChat", () => {
	const listUrl = "/chat/list";

	test("confirms an explicit chat id with one events request and aborts it", async () => {
		const harness = createHarness({ handlers: [sseResponse([], { end: false })] });
		await expect(
			harness.provider.resolveChat({ chatId: "c-fixed" }),
		).resolves.toEqual({ id: "c-fixed" });
		expect(harness.requests).toHaveLength(1);
		expect(harness.requests[0]?.url).toContain("/chat/c-fixed/events");
		expect(harness.requests[0]?.signal?.aborted).toBe(true);
	});

	test("fails an explicit chat id check that never answers with a timeout error naming the chat check", async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		const spy = spyOn(AbortSignal, "timeout").mockImplementation(() => realTimeout(20));
		try {
			const harness = createHarness({
				handlers: [
					(request) =>
						new Promise<Response>((_, reject) => {
							request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
								once: true,
							});
						}),
				],
			});
			await expect(harness.provider.resolveChat({ chatId: "c-slow" })).rejects.toThrow(
				"chat check timed out after 20 s",
			);
		} finally {
			spy.mockRestore();
		}
	});

	test("maps a 404 for an explicit chat id to the not-member remedy", async () => {
		const harness = createHarness({ handlers: [status(404)] });
		await expect(
			harness.provider.resolveChat({ chatId: "c-wrong" }),
		).rejects.toThrow("Review Bot is not a member of this chat, or the chat id is wrong");
	});

	test.each([401, 403])(
		"throws RelayAuthError for %i on an explicit chat id",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			await expect(
				harness.provider.resolveChat({ chatId: "c-fixed" }),
			).rejects.toBeInstanceOf(RelayAuthError);
		},
	);

	test("matches the topic case-insensitively after trim", async () => {
		const harness = createHarness({
			handlers: [
				json(200, [
					{ id: "c-other", topic: "Standup" },
					{ id: "c-review", topic: "  TEAM reviews " },
				]),
			],
		});
		const chat = await harness.provider.resolveChat({ topic: "team Reviews" });
		expect(chat.id).toBe("c-review");
		expect(harness.requests[0]?.url).toBe(harness.url(listUrl));
		expect(harness.requests[0]?.method).toBe("GET");
	});

	test("skips a chat with a null topic", async () => {
		const harness = createHarness({
			handlers: [
				json(200, [
					{ id: "c-null", topic: null },
					{ id: "c-review", topic: "Team Reviews" },
				]),
			],
		});
		await expect(
			harness.provider.resolveChat({ topic: "Team Reviews" }),
		).resolves.toMatchObject({
			id: "c-review",
		});
	});

	test("throws the not-member remedy when nothing matches", async () => {
		const harness = createHarness({ handlers: [json(200, [])] });
		const failure = await harness.provider
			.resolveChat({ topic: "Team Reviews" })
			.catch((error: Error) => error);
		expect((failure as Error).message).toContain(
			'Chat "Team Reviews" not found',
		);
		expect((failure as Error).message).toContain("Review Bot");
		expect((failure as Error).message).toContain("--chat-id");
	});

	test("throws listing every id when more than one chat matches", async () => {
		const harness = createHarness({
			handlers: [
				json(200, [
					{ id: "c-one", topic: "Team Reviews" },
					{ id: "c-two", topic: "team reviews" },
				]),
			],
		});
		const failure = await harness.provider
			.resolveChat({ topic: "Team Reviews" })
			.catch((error: Error) => error);
		expect((failure as Error).message).toContain("c-one");
		expect((failure as Error).message).toContain("c-two");
	});

	test("uses no timeout under 90 s for the chat list fetch", async () => {
		const timeoutSpy = spyOn(AbortSignal, "timeout");
		try {
			const harness = createHarness({
				handlers: [json(200, [{ id: "c1", topic: "Team Reviews" }])],
			});
			await harness.provider.resolveChat({ topic: "Team Reviews" });
			for (const [ms] of timeoutSpy.mock.calls) {
				expect(ms as number).toBeGreaterThanOrEqual(90_000);
			}
		} finally {
			timeoutSpy.mockRestore();
		}
	});

	test.each([401, 500])(
		"chat list error %i carries no secret, api code, or body",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			const failure = await harness.provider
				.resolveChat({ topic: "Team Reviews" })
				.catch((error: Error) => error);
			expect(failure).toBeInstanceOf(Error);
			expectNoCredentialOrBody((failure as Error).message);
		},
	);

	test("a 200 chat list body that is not JSON never reaches the thrown message", async () => {
		const harness = createHarness({ handlers: [rawBody(200, LEAK_HTML)] });
		const failure = await harness.provider
			.resolveChat({ topic: "Team Reviews" })
			.catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expectNoCredentialOrBody((failure as Error).message);
		expect(harness.lines().join("\n")).not.toContain("LEAKMARK");
	});

	test("throws RelayAuthError on 401 from the chat list", async () => {
		const harness = createHarness({ handlers: [status(401)] });
		const failure = await harness.provider
			.resolveChat({ topic: "Team Reviews" })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RelayAuthError);
	});
});

describe("createTeamsRelayProvider redirect handling", () => {
	test("sends every request with redirect error", async () => {
		const reactionId = "custom_one;0-cus-d1-0123456789abcdef0123456789abcdef";
		const harness = createHarness({
			handlers: [
				sseResponse([messageFrame("e1")], { end: false }),
				status(204),
				status(204),
				json(201, { messageIds: [] }),
				json(200, []),
				json(200, [{ id: "c1", topic: "Team Reviews" }]),
			],
		});
		const drain = startDrain(harness);
		await waitUntil(() => drain.events.length === 1);
		await drain.stop();
		await harness.provider.react({
			chatId: CHAT_ID,
			messageId: "m-1",
			reactionId,
		});
		await harness.provider.unreact({
			chatId: CHAT_ID,
			messageId: "m-1",
			reactionId,
		});
		await harness.provider.reply({ chatId: CHAT_ID, text: "x" });
		await harness.provider.listReactions();
		await harness.provider.resolveChat({ topic: "Team Reviews" });
		expect(harness.requests.length).toBeGreaterThanOrEqual(6);
		for (const request of harness.requests)
			expect(request.redirect).toBe("error");
	});
});

describe("createTeamsRelayProvider reply", () => {
	const created = (messageIds?: unknown) =>
		json(201, {
			chatId: CHAT_ID,
			delivered: 1,
			missings: [],
			failed: [],
			messageIds,
		});

	test("posts To, Body, ChatId, Mode group, and TextFormat plain without AdaptiveCard", async () => {
		const harness = createHarness({ handlers: [created(["sent-1"])] });
		await harness.provider.reply({ chatId: CHAT_ID, text: "done" });
		const [request] = harness.requests;
		expect(request?.method).toBe("POST");
		expect(request?.url).toBe(harness.url("/message/teams"));
		expect(JSON.parse(request?.body ?? "null")).toEqual({
			To: [SENDER_EMAIL],
			Body: "done",
			ChatId: CHAT_ID,
			Mode: "group",
			TextFormat: "plain",
		});
	});

	test("posts a direct message to the owner without a ChatId", async () => {
		const harness = createHarness({ handlers: [created(["dm-1"])] });
		await expect(harness.provider.dm({ text: "heads up" })).resolves.toEqual({ messageIds: ["dm-1"] });
		const [request] = harness.requests;
		expect(request?.method).toBe("POST");
		expect(request?.url).toBe(harness.url("/message/teams"));
		expect(JSON.parse(request?.body ?? "null")).toEqual({
			To: [SENDER_EMAIL],
			Body: "heads up",
			Mode: "direct",
			TextFormat: "plain",
		});
	});

	test("posts TextFormat xml for an html direct message", async () => {
		const harness = createHarness({ handlers: [created(["dm-1"])] });
		await harness.provider.dm({ text: "<p>hi</p>", html: true });
		expect(JSON.parse(harness.requests[0]?.body ?? "null")).toMatchObject({ TextFormat: "xml" });
	});

	test("fails a direct message on a non-201 status", async () => {
		const harness = createHarness({ handlers: [json(500, {})] });
		await expect(harness.provider.dm({ text: "x" })).rejects.toThrow("dm failed with HTTP 500");
	});

	test("posts TextFormat xml for an html reply", async () => {
		const harness = createHarness({ handlers: [created(["sent-1"])] });
		await harness.provider.reply({ chatId: CHAT_ID, text: "<p>hi</p>", html: true });
		expect(JSON.parse(harness.requests[0]?.body ?? "null")).toMatchObject({
			Body: "<p>hi</p>",
			TextFormat: "xml",
		});
	});

	test("returns the messageIds of the 201 body", async () => {
		const harness = createHarness({ handlers: [created(["a", "b"])] });
		await expect(
			harness.provider.reply({ chatId: CHAT_ID, text: "x" }),
		).resolves.toEqual({
			messageIds: ["a", "b"],
		});
	});

	test.each([
		["absent", undefined],
		["not an array", "a"],
	])("returns an empty list when messageIds is %s", async (_name, value) => {
		const harness = createHarness({ handlers: [created(value)] });
		await expect(
			harness.provider.reply({ chatId: CHAT_ID, text: "x" }),
		).resolves.toEqual({
			messageIds: [],
		});
	});

	test("sends the card as an adaptive card attachment and keeps the Body", async () => {
		const card: AdaptiveCard = {
			type: "AdaptiveCard",
			version: "1.4",
			body: [
				{ type: "Image", url: "https://img.example.com/a.gif", altText: "alt" },
			],
		};
		const harness = createHarness({ handlers: [created([])] });
		await harness.provider.reply({ chatId: CHAT_ID, text: "with card", card });
		const sent = JSON.parse(harness.requests[0]?.body ?? "null");
		expect(sent.Body).toBe("with card");
		expect(sent.AdaptiveCard).toEqual({
			ContentType: "application/vnd.microsoft.card.adaptive",
			Content: card,
		});
		expect(sent).not.toHaveProperty("Topic");
	});

	test.each([207, 400, 500])(
		"throws with %i and never the body text",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			const failure = await harness.provider
				.reply({ chatId: CHAT_ID, text: "x" })
				.catch((error: Error) => error);
			expect((failure as Error).message).toContain(String(code));
			expect((failure as Error).message).not.toContain(RESPONSE_BODY_LEAK);
		},
	);

	test("throws before any fetch when the chat id is empty", async () => {
		const harness = createHarness({});
		await expect(
			harness.provider.reply({ chatId: "", text: "x" }),
		).rejects.toThrow();
		expect(harness.requests).toHaveLength(0);
	});

	test.each([401, 403, 404, 500])(
		"reply error %i carries no secret, api code, or body",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			const failure = await harness.provider
				.reply({ chatId: CHAT_ID, text: "x" })
				.catch((error: Error) => error);
			expect(failure).toBeInstanceOf(Error);
			expectNoCredentialOrBody((failure as Error).message);
		},
	);

	test.each([401, 403])("throws RelayAuthError on %i", async (code) => {
		const harness = createHarness({ handlers: [status(code)] });
		const failure = await harness.provider
			.reply({ chatId: CHAT_ID, text: "x" })
			.catch((error: unknown) => error);
		expect(failure).toBeInstanceOf(RelayAuthError);
	});
});

describe("createTeamsRelayProvider listReactions", () => {
	test("maps the id of each catalog entry", async () => {
		const harness = createHarness({
			handlers: [
				json(200, [
					{ id: "r1", name: "one", emoji: "1" },
					{
						id: "r2;0-cus-d1-0123456789abcdef0123456789abcdef",
						name: "two",
						emoji: "2",
					},
				]),
			],
		});
		await expect(harness.provider.listReactions()).resolves.toEqual([
			"r1",
			"r2;0-cus-d1-0123456789abcdef0123456789abcdef",
		]);
		expect(harness.requests[0]?.url).toBe(harness.url("/message/teams/react"));
		expect(harness.requests[0]?.method).toBe("GET");
	});
});

describe("createTeamsRelayProvider listReactions failures", () => {
	test.each([401, 500])(
		"catalog error %i carries no secret, api code, or body",
		async (code) => {
			const harness = createHarness({ handlers: [status(code)] });
			const failure = await harness.provider
				.listReactions()
				.catch((error: Error) => error);
			expect(failure).toBeInstanceOf(Error);
			expectNoCredentialOrBody((failure as Error).message);
		},
	);

	test("a 200 catalog body that is not JSON never reaches the thrown message", async () => {
		const harness = createHarness({ handlers: [rawBody(200, LEAK_HTML)] });
		const failure = await harness.provider
			.listReactions()
			.catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expectNoCredentialOrBody((failure as Error).message);
		expect(harness.lines().join("\n")).not.toContain("LEAKMARK");
	});
});

describe("createTeamsRelayProvider env selection", () => {
	test("uses the prod base URL when the env resolves to prod", async () => {
		const harness = createHarness({ envName: "prod", handlers: [status(204)] });
		await harness.provider.react({
			chatId: CHAT_ID,
			messageId: "m-1",
			reactionId: "plain_id",
		});
		expect(harness.requests[0]?.url.startsWith(harness.env.baseUrl)).toBe(true);
		expect(harness.env.name).toBe("prod");
	});
});

describe("retryAfterMs", () => {
	const withHeader = (value: string) =>
		new Response(null, { status: 429, headers: { "retry-after": value } });

	test.each([
		["0", 1_000],
		["5", 5_000],
		["2147484", 60_000],
	])("clamps Retry-After %s to %d ms", (value, expected) => {
		expect(retryAfterMs(withHeader(value))).toBe(expected);
	});

	test("returns undefined for a missing or invalid header", () => {
		expect(retryAfterMs(new Response(null, { status: 429 }))).toBeUndefined();
		expect(retryAfterMs(withHeader("soon"))).toBeUndefined();
		expect(retryAfterMs(withHeader("-1"))).toBeUndefined();
	});
});
