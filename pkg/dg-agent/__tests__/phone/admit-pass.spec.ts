import { describe, expect, it } from "bun:test";
import { admitInPasses } from "../../src/phone/admit-pass";

describe("admitInPasses", () => {
	it("retries a message after a later ring grows the gate, and drops a stranger once", () => {
		const seen: string[] = [];
		const introduced = new Set<string>();
		const { admitted, drops } = admitInPasses(["msg", "ring", "stranger"], (item) => {
			seen.push(item);
			if (item === "stranger") return { ok: false as const, retry: false, drop: { id: "s" } };
			if (item === "msg" && !introduced.has("ada")) return { ok: false as const, retry: true, drop: { id: "m" } };
			if (item === "ring") {
				introduced.add("ada");
				return { ok: true as const, value: "ring", grew: true };
			}
			return { ok: true as const, value: item, grew: false };
		});

		expect(admitted).toEqual(["ring", "msg"]);
		expect(drops).toEqual([{ id: "s" }]);
		expect(seen.filter((item) => item === "stranger")).toEqual(["stranger"]);
		expect(seen.filter((item) => item === "msg")).toHaveLength(2);
	});

	it("drops a retryable message when nobody in the batch is new", () => {
		const { admitted, drops } = admitInPasses(["alone"], () => ({ ok: false as const, retry: true, drop: { id: "alone" } }));

		expect(admitted).toEqual([]);
		expect(drops).toEqual([{ id: "alone" }]);
	});

	it("returns nothing for an empty batch and does not keep the caller's array", () => {
		const items: string[] = [];
		expect(admitInPasses(items, () => ({ ok: true as const, value: "x", grew: false }))).toEqual({ admitted: [], drops: [] });
		expect(items).toEqual([]);
	});
});
