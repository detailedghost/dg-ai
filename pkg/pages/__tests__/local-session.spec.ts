import { afterEach, expect, test } from "bun:test";
import { CHAT_MARKER_KEY } from "@dg/common";
import { readChatBootstrap } from "../src/chat-marker";
import {
	attachLocalSession,
	exchangeChatCode,
	forgetLocalBootstrap,
	loadLocalBootstrap,
	loadLocalBootstraps,
	storeLocalBootstraps,
} from "../src/local";
import { browserStorage, memoryStorage, positionAreaFor } from "../src/runtime";

const BOOTSTRAP = {
	port: 47823,
	sessionId: "session-a",
	token: "tok-a",
	agentIdentity: "claude-js",
};

function marker(value: unknown): string {
	return `${CHAT_MARKER_KEY}=${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function fakeWindow(
	href: string,
	navigationName?: string,
	replaced: string[] = [],
): Window {
	return {
		location: {
			href,
			port: new URL(href).port,
			origin: new URL(href).origin,
		},
		history: {
			state: null,
			replaceState: (_state: unknown, _title: string, url: string) => {
				replaced.push(url);
			},
		},
		performance: {
			getEntriesByType: () =>
				navigationName === undefined ? [] : [{ name: navigationName }],
		},
	} as unknown as Window;
}

test("readChatBootstrap decodes the _chat fragment marker", () => {
	const url = `http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`;

	expect(readChatBootstrap(url)).toEqual(BOOTSTRAP);
});

test("readChatBootstrap ignores a missing or malformed marker", () => {
	expect(readChatBootstrap("http://127.0.0.1:47823/chat")).toBeUndefined();
	expect(
		readChatBootstrap("http://127.0.0.1:47823/chat#_chat=!!!"),
	).toBeUndefined();
	expect(
		readChatBootstrap(`http://127.0.0.1:47823/chat#${marker({ port: 1 })}`),
	).toBeUndefined();
});

test("loadLocalBootstrap falls back to the navigation entry when an extension stripped the fragment", () => {
	const storage = memoryStorage();
	const navigation = `http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`;

	const loaded = loadLocalBootstrap(
		fakeWindow("http://127.0.0.1:47823/chat", navigation),
		storage,
	);

	expect(loaded).toEqual(BOOTSTRAP);
});

test("loadLocalBootstrap restores the stored session on a reload without a fragment", () => {
	const storage = memoryStorage();
	loadLocalBootstrap(
		fakeWindow(`http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`),
		storage,
	);

	const reloaded = loadLocalBootstrap(
		fakeWindow("http://127.0.0.1:47823/chat"),
		storage,
	);

	expect(reloaded).toEqual(BOOTSTRAP);
});

test("loadLocalBootstrap strips the token fragment from the address bar after reading it", () => {
	const replaced: string[] = [];

	loadLocalBootstrap(
		fakeWindow(
			`http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`,
			undefined,
			replaced,
		),
		memoryStorage(),
	);

	expect(replaced).toEqual(["http://127.0.0.1:47823/chat"]);
});

test("loadLocalBootstrap leaves the address bar alone when no marker is present", () => {
	const replaced: string[] = [];

	loadLocalBootstrap(
		fakeWindow("http://127.0.0.1:47823/chat", undefined, replaced),
		memoryStorage(),
	);

	expect(replaced).toEqual([]);
});

test("forgetLocalBootstrap drops the stored session so a reload cannot reuse a refused token", () => {
	const storage = memoryStorage();
	loadLocalBootstrap(
		fakeWindow(`http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`),
		storage,
	);

	forgetLocalBootstrap(storage, BOOTSTRAP.token);

	expect(
		loadLocalBootstrap(fakeWindow("http://127.0.0.1:47823/chat"), storage),
	).toBeUndefined();
});

test("loadLocalBootstrap ignores a refused token that the fragment or the navigation entry presents again", () => {
	const storage = memoryStorage();
	const url = `http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`;
	loadLocalBootstrap(fakeWindow(url), storage);

	forgetLocalBootstrap(storage, BOOTSTRAP.token);

	expect(loadLocalBootstrap(fakeWindow(url), storage)).toBeUndefined();
	expect(
		loadLocalBootstrap(fakeWindow("http://127.0.0.1:47823/chat", url), storage),
	).toBeUndefined();
});

