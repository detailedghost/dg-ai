import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DOC = join(import.meta.dir, "payload-schema.md");

function readDoc(): string {
	return readFileSync(SCHEMA_DOC, "utf-8");
}

describe("payload-schema.md — erd graph/evidence documentation", () => {
	it("gains a section documenting the graph field's ArchitectureGraph shape", () => {
		const doc = readDoc();
		expect(doc).toMatch(/^##\s+(erd|graph)\b/m);
	});

	it("gains a section documenting the evidence field (EvidenceRecord[])", () => {
		const doc = readDoc();
		expect(doc).toMatch(/^##\s+(erd|evidence)\b/m);
	});

	it("documents the same field-doc granularity as the existing '## lineage' section (has a fenced json/jsonc example)", () => {
		const doc = readDoc();
		const lineageIdx = doc.search(/^##\s+lineage\b/m);
		expect(lineageIdx, "expected an existing '## lineage' section to anchor against").toBeGreaterThan(-1);
		const erdIdx = doc.search(/^##\s+(erd|graph|evidence)\b/m);
		expect(erdIdx, "expected a new erd/graph/evidence section").toBeGreaterThan(-1);
		const erdSectionEnd = doc.indexOf("\n## ", erdIdx + 1);
		const erdSection = doc.slice(erdIdx, erdSectionEnd === -1 ? undefined : erdSectionEnd);
		expect(erdSection).toMatch(/```json/);
	});
});
