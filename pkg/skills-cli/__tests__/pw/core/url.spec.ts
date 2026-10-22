import { describe, expect, test } from "bun:test";
import { normalizeUrl } from "../../../src/pw/core/url";

describe("normalizeUrl", () => {
	test.each([
		["https://a.test/x", "https://a.test/x"],
		["http://localhost:3000", "http://localhost:3000"],
		["about:blank", "about:blank"],
		["data:text/html,<p>x</p>", "data:text/html,<p>x</p>"],
		["file:///tmp/a.html", "file:///tmp/a.html"],
		["example.com/path", "https://example.com/path"],
		["localhost:3000/app", "http://localhost:3000/app"],
		["127.0.0.1:8080", "http://127.0.0.1:8080"],
	])("%s -> %s", (input, expected) => {
		expect(normalizeUrl(input)).toBe(expected);
	});
});
