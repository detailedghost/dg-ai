import { describe, expect, test } from "bun:test";
import { createAttachLimiter } from "../../src/server/attach-limiter";

const LIMIT = 30;
const WINDOW_MS = 60_000;

function exhaust(limiter: ReturnType<typeof createAttachLimiter>, token: string) {
	for (let i = 0; i < LIMIT; i++) expect(limiter.allow(token)).toBe(true);
}

describe("createAttachLimiter", () => {
	test("refuses a token after its limit inside the window", () => {
		const limiter = createAttachLimiter(() => 1_000);
		exhaust(limiter, "a");
		expect(limiter.allow("a")).toBe(false);
	});

	test("allows the token again once the window slides past old hits", () => {
		let clock = 1_000;
		const limiter = createAttachLimiter(() => clock);
		exhaust(limiter, "a");
		expect(limiter.allow("a")).toBe(false);
		clock += WINDOW_MS + 1;
		expect(limiter.allow("a")).toBe(true);
	});

	test("counts each token independently", () => {
		const limiter = createAttachLimiter(() => 1_000);
		exhaust(limiter, "a");
		expect(limiter.allow("a")).toBe(false);
		expect(limiter.allow("b")).toBe(true);
	});
});
