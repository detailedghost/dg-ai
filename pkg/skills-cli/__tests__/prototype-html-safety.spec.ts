import { describe, expect, test } from "bun:test";
import { injectScript } from "../src/prototype/inject";
import { parseManifestSource, render } from "../src/prototype/manifest";

describe("prototype decision bar", () => {
	const html = render(parseManifestSource("---\nname: x\n---\n::: A\nx\n:::\n"));

	test("renders a More versions button next to Approve and Reject", () => {
		expect(html).toContain('id="proto-more"');
		expect(html).toContain('aria-label="More versions"');
		expect(html.indexOf('id="proto-reject"')).toBeLessThan(
			html.indexOf('id="proto-more"'),
		);
	});

	test("posts the more action through the decision endpoint", () => {
		expect(html).toContain("window.prototypeDecide('more'");
	});

	test("keeps the viewed variant in a non-empty More note and leaves an empty note empty", () => {
		expect(html).toContain(
			"window.prototypeDecide('more', '', notes ? '[was viewing ' + current + '] ' + notes : '')",
		);
	});

	test("treats more as a processing favicon state", () => {
		expect(injectScript("x", [])).toContain("action === 'more'");
	});
});

describe("prototype page escaping", () => {
	test("embedded names and tools cannot close the inline script", () => {
		const script = injectScript("</script><img src=x>", [
			{ name: "</script><b>" },
		]);
		expect(script).not.toContain("</script><img");
		expect(script).not.toContain("</script><b>");
		expect(script).toContain("\\u003c/script>");
	});

	test("a variant key cannot break out of its attribute", () => {
		const html = render(
			parseManifestSource(
				'---\nname: x\n---\n::: a"onmouseover="alert(1)\n<p>x</p>\n:::\n',
			),
		);
		expect(html).not.toContain('data-variant="a"onmouseover');
		expect(html).toContain("data-variant=\"a&quot;onmouseover=&quot;alert(1)\"");
	});

	test.each([
		["reject_reasons: foo", /reject_reasons/],
		["data: foo", /data/],
		["labels:\n  - a", /labels/],
	])("rejects a malformed frontmatter value %p with a manifest message", (line, message) => {
		expect(() =>
			parseManifestSource(`---\nname: x\n${line}\n---\n::: A\nx\n:::\n`),
		).toThrow(message);
	});
});
