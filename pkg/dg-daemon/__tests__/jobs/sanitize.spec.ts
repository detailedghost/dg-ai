import { describe, expect, it } from "bun:test";
import { sanitize } from "../../src/jobs/sanitize";

const char = (code: number) => String.fromCodePoint(code);

describe("sanitize", () => {
	it("leaves plain text unchanged", () => {
		expect(sanitize("bun run bot.ts - ok")).toBe("bun run bot.ts - ok");
	});

	it("shows a visible escape for a control character", () => {
		expect(sanitize(`${char(0x1b)}[2K`)).toBe("\\u{1b}[2K");
		expect(sanitize("a\nb")).toBe("a\\u{a}b");
		expect(sanitize(`${char(0x7f)}${char(0x9f)}`)).toBe("\\u{7f}\\u{9f}");
	});

	it.each([
		0x202a, 0x202e, 0x2066, 0x2069, 0x200b, 0x200f, 0xfeff, 0x2028, 0x2029,
		0x061c, 0x180e, 0x2060, 0x2064, 0xfff9, 0xfffb, 0xe0000, 0xe0041, 0xe007f,
	])("shows a visible escape for U+%i", (code) => {
		expect(sanitize(`x${char(code)}y`)).toBe(`x\\u{${code.toString(16)}}y`);
	});

	it("keeps no character of the unsafe ranges in its output", () => {
		const every = Array.from({ length: 0xa0 }, (_, i) => char(i)).join("");
		expect(sanitize(every)).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
	});
});
