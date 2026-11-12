import { describe, expect, test } from "bun:test";
import type { TourScript } from "@dg/common";
import { setupNeedsPerson, unsetFillVariables } from "../src/demo/player-job";

const base = { startUrl: "https://example.test/", steps: [{ title: "A", body: "a" }] } as unknown as TourScript;
const fill = (value: string) => ({
	title: "Password",
	body: "p",
	selector: "#p",
	action: { do: "fill" as const, value },
});
const excluded = (...steps: TourScript["steps"]): TourScript => ({
	...base,
	setup: { includeInTour: false, steps },
});

describe("setupNeedsPerson", () => {
	test("is false without a setup section", () => {
		expect(setupNeedsPerson(base, {})).toBe(false);
	});
	test("is false for an empty setup section", () => {
		expect(setupNeedsPerson(excluded(), {})).toBe(false);
	});
	test("is false for setup steps that type nothing", () => {
		expect(setupNeedsPerson(excluded({ title: "S", body: "s" }), {})).toBe(false);
	});
	test("is false when the setup fills literal text", () => {
		expect(setupNeedsPerson(excluded(fill("dante")), {})).toBe(false);
	});
	test("is true when a setup fill names an unset variable", () => {
		expect(setupNeedsPerson(excluded(fill("$DG_DEMO_PW")), {})).toBe(true);
	});
	test("is true when the variable is empty", () => {
		expect(setupNeedsPerson(excluded(fill("$DG_DEMO_PW")), { DG_DEMO_PW: "" })).toBe(true);
	});
	test("is false when every variable is set", () => {
		expect(setupNeedsPerson(excluded(fill("$DG_DEMO_PW")), { DG_DEMO_PW: "x" })).toBe(false);
	});
	test("is false when setup is part of the tour", () => {
		expect(
			setupNeedsPerson({ ...base, setup: { includeInTour: true, steps: [fill("$DG_DEMO_PW")] } }, {}),
		).toBe(false);
	});
});

describe("unsetFillVariables", () => {
	test("lists each unset variable once, in step order", () => {
		const steps = [fill("$DG_DEMO_B"), fill("$DG_DEMO_A"), fill("$DG_DEMO_B"), fill("$DG_DEMO_SET"), fill("plain")];
		expect(unsetFillVariables(steps, { DG_DEMO_SET: "1" })).toEqual(["DG_DEMO_B", "DG_DEMO_A"]);
	});
});
