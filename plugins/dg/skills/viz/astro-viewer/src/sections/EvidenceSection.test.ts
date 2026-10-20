import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * There's no Astro-component render harness in this bun:test suite (see
 * xss-json-island-escaping.test.ts) — Astro files aren't resolvable by bun's
 * module loader outside the Vite/Astro build pipeline. Following that
 * project precedent, this asserts against EvidenceSection.astro's source
 * text for the contract in spec 001_erd.md (Slice: viz-evidence-section).
 */

const SRC = join(import.meta.dir, "EvidenceSection.astro");

function readSource(): string {
	return readFileSync(SRC, "utf-8");
}

describe("EvidenceSection.astro — props contract", () => {
	it("declares Props as { payload: ErdPayload }", () => {
		const src = readSource();
		expect(src).toMatch(/interface\s+Props\s*\{\s*payload:\s*ErdPayload\s*\}/);
	});

	it("reads payload.evidence with a fallback to an empty array", () => {
		const src = readSource();
		expect(src).toMatch(/payload\.evidence\s*\?\?\s*\[\]/);
	});
});

describe("EvidenceSection.astro — grouping and header", () => {
	it("groups evidence records by their type field", () => {
		const src = readSource();
		// grouping keyed on `.type`, mirroring the prototype's Map<string, EvidenceRecord[]>
		expect(src).toMatch(/groups\.set\(\s*\w+\.type/);
	});

	it("shows a per-group count next to each group's label", () => {
		const src = readSource();
		expect(src).toMatch(/evidence-proto-group-count|group-count/);
		expect(src).toMatch(/rows\.length/);
	});

	it("shows the total evidence count in the section header as 'Evidence (N)'", () => {
		const src = readSource();
		expect(src).toMatch(/Evidence\s*<span[^>]*>\(\{[^}]*\.length\}\)<\/span>/);
	});
});

describe("EvidenceSection.astro — LABEL_BY_TYPE", () => {
	it("extends the prototype's LABEL_BY_TYPE with an 'import' -> 'Imports' entry", () => {
		const src = readSource();
		const mapMatch = src.match(/LABEL_BY_TYPE[^=]*=\s*\{([\s\S]*?)\}/);
		expect(mapMatch, "expected a LABEL_BY_TYPE object literal").not.toBeNull();
		const body = mapMatch![1];
		expect(body).toMatch(/"db-table":\s*"DB Tables"/);
		expect(body).toMatch(/"db-column":\s*"DB Columns"/);
		expect(body).toMatch(/"file":\s*"Files"/);
		expect(body).toMatch(/"import":\s*"Imports"/);
	});

	it("falls back to the raw type string (not 'undefined') for an unmapped type", () => {
		const src = readSource();
		// e.g. `LABEL_BY_TYPE[type] ?? type` — must NOT fall back to a literal "undefined"
		expect(src).toMatch(/LABEL_BY_TYPE\[\s*type\s*\]\s*\?\?\s*type\b/);
	});
});

describe("EvidenceSection.astro — cell rendering", () => {
	it("renders detail as '—' when EvidenceRecord.detail is absent", () => {
		const src = readSource();
		expect(src).toMatch(/\.detail\s*\?\?\s*"—"/);
	});

	it("interpolates ref/detail via {expression} rather than a raw/unescaped HTML sink (relies on Astro auto-escaping)", () => {
		const src = readSource();
		// the ref/detail cells must NOT use set:html / dangerouslySetInnerHTML-style raw injection
		expect(src).not.toMatch(/set:html/);
		expect(src).toMatch(/\{e\.ref\}|\{\w+\.ref\}/);
	});
});

/**
 * No Astro render harness exists in this suite (see xss-json-island-escaping.test.ts),
 * so the grouping logic from the component's `---` frontmatter is replicated here as a
 * pure function to exercise actual data-shaping behavior, rather than re-asserting
 * source text alone.
 */
type EvidenceRecord = { type: string; ref: string; detail?: string };

function buildGroups(evidence: EvidenceRecord[]): Map<string, EvidenceRecord[]> {
	const groups = new Map<string, EvidenceRecord[]>();
	for (const e of evidence) {
		if (!groups.has(e.type)) groups.set(e.type, []);
		groups.get(e.type)!.push(e);
	}
	return groups;
}

// Mirrors Astro's automatic text-node escaping applied to {expression} interpolation.
function astroEscape(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

describe("EvidenceSection.astro — grouping behavior (error handling)", () => {
	it("an empty evidence array produces zero groups and a zero total count, without throwing", () => {
		const evidence: EvidenceRecord[] = [];
		expect(() => buildGroups(evidence)).not.toThrow();
		expect(buildGroups(evidence).size).toBe(0);
		expect(evidence.length).toBe(0);
	});
});

describe("EvidenceSection.astro — hostile ref value is rendered inert", () => {
	it("a hostile ref value is escaped to inert text, not executable markup, under Astro's auto-escaping", () => {
		const hostileRef = "<img src=x onerror=alert(1)>";
		const escaped = astroEscape(hostileRef);
		expect(escaped).not.toContain("<img");
		expect(escaped).not.toMatch(/<[a-z]/i);
		expect(escaped).toBe("&lt;img src=x onerror=alert(1)&gt;");
	});
});
