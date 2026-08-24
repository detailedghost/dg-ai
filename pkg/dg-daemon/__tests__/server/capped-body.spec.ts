import { describe, expect, it } from "bun:test";
import { readCappedBody } from "../../src/server/http";

describe("readCappedBody", () => {
	function post(body: BodyInit | null): Request {
		return new Request("http://127.0.0.1:1/assets", {
			method: "POST",
			body,
			duplex: "half",
		} as RequestInit);
	}

	function bytes(count: number): ReadableStream<Uint8Array> {
		const chunk = new Uint8Array(8).fill(3);
		let sent = 0;
		return new ReadableStream({
			pull(controller) {
				if (sent >= count) {
					controller.close();
					return;
				}
				const size = Math.min(chunk.byteLength, count - sent);
				controller.enqueue(chunk.subarray(0, size));
				sent += size;
			},
		});
	}

	it("returns the whole body when it stays under the cap", async () => {
		const read = await readCappedBody(post(bytes(24)), 100);

		expect(read?.byteLength).toBe(24);
		expect(read?.every((b) => b === 3)).toBe(true);
	});

	it("accepts a body that lands exactly on the cap", async () => {
		expect((await readCappedBody(post(bytes(32)), 32))?.byteLength).toBe(32);
	});

	it("abandons a body one byte over the cap", async () => {
		expect(await readCappedBody(post(bytes(40)), 32)).toBeUndefined();
	});

	it("abandons a body many times the cap", async () => {
		expect(await readCappedBody(post(bytes(4096)), 32)).toBeUndefined();
	});

	it("treats a request with no body as empty rather than refusing it", async () => {
		const read = await readCappedBody(post(null), 32);

		expect(read?.byteLength).toBe(0);
	});
});
