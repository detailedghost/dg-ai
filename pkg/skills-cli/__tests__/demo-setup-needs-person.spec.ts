import { describe, expect, test } from "bun:test";
import type { TourScript } from "@dg/common";
import { setupNeedsPerson } from "../src/demo/player-job";

const base = { startUrl: "https://example.test/", steps: [{ title: "A", body: "a" }] } as unknown as TourScript;

describe("setupNeedsPerson", () => {
	test("is false without a setup section", () => {
		expect(setupNeedsPerson(base)).toBe(false);
	});
	test("is false for an empty setup section", () => {
		expect(setupNeedsPerson({ ...base, setup: { includeInTour: false, steps: [] } })).toBe(false);
	});
	test("is true for a setup section with steps that is not in the tour", () => {
		expect(
			setupNeedsPerson({ ...base, setup: { includeInTour: false, steps: [{ title: "S", body: "s" }] } }),
		).toBe(true);
	});
	test("is false when setup is part of the tour", () => {
		expect(
			setupNeedsPerson({ ...base, setup: { includeInTour: true, steps: [{ title: "S", body: "s" }] } }),
		).toBe(false);
	});
});
