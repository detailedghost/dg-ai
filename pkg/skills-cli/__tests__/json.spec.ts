import { describe, expect, test } from "bun:test";
import { emitJson, escapeJsonString } from "../src/utils/json";

// ── escapeJsonString ──────────────────────────────────────────────────────────

describe("escapeJsonString", () => {
	test("plain text passes through unchanged", () => {
		expect(escapeJsonString("hello world")).toBe("hello world");
	});

	test("backslash is doubled", () => {
		expect(escapeJsonString("a\\b")).toBe("a\\\\b");
	});

	test("double-quote is escaped", () => {
		expect(escapeJsonString('say "hi"')).toBe('say \\"hi\\"');
	});

	test("newline becomes \\n", () => {
		expect(escapeJsonString("line1\nline2")).toBe("line1\\nline2");
	});

	test("carriage return becomes \\r", () => {
		expect(escapeJsonString("a\rb")).toBe("a\\rb");
	});

	test("tab becomes \\t", () => {
		expect(escapeJsonString("a\tb")).toBe("a\\tb");
	});

	test("control characters below 0x20 become \\uXXXX", () => {
		// U+0001 (SOH)
		expect(escapeJsonString("")).toBe("\\u0001");
		// U+001F (US)
		expect(escapeJsonString("")).toBe("\\u001f");
	});

	test("empty string returns empty string", () => {
		expect(escapeJsonString("")).toBe("");
	});

	test("output is valid inside a JSON string literal", () => {
		const input = 'line1\nline2\t"quoted"\\path';
		const escaped = escapeJsonString(input);
		const parsed = JSON.parse(`"${escaped}"`);
		expect(parsed).toBe(input);
	});

	test("unicode above 0x1F passes through unchanged", () => {
		expect(escapeJsonString("café 日本語")).toBe("café 日本語");
	});
});

// ── emitJson ──────────────────────────────────────────────────────────────────

describe("emitJson", () => {
	test("writes pretty-printed JSON followed by newline to stdout", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson({ a: 1, b: [2, 3] });`,
			],
			{ env: { ...process.env } },
		);
		const out = proc.stdout.toString();
		expect(out.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(out.trim());
		expect(parsed).toEqual({ a: 1, b: [2, 3] });
	});

	test("pretty-print uses 2-space indentation", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson({ x: 1 });`,
			],
			{ env: { ...process.env } },
		);
		const out = proc.stdout.toString().trim();
		expect(out).toBe('{\n  "x": 1\n}');
	});

	test("handles null value", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson(null);`,
			],
			{ env: { ...process.env } },
		);
		expect(proc.stdout.toString().trim()).toBe("null");
	});

	test("handles array value", () => {
		const proc = Bun.spawnSync(
			[
				process.execPath,
				"--eval",
				`import { emitJson } from "${import.meta.dir}/../src/utils/json.ts"; emitJson([1,"two",true]);`,
			],
			{ env: { ...process.env } },
		);
		const parsed = JSON.parse(proc.stdout.toString().trim());
		expect(parsed).toEqual([1, "two", true]);
	});
});
