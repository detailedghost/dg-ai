import { describe, expect, mock, spyOn, test } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PAIR_OFFER_PATH,
	type SessionBootstrap,
} from "@dg/common";
import { MSG } from "@dg/pages/chat-messages";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerPairOffer } = await import("@/lib/background/pair-offer");

type Listener = (
	message: unknown,
	sender: unknown,
	sendResponse: (response: unknown) => void,
) => boolean | undefined;

type FetchCall = { method: string; pathname: string; init?: RequestInit };

const POPUP_URL = "chrome-extension://offer-test/popup.html";
const POLL_MS = 10;
const STORAGE_KEY = "pairOffer";

const claimedBootstrap: SessionBootstrap = {
	port: CHAT_DEFAULT_PORT,
	sessionId: "claimed-session",
	token: "claimed-token-secret",
	agentIdentity: "claude-reviewer",
};

function offerBody(n: number) {
	return {
		offerId: `offer-${n}`,
		code: String(100000 + n),
		expiresAt: 9_000_000 + n,
	};
}

function memorySession(seed: Record<string, unknown> = {}) {
	const data: Record<string, unknown> = { ...seed };
	return {
		data,
		get: mock(async (keys?: unknown) => {
			if (keys === null || keys === undefined) return { ...data };
			const wanted = Array.isArray(keys) ? keys : [keys as string];
			return Object.fromEntries(
				wanted.filter((key) => key in data).map((key) => [key, data[key]]),
			);
		}),
		set: mock(async (items: Record<string, unknown>) => {
			Object.assign(data, items);
		}),
		remove: mock(async (keys: string | string[]) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
		}),
	};
}

type PollAnswer = () => Response;

function fakeDaemon() {
	const calls: FetchCall[] = [];
	let created = 0;
	const state = {
		createAnswer: undefined as undefined | (() => Response),
		pollAnswer: (() =>
			Response.json({ status: "pending", expiresAt: 1 })) as PollAnswer,
	};
	const fetchFn = mock(async (input: unknown, init?: RequestInit) => {
		const pathname = new URL(String(input)).pathname;
		const method = init?.method ?? "GET";
		calls.push({ method, pathname, init });
		if (method === "POST" && pathname === CHAT_PAIR_OFFER_PATH) {
			if (state.createAnswer) return state.createAnswer();
			created += 1;
			return Response.json(offerBody(created), { status: 201 });
		}
		if (method === "GET" && pathname.startsWith(`${CHAT_PAIR_OFFER_PATH}/`)) {
			return state.pollAnswer();
		}
		return new Response("unexpected", { status: 500 });
	});
	return {
		state,
		fetchFn,
		calls,
		posts: () => calls.filter((call) => call.method === "POST"),
		gets: () => calls.filter((call) => call.method === "GET"),
	};
}

function boot(
	options: {
		session?: ReturnType<typeof memorySession>;
		daemon?: ReturnType<typeof fakeDaemon>;
		findPort?: () => Promise<number | undefined>;
		pollIntervalMs?: number;
		adopt?: ReturnType<typeof mock>;
	} = {},
) {
	let listener: Listener | undefined;
	const session = options.session ?? memorySession();
	const daemon = options.daemon ?? fakeDaemon();
	const adopt = options.adopt ?? mock(async (_bootstrap: SessionBootstrap) => {});
	const runtime = {
		onMessage: {
			addListener: mock((next: Listener) => {
				listener = next;
			}),
		},
		getURL: (path: string) => `chrome-extension://offer-test/${path}`,
	};
	registerPairOffer({
		runtime,
		storage: { session },
		fetch: daemon.fetchFn as unknown as typeof fetch,
		findPort: options.findPort ?? (() => Promise.resolve(CHAT_DEFAULT_PORT)),
		adopt,
		...(options.pollIntervalMs === undefined
			? {}
			: { pollIntervalMs: options.pollIntervalMs }),
	});
	function request(
		message: Record<string, unknown> = {},
		sender: unknown = { url: POPUP_URL },
	): Promise<unknown> {
		return new Promise((resolve) => {
			const kept = listener?.(
				{ type: MSG.pairOfferRequest, ...message },
				sender,
				resolve,
			);
			if (!kept) resolve(undefined);
		});
	}
	return { request, session, daemon, adopt, runtime, hasListener: () => !!listener };
}

