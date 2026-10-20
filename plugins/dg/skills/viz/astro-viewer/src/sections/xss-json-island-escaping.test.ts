import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * M8: static-source guard for the XSS fix shipped in ReviewSection.astro/
 * LineageSection.astro (audit: `AUDIT-unauthorized-edits.md`, xss-unlabeled-
 * reviewsection-script-escape). Both sections serialize untrusted payload
 * content into a `<script type="application/json" set:html={...}>` island;
 * without escaping "<" a diff/comment/description containing "</script>"
 * would prematurely terminate the block. There's no Astro-component render
 * harness in this bun:test suite, so this asserts against the source text
 * directly — cheap, and it fails loudly the moment either file's escape is
 * dropped or a new JSON-island site is added without one.
 */

const SECTIONS_DIR = join(import.meta.dir, ".");
const ESCAPE_PATTERN = /\.replace\(\/</;

function readSection(name: string): string {
	return readFileSync(join(SECTIONS_DIR, name), "utf-8");
}

describe("JSON-island script escaping (XSS guard)", () => {
	it("ReviewSection.astro escapes '<' before embedding reviewData via set:html", () => {
		const src = readSection("ReviewSection.astro");
		const varMatch = src.match(/set:html=\{(\w+)\}/);
		expect(varMatch).not.toBeNull();
		const varName = varMatch![1];
		const assignMatch = src.match(new RegExp(`const ${varName} = ([^\\n]+)`));
		expect(assignMatch).not.toBeNull();
		expect(ESCAPE_PATTERN.test(assignMatch![1])).toBe(true);
	});

	it("LineageSection.astro escapes '<' before embedding graphData via set:html", () => {
		const src = readSection("LineageSection.astro");
		const varMatch = src.match(/set:html=\{(\w+)\}/);
		expect(varMatch).not.toBeNull();
		const varName = varMatch![1];
		const assignMatch = src.match(new RegExp(`const ${varName} = ([^\\n]+)`));
		expect(assignMatch).not.toBeNull();
		expect(ESCAPE_PATTERN.test(assignMatch![1])).toBe(true);
	});

	it("no other non-prototype section introduces an unescaped JSON-island set:html site (no-regress)", () => {
		const files = readdirSync(SECTIONS_DIR).filter((f) => f.endsWith(".astro"));
		for (const file of files) {
			const src = readSection(file);
			if (!/type=['"]application\/json['"][^>]*set:html/.test(src)) continue;
			const varMatch = src.match(/set:html=\{(\w+)\}/);
			expect(varMatch, `${file}: expected a set:html={var} binding`).not.toBeNull();
			const varName = varMatch![1];
			const assignMatch = src.match(new RegExp(`const ${varName} = ([^\\n]+)`));
			expect(assignMatch, `${file}: expected a 'const ${varName} = ...' assignment`).not.toBeNull();
			expect(
				ESCAPE_PATTERN.test(assignMatch![1]),
				`${file}: JSON-island data must escape '<' before set:html (matches ReviewSection.astro/LineageSection.astro)`,
			).toBe(true);
		}
	});
});
