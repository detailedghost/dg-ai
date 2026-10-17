import { describe, expect, test } from "bun:test";
import { optionalOption, requireOption } from "../src/utils/options";

describe("optionalOption", () => {
	test("returns the value after the flag and undefined when absent", () => {
		expect(optionalOption(["--title", "hello"], "--title")).toBe("hello");
		expect(optionalOption(["--other", "x"], "--title")).toBeUndefined();
	});

	test("rejects a missing value or a following flag", () => {
		expect(() => optionalOption(["--title"], "--title")).toThrow("--title requires a value");
		expect(() => optionalOption(["--title", "--body", "x"], "--title")).toThrow(
			"--title requires a value",
		);
	});

	test("accepts a value that only starts with dashes, such as a markdown rule", () => {
		expect(optionalOption(["--body", "---"], "--body")).toBe("---");
	});
});

describe("requireOption", () => {
	test("throws when the flag is absent", () => {
		expect(() => requireOption([], "--diff")).toThrow("--diff requires a value");
		expect(requireOption(["--diff", "a.diff"], "--diff")).toBe("a.diff");
	});
});
