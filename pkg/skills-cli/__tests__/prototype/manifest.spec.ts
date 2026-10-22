import { describe, expect, test } from "bun:test";
import { parseManifest, renderManifest } from "../../src/prototype/manifest";

describe("parseManifest", () => {
	test("minimal manifest (name + one unfenced variant) parses as implicit variant A", () => {
		const local = parseManifest(
			["---", "name: minimal-render", "---", "<p>Just render this, no fences needed.</p>"].join("\n"),
		);
		expect(local.plan.slug).toBe("minimal-render");
		expect(local.plan.variations).toEqual([
			{ key: "A", label: "A", html: "<p>Just render this, no fences needed.</p>", css: "" },
		]);
	});

	test("multi-variant manifest parses one entry per fenced block, with labels applied", () => {
		const local = parseManifest(
			[
				"---",
				"name: multi-variant",
				"labels:",
				"  A: Card grid",
				"  B: Sidebar nav",
				"---",
				"",
				"::: A",
				'<div class="cards">card grid markup</div>',
				":::",
				"",
				"::: B",
				'<div class="sidebar">sidebar markup</div>',
				":::",
			].join("\n"),
		);
		expect(local.plan.variations.map((v) => [v.key, v.label])).toEqual([
			["A", "Card grid"],
			["B", "Sidebar nav"],
		]);
	});

	test("a variant with no explicit label defaults its label to its own key", () => {
		const local = parseManifest(["---", "name: no-label", "---", "<p>content</p>"].join("\n"));
		expect(local.plan.variations[0]).toMatchObject({ key: "A", label: "A" });
	});

	test("interpolates {{key}} tokens from the data map and leaves no raw tokens behind", () => {
		const local = parseManifest(
			[
				"---",
				"name: interpolate-data",
				"data:",
				"  brand: Acme",
				"  cta: Get started",
				"---",
				"<h1>{{brand}}</h1>",
				"<button>{{cta}}</button>",
			].join("\n"),
		);
		expect(local.plan.variations[0].html).toBe("<h1>Acme</h1>\n<button>Get started</button>");
	});

	test("an unknown frontmatter key warns on stderr but does not throw", () => {
		const original = process.stderr.write.bind(process.stderr);
		let captured = "";
		process.stderr.write = ((chunk: string) => {
			captured += chunk;
			return true;
		}) as typeof process.stderr.write;
		try {
			const local = parseManifest(
				["---", "name: unknown-frontmatter", "totally_made_up_key: whatever", "---", "<p>Still renders.</p>"].join(
					"\n",
				),
			);
			expect(local.plan.variations[0].html).toBe("<p>Still renders.</p>");
		} finally {
			process.stderr.write = original;
		}
		expect(captured).toContain('ignoring unknown frontmatter key "totally_made_up_key"');
	});

	test("missing required 'name' field throws a descriptive error", () => {
		expect(() =>
			parseManifest(["---", "title: no name here", "---", "<p>content</p>"].join("\n")),
		).toThrow(/missing required frontmatter field "name"/);
	});

	test("unterminated frontmatter block (missing closing ---) throws", () => {
		expect(() =>
			parseManifest(["---", "name: unterminated-fm", "<p>content</p>"].join("\n")),
		).toThrow(/unterminated frontmatter/);
	});

	test('unterminated variant fence (missing closing ":::") throws', () => {
		expect(() =>
			parseManifest(["---", "name: unterminated-fence", "---", "::: A", "<p>never closed</p>"].join("\n")),
		).toThrow(/variant block "A" is missing its closing ":::"/);
	});

	test("manifest with frontmatter but an empty body throws (no variant content)", () => {
		expect(() => parseManifest(["---", "name: empty-body", "---", ""].join("\n"))).toThrow(
			/no variant content found/,
		);
	});

	test("quoted frontmatter values have surrounding quotes stripped", () => {
		const local = parseManifest(
			["---", "name: quoted-values", 'title: "My Quoted Title"', "---", "<p>content</p>"].join("\n"),
		);
		expect(local.title).toBe("My Quoted Title");
	});

	test("theme: dark is preserved", () => {
		const local = parseManifest(["---", "name: theme-dark", "theme: dark", "---", "<p>content</p>"].join("\n"));
		expect(local.theme).toBe("dark");
	});

	test("an invalid theme value falls back to auto", () => {
		const local = parseManifest(["---", "name: theme-invalid", "theme: neon", "---", "<p>content</p>"].join("\n"));
		expect(local.theme).toBe("auto");
	});

	test("custom reject_reasons overrides the default chip list", () => {
		const local = parseManifest(
			[
				"---",
				"name: custom-reject-reasons",
				"reject_reasons:",
				"  - Too loud",
				"  - Needs a llama",
				"---",
				"<p>content</p>",
			].join("\n"),
		);
		expect(local.rejectReasons).toEqual(["Too loud", "Needs a llama"]);
	});

	test("a bare HTML body with no frontmatter at all is rejected (name is required)", () => {
		expect(() => parseManifest("<p>no frontmatter</p>")).toThrow(/missing required frontmatter field "name"/);
	});
});

describe("renderManifest", () => {
	function render(name: string, body: string): string {
		return renderManifest(parseManifest(["---", `name: ${name}`, "---", body].join("\n")));
	}

	test("relabels Approve/Reject and wires reject to prefix notes with the viewed variant", () => {
		const html = render("bar-labels", "<p>content</p>");
		expect(html).toContain(">Approve ✓<");
		expect(html).toContain(">Reject ⟲<");
		expect(html).toContain("'[was viewing ' + current + '] ' + notes");
		expect(html).toContain("window.prototypeDecide('reject', '', ");
		expect(html).toContain("window.prototypeDecide('confirm', current, notes)");
	});

	test("document body closes with a literal </body> ahead of </html>", () => {
		const html = render("body-close", "<p>content</p>");
		const bodyIdx = html.indexOf("</body>");
		const htmlCloseIdx = html.indexOf("</html>");
		expect(bodyIdx).toBeGreaterThan(-1);
		expect(htmlCloseIdx).toBeGreaterThan(bodyIdx);
		expect(html.trim().endsWith("</html>")).toBe(true);
	});

	test("renders a data-variant section per variant and the theme attribute", () => {
		const local = parseManifest(["---", "name: theme-dark-render", "theme: dark", "---", "<p>content</p>"].join("\n"));
		const html = renderManifest(local);
		expect(html).toContain('<html lang="en" data-theme="dark">');
		expect(html).toContain('data-variant="A"');
	});

	test("an unlabeled variant renders as its bare key, not 'A — A'", () => {
		const html = render("no-label-render", "<p>content</p>");
		expect(html).toContain("var LABELS = {}");
		expect(html).not.toContain('"A":"A"');
	});

	test("a labeled variant's label reaches the client script", () => {
		const local = parseManifest(
			["---", "name: labeled-render", "labels:", "  A: Card grid", "---", "::: A", "<p>content</p>", ":::"].join(
				"\n",
			),
		);
		const html = renderManifest(local);
		expect(html).toContain('"A":"Card grid"');
	});
});
