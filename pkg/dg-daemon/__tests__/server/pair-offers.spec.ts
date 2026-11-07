import { describe, expect, it } from "bun:test";
import { PAIR_CODE_PATTERN, type SessionBootstrap } from "@dg/common";
import { PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS } from "../../src/pairing";
import { createPairOffers } from "../../src/server/pair-offers";

const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ORIGIN = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const BOOTSTRAP: SessionBootstrap = {
	port: 47823,
	sessionId: "session-a",
	token: "token-a",
	agentIdentity: "claude",
};

function clock(start = 1_000_000) {
	let current = start;
	return {
		now: () => current,
		advance(ms: number) {
			current += ms;
		},
	};
}

function newStore(options: Parameters<typeof createPairOffers>[0] = {}) {
	const time = clock();
	const store = createPairOffers({ now: time.now, ...options });
	return { store, time };
}

function created(store: ReturnType<typeof createPairOffers>, origin = ORIGIN) {
	const result = store.create({ origin });
	if ("outcome" in result) throw new Error("offer store is full");
	return result;
}

function wrongCode(code: string): string {
	return `${code.slice(0, -1)}${(Number(code.at(-1)) + 1) % 10}`;
}

describe("createPairOffers create", () => {
	it("returns a uuid offerId, a six digit code and an expiry one TTL ahead", () => {
		const { store, time } = newStore();

		const offer = created(store);

		expect(offer.offerId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(offer.code).toMatch(PAIR_CODE_PATTERN);
		expect(offer.expiresAt).toBe(time.now() + PAIRING_TTL_MS);
		expect(PAIRING_TTL_MS).toBe(300_000);
	});

	it("uses the injected ttl", () => {
		const { store, time } = newStore({ ttlMs: 1_000 });

		expect(created(store).expiresAt).toBe(time.now() + 1_000);
	});

	it("reports full on the ninth offer from nine distinct origins", () => {
		const { store } = newStore();
		for (let index = 0; index < 8; index++) {
			created(store, `chrome-extension://${String(index).repeat(32)}`);
		}

		expect(store.create({ origin: OTHER_ORIGIN })).toEqual({ outcome: "full" });
	});

	it("counts outstanding offers per daemon and honors maxOutstanding", () => {
		const { store } = newStore({ maxOutstanding: 2 });
		created(store, "chrome-extension://a");
		created(store, "chrome-extension://b");

		expect(store.create({ origin: "chrome-extension://c" })).toEqual({
			outcome: "full",
		});
	});

	it("frees capacity once offers expire", () => {
		const { store, time } = newStore({ maxOutstanding: 1 });
		created(store, "chrome-extension://a");
		time.advance(PAIRING_TTL_MS + 1);

		expect("outcome" in store.create({ origin: "chrome-extension://b" })).toBe(
			false,
		);
	});

	it("regenerates the code when it collides with an outstanding offer", () => {
		const { store } = newStore({ maxOutstanding: 2_000 });
		const codes = new Set<string>();

		for (let index = 0; index < 1_000; index++) {
			codes.add(created(store, `chrome-extension://origin-${index}`).code);
		}

		expect(codes.size).toBe(1_000);
	});

	it("supersedes the same origin's pending offer and never fills from one origin", () => {
		const { store } = newStore({ maxOutstanding: 20 });
		const first = created(store);

		const results = Array.from({ length: 12 }, () => store.create({ origin: ORIGIN }));

		expect(results.every((result) => !("outcome" in result))).toBe(true);
		expect(store.status({ offerId: first.offerId, origin: ORIGIN })).toEqual({
			status: "expired",
		});
		expect(store.status({ offerId: first.offerId, origin: ORIGIN })).toBeUndefined();
	});

	it("keeps at most maxOutstanding superseded tombstones and the newest offer claimable", () => {
		const maxOutstanding = 3;
		const { store } = newStore({ maxOutstanding });
		const offers = Array.from({ length: maxOutstanding + 5 }, () =>
			created(store),
		);

		const surviving = offers.filter(
			(offer) =>
				store.status({ offerId: offer.offerId, origin: ORIGIN })?.status ===
				"expired",
		);
		const newest = offers[offers.length - 1] as (typeof offers)[number];

		expect(surviving.length).toBeLessThanOrEqual(maxOutstanding);
		expect(store.claim({ code: newest.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "claimed",
			offerId: newest.offerId,
		});
	});

	it("does not supersede another origin's offer", () => {
		const { store } = newStore();
		const other = created(store, OTHER_ORIGIN);

		created(store, ORIGIN);

		expect(store.status({ offerId: other.offerId, origin: OTHER_ORIGIN })).toEqual(
			{ status: "pending", expiresAt: other.expiresAt },
		);
	});

	it("answers a claim on a superseded offer's code with expired and no count", () => {
		const { store } = newStore();
		const first = created(store);
		created(store);

		expect(store.claim({ code: first.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "expired",
		});
		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
			expect(store.claim({ code: first.code, bootstrap: BOOTSTRAP })).toEqual({
				outcome: "expired",
			});
		}
	});
});

describe("createPairOffers status", () => {
	it("reports pending with the expiry before a claim", () => {
		const { store } = newStore();
		const offer = created(store);

		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toEqual({
			status: "pending",
			expiresAt: offer.expiresAt,
		});
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toEqual({
			status: "pending",
			expiresAt: offer.expiresAt,
		});
	});

	it("returns undefined for an unknown id", () => {
		const { store } = newStore();

		expect(
			store.status({ offerId: crypto.randomUUID(), origin: ORIGIN }),
		).toBeUndefined();
	});

	it("returns undefined for a foreign origin and leaves the offer intact", () => {
		const { store } = newStore();
		const offer = created(store);

		expect(
			store.status({ offerId: offer.offerId, origin: OTHER_ORIGIN }),
		).toBeUndefined();
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })?.status).toBe(
			"pending",
		);
	});

	it("returns the claimed bootstrap once, then undefined", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });

		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toEqual({
			status: "claimed",
			bootstrap: BOOTSTRAP,
		});
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toBeUndefined();
	});

	it("returns expired once after the TTL, then undefined", () => {
		const { store, time } = newStore();
		const offer = created(store);
		time.advance(PAIRING_TTL_MS + 1);

		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toEqual({
			status: "expired",
		});
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toBeUndefined();
	});

	it("does not know an old id after prune removed it", () => {
		const { store, time } = newStore();
		const offer = created(store);
		time.advance(PAIRING_TTL_MS + 1);
		store.prune();

		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toBeUndefined();
	});

	it("does not know any id in a fresh store, as after a daemon restart", () => {
		const { store } = newStore();
		const offer = created(store);
		const { store: restarted } = newStore();

		expect(
			restarted.status({ offerId: offer.offerId, origin: ORIGIN }),
		).toBeUndefined();
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })?.status).toBe(
			"pending",
		);
	});
});

