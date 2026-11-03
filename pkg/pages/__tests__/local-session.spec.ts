import { expect, test } from "bun:test";
import { CHAT_MARKER_KEY } from "@dg/common";
import { readChatBootstrap } from "../src/chat-marker";
import { forgetLocalBootstrap, loadLocalBootstrap } from "../src/local";
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
		location: { href },
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
