import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// BoardView.astro components can't be instantiated directly under bun:test (SSR/Astro
// compiler required); assert the wiring via the source text instead, plus the
// placeholder section files existing and being valid Astro modules.

const boardViewSource = fs.readFileSync(path.join(import.meta.dir, "BoardView.astro"), "utf8");

describe("BoardView.astro — CytoscapeSection/EvidenceSection wiring", () => {
	test("imports CytoscapeSection from ../sections/CytoscapeSection.astro", () => {
		expect(boardViewSource).toContain("import CytoscapeSection from '../sections/CytoscapeSection.astro'");
	});

	test("imports EvidenceSection from ../sections/EvidenceSection.astro", () => {
		expect(boardViewSource).toContain("import EvidenceSection from '../sections/EvidenceSection.astro'");
	});

	test("maps 'cytoscape' to CytoscapeSection in SECTION_COMPONENTS", () => {
		expect(boardViewSource).toMatch(/'cytoscape':\s*CytoscapeSection/);
	});

	test("maps 'evidence' to EvidenceSection in SECTION_COMPONENTS", () => {
		expect(boardViewSource).toMatch(/'evidence':\s*EvidenceSection/);
	});
});

describe("placeholder section files exist (later slices replace contents in place)", () => {
	test("CytoscapeSection.astro exists in src/sections/", () => {
		const p = path.join(import.meta.dir, "../sections/CytoscapeSection.astro");
		expect(fs.existsSync(p)).toBe(true);
	});

	test("EvidenceSection.astro exists in src/sections/", () => {
		const p = path.join(import.meta.dir, "../sections/EvidenceSection.astro");
		expect(fs.existsSync(p)).toBe(true);
	});
});
