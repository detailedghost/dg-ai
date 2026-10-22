import { describe, expect, test } from "bun:test";
import { capText, redactExtOutput, redactPasswordFields } from "../../../src/pw/ext/redact";

describe("redactPasswordFields", () => {
	test("masks an accessibility-snapshot-shaped password field value", () => {
		const text = '- textbox "Password" [value="super-secret-123"] [ref=e5]';
		expect(redactPasswordFields(text)).toBe('- textbox "Password" [value="[redacted]"] [ref=e5]');
	});

	test("leaves unrelated fields untouched", () => {
		const text = '- textbox "Username" [value="alice"] [ref=e4]';
		expect(redactPasswordFields(text)).toBe(text);
	});
});

describe("capText", () => {
	test("leaves short text alone", () => {
		expect(capText("hello", 100)).toBe("hello");
	});

	test("truncates text over the byte cap and adds a notice", () => {
		const text = "x".repeat(50);
		const capped = capText(text, 10);
		expect(capped.startsWith("x".repeat(10))).toBe(true);
		expect(capped).toContain("[truncated]");
		expect(Buffer.byteLength(capped, "utf8")).toBeLessThan(Buffer.byteLength(text, "utf8"));
	});
});

describe("redactExtOutput", () => {
	test("masks a password field and a token-like bearer value, then caps size", () => {
		const text = [
			'- textbox "Password" [value="hunter2hunter2"] [ref=e5]',
			"Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
		].join("\n");
		const redacted = redactExtOutput(text);
		expect(redacted).not.toContain("hunter2hunter2");
		expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(redacted).toContain("[redacted]");
	});

	test("passes through ordinary text unchanged", () => {
		expect(redactExtOutput("Welcome back")).toBe("Welcome back");
	});
});
