import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	CHAT_ASSETS_PATH,
	CHAT_DEFAULT_PORT,
	CHAT_MAX_ASSET_BYTES,
	CHAT_PROTOCOL_VERSION,
	INBOX_RELAY,
	PROTO_RELAY,
	PW_EXT_RELAY,
	RELAY_FEATURES,
	type RelayFeatureName,
	type SessionBootstrap,
} from "@dg/common";
import { MSG } from "@dg/pages/chat-messages";

mock.module("wxt/browser", () => ({ browser: {} }));

const { createRelayDispatcher } = await import("@/lib/background/relay-dispatch");
const { bootRelay, flushMicrotasks, frameEvent, makeBootstrap, settle } =
	await import("./utils/relay-harness");

type Body = Record<string, unknown>;
type AnyHandler = (input: Record<string, unknown>) => Promise<Body>;

const FEATURES = { inbox: INBOX_RELAY, proto: PROTO_RELAY, "pw-ext": PW_EXT_RELAY };
const FEATURE_NAMES = RELAY_FEATURES.map((feature) => feature.name);
const DEADLINE_MS = 60_000;
const LIVENESS_MS = 250;

const BODIES: Record<RelayFeatureName, Body> = {
	inbox: { ok: true, data: { messages: [], hasMore: false } },
	proto: { ok: false, error: "the extension could not open a tab for this URL" },
	"pw-ext": { ok: true, data: { text: "### Page" } },
};

const FALLBACKS: Record<RelayFeatureName, string> = {
	inbox: "Proton extension request failed. Open or reload the mail tab and retry.",
	proto: "Prototype extension request failed before the browser reported a result.",
	"pw-ext": "pw --ext failed in the extension before it reported a result.",
};

const FIRST = makeBootstrap();
const SECOND = makeBootstrap({ sessionId: "sess-other", token: "tok-other-456" });

const envelope = (requestId: string, sessionId = FIRST.sessionId) => ({
	sessionId,
	requestId,
	protocolVersion: CHAT_PROTOCOL_VERSION,
});

function inboxFrame(requestId: string, sessionId?: string) {
	return {
		type: INBOX_RELAY.frames.browserRequest,
		...envelope(requestId, sessionId),
		request: { operation: "list-messages", page: 0, pageSize: 50 },
	};
}

function protoFrame(requestId: string, extra: Body = {}, sessionId?: string) {
	return {
		type: PROTO_RELAY.frames.browserRequest,
		...envelope(requestId, sessionId),
		phase: "scrape",
		slug: "account-summary",
		markedUrl: "https://example.test/account#_proto=fixture",
		...extra,
	};
}

function pwFrame(requestId: string, timeoutMs = DEADLINE_MS, sessionId?: string) {
	return {
		type: PW_EXT_RELAY.frames.browserRequest,
		...envelope(requestId, sessionId),
		request: { verb: "current" },
		timeoutMs,
	};
}

function pwCancelFrame(requestId: string, sessionId?: string) {
	return {
		type: PW_EXT_RELAY.frames.browserCancel,
		...envelope(requestId, sessionId),
	};
}

const REQUEST_FRAMES: Record<RelayFeatureName, (requestId: string) => Body> = {
	inbox: (requestId) => inboxFrame(requestId),
	proto: (requestId) => protoFrame(requestId),
	"pw-ext": (requestId) => pwFrame(requestId),
};

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flush(): Promise<void> {
	await settle();
	await flushMicrotasks();
}

function abortAware(signals: AbortSignal[] = []) {
	const handler = mock(
		({ signal }: { signal: AbortSignal }) =>
			new Promise<Body>((resolve) => {
				signals.push(signal);
				signal.addEventListener("abort", () =>
					resolve({ ok: false, error: "aborted" }),
				);
			}),
	);
	return { signals, handler };
}

function spyTimers() {
	type Created = {
		id: unknown;
		kind: "timeout" | "interval";
		ms: number | undefined;
		fn: () => void;
	};
	const original = {
		setTimeout: globalThis.setTimeout,
		setInterval: globalThis.setInterval,
		clearTimeout: globalThis.clearTimeout,
		clearInterval: globalThis.clearInterval,
	};
	const created: Created[] = [];
	const cleared = new Set<unknown>();
	globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		const id = (original.setTimeout as (...a: unknown[]) => unknown)(fn, ms, ...rest);
		created.push({ id, kind: "timeout", ms, fn });
		return id;
	}) as unknown as typeof setTimeout;
	globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
		const id = (original.setInterval as (...a: unknown[]) => unknown)(fn, ms, ...rest);
		created.push({ id, kind: "interval", ms, fn });
		return id;
	}) as unknown as typeof setInterval;
	globalThis.clearTimeout = ((id: unknown) => {
		cleared.add(id);
		(original.clearTimeout as (...a: unknown[]) => void)(id);
	}) as unknown as typeof clearTimeout;
	globalThis.clearInterval = ((id: unknown) => {
		cleared.add(id);
		(original.clearInterval as (...a: unknown[]) => void)(id);
	}) as unknown as typeof clearInterval;
	return {
		created,
		armed: (match: (timer: Created) => boolean) =>
			created.filter((timer) => match(timer) && !cleared.has(timer.id)),
		restore() {
			Object.assign(globalThis, original);
		},
	};
}

