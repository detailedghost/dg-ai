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

	test("shows More success only after the decision request succeeds", () => {
		const handler = html.slice(html.indexOf("getElementById('proto-more')"));
		expect(handler.indexOf(".then(function(ok)")).toBeLessThan(
			handler.indexOf("decided('more')"),
		);
		expect(injectScript("x", [])).toContain("return !!d.ok;");
		expect(injectScript("x", [])).toContain("catch(function(){ return false; })");
	});

	test("disables the decision buttons while a More request is pending and restores them on failure", () => {
		const handler = html.slice(html.indexOf("getElementById('proto-more')"));
		expect(handler.indexOf("setBusy(true)")).toBeLessThan(
			handler.indexOf("prototypeDecide('more'"),
		);
		expect(handler).toContain("setBusy(false); toast('Could not reach");
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

describe("prototype viewer width", () => {
	const html = render(parseManifestSource("---\nname: x\n---\n::: A\nx\n:::\n"));

	test("passes the page straight through by default with no padding", () => {
		expect(html).not.toMatch(/\nsection\[data-variant\]\{[^}]*max-width/);
		expect(html).toMatch(/\n#proto-root\{min-height:100vh;\}/);
		expect(html).not.toMatch(/#proto-root[^{]*\{[^}]*padding/);
	});

	test("labels the default width Responsive", () => {
		expect(html).toMatch(/data-w="all" aria-checked="true"><span data-icon="all"><\/span>Responsive</);
		expect(html).not.toContain("All widths");
	});

	test("offers a framed option that restores the 960px frame", () => {
		expect(html).toContain('data-w="framed"');
		expect(html).toMatch(
			/#proto-root\[data-width="framed"\] section\[data-variant\]\{[^}]*max-width:960px/,
		);
	});

	test("keeps the mobile and tablet widths", () => {
		expect(html).toMatch(
			/#proto-root\[data-width="mobile"\] section\[data-variant\]\{max-width:390px;\}/,
		);
		expect(html).toMatch(
			/#proto-root\[data-width="tablet"\] section\[data-variant\]\{max-width:768px;\}/,
		);
	});

	test("fixed widths only narrow the variant", () => {
		expect(html).toMatch(
			/#proto-root\[data-width="desktop"\] section\[data-variant\]\{max-width:1440px;\}/,
		);
		expect(html).toMatch(/\nsection\[data-variant\]\{display:none;margin:0 auto;\}/);
	});
});
