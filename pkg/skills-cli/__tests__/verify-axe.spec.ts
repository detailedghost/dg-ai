import { describe, expect, test } from "bun:test";
import { axeSummary, mergeAxe } from "../src/verify/axe";

function page(body: string): string {
	return `<html lang="en"><head><title>T</title></head><body>${body}</body></html>`;
}

const CLEAN = `<!doctype html>
<html lang="en">
<head><title>Home</title></head>
<body>
<h1>Home</h1>
<img alt="Logo" src="/logo.png">
<button type="button">Open menu</button>
<a href="/next">Next</a>
<label for="q">Query</label>
<input id="q">
</body>
</html>`;

describe("axe summary", () => {
	test("passes every static rule on a labeled page", () => {
		const report = axeSummary(CLEAN);
		expect(report.tool).toBe("dg-axe-summary");
		expect(report.engine).toBe("local-static");
		expect(report.violations).toEqual([]);
		expect(report.passes).toEqual([
			"button-name",
			"document-title",
			"duplicate-id",
			"html-has-lang",
			"image-alt",
			"label",
			"link-name",
		]);
	});

	test("flags an empty document for title and lang", () => {
		const ids = axeSummary("").violations.map((item) => item.id);
		expect(ids).toContain("document-title");
		expect(ids).toContain("html-has-lang");
	});

	test("treats a blank title and a blank lang as failures", () => {
		const ids = axeSummary("<html lang=' '><title>  </title></html>").violations.map(
			(item) => item.id,
		);
		expect(ids).toContain("document-title");
		expect(ids).toContain("html-has-lang");
	});

	test("flags a missing alt and accepts a decorative empty alt", () => {
		expect(axeSummary(page('<img src="/a.png"><img alt="" src="/b.png">')).violations).toEqual([
			expect.objectContaining({
				id: "image-alt",
				impact: "critical",
				nodes: [{ html: '<img src="/a.png">' }],
			}),
		]);
	});

	test("ignores an image that appears only inside a script", () => {
		const report = axeSummary(`${CLEAN}<script>const tag = '<img src="/nope.png">';</script>`);
		expect(report.violations.map((item) => item.id)).not.toContain("image-alt");
	});

	test("flags a nameless button and accepts aria-label", () => {
		const report = axeSummary(
			page('<button type="button"><svg></svg></button><button aria-label="Close"></button>'),
		);
		const buttons = report.violations.filter((item) => item.id === "button-name");
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.nodes[0]?.html).toContain("<button");
	});

	test("flags a nameless link and ignores an anchor without href", () => {
		const ids = axeSummary(page('<a href="/x"></a><a name="top"></a>')).violations.map(
			(item) => item.id,
		);
		expect(ids).toEqual(["link-name"]);
	});

	test("accepts a wrapping label and a for attribute whose id has regex characters", () => {
		expect(axeSummary(page('<label>Name <input id="n"></label>')).violations.map((item) => item.id)).not.toContain(
			"label",
		);
		expect(
			axeSummary(page('<label for="a+b">Name</label><input id="a+b">')).violations.map((item) => item.id),
		).not.toContain("label");
	});

	test("flags an unlabeled field and skips hidden and submit inputs", () => {
		const report = axeSummary(
			page('<input id="q"><input type="hidden" name="tok"><input type="submit" value="Go">'),
		);
		const label = report.violations.find((item) => item.id === "label");
		expect(label?.impact).toBe("critical");
		expect(label?.nodes).toEqual([{ html: '<input id="q">' }]);
		expect(report.violations.map((item) => item.id)).toEqual(["label"]);
	});

	test("flags a repeated id and ignores an empty id", () => {
		const report = axeSummary(page('<div id="a"></div><span id="a"></span><b id=""></b>'));
		expect(report.violations).toEqual([
			expect.objectContaining({ id: "duplicate-id", impact: "minor", nodes: [{ html: 'id="a"' }] }),
		]);
	});

	test("keeps at most three nodes for one rule", () => {
		const html = page([1, 2, 3, 4].map((n) => `<img src="/${n}.png">`).join(""));
		const images = axeSummary(html).violations.find((item) => item.id === "image-alt");
		expect(images?.nodes).toHaveLength(3);
	});
});

describe("merge axe reports", () => {
	test("a failure on any shot beats a pass of the same rule", () => {
		const clean = axeSummary(CLEAN);
		const dirty = axeSummary(`${CLEAN}<input id="bare">`);
		const merged = mergeAxe([clean, dirty, clean]);
		expect(merged.violations.map((item) => item.id)).toEqual(["label"]);
		expect(merged.passes).not.toContain("label");
		expect(merged.passes).toContain("document-title");
	});

	test("sorts violations by impact and dedupes identical nodes", () => {
		const first = axeSummary('<html lang="en"><title>T</title><img src="/a.png"><div id="a"></div><div id="a"></div>');
		const second = axeSummary('<html lang="en"><title>T</title><img src="/a.png">');
		const merged = mergeAxe([first, second]);
		expect(merged.violations.map((item) => item.id)).toEqual(["image-alt", "duplicate-id"]);
		expect(merged.violations[0]?.nodes).toHaveLength(1);
	});
});