test("loadLocalBootstrap still accepts a different token after another was refused", () => {
	const storage = memoryStorage();
	loadLocalBootstrap(
		fakeWindow(`http://127.0.0.1:47823/chat#${marker(BOOTSTRAP)}`),
		storage,
	);
	forgetLocalBootstrap(storage, BOOTSTRAP.token);
	const fresh = { ...BOOTSTRAP, sessionId: "session-b", token: "tok-b" };

	expect(
		loadLocalBootstrap(
			fakeWindow(`http://127.0.0.1:47823/chat#${marker(fresh)}`),
			storage,
		),
	).toEqual(fresh);
});

test("loadLocalBootstrap returns undefined when nothing was ever stored", () => {
	expect(
		loadLocalBootstrap(
			fakeWindow("http://127.0.0.1:47823/chat"),
			memoryStorage(),
		),
	).toBeUndefined();
});

test("positionAreaFor keeps canvas positions in one storage key and prunes by key", async () => {
	const storage = memoryStorage();
	const area = positionAreaFor(storage);

	await area.set({ "canvas_position:a": { x: 1, y: 2 } });
	await area.set({ "canvas_position:b": { x: 3, y: 4 } });
	await area.remove(["canvas_position:a"]);

	expect(await area.get(null)).toEqual({ "canvas_position:b": { x: 3, y: 4 } });
});

test("positionAreaFor recovers from corrupt stored data", async () => {
	const storage = memoryStorage();
	storage.set("chat_canvas_positions", "not json");

	expect(await positionAreaFor(storage).get(null)).toEqual({});
});

test("browserStorage keeps a value in memory when the browser refuses the write", async () => {
	const refusing = {
		getItem: () => null,
		setItem: () => {
			throw new DOMException("quota", "QuotaExceededError");
		},
	} as unknown as Storage;
	const area = positionAreaFor(browserStorage(refusing));

	await area.set({ a: { x: 1, y: 2 } });

	expect(await area.get(null)).toEqual({ a: { x: 1, y: 2 } });
});

const HELD_KEY = "dg_local_bootstraps";
const LEGACY_KEY = "dg_local_bootstrap";
const REFUSED_KEY = "dg_local_refused";
const BARE_CHAT = "http://127.0.0.1:47823/chat";

function bootstrapFor(index: number) {
	return {
		...BOOTSTRAP,
		sessionId: `session-${index}`,
		token: `tok-${index}`,
	};
}

function chatUrl(value: unknown, path = "chat"): string {
	return `http://127.0.0.1:47823/${path}#${marker(value)}`;
}

function heldIds(storage: ReturnType<typeof memoryStorage>): string[] {
	const parsed: { sessionId: string }[] = JSON.parse(storage.get(HELD_KEY) ?? "[]");
	return parsed.map((entry) => entry.sessionId);
}

test("loadLocalBootstraps keeps both sessions when two fragments load in the same tab and drops the single key", () => {
	const storage = memoryStorage();
	const [a, b] = [bootstrapFor(1), bootstrapFor(2)];
	const replaced: string[] = [];

	loadLocalBootstraps(fakeWindow(chatUrl(a), undefined, replaced), storage);
	const held = loadLocalBootstraps(fakeWindow(chatUrl(b), undefined, replaced), storage);

	expect(held).toEqual([b, a]);
	expect(heldIds(storage)).toEqual([a.sessionId, b.sessionId]);
	expect(storage.get(LEGACY_KEY)).toBeNull();
	expect(replaced).toEqual([BARE_CHAT, BARE_CHAT]);
});

test("loadLocalBootstraps lists the session from the new fragment first while keeping the held set", () => {
	const storage = memoryStorage();
	const [a, b] = [bootstrapFor(1), bootstrapFor(2)];
	storeLocalBootstraps(storage, [a]);

	const held = loadLocalBootstraps(fakeWindow(chatUrl(b)), storage);

	expect(held).toEqual([b, a]);
	expect(heldIds(storage)).toEqual([a.sessionId, b.sessionId]);
});

