import { describe, expect, test } from "bun:test";
import type { ArchitectureGraph, ErdPayload, EvidenceRecord, EvidenceType, MermaidPayload } from "./types";

// ── EvidenceType / EvidenceRecord / MermaidPayload / ArchitectureGraph / ErdPayload ──
// These types do not exist yet on types.ts — this file is RED until the slice adds them.

describe("EvidenceRecord", () => {
	test("accepts the four documented EvidenceType literals plus an arbitrary string (string fallback)", () => {
		const literalTypes: EvidenceType[] = ["db-table", "db-column", "file", "import"];
		for (const type of literalTypes) {
			const record = { type, ref: "some.ref" } satisfies EvidenceRecord;
			expect(record.type).toBe(type);
		}
		// EvidenceType's union includes `| string`, so an arbitrary literal must also satisfy it
		const custom: EvidenceRecord = { type: "custom-source", ref: "x" };
		expect(custom.type).toBe("custom-source");
	});

	test("detail is optional", () => {
		const record = { type: "file", ref: "src/foo.ts" } satisfies EvidenceRecord;
		expect(record.detail).toBeUndefined();
	});
});

describe("MermaidPayload", () => {
	test("requires diagram, allows optional title/caption", () => {
		const minimal = { diagram: "graph LR\n a --> b" } satisfies MermaidPayload;
		expect(minimal.title).toBeUndefined();
		expect(minimal.caption).toBeUndefined();

		const full = {
			diagram: "graph LR\n a --> b",
			title: "Import graph",
			caption: "generated",
		} satisfies MermaidPayload;
		expect(full.title).toBe("Import graph");
	});
});

describe("ArchitectureGraph (viz-side mirror)", () => {
	test("accepts the full erd-graph.ts shape via its index signature", () => {
		const graph: ArchitectureGraph = {
			scope: "src/",
			codeNodes: [],
			codeEdges: [],
			dbNodes: [],
			dbEdges: [],
			crossLinks: [],
			evidence: [],
			truncated: { codeNodes: 0, codeEdges: 0, dbNodes: 0 },
			generatedAt: new Date().toISOString(),
		};
		expect(graph.scope).toBe("src/");
	});

	test("accepts an empty object — no field is required, purely an index signature", () => {
		const graph: ArchitectureGraph = {};
		expect(Object.keys(graph)).toHaveLength(0);
	});
});

describe("ErdPayload", () => {
	test("all fields optional; extra keys allowed via index signature", () => {
		const empty = {} satisfies ErdPayload;
		expect(empty.graph).toBeUndefined();

		const full: ErdPayload = {
			graph: {} as ArchitectureGraph,
			evidence: [{ type: "file", ref: "a.ts" }],
			scope: "src/",
			generatedAt: new Date().toISOString(),
			extraField: "allowed by index signature",
		};
		expect(full.extraField).toBe("allowed by index signature");
	});
});