let activeTimers: ReturnType<typeof spyTimers> | undefined;

afterEach(() => {
	activeTimers?.restore();
	activeTimers = undefined;
});

function makeRig(
	options: {
		handlers?: Partial<Record<RelayFeatureName, AnyHandler>>;
		live?: (sessionId: string) => (() => boolean) | undefined;
		send?: (frame: Body) => void;
		sessions?: SessionBootstrap[];
	} = {},
) {
	const sessions = new Map(
		(options.sessions ?? [FIRST]).map((bootstrap) => [bootstrap.sessionId, bootstrap]),
	);
	const sent: Body[] = [];
	const handlers = Object.fromEntries(
		FEATURE_NAMES.map((name) => [
			name,
			mock(options.handlers?.[name] ?? (async () => BODIES[name])),
		]),
	) as Record<RelayFeatureName, ReturnType<typeof mock<AnyHandler>>>;
	const live = mock(options.live ?? (() => () => true));
	const fetchAsset = async () => new Blob();
	const deleteAsset = async () => undefined;
	const contextFor = {
		"pw-ext": mock(({ bootstrap }: { bootstrap: SessionBootstrap }) => ({
			sessionId: bootstrap.sessionId,
			agentIdentity: bootstrap.agentIdentity,
			fetchAsset,
			deleteAsset,
		})),
	};
	const dispatcher = createRelayDispatcher({
		features: RELAY_FEATURES,
		handlers: handlers as never,
		send: (frame: Body) => {
			if (options.send) options.send(frame);
			else sent.push(frame);
		},
		live,
		bootstrapFor: (sessionId: string) => sessions.get(sessionId),
		contextFor: contextFor as never,
	} as never) as ReturnType<typeof createRelayDispatcher>;
	const dispatch = (frame: Body) => dispatcher.dispatch(frame as never);
	return { dispatcher, dispatch, handlers, live, sent, sessions, contextFor };
}

describe("createRelayDispatcher result frames", () => {
	it.each(FEATURE_NAMES)(
		"answers one %s request with exactly one tokened result frame",
		async (name) => {
			const rig = makeRig();
			expect(rig.dispatch(REQUEST_FRAMES[name]("req-1"))).toBe(true);
			await flush();
			expect(rig.sent).toStrictEqual([
				{
					type: FEATURES[name].frames.browserResult,
					...BODIES[name],
					sessionId: FIRST.sessionId,
					requestId: "req-1",
					token: FIRST.token,
					protocolVersion: CHAT_PROTOCOL_VERSION,
				},
			]);
		},
	);

	it.each(FEATURE_NAMES)(
		"answers a rejecting %s handler with the feature's fallback error",
		async (name) => {
			const rig = makeRig({ handlers: { [name]: async () => Promise.reject(new Error("boom")) } });
			rig.dispatch(REQUEST_FRAMES[name]("req-1"));
			await flush();
			expect(rig.sent).toStrictEqual([
				{
					type: FEATURES[name].frames.browserResult,
					ok: false,
					error: FALLBACKS[name],
					sessionId: FIRST.sessionId,
					requestId: "req-1",
					token: FIRST.token,
					protocolVersion: CHAT_PROTOCOL_VERSION,
				},
			]);
		},
	);

	it("swallows a throwing send once and never retries it as a fallback", async () => {
		const send = mock((_frame: Body) => {
			throw new Error("socket closed");
		});
		const rig = makeRig({ send });
		expect(() => rig.dispatch(pwFrame("req-1"))).not.toThrow();
		await flush();
		expect(send).toHaveBeenCalledTimes(1);
		expect(rig.dispatcher.pending()).toEqual([]);
	});

	it("drops the result when the admission-time liveness predicate turns false", async () => {
		let alive = true;
		const gate = deferred<Body>();
		const rig = makeRig({ live: () => () => alive, handlers: { inbox: () => gate.promise } });
		rig.dispatch(inboxFrame("req-1"));
		await flush();
		alive = false;
		gate.resolve(BODIES.inbox);
		await flush();
		expect(rig.sent).toEqual([]);
		expect(rig.dispatcher.pending()).toEqual([]);
	});

	it("drops the fallback error too when the session is no longer live", async () => {
		let alive = true;
		const gate = deferred<Body>();
		const rig = makeRig({ live: () => () => alive, handlers: { inbox: () => gate.promise } });
		rig.dispatch(inboxFrame("req-1"));
		alive = false;
		gate.reject(new Error("boom"));
		await flush();
		expect(rig.sent).toEqual([]);
	});
});

