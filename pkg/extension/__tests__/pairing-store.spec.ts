import { describe, expect, mock, test } from "bun:test";
import {
	CHAT_DEFAULT_PORT,
	CHAT_PORT_FALLBACK_COUNT,
	type SessionBootstrap,
} from "@dg/common";
import { createPairingStore } from "@/lib/background/pairing-store";
import {
	makeBootstrapFactory,
	makeLocalArea,
	makeStorage,
} from "./utils/relay-harness";

mock.module("wxt/browser", () => ({ browser: {} }));

const makeBootstrap = makeBootstrapFactory({
	port: CHAT_DEFAULT_PORT,
	sessionId: "sess-one",
	token: "tok-one-secret-value",
	agentIdentity: "claude",
});

const MAX_PORT = CHAT_DEFAULT_PORT + CHAT_PORT_FALLBACK_COUNT;

function storeOver(initial: Record<string, unknown> = {}) {
	const local = makeLocalArea(initial);
	return { local, store: createPairingStore({ storage: makeStorage(local) }) };
}

const bySession = (a: SessionBootstrap, b: SessionBootstrap) =>
	a.sessionId.localeCompare(b.sessionId);

describe("createPairingStore keys", () => {
	test("put writes exactly one pairing key in local storage with the bootstrap as value", async () => {
		const { local, store } = storeOver();
		const bootstrap = makeBootstrap();

		await store.put(bootstrap);

		expect(local.set).toHaveBeenCalledTimes(1);
		expect(Object.keys(local.data)).toEqual([`pairing:${bootstrap.sessionId}`]);
		expect(local.data[`pairing:${bootstrap.sessionId}`]).toEqual(bootstrap);
	});

	test("put for a session that is already stored replaces its value under the same key", async () => {
		const { local, store } = storeOver();
		await store.put(makeBootstrap({ token: "tok-first-secret-value" }));
		await store.put(makeBootstrap({ token: "tok-second-secret-value" }));

		expect(Object.keys(local.data)).toHaveLength(1);
		expect((await store.list())[0]?.token).toBe("tok-second-secret-value");
	});

	test("remove deletes exactly the key of that session", async () => {
		const { local, store } = storeOver();
		const first = makeBootstrap();
		const second = makeBootstrap({ sessionId: "sess-two" });
		await store.put(first);
		await store.put(second);

		await store.remove({ sessionId: first.sessionId });

		expect(Object.keys(local.data)).toEqual([`pairing:${second.sessionId}`]);
	});

	test("remove for a session that was never stored resolves and leaves the others", async () => {
		const { local, store } = storeOver();
		await store.put(makeBootstrap());

		await store.remove({ sessionId: "sess-unknown" });

		expect(Object.keys(local.data)).toHaveLength(1);
	});

	test("put, list and remove round trip through the local area", async () => {
		const { store } = storeOver();
		const first = makeBootstrap();
		const second = makeBootstrap({ sessionId: "sess-two" });
		await store.put(first);
		await store.put(second);
		expect((await store.list()).sort(bySession)).toEqual(
			[first, second].sort(bySession),
		);

		await store.remove({ sessionId: first.sessionId });

		expect(await store.list()).toEqual([second]);
	});

	test("never writes to the session area", async () => {
		const local = makeLocalArea();
		const storage = makeStorage(local);
		const store = createPairingStore({ storage });
		await store.put(makeBootstrap());
		await store.remove({ sessionId: makeBootstrap().sessionId });

		expect(storage.session.set).not.toHaveBeenCalled();
		expect(storage.session.remove).not.toHaveBeenCalled();
	});
});

describe("createPairingStore list", () => {
	test("returns every valid pairing", async () => {
		const first = makeBootstrap();
		const second = makeBootstrap({ sessionId: "sess-two", port: MAX_PORT });
		const { store } = storeOver({
			[`pairing:${first.sessionId}`]: first,
			[`pairing:${second.sessionId}`]: second,
		});

		expect((await store.list()).sort(bySession)).toEqual(
			[first, second].sort(bySession),
		);
	});

	test("returns nothing from an empty area", async () => {
		const { store } = storeOver();

		expect(await store.list()).toEqual([]);
	});

	test.each([
		["null", null],
		["a string", "not a bootstrap"],
		["a number", 4317],
		["an object without a token", { port: CHAT_DEFAULT_PORT, sessionId: "s", agentIdentity: "a" }],
		["a non-numeric port", { ...makeBootstrap(), port: "4317" }],
		["a non-string token", { ...makeBootstrap(), token: 12345678 }],
		["an empty object", {}],
	])("skips a value that is %s", async (_label, value) => {
		const valid = makeBootstrap({ sessionId: "sess-valid" });
		const { store } = storeOver({
			"pairing:sess-bad": value,
			"pairing:sess-valid": valid,
		});

		expect(await store.list()).toEqual([valid]);
	});

	test.each([
		["below the range", CHAT_DEFAULT_PORT - 1],
		["above the range", MAX_PORT + 1],
		["port zero", 0],
		["a far port", 9999],
	])("skips a pairing whose port is %s", async (_label, port) => {
		const tampered = makeBootstrap({ sessionId: "sess-tampered", port });
		const { store } = storeOver({ "pairing:sess-tampered": tampered });

		expect(await store.list()).toEqual([]);
	});

	test("accepts both ends of the daemon port range", async () => {
		const low = makeBootstrap({ sessionId: "sess-low", port: CHAT_DEFAULT_PORT });
		const high = makeBootstrap({ sessionId: "sess-high", port: MAX_PORT });
		const { store } = storeOver({
			"pairing:sess-low": low,
			"pairing:sess-high": high,
		});

		expect((await store.list()).sort(bySession)).toEqual(
			[low, high].sort(bySession),
		);
	});

	test("ignores keys without the pairing prefix even when their values are valid bootstraps", async () => {
		const valid = makeBootstrap({ sessionId: "sess-valid" });
		const foreign = makeBootstrap({ sessionId: "sess-foreign" });
		const { store } = storeOver({
			"pairing:sess-valid": valid,
			"chat_session:sess-foreign": foreign,
			"chat_pos:sess-foreign": foreign,
			"demo_tour:state": foreign,
			"sess-foreign": foreign,
		});

		expect(await store.list()).toEqual([valid]);
	});

	test("propagates a read failure so the caller can log it", async () => {
		const local = makeLocalArea();
		local.get.mockImplementation(() => Promise.reject(new Error("read failed")));
		const store = createPairingStore({ storage: makeStorage(local) });

		await expect(store.list()).rejects.toThrow("read failed");
	});
});
