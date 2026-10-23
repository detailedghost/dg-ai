import { describe, expect, test } from "bun:test";
import { selectDemoMode } from "../src/commands/demo";

describe("selectDemoMode", () => {
	test("selects local by default, with no --ext flag", () => {
		expect(selectDemoMode({})).toBe("local");
		expect(selectDemoMode({ ext: false })).toBe("local");
	});

	test("selects ext only when --ext is passed", () => {
		expect(selectDemoMode({ ext: true })).toBe("ext");
	});
});