describe("createRelayDispatcher handler input", () => {
	it("hands the inbox handler the browser request and no timeout", async () => {
		const frame = inboxFrame("req-1");
		const rig = makeRig();
		rig.dispatch(frame);
		await flush();
		const input = rig.handlers.inbox.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(input.request).toEqual(frame.request);
		expect(input.timeoutMs).toBeUndefined();
		expect(input.signal).toBeInstanceOf(AbortSignal);
		expect(input.progress).toBeInstanceOf(Function);
	});

	it("hands the proto handler the request fields and a progress function", async () => {
		const frame = protoFrame("req-1", { timeoutMs: 45_000 });
		const rig = makeRig();
		rig.dispatch(frame);
		await flush();
		const input = rig.handlers.proto.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(input.request).toEqual({
			phase: frame.phase,
			slug: frame.slug,
			markedUrl: frame.markedUrl,
			timeoutMs: 45_000,
		});
		expect(input.timeoutMs).toBe(45_000);
		expect(input.progress).toBeInstanceOf(Function);
	});

	it("hands the pw-ext handler exactly the request, deadline, signal, progress and context", async () => {
		const rig = makeRig();
		rig.dispatch(pwFrame("req-1", 60_000));
		await flush();
		expect(rig.handlers["pw-ext"].mock.calls).toEqual([
			[
				{
					request: { verb: "current" },
					timeoutMs: 60_000,
					signal: expect.any(AbortSignal),
					progress: expect.any(Function),
					context: expect.objectContaining({
						sessionId: FIRST.sessionId,
						agentIdentity: FIRST.agentIdentity,
						fetchAsset: expect.any(Function),
						deleteAsset: expect.any(Function),
					}),
				},
			],
		]);
		expect(rig.contextFor["pw-ext"].mock.calls).toEqual([[{ bootstrap: FIRST }]]);
	});

	it("builds no context for a feature without a contextFor entry", async () => {
		const rig = makeRig();
		rig.dispatch(inboxFrame("req-1"));
		await flush();
		const input = rig.handlers.inbox.mock.calls[0]?.[0] as Record<string, unknown>;
		expect(input.context).toBeUndefined();
	});

	it("sends proto progress frames only while the session is live", async () => {
		let alive = true;
		const gate = deferred<Body>();
		const rig = makeRig({ live: () => () => alive, handlers: { proto: () => gate.promise } });
		rig.dispatch(protoFrame("req-1"));
		await flush();
		const { progress } = rig.handlers.proto.mock.calls[0]?.[0] as {
			progress: (status: string) => void;
		};
		progress("ready; scraping");
		alive = false;
		progress("dropped");
		expect(rig.sent).toStrictEqual([
			{
				type: PROTO_RELAY.frames.browserProgress,
				...envelope("req-1"),
				token: FIRST.token,
				status: "ready; scraping",
			},
		]);
		gate.resolve(BODIES.proto);
	});

	it.each(["inbox", "pw-ext"] as const)(
		"gives %s a progress function that sends nothing",
		async (name) => {
			const gate = deferred<Body>();
			const rig = makeRig({ handlers: { [name]: () => gate.promise } });
			rig.dispatch(REQUEST_FRAMES[name]("req-1"));
			await flush();
			const { progress } = rig.handlers[name].mock.calls[0]?.[0] as {
				progress: (status: string) => void;
			};
			expect(() => progress("anything")).not.toThrow();
			expect(rig.sent).toEqual([]);
			gate.resolve(BODIES[name]);
		},
	);
});

describe("createRelayDispatcher deadlines", () => {
	it("arms no deadline for an inbox request or a proto request without timeoutMs", async () => {
		activeTimers = spyTimers();
		const gate = deferred<Body>();
		const signals: AbortSignal[] = [];
		const record = ({ signal }: { signal: AbortSignal }) => {
			signals.push(signal);
			return gate.promise;
		};
		const rig = makeRig({ handlers: { inbox: record as never, proto: record as never } });
		rig.dispatch(inboxFrame("req-1"));
		rig.dispatch(protoFrame("req-2"));
		expect(activeTimers.created.filter((timer) => timer.kind === "timeout")).toEqual([]);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => !signal.aborted)).toBe(true);
		gate.resolve(BODIES.inbox);
	});

	it("aborts a pw-ext signal when its timeoutMs elapses", async () => {
		const { signals, handler } = abortAware();
		const rig = makeRig({ handlers: { "pw-ext": handler as never } });
		rig.dispatch(pwFrame("req-1", 20));
		await flushMicrotasks();
		expect(signals[0]?.aborted).toBe(false);
		await new Promise<void>((resolve) =>
			signals[0]?.addEventListener("abort", () => resolve()),
		);
		expect(signals[0]?.aborted).toBe(true);
	});
});

