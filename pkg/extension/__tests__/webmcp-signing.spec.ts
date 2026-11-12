import { describe, expect, it } from "bun:test";
import { IDBFactory } from "fake-indexeddb";
import { createWebMcpSigner, loadSigningKey } from "@/lib/background/webmcp-signing";

const bytes = (text: string) => new TextEncoder().encode(text);

async function memoryKey(): Promise<CryptoKey> {
	return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

describe("createWebMcpSigner", () => {
	it("verifies its own MAC and refuses a changed payload", async () => {
		const key = await memoryKey();
		const signer = createWebMcpSigner({ loadKey: async () => key });

		const mac = await signer.sign(bytes("payload"));

		expect(await signer.verify(bytes("payload"), mac)).toBe(true);
		expect(await signer.verify(bytes("payload!"), mac)).toBe(false);
	});

	it("refuses a MAC made with another key", async () => {
		const mine = createWebMcpSigner({ loadKey: async () => memoryKey() });
		const theirs = createWebMcpSigner({ loadKey: async () => memoryKey() });

		expect(await mine.verify(bytes("payload"), await theirs.sign(bytes("payload")))).toBe(false);
	});

	it.each(["", "zz", "not hex at all", "ab"])("refuses the malformed MAC %p", async (mac) => {
		const signer = createWebMcpSigner({ loadKey: async () => memoryKey() });

		expect(await signer.verify(bytes("payload"), mac)).toBe(false);
	});

	it("loads the key once and reuses it", async () => {
		let loads = 0;
		const key = await memoryKey();
		const signer = createWebMcpSigner({
			loadKey: async () => {
				loads++;
				return key;
			},
		});

		await signer.sign(bytes("a"));
		await signer.verify(bytes("a"), await signer.sign(bytes("a")));

		expect(loads).toBe(1);
	});

	it("rejects when the key cannot load and retries on the next call", async () => {
		const key = await memoryKey();
		let attempts = 0;
		const signer = createWebMcpSigner({
			loadKey: async () => {
				if (++attempts === 1) throw new Error("indexeddb unavailable");
				return key;
			},
		});

		await expect(signer.sign(bytes("a"))).rejects.toThrow("indexeddb unavailable");
		expect(typeof (await signer.sign(bytes("a")))).toBe("string");
	});
});

describe("loadSigningKey", () => {
	it("creates a non-extractable key once and returns the same key later", async () => {
		const factory = new IDBFactory();

		const first = await loadSigningKey(factory);
		const second = await loadSigningKey(factory);

		expect(first.extractable).toBe(false);
		const signer = createWebMcpSigner({ loadKey: async () => first });
		const other = createWebMcpSigner({ loadKey: async () => second });
		expect(await other.verify(bytes("p"), await signer.sign(bytes("p")))).toBe(true);
	});

	it("makes a different key in a different database", async () => {
		const one = createWebMcpSigner({ loadKey: () => loadSigningKey(new IDBFactory()) });
		const two = createWebMcpSigner({ loadKey: () => loadSigningKey(new IDBFactory()) });

		expect(await two.verify(bytes("p"), await one.sign(bytes("p")))).toBe(false);
	});
});

describe("loadSigningKey persistence", () => {
	function abortingFactory(counters: { opens: number }): IDBFactory {
		const request = <T>(result: T) => {
			const pending: { result: T; onsuccess?: () => void; onerror?: () => void } = { result };
			queueMicrotask(() => pending.onsuccess?.());
			return pending;
		};
		const tx: { oncomplete?: () => void; onabort?: () => void; onerror?: () => void; error: Error | null; objectStore(): unknown } = {
			error: new Error("quota exceeded"),
			objectStore: () => ({
				get: () => request(undefined),
				put: () => {
					setTimeout(() => tx.onabort?.(), 0);
					return request("script-signing");
				},
			}),
		};
		const db = { transaction: () => tx, close: () => undefined, createObjectStore: () => undefined };
		return {
			open: () => {
				counters.opens++;
				const opening: { result: unknown; onsuccess?: () => void; onupgradeneeded?: () => void } = { result: db };
				queueMicrotask(() => opening.onsuccess?.());
				return opening;
			},
		} as unknown as IDBFactory;
	}

	it("rejects when the transaction aborts after the put succeeded", async () => {
		await expect(loadSigningKey(abortingFactory({ opens: 0 }))).rejects.toThrow("quota exceeded");
	});

	it("caches nothing from an aborted load and retries on the next call", async () => {
		const counters = { opens: 0 };
		const factory = abortingFactory(counters);
		const signer = createWebMcpSigner({ loadKey: () => loadSigningKey(factory) });

		await expect(signer.sign(bytes("a"))).rejects.toThrow("quota exceeded");
		await expect(signer.sign(bytes("a"))).rejects.toThrow("quota exceeded");

		expect(counters.opens).toBe(2);
	});

	it("resolves a stored key only after the transaction completes", async () => {
		const factory = new IDBFactory();
		await loadSigningKey(factory);
		const events: string[] = [];
		const original = factory.open.bind(factory);
		factory.open = ((name: string, version?: number) => {
			const opening = original(name, version);
			opening.addEventListener("success", () => {
				const db = opening.result;
				const transaction = db.transaction.bind(db);
				db.transaction = ((...args: Parameters<typeof transaction>) => {
					const tx = transaction(...args);
					tx.addEventListener("complete", () => events.push("complete"));
					return tx;
				}) as typeof db.transaction;
			});
			return opening;
		}) as typeof factory.open;

		await loadSigningKey(factory);
		events.push("resolved");

		expect(events).toEqual(["complete", "resolved"]);
	});
});