test("loadLocalBootstraps restores the whole held set on a reload without a fragment", () => {
	const storage = memoryStorage();
	const held = [bootstrapFor(1), bootstrapFor(2)];
	storeLocalBootstraps(storage, held);

	expect(loadLocalBootstraps(fakeWindow(BARE_CHAT), storage)).toEqual(held);
});

test("loadLocalBootstraps deduplicates a fragment for a session it already holds", () => {
	const storage = memoryStorage();
	const a = bootstrapFor(1);

	loadLocalBootstraps(fakeWindow(chatUrl(a)), storage);
	loadLocalBootstraps(fakeWindow(chatUrl(a)), storage);

	expect(heldIds(storage)).toEqual([a.sessionId]);
});

test("loadLocalBootstraps caps the set at 16 entries and evicts the oldest on the 17th", () => {
	const storage = memoryStorage();
	const all = Array.from({ length: 17 }, (_, index) => bootstrapFor(index + 1));

	for (const entry of all) {
		loadLocalBootstraps(fakeWindow(chatUrl(entry)), storage);
	}

	expect(heldIds(storage)).toEqual(all.slice(1).map((entry) => entry.sessionId));
});

test("loadLocalBootstraps evicts the oldest refused entry before an older live one on the 17th", () => {
	const storage = memoryStorage();
	const all = Array.from({ length: 17 }, (_, index) => bootstrapFor(index + 1));
	storeLocalBootstraps(storage, all.slice(0, 16));
	storage.set("dg_local_refused", JSON.stringify([all[5].token]));

	loadLocalBootstraps(fakeWindow(chatUrl(all[16])), storage);

	expect(heldIds(storage)).toEqual(
		all.filter((_, index) => index !== 5).map((entry) => entry.sessionId),
	);
});

test("loadLocalBootstraps migrates the old single key once and clears it after the array is written", () => {
	const storage = memoryStorage();
	const legacy = bootstrapFor(1);
	storage.set(LEGACY_KEY, JSON.stringify(legacy));

	const held = loadLocalBootstraps(fakeWindow(BARE_CHAT), storage);

	expect(held).toEqual([legacy]);
	expect(heldIds(storage)).toEqual([legacy.sessionId]);
	expect(storage.get(LEGACY_KEY)).toBeNull();
	expect(loadLocalBootstraps(fakeWindow(BARE_CHAT), storage)).toEqual([legacy]);
});

test("loadLocalBootstraps returns an empty set for a corrupt array and for a tab that never held a session", () => {
	const storage = memoryStorage();
	expect(loadLocalBootstraps(fakeWindow(BARE_CHAT), storage)).toEqual([]);

	storage.set(HELD_KEY, "not json");

	expect(loadLocalBootstraps(fakeWindow(BARE_CHAT), storage)).toEqual([]);
});

test("forgetLocalBootstrap removes only the refused session, remembers its token and ignores it when presented again", () => {
	const storage = memoryStorage();
	const [a, b] = [bootstrapFor(1), bootstrapFor(2)];
	loadLocalBootstraps(fakeWindow(chatUrl(a)), storage);
	loadLocalBootstraps(fakeWindow(chatUrl(b)), storage);

	forgetLocalBootstrap(storage, a.token);

	expect(heldIds(storage)).toEqual([b.sessionId]);
	expect(JSON.parse(storage.get(REFUSED_KEY) ?? "[]")).toContain(a.token);
	expect(loadLocalBootstraps(fakeWindow(chatUrl(a)), storage)).toEqual([b]);
});

test("loadLocalBootstrap returns the first live entry of the held set and moves on when it is forgotten", () => {
	const storage = memoryStorage();
	const [a, b] = [bootstrapFor(1), bootstrapFor(2)];
	storeLocalBootstraps(storage, [a, b]);

	expect(loadLocalBootstrap(fakeWindow(BARE_CHAT), storage)).toEqual(a);

	forgetLocalBootstrap(storage, a.token);

	expect(loadLocalBootstrap(fakeWindow(BARE_CHAT), storage)).toEqual(b);
});