describe("createRelayDispatcher admission", () => {
	it("calls the handler once for a duplicate session and request id while pending", async () => {
		const gate = deferred<Body>();
		const rig = makeRig({ handlers: { "pw-ext": () => gate.promise } });
		expect(rig.dispatch(pwFrame("req-1"))).toBe(true);
		expect(rig.dispatch(pwFrame("req-1"))).toBe(true);
		await flush();
		expect(rig.handlers["pw-ext"]).toHaveBeenCalledTimes(1);
		gate.resolve(BODIES["pw-ext"]);
		await flush();
		expect(rig.sent).toHaveLength(1);
	});

	it("admits the same request id again after the first run settled", async () => {
		const rig = makeRig();
		rig.dispatch(pwFrame("req-1"));
		await flush();
		rig.dispatch(pwFrame("req-1"));
		await flush();
		expect(rig.handlers["pw-ext"]).toHaveBeenCalledTimes(2);
	});

	it("keys runs by session as well as request id", async () => {
		const gate = deferred<Body>();
		const rig = makeRig({
			sessions: [FIRST, SECOND],
			handlers: { "pw-ext": () => gate.promise },
		});
		rig.dispatch(pwFrame("req-1", DEADLINE_MS, FIRST.sessionId));
		rig.dispatch(pwFrame("req-1", DEADLINE_MS, SECOND.sessionId));
		await flush();
		expect(rig.handlers["pw-ext"]).toHaveBeenCalledTimes(2);
		gate.resolve(BODIES["pw-ext"]);
	});

	it.each(FEATURE_NAMES)(
		"consumes a %s request for a session with no bootstrap without calling a handler",
		async (name) => {
			const rig = makeRig({ sessions: [] });
			expect(rig.dispatch(REQUEST_FRAMES[name]("req-1"))).toBe(true);
			await flush();
			expect(rig.handlers[name]).not.toHaveBeenCalled();
			expect(rig.sent).toEqual([]);
		},
	);

	it.each(FEATURE_NAMES)(
		"consumes a %s request when the session is not keepalive-eligible at admission",
		async (name) => {
			const rig = makeRig({ live: () => undefined });
			expect(rig.dispatch(REQUEST_FRAMES[name]("req-1"))).toBe(true);
			await flush();
			expect(rig.handlers[name]).not.toHaveBeenCalled();
			expect(rig.sent).toEqual([]);
		},
	);
});

describe("createRelayDispatcher frame routing", () => {
	it.each([
		["session-list", { type: "session-list", ...envelope("x"), sessions: [] }],
		["error", { type: "error", ...envelope("x"), message: "boom" }],
		["user-message", { type: "user-message", ...envelope("x"), body: "hi" }],
		[
			"a pw-ext result the extension only sends",
			{ type: PW_EXT_RELAY.frames.browserResult, ...envelope("x"), ok: true },
		],
		[
			"a proto result the extension only sends",
			{ type: PROTO_RELAY.frames.browserResult, ...envelope("x"), ok: true },
		],
		[
			"a proto progress frame the extension only sends",
			{ type: PROTO_RELAY.frames.browserProgress, ...envelope("x"), status: "s" },
		],
		[
			"a cancel frame for inbox, which has none",
			{ type: "inbox-browser-cancel", ...envelope("x") },
		],
		[
			"a cancel frame for proto, which has none",
			{ type: "proto-browser-cancel", ...envelope("x") },
		],
	])("returns false for %s", async (_label, frame) => {
		const rig = makeRig();
		expect(rig.dispatch(frame as Body)).toBe(false);
		await flush();
		for (const name of FEATURE_NAMES) expect(rig.handlers[name]).not.toHaveBeenCalled();
		expect(rig.sent).toEqual([]);
	});

	it("returns true for a dropped relay request", () => {
		const rig = makeRig({ sessions: [] });
		expect(rig.dispatch(inboxFrame("req-1"))).toBe(true);
	});

	it("returns true for a cancel frame that matches no run", () => {
		const rig = makeRig();
		expect(rig.dispatch(pwCancelFrame("nothing-pending"))).toBe(true);
	});
});

