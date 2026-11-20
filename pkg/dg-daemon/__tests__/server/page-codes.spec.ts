import { describe, expect, it } from "bun:test";
import {
	createPageCodes,
	SECRET_INTENT_TTL_MS,
} from "../../src/server/page-codes";

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

describe("createPageCodes with an intent payload", () => {
	const intent = { name: "db/pg1", meta: { engine: "postgresql" } };

	it("redeems a code once for the intent it was minted for", () => {
		const codes = createPageCodes<typeof intent>({ ttlMs: SECRET_INTENT_TTL_MS });

		const code = codes.mint(intent);

		expect(codes.redeem(code)).toEqual(intent);
		expect(codes.redeem(code)).toBeUndefined();
	});

	it("keeps a code redeemable for 120 seconds and refuses it afterwards", () => {
		const time = clock();
		const codes = createPageCodes<typeof intent>({
			now: time.now,
			ttlMs: SECRET_INTENT_TTL_MS,
		});
		const live = codes.mint(intent);
		const late = codes.mint(intent);

		time.advance(119_999);
		expect(codes.redeem(live)).toEqual(intent);
		time.advance(2);
		expect(codes.redeem(late)).toBeUndefined();
	});

	it("peeks without consuming the code", () => {
		const codes = createPageCodes<typeof intent>({ ttlMs: SECRET_INTENT_TTL_MS });
		const code = codes.mint(intent);

		expect(codes.peek(code)).toEqual(intent);
		expect(codes.peek(code)).toEqual(intent);
		expect(codes.redeem(code)).toEqual(intent);
		expect(codes.peek(code)).toBeUndefined();
	});

	it("refuses to peek an expired or unknown code", () => {
		const time = clock();
		const codes = createPageCodes<typeof intent>({
			now: time.now,
			ttlMs: SECRET_INTENT_TTL_MS,
		});
		const code = codes.mint(intent);

		time.advance(SECRET_INTENT_TTL_MS + 1);

		expect(codes.peek(code)).toBeUndefined();
		expect(codes.peek("nope")).toBeUndefined();
	});
});
