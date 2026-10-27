import { describe, expect, test } from "bun:test";
import {
	oneOf,
	parseFlag,
	parseOptionalFlag,
	readEnvFlag,
	trueOrFalse,
	wholeNumber,
} from "../src/flags";

describe("wholeNumber", () => {
	test("accepts a whole number in range and trims spaces", () => {
		expect(parseFlag(wholeNumber(1, 5), " 3 ", "--spice")).toBe(3);
		expect(parseFlag(wholeNumber(0), "0", "--days")).toBe(0);
	});

	test("rejects decimals, words, empty text and out-of-range values with one clear message", () => {
		for (const raw of ["2.5", "two", "", "0", "6", "1e3"]) {
			expect(() => parseFlag(wholeNumber(1, 5), raw, "--spice")).toThrow(
				`--spice must be a whole number from 1 to 5, got "${raw}"`,
			);
		}
		expect(() => parseFlag(wholeNumber(1), "-1", "--at")).toThrow(
			'--at must be a whole number of 1 or more, got "-1"',
		);
	});
});

describe("oneOf", () => {
	test("accepts a listed value and names every choice when it rejects one", () => {
		const verdict = oneOf(["auto", "approve", "comment"] as const);
		expect(parseFlag(verdict, "approve", "verdict")).toBe("approve");
		expect(() => parseFlag(verdict, "reject", "verdict")).toThrow(
			'verdict must be one of auto, approve, comment, got "reject"',
		);
	});
});

describe("trueOrFalse", () => {
	test("reads true and false only", () => {
		expect(parseFlag(trueOrFalse, "true", "sass")).toBe(true);
		expect(parseFlag(trueOrFalse, "false", "sass")).toBe(false);
		expect(() => parseFlag(trueOrFalse, "yes", "sass")).toThrow(
			'sass must be true or false, got "yes"',
		);
	});
});

describe("absent values", () => {
	test("parseOptionalFlag returns undefined for a missing value", () => {
		expect(parseOptionalFlag(wholeNumber(0), undefined, "--n")).toBeUndefined();
	});

	test("readEnvFlag treats unset and empty the same", () => {
		const env = { A: "", B: "  ", C: "4" };
		expect(readEnvFlag(env, "A", wholeNumber(0), "a")).toBeUndefined();
		expect(readEnvFlag(env, "B", wholeNumber(0), "b")).toBeUndefined();
		expect(readEnvFlag(env, "MISSING", wholeNumber(0), "m")).toBeUndefined();
		expect(readEnvFlag(env, "C", wholeNumber(0), "c")).toBe(4);
	});
});
