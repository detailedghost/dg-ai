import { describe, expect, test } from "bun:test";
import { injectScript } from "../src/prototype/inject";
import { parseManifestSource, render } from "../src/prototype/manifest";

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
