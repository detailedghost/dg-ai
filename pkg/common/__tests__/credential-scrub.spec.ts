import { describe, expect, test } from "bun:test";
import { createScrubber, scrubText } from "../src/node/credential-scrub";

const marker = "fake-marker-value-for-tests";
const forms = [
	marker,
	Buffer.from(marker).toString("base64"),
	Buffer.from(marker).toString("base64").replace(/=+$/, ""),
	Buffer.from(marker).toString("base64url"),
	Buffer.from(marker).toString("base64url").replace(/=+$/, ""),
	encodeURIComponent(marker),
	new URLSearchParams({ v: marker }).toString().slice(2),
];

describe("scrubber", () => {
	test("replaces every form and skips forms under four characters", () => {
		const text = forms.join(" | ");
		expect(scrubText(text, [marker]).replaceAll("[redacted]", "")).toBe(" |  |  |  |  |  | ");
		expect(scrubText("abc abc", ["abc"])).toBe("abc abc");
	});

	test("replaces lowercase-hex percent forms", () => {
		const value = "a b/c+d=e:f-test";
		const encoded = encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (h) => h.toLowerCase());
		expect(scrubText(`x ${encoded} y`, [value])).toBe("x [redacted] y");
	});

	test("catches a value split at every chunk boundary", () => {
		const text = `before ${marker} after`;
		for (let cut = 1; cut < text.length; cut++) {
			const scrubber = createScrubber([marker]);
			const joined = scrubber.push(text.slice(0, cut)) + scrubber.push(text.slice(cut)) + scrubber.flush();
			expect(joined).toBe("before [redacted] after");
		}
	});
});

describe("overlapping values", () => {
	const values = ["fake-alpha-over", "over-bravo-tail"];
	const text = "x fake-alpha-over-bravo-tail y";

	test("redacts the union of overlapping values in one pass", () => {
		expect(scrubText(text, values)).toBe("x [redacted] y");
	});

	test("redacts the union of overlapping values split at every chunk boundary", () => {
		for (let cut = 1; cut < text.length; cut++) {
			const scrubber = createScrubber(values);
			const joined = scrubber.push(text.slice(0, cut)) + scrubber.push(text.slice(cut)) + scrubber.flush();
			expect(joined).toBe("x [redacted] y");
		}
	});

	test("redacts the union when each character arrives alone", () => {
		const scrubber = createScrubber(values);
		const joined = [...text].map((char) => scrubber.push(char)).join("") + scrubber.flush();
		expect(joined).toBe("x [redacted] y");
	});
});

describe("scrubber hold-back", () => {
	test("emits a prompt at once when no tail could start a secret", () => {
		const scrubber = createScrubber(["fake-marker-value-for-tests"]);
		expect(scrubber.push("Continue? [y/N]: ")).toBe("Continue? [y/N]: ");
	});

	test("holds only a tail that could start a secret, and still masks the split value", () => {
		const scrubber = createScrubber(["fake-marker-value-for-tests"]);
		expect(scrubber.push("token: fake-mar")).toBe("token: ");
		expect(scrubber.push("ker-value-for-tests done") + scrubber.flush()).toBe("[redacted] done");
	});
});

describe("JSON-escaped forms", () => {
	test("scrubs a value with quotes, backslashes and a newline inside JSON output", () => {
		const value = 'fake"quote\\slash\nline-value';
		const text = JSON.stringify({ data: value });
		expect(scrubText(text, [value])).toBe('{"data":"[redacted]"}');
	});
});