describe("createPairOffers claim", () => {
	it("claims the matching offer and names it", () => {
		const { store } = newStore();
		const offer = created(store);

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "claimed",
			offerId: offer.offerId,
		});
	});

	it("keeps a claimed offer readable past its original expiry", () => {
		const { store, time } = newStore();
		const offer = created(store);
		time.advance(PAIRING_TTL_MS - 1);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		time.advance(PAIRING_TTL_MS / 2);
		created(store, OTHER_ORIGIN);

		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toEqual({
			status: "claimed",
			bootstrap: BOOTSTRAP,
		});
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toBeUndefined();
	});

	it("matches the right offer among several", () => {
		const { store } = newStore();
		const first = created(store, "chrome-extension://a");
		const second = created(store, "chrome-extension://b");
		const bootstrapB = { ...BOOTSTRAP, sessionId: "session-b", token: "token-b" };

		expect(store.claim({ code: second.code, bootstrap: bootstrapB })).toEqual({
			outcome: "claimed",
			offerId: second.offerId,
		});
		expect(
			store.status({ offerId: first.offerId, origin: "chrome-extension://a" })
				?.status,
		).toBe("pending");
		expect(
			store.status({ offerId: second.offerId, origin: "chrome-extension://b" }),
		).toEqual({ status: "claimed", bootstrap: bootstrapB });
	});

	it("answers no-match for a wrong code", () => {
		const { store } = newStore();
		const offer = created(store);

		expect(
			store.claim({ code: wrongCode(offer.code), bootstrap: BOOTSTRAP }),
		).toEqual({ outcome: "no-match" });
	});

	it("answers no-match for the code of an offer another session already claimed", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });

		expect(
			store.claim({
				code: offer.code,
				bootstrap: { ...BOOTSTRAP, sessionId: "session-b", token: "token-b" },
			}),
		).toEqual({ outcome: "no-match" });
	});

	it("answers claimed again when the same session replays the code before the poll", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "claimed",
			offerId: offer.offerId,
		});
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })).toEqual({
			status: "claimed",
			bootstrap: BOOTSTRAP,
		});
	});

	it("does not count same-session replays toward the lockout", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });

		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS + 2; attempt++) {
			expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP }).outcome).toBe(
				"claimed",
			);
		}
	});

	it("answers claimed again when the holding session replays the code after the poll", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "claimed",
			offerId: offer.offerId,
		});
		expect(
			store.status({ offerId: offer.offerId, origin: ORIGIN }),
		).toBeUndefined();
	});

	it("does not count holding-session replays after the poll toward the lockout", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });

		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS + 2; attempt++) {
			expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP }).outcome).toBe(
				"claimed",
			);
		}
	});

	it("counts a replay of a polled code by another session as a wrong code", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });
		const next = created(store);
		const other = { ...BOOTSTRAP, sessionId: "session-b", token: "token-b" };

		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
			expect(store.claim({ code: offer.code, bootstrap: other })).toEqual({
				outcome: "no-match",
			});
		}

		expect(store.claim({ code: next.code, bootstrap: other })).toEqual({
			outcome: "locked",
		});
	});

	it("answers locked to the holding session once the lockout window is open", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });
		const next = created(store);
		const other = { ...BOOTSTRAP, sessionId: "session-b", token: "token-b" };
		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
			store.claim({ code: wrongCode(next.code), bootstrap: other });
		}

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
	});

	it("does not remember a replay of a different code by the holding session", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });

		expect(
			store.claim({ code: wrongCode(offer.code), bootstrap: BOOTSTRAP }),
		).toEqual({ outcome: "no-match" });
	});

	it("forgets the remembered claim when the session is forgotten", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });

		store.forget(BOOTSTRAP.sessionId);

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "no-match",
		});
	});

	it("keeps the remembered claim of other sessions when one is forgotten", () => {
		const { store } = newStore();
		const first = created(store, ORIGIN);
		const second = created(store, OTHER_ORIGIN);
		const other = { ...BOOTSTRAP, sessionId: "session-b", token: "token-b" };
		store.claim({ code: first.code, bootstrap: BOOTSTRAP });
		store.claim({ code: second.code, bootstrap: other });
		store.status({ offerId: first.offerId, origin: ORIGIN });
		store.status({ offerId: second.offerId, origin: OTHER_ORIGIN });

		store.forget(BOOTSTRAP.sessionId);

		expect(store.claim({ code: second.code, bootstrap: other }).outcome).toBe(
			"claimed",
		);
	});

	it("does not extend the remembered claim when it is replayed", () => {
		const { store, time } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });
		time.advance(PAIRING_TTL_MS - 1);
		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP }).outcome).toBe(
			"claimed",
		);

		time.advance(2);

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "no-match",
		});
	});

	it("answers no-match for a replay after the claimed offer's TTL passed", () => {
		const { store, time } = newStore();
		const offer = created(store);
		store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		store.status({ offerId: offer.offerId, origin: ORIGIN });
		time.advance(PAIRING_TTL_MS + 1);

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "no-match",
		});
	});

	it("never claims an offer whose TTL has passed", () => {
		const { store, time } = newStore();
		const offer = created(store);
		time.advance(PAIRING_TTL_MS + 1);

		expect(["expired", "no-match"]).toContain(
			store.claim({ code: offer.code, bootstrap: BOOTSTRAP }).outcome,
		);
		expect(store.status({ offerId: offer.offerId, origin: ORIGIN })?.status).not.toBe(
			"claimed",
		);
	});

	it("keeps no-match for an expired code that has been pruned", () => {
		const { store, time } = newStore();
		const offer = created(store);
		time.advance(PAIRING_TTL_MS + 1);
		store.prune();

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "no-match",
		});
	});

	it("does not count an expired match toward the lockout", () => {
		const { store } = newStore();
		const superseded = created(store, ORIGIN);
		const live = created(store, ORIGIN);

		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS + 2; attempt++) {
			expect(
				store.claim({ code: superseded.code, bootstrap: BOOTSTRAP }),
			).toEqual({ outcome: "expired" });
		}
		expect(store.claim({ code: live.code, bootstrap: BOOTSTRAP }).outcome).toBe(
			"claimed",
		);
	});
});