describe("createRelayDispatcher cancel", () => {
	it("aborts the signal of the pending request a cancel frame names", async () => {
		const { signals, handler } = abortAware();
		const rig = makeRig({ handlers: { "pw-ext": handler as never } });
		rig.dispatch(pwFrame("req-1"));
		await flush();
		rig.dispatch(pwCancelFrame("req-other"));
		expect(signals[0]?.aborted).toBe(false);
		rig.dispatch(pwCancelFrame("req-1"));
		expect(signals[0]?.aborted).toBe(true);
	});

	it("ignores a cancel frame for a session the dispatcher has no bootstrap for", async () => {
		const { signals, handler } = abortAware();
		const rig = makeRig({ handlers: { "pw-ext": handler as never } });
		rig.dispatch(pwFrame("req-1"));
		await flush();
		rig.sessions.delete(FIRST.sessionId);
		rig.dispatch(pwCancelFrame("req-1"));
		expect(signals[0]?.aborted).toBe(false);
	});

	it("ignores a cancel frame for another session's request id", async () => {
		const { signals, handler } = abortAware();
		const rig = makeRig({
			sessions: [FIRST, SECOND],
			handlers: { "pw-ext": handler as never },
		});
		rig.dispatch(pwFrame("req-1", DEADLINE_MS, FIRST.sessionId));
		await flush();
		rig.dispatch(pwCancelFrame("req-1", SECOND.sessionId));
		expect(signals[0]?.aborted).toBe(false);
	});

	it("cancelSession aborts only the named session and cancelSession() aborts all", async () => {
		const { signals, handler } = abortAware();
		const rig = makeRig({
			sessions: [FIRST, SECOND],
			handlers: { "pw-ext": handler as never },
		});
		rig.dispatch(pwFrame("a", DEADLINE_MS, FIRST.sessionId));
		rig.dispatch(pwFrame("b", DEADLINE_MS, FIRST.sessionId));
		rig.dispatch(pwFrame("c", DEADLINE_MS, SECOND.sessionId));
		await flush();
		rig.dispatcher.cancelSession(FIRST.sessionId);
		expect(signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
		rig.dispatcher.cancelSession();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	it("cancelSession on an idle dispatcher aborts nothing and does not throw", () => {
		const rig = makeRig();
		expect(() => rig.dispatcher.cancelSession()).not.toThrow();
		expect(() => rig.dispatcher.cancelSession(FIRST.sessionId)).not.toThrow();
	});
});

describe("createRelayDispatcher synchronous failures", () => {
	const owned = (timer: { ms?: number }) =>
		timer.ms === LIVENESS_MS || timer.ms === DEADLINE_MS;
	const failureFrame = (name: RelayFeatureName) => ({
		type: FEATURES[name].frames.browserResult,
		ok: false,
		error: FALLBACKS[name],
		sessionId: FIRST.sessionId,
		requestId: "req-1",
		token: FIRST.token,
		protocolVersion: CHAT_PROTOCOL_VERSION,
	});

	it.each(FEATURE_NAMES)(
		"answers a %s handler that throws before returning a promise and releases the run",
		async (name) => {
			activeTimers = spyTimers();
			const rig = makeRig({
				handlers: {
					[name]: () => {
						throw new Error("boom");
					},
				},
			});
			expect(() => rig.dispatch(REQUEST_FRAMES[name]("req-1"))).not.toThrow();
			await flush();
			expect(rig.sent).toStrictEqual([failureFrame(name)]);
			expect(rig.dispatcher.pending()).toEqual([]);
			expect(activeTimers.armed(owned)).toEqual([]);
		},
	);

	it("answers a pw-ext request whose context builder throws and releases the run", async () => {
		activeTimers = spyTimers();
		const rig = makeRig();
		rig.contextFor["pw-ext"].mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => rig.dispatch(pwFrame("req-1"))).not.toThrow();
		await flush();
		expect(rig.handlers["pw-ext"]).not.toHaveBeenCalled();
		expect(rig.sent).toStrictEqual([failureFrame("pw-ext")]);
		expect(rig.dispatcher.pending()).toEqual([]);
		expect(activeTimers.armed(owned)).toEqual([]);
	});

	it("admits the same request id again after a handler threw before returning a promise", async () => {
		const rig = makeRig();
		rig.handlers.inbox.mockImplementationOnce(() => {
			throw new Error("boom");
		});
		rig.dispatch(inboxFrame("req-1"));
		await flush();
		rig.dispatch(inboxFrame("req-1"));
		await flush();
		expect(rig.handlers.inbox).toHaveBeenCalledTimes(2);
		expect(rig.sent.map((frame) => frame.ok)).toEqual([false, true]);
	});
});

describe("createRelayDispatcher timers", () => {
	it("arms one 250 ms liveness interval for concurrent runs and clears it with the last", async () => {
		activeTimers = spyTimers();
		const gate = deferred<Body>();
		const rig = makeRig({ handlers: { "pw-ext": () => gate.promise } });
		const owned = (timer: { ms?: number }) =>
			timer.ms === LIVENESS_MS || timer.ms === DEADLINE_MS;
		rig.dispatch(pwFrame("a"));
		rig.dispatch(pwFrame("b"));
		await flushMicrotasks();
		expect(
			activeTimers.created.filter((timer) => timer.kind === "interval").map((t) => t.ms),
		).toEqual([LIVENESS_MS]);
		expect(activeTimers.armed((timer) => timer.kind === "interval")).toHaveLength(1);
		gate.resolve(BODIES["pw-ext"]);
		await flush();
		expect(rig.dispatcher.pending()).toEqual([]);
		expect(activeTimers.armed(owned)).toEqual([]);
	});

	it("arms the interval again when a later run starts after the dispatcher went idle", async () => {
		activeTimers = spyTimers();
		const rig = makeRig();
		rig.dispatch(pwFrame("a"));
		await flush();
		rig.dispatch(pwFrame("b"));
		await flush();
		const intervals = activeTimers.created.filter((timer) => timer.kind === "interval");
		expect(intervals).toHaveLength(2);
		expect(
			activeTimers.armed((timer) => timer.ms === LIVENESS_MS || timer.ms === DEADLINE_MS),
		).toEqual([]);
	});

	it("leaves no timer armed after a handler rejects", async () => {
		activeTimers = spyTimers();
		const rig = makeRig({ handlers: { "pw-ext": () => Promise.reject(new Error("boom")) } });
		rig.dispatch(pwFrame("a"));
		await flush();
		expect(
			activeTimers.armed((timer) => timer.ms === LIVENESS_MS || timer.ms === DEADLINE_MS),
		).toEqual([]);
	});

	it("aborts a run from the liveness tick once its session stops being live", async () => {
		activeTimers = spyTimers();
		let alive = true;
		const { signals, handler } = abortAware();
		const rig = makeRig({ live: () => () => alive, handlers: { "pw-ext": handler as never } });
		rig.dispatch(pwFrame("a"));
		await flush();
		const tick = activeTimers.created.find((timer) => timer.kind === "interval");
		tick?.fn();
		expect(signals[0]?.aborted).toBe(false);
		alive = false;
		tick?.fn();
		expect(signals[0]?.aborted).toBe(true);
	});
});

describe("createRelayDispatcher pending", () => {
	it("lists in-flight runs only, filters by session, and empties after settle", async () => {
		const gate = deferred<Body>();
		const rig = makeRig({
			sessions: [FIRST, SECOND],
			handlers: { "pw-ext": () => gate.promise },
		});
		expect(rig.dispatcher.pending()).toEqual([]);
		rig.dispatch(pwFrame("a", DEADLINE_MS, FIRST.sessionId));
		rig.dispatch(pwFrame("b", DEADLINE_MS, SECOND.sessionId));
		await flush();
		const all: Array<{ sessionId: string; requestId: string; feature: string; startedAt: number }> =
			rig.dispatcher.pending();
		expect(all.map(({ sessionId, requestId, feature }) => ({ sessionId, requestId, feature }))).toEqual([
			{ sessionId: FIRST.sessionId, requestId: "a", feature: "pw-ext" },
			{ sessionId: SECOND.sessionId, requestId: "b", feature: "pw-ext" },
		]);
		expect(all.every((run) => Number.isFinite(run.startedAt))).toBe(true);
		expect(rig.dispatcher.pending(SECOND.sessionId).map((run) => run.requestId)).toEqual(["b"]);
		expect(rig.dispatcher.pending("sess-unknown")).toEqual([]);
		gate.resolve(BODIES["pw-ext"]);
		await flush();
		expect(rig.dispatcher.pending()).toEqual([]);
	});

	it("shares no pending state between two dispatchers", async () => {
		const gate = deferred<Body>();
		const first = makeRig({ handlers: { "pw-ext": () => gate.promise } });
		const second = makeRig();
		first.dispatch(pwFrame("a"));
		await flush();
		expect(second.dispatcher.pending()).toEqual([]);
		expect(() => second.dispatcher.cancelSession()).not.toThrow();
		expect(() => second.dispatch(pwCancelFrame("a"))).not.toThrow();
		expect(first.dispatcher.pending()).toHaveLength(1);
		gate.resolve(BODIES["pw-ext"]);
	});
});

async function waitFor(check: () => boolean, ms = 1000): Promise<void> {
	const until = Date.now() + ms;
	while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
}

function resultFrames(relay: { sentFrames(): Body[] }, type: string): Body[] {
	return relay.sentFrames().filter((frame) => frame.type === type);
}

describe("registerDaemonLink relay wiring", () => {
	it.each(FEATURE_NAMES)(
		"answers a %s request through the default handler with one correctly shaped result frame",
		async (name) => {
			const relay = await bootRelay();
			relay.socket.dispatch(
				"message",
				frameEvent({ ...REQUEST_FRAMES[name]("req-default"), sessionId: relay.sessionId }),
			);
			const type = FEATURES[name].frames.browserResult;
			await waitFor(() => resultFrames(relay, type).length > 0);
			await flush();
			const results = resultFrames(relay, type);
			expect(results).toHaveLength(1);
			const [result] = results as [Body];
			expect(typeof result.ok).toBe("boolean");
			expect(Object.keys(result).sort()).toEqual(
				[
					"type",
					"ok",
					result.ok ? "data" : "error",
					"sessionId",
					"requestId",
					"token",
					"protocolVersion",
				].sort(),
			);
			expect(result).toMatchObject({
				type,
				sessionId: relay.sessionId,
				requestId: "req-default",
				token: relay.token,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			});
		},
	);

	it("hands a pw-ext relayHandler the session's agent identity in its context", async () => {
		const seen: Array<{ context: { sessionId: string; agentIdentity: string } }> = [];
		const relay = await bootRelay({
			relayHandlers: {
				"pw-ext": (async (input: never) => {
					seen.push(input);
					return { ok: false, error: "x" };
				}) as never,
			},
		});
		relay.socket.dispatch(
			"message",
			frameEvent({ ...pwFrame("req-1"), sessionId: relay.sessionId }),
		);
		await flush();
		expect(seen[0]?.context.sessionId).toBe(relay.sessionId);
		expect(seen[0]?.context.agentIdentity).toBe(makeBootstrap().agentIdentity);
	});

	const TRIGGERS: Array<
		[string, (relay: Awaited<ReturnType<typeof bootRelay>>) => Promise<void>]
	> = [
		[
			"an error frame that drops the session",
			async (relay) => {
				relay.socket.dispatch(
					"message",
					frameEvent({
						type: "error",
						sessionId: relay.sessionId,
						protocolVersion: CHAT_PROTOCOL_VERSION,
						code: "invalid-session",
						message: "unknown session",
					}),
				);
			},
		],
		[
			"a session-closed frame",
			async (relay) => {
				relay.socket.dispatch(
					"message",
					frameEvent({
						type: "session-closed",
						sessionId: relay.sessionId,
						protocolVersion: CHAT_PROTOCOL_VERSION,
					}),
				);
			},
		],
		[
			"MSG.sessionDisconnect confirmed by a session-disconnected frame",
			async (relay) => {
				const reply = relay.postAsOptionsPage({
					type: MSG.sessionDisconnect,
					sessionId: relay.sessionId,
				});
				await settle();
				relay.socket.dispatch(
					"message",
					frameEvent({
						type: "session-disconnected",
						sessionId: relay.sessionId,
						protocolVersion: CHAT_PROTOCOL_VERSION,
					}),
				);
				await reply;
			},
		],
		[
			"socket teardown",
			async (relay) => {
				relay.socket.dispatch("close");
			},
		],
	];

	it.each(TRIGGERS)("aborts every pending signal of the session on %s", async (_label, trigger) => {
		const { signals, handler } = abortAware();
		const relay = await bootRelay({ relayHandlers: { "pw-ext": handler as never } });
		for (const requestId of ["a", "b"]) {
			relay.socket.dispatch(
				"message",
				frameEvent({ ...pwFrame(requestId), sessionId: relay.sessionId }),
			);
		}
		await flush();
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => !signal.aborted)).toBe(true);
		await trigger(relay);
		await flush();
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	it("aborts a pending pw-ext signal on a daemon cancel frame for its request", async () => {
		const { signals, handler } = abortAware();
		const relay = await bootRelay({ relayHandlers: { "pw-ext": handler as never } });
		relay.socket.dispatch(
			"message",
			frameEvent({ ...pwFrame("req-1"), sessionId: relay.sessionId }),
		);
		await flush();
		relay.socket.dispatch(
			"message",
			frameEvent({ ...pwCancelFrame("req-1"), sessionId: relay.sessionId }),
		);
		await flush();
		expect(signals[0]?.aborted).toBe(true);
	});

	it("shares no pending state between two registerDaemonLink instances", async () => {
		const { signals, handler } = abortAware();
		const first = await bootRelay({ relayHandlers: { "pw-ext": handler as never } });
		const second = await bootRelay();
		first.socket.dispatch(
			"message",
			frameEvent({ ...pwFrame("req-1"), sessionId: first.sessionId }),
		);
		await flush();
		second.socket.dispatch(
			"message",
			frameEvent({ ...pwCancelFrame("req-1"), sessionId: second.sessionId }),
		);
		second.socket.dispatch(
			"message",
			frameEvent({
				type: "session-closed",
				sessionId: second.sessionId,
				protocolVersion: CHAT_PROTOCOL_VERSION,
			}),
		);
		second.socket.dispatch("close");
		await flush();
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
	});

	it("starts a fresh instance with nothing to cancel", async () => {
		const relay = await bootRelay();
		expect(() => {
			relay.socket.dispatch(
				"message",
				frameEvent({ ...pwCancelFrame("never-sent"), sessionId: relay.sessionId }),
			);
			relay.socket.dispatch("close");
		}).not.toThrow();
		await flush();
	});
});

describe("registerDaemonLink asset context", () => {
	async function bootWithContext() {
		const contexts: Array<{
			fetchAsset(assetId: string): Promise<Blob>;
			deleteAsset(assetId: string): Promise<void>;
		}> = [];
		const relay = await bootRelay({
			relayHandlers: {
				"pw-ext": (async ({ context }: { context: never }) => {
					contexts.push(context);
					return { ok: false, error: "x" };
				}) as never,
			},
		});
		relay.socket.dispatch(
			"message",
			frameEvent({ ...pwFrame("req-1"), sessionId: relay.sessionId }),
		);
		await flush();
		const context = contexts[0];
		if (!context) throw new Error("the pw-ext handler never ran");
		const assetUrl = (assetId: string) =>
			`http://127.0.0.1:${CHAT_DEFAULT_PORT}${CHAT_ASSETS_PATH}/${encodeURIComponent(assetId)}`;
		const headers = {
			"X-Dg-Session-Id": relay.sessionId,
			"X-Dg-Session-Token": relay.token,
		};
		return { context, assetUrl, headers };
	}

	it("fetches a staged asset from the daemon with the session headers", async () => {
		const { context, assetUrl, headers } = await bootWithContext();
		const blob = new Blob(["hello"]);
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response(blob)) as never,
		);
		try {
			const fetched = await context.fetchAsset("asset id/1");
			expect(await fetched.text()).toBe("hello");
			const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(assetUrl("asset id/1"));
			expect(init.headers).toEqual(headers);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an asset the daemon does not serve", async () => {
		const { context } = await bootWithContext();
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response("nope", { status: 404 })) as never,
		);
		try {
			await expect(context.fetchAsset("a")).rejects.toThrow("the staged file is not available");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("refuses an asset over the size limit", async () => {
		const { context } = await bootWithContext();
		const oversized = { ok: true, blob: async () => ({ size: CHAT_MAX_ASSET_BYTES + 1 }) };
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () => oversized) as never,
		);
		try {
			await expect(context.fetchAsset("a")).rejects.toThrow("the staged file is too large");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("deletes a staged asset with a DELETE to the same URL and headers", async () => {
		const { context, assetUrl, headers } = await bootWithContext();
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
			(async () => new Response(null, { status: 204 })) as never,
		);
		try {
			await context.deleteAsset("asset id/1");
			const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
			expect(url).toBe(assetUrl("asset id/1"));
			expect(init.method).toBe("DELETE");
			expect(init.headers).toEqual(headers);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});

describe("background module layout", () => {
	const lib = fileURLToPath(new URL("../lib/background/", import.meta.url));
	const read = (name: string) => readFileSync(`${lib}${name}`, "utf8");

	it("keeps storage access out of daemon-link.ts", () => {
		expect(read("daemon-link.ts")).not.toMatch(/api\.storage\.session/);
	});

	it("keeps relay-dispatch.ts and pairing-store.ts free of chat.ts imports", () => {
		for (const name of ["relay-dispatch.ts", "pairing-store.ts", "pages.ts"]) {
			expect(read(name)).not.toMatch(/from\s+["'][^"']*\/chat["']|from\s+["']\.\/chat["']/);
		}
	});

	it("keeps the retired relay names out of the extension package", () => {
		const retired = new RegExp(
			[
				...["inbox", "proto", "pwExt"].map((part) => `${part}Handler`),
				...["Inbox", "Proto", "PwExt"].map((part) => `pending${part}`),
				"pwExt" + "Cancels",
				"cancel" + "PwExt",
				"PW_EXT_" + "LIVENESS_MS",
				"InboxResult" + "Frame",
			].join("|"),
		);
		const root = fileURLToPath(new URL("../", import.meta.url));
		const self = fileURLToPath(import.meta.url);
		const offenders = ["lib", "entrypoints", "__tests__"].flatMap((dir) =>
			readdirSync(`${root}${dir}`, { recursive: true, encoding: "utf8" })
				.filter((entry) => entry.endsWith(".ts"))
				.map((entry) => `${root}${dir}/${entry}`)
				.filter((path) => path !== self && retired.test(readFileSync(path, "utf8"))),
		);
		expect(offenders).toEqual([]);
	});
});
