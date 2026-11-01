import { describe, expect, test } from "bun:test";
import { numberArg } from "../../../src/pw/core/numbers";

describe("numberArg", () => {
	test("parses integers, negatives, and decimals", () => {
		expect([
			numberArg("5", "x"),
			numberArg("-120", "x"),
			numberArg("2.5", "x"),
		]).toEqual([5, -120, 2.5]);
	});

	test.each(["", " ", "abc", "Infinity", "NaN"])("rejects %p", (value) => {
		expect(() => numberArg(value, "dy")).toThrow(`Invalid dy '${value}'`);
	});
});
