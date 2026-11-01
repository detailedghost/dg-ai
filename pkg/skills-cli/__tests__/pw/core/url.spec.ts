import { describe, expect, test } from "bun:test";
import { UsageError } from "../../../src/pw/core/args";
import { normalizeUrl, parseCdpUrl } from "../../../src/pw/core/url";

describe("parseCdpUrl", () => {
	test.each([
		"http://127.0.0.1:9222",
		"https://127.0.0.1:9222/",
		"ws://[::1]:9222/devtools/browser/abc",
		"wss://127.0.0.1:65535",
	])("accepts %s unchanged", (value) => {
		expect(parseCdpUrl(value)).toBe(value);
	});

	test.each([
		["not a url", "Invalid CDP URL"],
		["file:///etc/passwd", "must be http(s) or ws(s)"],
		["ftp://127.0.0.1:9222", "must be http(s) or ws(s)"],
		["http://10.0.0.5:9222", "loopback host"],
		["http://localhost:9222", "loopback host"],
		["http://127.0.0.1.evil.example:9222", "loopback host"],
		["http://127.0.0.1", "port from 1 to 65535"],
		["http://127.0.0.1:0", "port from 1 to 65535"],
		["http://127.0.0.1:65536", "Invalid CDP URL"],
	])("rejects %s with a usage error", (value, message) => {
		expect(() => parseCdpUrl(value)).toThrow(message);
		expect(() => parseCdpUrl(value)).toThrow(UsageError);
	});
});

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
