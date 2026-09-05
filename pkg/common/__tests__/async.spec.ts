import { describe, expect, it } from "bun:test";
import { wait } from "../src/index";

describe("wait", () => {
	it("resolves after roughly the requested delay", async () => {
		const start = Date.now();
		await wait(20);
		expect(Date.now() - start).toBeGreaterThanOrEqual(15);
	});

	it("resolves with no value", async () => {
		await expect(wait(0)).resolves.toBeUndefined();
	});
});