async function until(condition: () => boolean, timeoutMs = 1000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error("condition not met in time");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function bootPolling(options: Parameters<typeof boot>[0] = {}) {
	return boot({ pollIntervalMs: POLL_MS, ...options });
}

describe("registerPairOffer create", () => {
	test("registers exactly one runtime message listener", () => {
		const harness = boot();

		expect(harness.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
		expect(harness.hasListener()).toBe(true);
	});

	test("with no stored offer a request POSTs once, stores only the id and expiry, and replies pending with the code", async () => {
		const harness = bootPolling();

		const reply = await harness.request();

		expect(harness.daemon.posts()).toHaveLength(1);
		expect(harness.daemon.posts()[0]?.pathname).toBe(CHAT_PAIR_OFFER_PATH);
		const offer = offerBody(1);
		expect(reply).toEqual({
			status: "pending",
			code: offer.code,
			expiresAt: offer.expiresAt,
		});
		expect(harness.session.data[STORAGE_KEY]).toEqual({
			offerId: offer.offerId,
			expiresAt: offer.expiresAt,
		});
		expect(JSON.stringify(harness.session.data)).not.toContain(offer.code);
	});

	test("three requests inside one window cause exactly one POST", async () => {
		const harness = bootPolling();

		const replies = await Promise.all([
			harness.request(),
			harness.request(),
			harness.request(),
		]);
		const later = await harness.request();

		expect(harness.daemon.posts()).toHaveLength(1);
		for (const reply of [...replies, later]) {
			expect(reply).toMatchObject({
				status: "pending",
				code: offerBody(1).code,
			});
		}
	});

	test("a renew request POSTs a fresh offer", async () => {
		const harness = bootPolling();
		await harness.request();

		const reply = await harness.request({ renew: true });

		expect(harness.daemon.posts()).toHaveLength(2);
		expect(reply).toMatchObject({
			status: "pending",
			code: offerBody(2).code,
		});
		expect(harness.session.data[STORAGE_KEY]).toEqual({
			offerId: offerBody(2).offerId,
			expiresAt: offerBody(2).expiresAt,
		});
	});
});

describe("registerPairOffer polling", () => {
	test("polls the offer status with no popup message in between", async () => {
		const harness = bootPolling();
		await harness.request();

		await until(() => harness.daemon.gets().length >= 3);

		for (const call of harness.daemon.gets()) {
			expect(call.pathname).toBe(
				`${CHAT_PAIR_OFFER_PATH}/${offerBodyId(1)}`,
			);
		}
		expect(harness.adopt).not.toHaveBeenCalled();
	});

	test("the default poll interval is 1500 ms", async () => {
		const delays: number[] = [];
		const handles: Array<ReturnType<typeof setTimeout>> = [];
		const realTimeout = globalThis.setTimeout;
		const realInterval = globalThis.setInterval;
		globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms !== undefined) delays.push(ms);
			const handle = realTimeout(fn, ms, ...(rest as []));
			handles.push(handle);
			return handle;
		}) as unknown as typeof setTimeout;
		globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
			if (ms !== undefined) delays.push(ms);
			const handle = realInterval(fn, ms, ...(rest as []));
			handles.push(handle);
			return handle;
		}) as unknown as typeof setInterval;
		try {
			const harness = boot();
			await harness.request();
			expect(delays).toContain(1500);
		} finally {
			globalThis.setTimeout = realTimeout;
			globalThis.setInterval = realInterval;
			for (const handle of handles) {
				clearTimeout(handle);
				clearInterval(handle as unknown as ReturnType<typeof setInterval>);
			}
		}
	});

	test("a claimed offer adopts the bootstrap exactly once, clears the key, stops polling and replies claimed without the token", async () => {
		const harness = bootPolling();
		await harness.request();
		harness.daemon.state.pollAnswer = () =>
			Response.json({ status: "claimed", bootstrap: claimedBootstrap });

		await until(() => (harness.adopt as ReturnType<typeof mock>).mock.calls.length > 0);
		await pause(POLL_MS * 6);
		const getsAfterClaim = harness.daemon.gets().length;
		await pause(POLL_MS * 6);

		expect(harness.adopt).toHaveBeenCalledTimes(1);
		expect(harness.adopt).toHaveBeenCalledWith(claimedBootstrap);
		expect(harness.session.data).not.toHaveProperty(STORAGE_KEY);
		expect(harness.daemon.gets()).toHaveLength(getsAfterClaim);
		const reply = await harness.request();
		expect(reply).toEqual({
			status: "claimed",
			agentIdentity: claimedBootstrap.agentIdentity,
		});
		expect(JSON.stringify(reply)).not.toContain(claimedBootstrap.token);
		expect(harness.daemon.posts()).toHaveLength(1);
		expect(harness.adopt).toHaveBeenCalledTimes(1);
	});

	test.each([
		[
			"expired",
			() => Response.json({ status: "expired" }),
		],
		["404", () => new Response("not found", { status: 404 })],
		["an invalid status body", () => Response.json({ status: "bogus" })],
	])("%s clears the key, stops polling and replies expired", async (_name, answer) => {
		const harness = bootPolling();
		await harness.request();
		harness.daemon.state.pollAnswer = answer;

		await until(() => !(STORAGE_KEY in harness.session.data));
		await pause(POLL_MS * 4);
		const settled = harness.daemon.gets().length;
		await pause(POLL_MS * 6);

		expect(harness.daemon.gets()).toHaveLength(settled);
		expect(harness.adopt).not.toHaveBeenCalled();
		expect(await harness.request()).toMatchObject({
			status: "pending",
			code: offerBody(2).code,
		});
		expect(harness.daemon.posts()).toHaveLength(2);
	});

	test.each([400, 429, 500, 503])(
		"a %i poll reply keeps the offer pending and keeps polling until the claim lands",
		async (status) => {
			const warn = spyOn(console, "warn").mockImplementation(() => undefined);
			try {
				const harness = bootPolling();
				await harness.request();
				harness.daemon.state.pollAnswer = () =>
					new Response("try later", { status });

				await until(() => harness.daemon.gets().length >= 3);

				expect(harness.session.data[STORAGE_KEY]).toEqual({
					offerId: offerBody(1).offerId,
					expiresAt: offerBody(1).expiresAt,
				});
				expect(await harness.request()).toMatchObject({
					status: "pending",
					code: offerBody(1).code,
				});
				expect(harness.daemon.posts()).toHaveLength(1);
				expect(warn).toHaveBeenCalled();

				harness.daemon.state.pollAnswer = () =>
					Response.json({ status: "claimed", bootstrap: claimedBootstrap });
				await until(
					() => (harness.adopt as ReturnType<typeof mock>).mock.calls.length > 0,
				);

				expect(harness.adopt).toHaveBeenCalledTimes(1);
			} finally {
				warn.mockRestore();
			}
		},
	);

	test("a claim that lands after the original local deadline is still adopted", async () => {
		const harness = bootPolling();
		await harness.request();
		harness.daemon.state.pollAnswer = () =>
			Response.json({
				status: "pending",
				expiresAt: offerBody(1).expiresAt + 600_000,
			});
		await until(() => harness.daemon.gets().length >= 3);
		expect(harness.session.data).toHaveProperty(STORAGE_KEY);
		expect(await harness.request()).toMatchObject({
			status: "pending",
			expiresAt: offerBody(1).expiresAt + 600_000,
		});

		harness.daemon.state.pollAnswer = () =>
			Response.json({ status: "claimed", bootstrap: claimedBootstrap });
		await until(
			() => (harness.adopt as ReturnType<typeof mock>).mock.calls.length > 0,
		);

		expect(harness.adopt).toHaveBeenCalledTimes(1);
	});

	test("a slow claimed reply overlapped by later 404s still adopts exactly once", async () => {
		const harness = bootPolling();
		await harness.request();
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		harness.daemon.state.pollAnswer = (() => {
			if (first) {
				first = false;
				return gate.then(() =>
					Response.json({ status: "claimed", bootstrap: claimedBootstrap }),
				);
			}
			return new Response("not found", { status: 404 });
		}) as unknown as PollAnswer;

		await until(() => harness.daemon.gets().length >= 1);
		await pause(POLL_MS * 6);
		expect(harness.daemon.gets()).toHaveLength(1);
		release();
		await until(
			() => (harness.adopt as ReturnType<typeof mock>).mock.calls.length > 0,
		);
		await pause(POLL_MS * 4);

		expect(harness.adopt).toHaveBeenCalledTimes(1);
		expect(harness.adopt).toHaveBeenCalledWith(claimedBootstrap);
	});

	test("an adopt that rejects replies error without the token and stops polling", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const adopt = mock(async (_bootstrap: SessionBootstrap) => {
				throw new Error(`boom ${claimedBootstrap.token}`);
			});
			const harness = bootPolling({ adopt });
			await harness.request();
			harness.daemon.state.pollAnswer = () =>
				Response.json({ status: "claimed", bootstrap: claimedBootstrap });

			await until(() => adopt.mock.calls.length > 0);
			await pause(POLL_MS * 4);
			const settled = harness.daemon.gets().length;
			await pause(POLL_MS * 6);
			const first = await harness.request();
			const second = await harness.request();

			expect(first).toMatchObject({ status: "error" });
			expect(second).toEqual(first);
			expect(JSON.stringify(first)).not.toContain(claimedBootstrap.token);
			expect(JSON.stringify(warn.mock.calls)).not.toContain(
				claimedBootstrap.token,
			);
			expect(adopt).toHaveBeenCalledTimes(1);
			expect(harness.session.data).not.toHaveProperty(STORAGE_KEY);
			expect(harness.daemon.gets()).toHaveLength(settled);
			expect(harness.daemon.posts()).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("no further fetch happens after the offer settles", async () => {
		const harness = bootPolling();
		await harness.request();
		harness.daemon.state.pollAnswer = () => Response.json({ status: "expired" });
		await until(() => !(STORAGE_KEY in harness.session.data));
		await pause(POLL_MS * 3);
		const before = harness.daemon.calls.length;

		await pause(POLL_MS * 8);

		expect(harness.daemon.calls).toHaveLength(before);
	});
});

