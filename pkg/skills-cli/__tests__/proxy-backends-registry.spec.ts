import { describe, expect, test } from "bun:test";

import { BACKENDS, findBackend } from "../src/proxy/backends";
import { parseJsonLines } from "../src/proxy/backends/json-lines";

describe("findBackend", () => {
	test("returns the registered backend for a known name", () => {
		expect(findBackend("codex")).toBe(BACKENDS.codex);
	});

	test.each(["nope", "constructor", "toString", "__proto__"])("returns undefined for %s", (name) => {
		expect(findBackend(name)).toBeUndefined();
	});
});

describe("parseJsonLines", () => {
	test("keeps object lines and skips blank, malformed and non-object lines", () => {
		const stdout = ['{"a":1}', "", "not json", "42", "null", '["x"]', '{"b":2}'].join("\n");
		expect(parseJsonLines(stdout)).toEqual([{ a: 1 }, ["x"], { b: 2 }]);
	});
});