describe("createPairOffers lockout", () => {
	function failTimes(
		store: ReturnType<typeof createPairOffers>,
		code: string,
		count: number,
	) {
		for (let attempt = 0; attempt < count; attempt++) {
			expect(store.claim({ code, bootstrap: BOOTSTRAP })).toEqual({
				outcome: "no-match",
			});
		}
	}

	it("locks after five wrong codes and expires every outstanding offer", () => {
		const { store } = newStore();
		const first = created(store, "chrome-extension://a");
		const second = created(store, "chrome-extension://b");
		failTimes(store, wrongCode(first.code), PAIRING_MAX_ATTEMPTS);

		expect(store.claim({ code: first.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
		expect(store.claim({ code: second.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
		expect(
			store.status({ offerId: first.offerId, origin: "chrome-extension://a" }),
		).toEqual({ status: "expired" });
		expect(
			store.status({ offerId: second.offerId, origin: "chrome-extension://b" }),
		).toEqual({ status: "expired" });
	});

	it("stays unlocked at four wrong codes", () => {
		const { store } = newStore();
		const offer = created(store);
		failTimes(store, wrongCode(offer.code), PAIRING_MAX_ATTEMPTS - 1);

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP }).outcome).toBe(
			"claimed",
		);
	});

	it("honors maxFailures", () => {
		const { store } = newStore({ maxFailures: 2 });
		const offer = created(store);
		failTimes(store, wrongCode(offer.code), 2);

		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
	});

	it("counts a claimed offer's code from another session as a wrong code", () => {
		const { store } = newStore();
		const offer = created(store);
		store.claim({
			code: offer.code,
			bootstrap: { ...BOOTSTRAP, sessionId: "session-b", token: "token-b" },
		});
		const next = created(store);
		failTimes(store, offer.code, PAIRING_MAX_ATTEMPTS);

		expect(store.claim({ code: next.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
	});

	it("locks after maxFailures replays of a claimed code by another session and expires pending offers", () => {
		const { store } = newStore();
		const claimed = created(store, "chrome-extension://a");
		const pending = created(store, "chrome-extension://b");
		store.claim({ code: claimed.code, bootstrap: BOOTSTRAP });
		const otherSession = {
			...BOOTSTRAP,
			sessionId: "session-b",
			token: "token-b",
		};

		for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
			expect(
				store.claim({ code: claimed.code, bootstrap: otherSession }),
			).toEqual({ outcome: "no-match" });
		}

		expect(
			store.claim({ code: pending.code, bootstrap: otherSession }),
		).toEqual({ outcome: "locked" });
		expect(
			store.status({ offerId: pending.offerId, origin: "chrome-extension://b" }),
		).toEqual({ status: "expired" });
	});

	it("does not reset the counter on create", () => {
		const { store } = newStore();
		const offer = created(store);
		failTimes(store, wrongCode(offer.code), PAIRING_MAX_ATTEMPTS - 1);
		const fresh = created(store);

		failTimes(store, wrongCode(fresh.code), 1);

		expect(store.claim({ code: fresh.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
	});

	it("does not reset the counter on a successful claim", () => {
		const { store } = newStore();
		const offer = created(store, "chrome-extension://a");
		const other = created(store, "chrome-extension://b");
		failTimes(store, wrongCode(offer.code), PAIRING_MAX_ATTEMPTS - 1);
		expect(store.claim({ code: offer.code, bootstrap: BOOTSTRAP }).outcome).toBe(
			"claimed",
		);

		failTimes(store, wrongCode(other.code), 1);

		expect(store.claim({ code: other.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
	});

	it("clears the window after ttlMs", () => {
		const { store, time } = newStore();
		const offer = created(store);
		failTimes(store, wrongCode(offer.code), PAIRING_MAX_ATTEMPTS);
		time.advance(PAIRING_TTL_MS + 1);
		const fresh = created(store);

		expect(store.claim({ code: fresh.code, bootstrap: BOOTSTRAP }).outcome).toBe(
			"claimed",
		);
	});

	it("allows a new offer to be created while locked, but not claimed", () => {
		const { store } = newStore();
		const offer = created(store);
		failTimes(store, wrongCode(offer.code), PAIRING_MAX_ATTEMPTS);
		const fresh = created(store);

		expect(store.claim({ code: fresh.code, bootstrap: BOOTSTRAP })).toEqual({
			outcome: "locked",
		});
	});
});

describe("createPairOffers prune", () => {
	it("is safe on an empty store", () => {
		const { store } = newStore();

		expect(() => store.prune()).not.toThrow();
	});

	it("runs at the start of create so an expired offer frees its slot", () => {
		const { store, time } = newStore({ maxOutstanding: 1 });
		const old = created(store, "chrome-extension://a");
		time.advance(PAIRING_TTL_MS + 1);
		created(store, "chrome-extension://b");

		expect(
			store.status({ offerId: old.offerId, origin: "chrome-extension://a" }),
		).toBeUndefined();
	});
});

describe("createPairOffers secrecy", () => {
	it("never exposes the plaintext code through status or claim results", () => {
		const { store } = newStore();
		const offer = created(store);
		const claimResult = store.claim({ code: offer.code, bootstrap: BOOTSTRAP });
		const status = store.status({ offerId: offer.offerId, origin: ORIGIN });

		expect(JSON.stringify(claimResult)).not.toContain(offer.code);
		expect(JSON.stringify(status)).not.toContain(offer.code);
	});

	it("exposes only the five store methods", () => {
		const { store } = newStore();

		expect(Object.keys(store).sort()).toEqual([
			"claim",
			"create",
			"forget",
			"prune",
			"status",
		]);
	});
});