describe("registerPairOffer reconcile after a worker restart", () => {
	const stored = { offerId: "stored-offer", expiresAt: 9_999_999 };

	test("a stored pending offer with no code in memory is replaced by a new offer", async () => {
		const session = memorySession({ [STORAGE_KEY]: stored });
		const harness = bootPolling({ session });

		const reply = await harness.request();

		expect(harness.daemon.gets()[0]?.pathname).toBe(
			`${CHAT_PAIR_OFFER_PATH}/${stored.offerId}`,
		);
		expect(harness.daemon.posts()).toHaveLength(1);
		expect(reply).toMatchObject({
			status: "pending",
			code: offerBody(1).code,
		});
	});

	test("a stored offer claimed in the meantime is adopted without a new POST", async () => {
		const session = memorySession({ [STORAGE_KEY]: stored });
		const daemon = fakeDaemon();
		daemon.state.pollAnswer = () =>
			Response.json({ status: "claimed", bootstrap: claimedBootstrap });
		const harness = bootPolling({ session, daemon });

		const reply = await harness.request();

		expect(harness.adopt).toHaveBeenCalledTimes(1);
		expect(harness.adopt).toHaveBeenCalledWith(claimedBootstrap);
		expect(session.data).not.toHaveProperty(STORAGE_KEY);
		expect(daemon.posts()).toHaveLength(0);
		expect(reply).toEqual({
			status: "claimed",
			agentIdentity: claimedBootstrap.agentIdentity,
		});
	});

	test("a stored offer claimed in the meantime whose adopt rejects replies error and keeps replaying it", async () => {
		const warn = spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const session = memorySession({ [STORAGE_KEY]: stored });
			const daemon = fakeDaemon();
			daemon.state.pollAnswer = () =>
				Response.json({ status: "claimed", bootstrap: claimedBootstrap });
			const adopt = mock(async (_bootstrap: SessionBootstrap) => {
				throw new Error("link refused the bootstrap");
			});
			const harness = bootPolling({ session, daemon, adopt });

			const first = await harness.request();
			const second = await harness.request();

			expect(first).toMatchObject({ status: "error" });
			expect(second).toEqual(first);
			expect(adopt).toHaveBeenCalledTimes(1);
			expect(session.data).not.toHaveProperty(STORAGE_KEY);
			expect(daemon.posts()).toHaveLength(0);
		} finally {
			warn.mockRestore();
		}
	});

	test.each([
		["expired", () => Response.json({ status: "expired" })],
		["404", () => new Response("gone", { status: 404 })],
		["an invalid body", () => Response.json({ nope: true })],
	])("a stored offer that is %s gets a new offer", async (_name, answer) => {
		const session = memorySession({ [STORAGE_KEY]: stored });
		const daemon = fakeDaemon();
		daemon.state.pollAnswer = answer;
		const harness = bootPolling({ session, daemon });

		const reply = await harness.request();

		expect(daemon.posts()).toHaveLength(1);
		expect(reply).toMatchObject({
			status: "pending",
			code: offerBody(1).code,
		});
		expect(session.data[STORAGE_KEY]).toEqual({
			offerId: offerBody(1).offerId,
			expiresAt: offerBody(1).expiresAt,
		});
	});
});

