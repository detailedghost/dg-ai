import { describe, expect, it } from "bun:test";
import { wait, withTimeout } from "../src/index";

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

describe("withTimeout", () => {
	it("resolves with the work when it finishes first", async () => {
		await expect(withTimeout(Promise.resolve(7), 50)).resolves.toBe(7);
	});

	it("resolves undefined when the timer wins", async () => {
		await expect(withTimeout(wait(200), 10)).resolves.toBeUndefined();
	});

	it("resolves with the onTimeout value", async () => {
		await expect(withTimeout(wait(200), 10, () => "late")).resolves.toBe("late");
	});

	it("rejects when onTimeout throws", async () => {
		await expect(
			withTimeout(wait(200), 10, () => {
				throw new Error("timed out");
			}),
		).rejects.toThrow("timed out");
	});

	it("propagates a rejection from the work", async () => {
		await expect(withTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
	});
});