test("loadLocalBootstrap still gives the board a session after a /board fragment filled the held set", () => {
	const storage = memoryStorage();
	const a = bootstrapFor(1);

	loadLocalBootstraps(fakeWindow(chatUrl(a, "board")), storage);

	expect(loadLocalBootstrap(fakeWindow("http://127.0.0.1:47823/board"), storage)).toEqual(a);
});

test("loadLocalBootstraps ignores a fragment whose port is not the page port", () => {
	const storage = memoryStorage();
	const a = bootstrapFor(1);
	const forged = { ...bootstrapFor(2), port: 9 };

	loadLocalBootstraps(fakeWindow(chatUrl(a)), storage);
	const held = loadLocalBootstraps(fakeWindow(chatUrl(forged)), storage);

	expect(held).toEqual([a]);
	expect(heldIds(storage)).toEqual([a.sessionId]);
});

test("loadLocalBootstraps drops a stored entry whose port is not the page port", () => {
	const storage = memoryStorage();
	const a = bootstrapFor(1);
	storeLocalBootstraps(storage, [a, { ...bootstrapFor(2), port: 9 }]);

	expect(loadLocalBootstraps(fakeWindow(BARE_CHAT), storage)).toEqual([a]);
});

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("attachLocalSession reaches a live third token after two are refused", async () => {
	const [a, b, c] = [bootstrapFor(1), bootstrapFor(2), bootstrapFor(3)];
	const target = bootstrapFor(4);
	const bearers: string[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const bearer = new Headers(init?.headers).get("Authorization") ?? "";
		bearers.push(bearer);
		return bearer === `Bearer ${c.token}`
			? Response.json({ sessions: [target] })
			: new Response("refused", { status: 403 });
	}) as unknown as typeof fetch;

	const result = await attachLocalSession("http://127.0.0.1:47823", target.sessionId, [a, b, c]);

	expect(bearers).toEqual([`Bearer ${a.token}`, `Bearer ${b.token}`, `Bearer ${c.token}`]);
	expect(result).toEqual({ status: "attached", bootstrap: target, refused: [a, b] });
});

test("exchangeChatCode strips the code from the address and trades it for the bootstrap", async () => {
	const replaced: string[] = [];
	const win = fakeWindow("http://127.0.0.1:47823/chat#_chatcode=one-time", undefined, replaced);
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return Response.json(BOOTSTRAP);
	}) as unknown as typeof fetch;

	const exchanged = await exchangeChatCode(win, fetchFn);

	expect(exchanged).toEqual(BOOTSTRAP);
	expect(replaced).toEqual(["http://127.0.0.1:47823/chat"]);
	expect(calls[0]?.url).toBe("http://127.0.0.1:47823/chat/exchange");
	expect(calls[0]?.init.method).toBe("POST");
	expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ code: "one-time" });
});

test("exchangeChatCode makes no request when the address carries no code", async () => {
	let called = false;
	const fetchFn = (async () => {
		called = true;
		return Response.json(BOOTSTRAP);
	}) as unknown as typeof fetch;

	expect(await exchangeChatCode(fakeWindow("http://127.0.0.1:47823/chat"), fetchFn)).toBeUndefined();
	expect(called).toBe(false);
});

test("exchangeChatCode returns undefined when the daemon refuses the code", async () => {
	const fetchFn = (async () =>
		new Response("no such code", { status: 404 })) as unknown as typeof fetch;

	expect(
		await exchangeChatCode(fakeWindow("http://127.0.0.1:47823/chat#_chatcode=spent"), fetchFn),
	).toBeUndefined();
});

test("loadLocalBootstraps puts a bootstrap won by code exchange first and stores it", () => {
	const storage = memoryStorage();
	const win = fakeWindow("http://127.0.0.1:47823/chat");

	const loaded = loadLocalBootstraps(win, storage, BOOTSTRAP);

	expect(loaded).toEqual([BOOTSTRAP]);
	expect(loadLocalBootstraps(win, storage)).toEqual([BOOTSTRAP]);
});
