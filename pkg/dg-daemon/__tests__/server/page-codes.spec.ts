import { describe, expect, it } from "bun:test";
import { createPageCodes } from "../../src/server/page-codes";

function clock(start = 1_000_000) {
	let current = start;
	return {
		now: () => current,
		advance(ms: number) {
			current += ms;
		},
	};
}

describe("createPageCodes", () => {
	it("redeems a minted code once for the session it was minted for", () => {
		const codes = createPageCodes();

		const code = codes.mint("session-a");

		expect(code.length).toBeGreaterThanOrEqual(32);
		expect(codes.redeem(code)).toBe("session-a");
		expect(codes.redeem(code)).toBeUndefined();
	});

	it("refuses a code it never minted", () => {
		expect(createPageCodes().redeem("nope")).toBeUndefined();
	});

	it("expires a code after its time to live", () => {
		const time = clock();
		const codes = createPageCodes({ now: time.now, ttlMs: 1_000 });
		const code = codes.mint("session-a");

		time.advance(1_001);

		expect(codes.redeem(code)).toBeUndefined();
	});

	it("mints a different code each time", () => {
		const codes = createPageCodes();

		expect(codes.mint("session-a")).not.toBe(codes.mint("session-a"));
	});

	it("drops the oldest code when more than the cap are outstanding", () => {
		const codes = createPageCodes({ max: 2 });
		const first = codes.mint("session-a");
		codes.mint("session-b");
		codes.mint("session-c");

		expect(codes.redeem(first)).toBeUndefined();
	});
});