describe("registerPairOffer failures and gates", () => {
	test("an unreachable daemon replies daemon-down and makes no fetch", async () => {
		const harness = bootPolling({ findPort: () => Promise.resolve(undefined) });

		const reply = await harness.request();

		expect(reply).toEqual({ status: "daemon-down" });
		expect(harness.daemon.fetchFn).not.toHaveBeenCalled();
	});

	test("a findPort miss during a live offer keeps it and a later claim is adopted", async () => {
		let port: number | undefined = CHAT_DEFAULT_PORT;
		const harness = bootPolling({ findPort: () => Promise.resolve(port) });
		await harness.request();
		port = undefined;

		expect(await harness.request()).toEqual({ status: "daemon-down" });
		expect(harness.session.data).toHaveProperty(STORAGE_KEY);

		harness.daemon.state.pollAnswer = () =>
			Response.json({ status: "claimed", bootstrap: claimedBootstrap });
		await until(
			() => (harness.adopt as ReturnType<typeof mock>).mock.calls.length > 0,
		);

		expect(harness.adopt).toHaveBeenCalledTimes(1);
		expect(harness.daemon.posts()).toHaveLength(1);
	});

	test("a 429 POST replies error carrying the daemon's text", async () => {
		const daemon = fakeDaemon();
		const text = "too many pairing offers; wait for one to expire";
		daemon.state.createAnswer = () => new Response(text, { status: 429 });
		const harness = bootPolling({ daemon });

		const reply = await harness.request();

		expect(reply).toEqual({ status: "error", error: text });
		expect(harness.session.data).not.toHaveProperty(STORAGE_KEY);
	});

	test("a refused renew after an expired offer makes the next plain request reply error", async () => {
		const daemon = fakeDaemon();
		const text = "too many pairing offers; wait for one to expire";
		const harness = bootPolling({ daemon });
		await harness.request();
		daemon.state.pollAnswer = () => Response.json({ status: "expired" });
		await until(() => !(STORAGE_KEY in harness.session.data));
		daemon.state.createAnswer = () => new Response(text, { status: 429 });

		const renewReply = await harness.request({ renew: true });
		const nextReply = await harness.request();

		expect(renewReply).toEqual({ status: "error", error: text });
		expect(nextReply).toEqual({ status: "error", error: text });
	});

	test("a 429 on the first POST is not retried by the next plain request", async () => {
		const daemon = fakeDaemon();
		const text = "too many pairing offers; wait for one to expire";
		daemon.state.createAnswer = () => new Response(text, { status: 429 });
		const harness = bootPolling({ daemon });

		await harness.request();
		const nextReply = await harness.request();

		expect(daemon.posts()).toHaveLength(1);
		expect(nextReply).toEqual({ status: "error", error: text });
	});

	test("a 429 POST is replayed on later plain requests and only a renew POSTs again", async () => {
		const daemon = fakeDaemon();
		const text = "too many pairing offers; wait for one to expire";
		daemon.state.createAnswer = () => new Response(text, { status: 429 });
		const harness = bootPolling({ daemon });

		const replies = [
			await harness.request(),
			await harness.request(),
			await harness.request(),
		];

		expect(replies).toEqual(Array(3).fill({ status: "error", error: text }));
		expect(daemon.posts()).toHaveLength(1);

		daemon.state.createAnswer = undefined;
		const renewed = await harness.request({ renew: true });

		expect(daemon.posts()).toHaveLength(2);
		expect(renewed).toMatchObject({ status: "pending" });
	});

	test("a renew that hits a 429 after an expiry shows the error, not the expiry, on the next plain request", async () => {
		const daemon = fakeDaemon();
		const harness = bootPolling({ daemon });
		await harness.request();
		daemon.state.pollAnswer = () => Response.json({ status: "expired" });
		await until(() => !(STORAGE_KEY in harness.session.data));
		const text = "too many pairing offers; wait for one to expire";
		daemon.state.createAnswer = () => new Response(text, { status: 429 });

		const renewed = await harness.request({ renew: true });
		const next = await harness.request();

		expect(renewed).toEqual({ status: "error", error: text });
		expect(next).toEqual({ status: "error", error: text });
		expect(daemon.posts()).toHaveLength(2);
	});

	test.each([
		["a content script tab", { tab: { id: 4 }, url: "https://example.com/" }],
		["a web page url", { url: "https://example.com/" }],
		["no url", {}],
	])("a request from %s is refused and changes nothing", async (_name, sender) => {
		const harness = bootPolling();

		const reply = await harness.request({}, sender);

		expect(reply).toBeUndefined();
		expect(harness.daemon.fetchFn).not.toHaveBeenCalled();
		expect(harness.session.data).toEqual({});
	});

	test("a tab sender inside the extension origin is still refused", async () => {
		const harness = bootPolling();

		const reply = await harness.request({}, { tab: { id: 9 }, url: POPUP_URL });

		expect(reply).toBeUndefined();
		expect(harness.daemon.fetchFn).not.toHaveBeenCalled();
	});
});

function offerBodyId(n: number): string {
	return offerBody(n).offerId;
}
