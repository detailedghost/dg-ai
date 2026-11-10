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
