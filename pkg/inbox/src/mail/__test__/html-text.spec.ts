import { describe, expect, test } from "bun:test";
import { htmlToText } from "../html-text";

describe("htmlToText", () => {
	test("converts closing paragraph tags and line breaks to newlines", () => {
		const html = "<p>First line.</p><p>Second line.<br>Still second.</p>";
		expect(htmlToText(html)).toBe("First line.\nSecond line.\nStill second.");
	});

	test("handles nested lists without leaking tags", () => {
		const html =
			"<ul><li>Fruit<ul><li>Apple</li><li>Banana</li></ul></li><li>Done</li></ul>";
		const text = htmlToText(html);
		expect(text).not.toContain("<");
		expect(text).not.toContain(">");
		expect(text).toContain("- Fruit");
		expect(text).toContain("- Apple");
		expect(text).toContain("- Banana");
		expect(text).toContain("- Done");
	});

	test("decodes named and numeric entities, including &nbsp;", () => {
		const html = "<p>Ben&nbsp;&amp;&nbsp;Jerry&#39;s &lt;3 &quot;ice cream&quot;</p>";
		expect(htmlToText(html)).toBe('Ben & Jerry\'s <3 "ice cream"');
	});

	test("drops head, style, and script content without leaking CSS or JS", () => {
		const html =
			"<html><head><style>body { color: red; }</style></head><body><script>trackClick();</script><p>Visible text.</p></body></html>";
		const text = htmlToText(html);
		expect(text).toBe("Visible text.");
		expect(text).not.toContain("color");
		expect(text).not.toContain("trackClick");
	});

	test("collapses runs of spaces and caps blank lines at one", () => {
		const html = "<p>Too    many     spaces.</p><br><br><br><p>After gap.</p>";
		expect(htmlToText(html)).toBe("Too many spaces.\n\nAfter gap.");
	});
});
