import { describe, expect, it } from "bun:test";
import type { LineageEdge } from "../types";
import { registry } from "./registry";

// helpers — build minimal payloads without repeating shape details
function withLineage(extra: Record<string, unknown> = {}) {
	return { lineage: { nodes: [], edges: [] }, ...extra };
}

function withoutLineage(fields: Record<string, unknown> = {}) {
	return { ...fields };
}

const lineageEntry = () => registry.find((s) => s.id === "lineage");

describe("registry — lineage entry", () => {
	it("contains an entry with id 'lineage'", () => {
		expect(lineageEntry()).toBeDefined();
	});

	it("has a non-empty label", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		expect(entry!.label.length).toBeGreaterThan(0);
	});

	it("has a non-empty icon", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		expect(entry!.icon.length).toBeGreaterThan(0);
	});
});

describe("registry — lineage applies()", () => {
	it("returns true when payload has lineage with empty nodes/edges", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies(withLineage())).toBe(true);
	});

	it("returns true when payload has lineage with populated nodes", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		const p = withLineage({ lineage: { nodes: [{ id: "a" }], edges: [] } });
		expect(entry!.applies(p)).toBe(true);
	});

	it("returns false when payload has no lineage field", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies(withoutLineage())).toBe(false);
	});

	it("returns false for a plan-shaped payload without lineage (no-regress guard)", () => {
		// existing plan/spec boards have scope + phases but no lineage
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		const planPayload = withoutLineage({
			scope: "build the thing",
			phases: [{ id: "p1", label: "Research", status: "done" }],
		});
		expect(entry!.applies(planPayload)).toBe(false);
	});

	it("returns false for a spec-shaped payload with slices but no lineage (no-regress guard)", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		const specPayload = withoutLineage({
			scope: "spec scope",
			slices: [{ id: 1, label: "Slice 1", status: "pending" }],
			decisions: [{ question: "q", answer: "a" }],
		});
		expect(entry!.applies(specPayload)).toBe(false);
	});

	it("returns false when lineage field is explicitly undefined", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		// undefined property is falsy — applies must not gate on presence alone
		const p: Record<string, unknown> = { lineage: undefined };
		expect(entry!.applies(p)).toBe(false);
	});

	it("returns false when lineage field is explicitly null", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		// null is a distinct falsy shape from undefined; Boolean(null) === false
		const p: Record<string, unknown> = { lineage: null };
		expect(entry!.applies(p)).toBe(false);
	});

	it("returns true when lineage.edges is absent (only nodes present)", () => {
		// SSR guards with `lineage.edges ?? []`; registry gate must not require edges
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ lineage: { nodes: [{ id: "x" }] } })).toBe(true);
	});
});

describe("registry — ordering: lineage appears after scope and before phases", () => {
	it("lineage index is greater than scope index", () => {
		const scopeIdx = registry.findIndex((s) => s.id === "scope");
		const lineageIdx = registry.findIndex((s) => s.id === "lineage");
		// both must exist; lineage headline comes after scope
		expect(scopeIdx).toBeGreaterThanOrEqual(0);
		expect(lineageIdx).toBeGreaterThan(scopeIdx);
	});

	it("lineage index is less than phases index", () => {
		const lineageIdx = registry.findIndex((s) => s.id === "lineage");
		const phasesIdx = registry.findIndex((s) => s.id === "phases");
		expect(phasesIdx).toBeGreaterThanOrEqual(0);
		expect(lineageIdx).toBeLessThan(phasesIdx);
	});
});

describe("registry — existing entries unaffected (no-regress)", () => {
	const existingIds = [
		"links",
		"scope",
		"phases",
		"tracks",
		"slices",
		"contracts",
		"discoveries",
		"risks",
		"blockers",
		"errors",
		"roundtable",
		"decisions",
		"checklist",
		"open-questions",
		"resolved-questions",
		"code-samples",
		"permissions",
		"approval",
		"next-steps",
	];

	for (const id of existingIds) {
		it(`still contains '${id}' entry`, () => {
			expect(registry.some((s) => s.id === id)).toBe(true);
		});
	}

	it("scope applies({scope:'x'}) is still true", () => {
		const entry = registry.find((s) => s.id === "scope");
		expect(entry).toBeDefined();
		expect(entry!.applies({ scope: "x" })).toBe(true);
	});

	it("phases applies({phases:[{id:'p1'}]}) is still true", () => {
		const entry = registry.find((s) => s.id === "phases");
		expect(entry).toBeDefined();
		expect(entry!.applies({ phases: [{ id: "p1" }] })).toBe(true);
	});
});

describe("registry — next steps ordering", () => {
	it("renders next steps last", () => {
		expect(registry.at(-1)?.id).toBe("next-steps");
	});
});

describe("registry — lineage applies() gating: primitive-truthy lineage values", () => {
	it("returns false when lineage is a number (truthy primitive)", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		// Boolean(42) is true, but 42 is not a lineage object — board would render a blank canvas
		expect(entry!.applies({ lineage: 42 })).toBe(false);
	});

	it("returns true when lineage is a proper object with nodes and edges arrays", () => {
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ lineage: { nodes: [], edges: [] } })).toBe(true);
	});
});

describe("registry — lineage applies() gating: non-lineage payload shapes", () => {
	it("returns false for a recap-shaped payload (summary + actions, no lineage)", () => {
		// recap boards have summary/actions but no lineage key
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		const recapPayload: Record<string, unknown> = {
			summary: "Sprint 3 complete",
			actions: [{ id: "a1", label: "Deploy", status: "done" }],
		};
		expect(entry!.applies(recapPayload)).toBe(false);
	});

	it("returns false for a roundtable-only payload (roundtable without lineage)", () => {
		// roundtable boards carry agents/recommendations but no lineage
		const entry = lineageEntry();
		expect(entry).toBeDefined();
		const roundtablePayload: Record<string, unknown> = {
			roundtable: [
				{
					name: "arch",
					recommendations: [{ text: "use dbt", flavor: "edit" }],
				},
			],
		};
		expect(entry!.applies(roundtablePayload)).toBe(false);
	});
});

const cytoscapeEntry = () => registry.find((s) => s.id === "cytoscape");
const evidenceEntry = () => registry.find((s) => s.id === "evidence");

describe("registry — cytoscape entry", () => {
	it("contains an entry with id 'cytoscape'", () => {
		expect(cytoscapeEntry()).toBeDefined();
	});

	it("has label 'Diagram' and icon 'squares-2x2' (distinct from lineage's chart-bar)", () => {
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.label).toBe("Diagram");
		expect(entry!.icon).toBe("squares-2x2");
	});

	it("is positioned adjacently after lineage", () => {
		const lineageIdx = registry.findIndex((s) => s.id === "lineage");
		const cytoscapeIdx = registry.findIndex((s) => s.id === "cytoscape");
		expect(lineageIdx).toBeGreaterThanOrEqual(0);
		expect(cytoscapeIdx).toBe(lineageIdx + 1);
	});
});

describe("registry — cytoscape applies()", () => {
	it("returns true when payload.graph is a non-null object", () => {
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ graph: { codeNodes: [] } })).toBe(true);
	});

	it("returns false when payload.graph is undefined", () => {
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({})).toBe(false);
	});

	it("returns false when payload.graph is null", () => {
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ graph: null })).toBe(false);
	});

	it("returns false when payload.graph is a string", () => {
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ graph: "not-a-graph" })).toBe(false);
	});

	it("returns false when payload.graph is a number", () => {
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ graph: 42 })).toBe(false);
	});

	it("returns true when payload.graph is an array (typeof [] === 'object')", () => {
		// documents the object-presence check's actual boundary: arrays pass typeof/null test
		const entry = cytoscapeEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ graph: [] })).toBe(true);
	});
});

describe("registry — evidence entry", () => {
	it("contains an entry with id 'evidence' positioned adjacently after cytoscape", () => {
		const cytoscapeIdx = registry.findIndex((s) => s.id === "cytoscape");
		const evidenceIdx = registry.findIndex((s) => s.id === "evidence");
		expect(cytoscapeIdx).toBeGreaterThanOrEqual(0);
		expect(evidenceIdx).toBe(cytoscapeIdx + 1);
	});

	it("has a non-empty label and icon", () => {
		const entry = evidenceEntry();
		expect(entry).toBeDefined();
		expect(entry!.label.length).toBeGreaterThan(0);
		expect(entry!.icon.length).toBeGreaterThan(0);
	});
});

describe("registry — evidence applies() (uses has() helper, not bare Array.isArray)", () => {
	it("returns true when payload.evidence is a non-empty array", () => {
		const entry = evidenceEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ evidence: [{ type: "file", ref: "a.ts" }] })).toBe(
			true,
		);
	});

	it("returns false when payload.evidence is an empty array", () => {
		// has() treats empty arrays as absent — a bare Array.isArray check would wrongly return true here
		const entry = evidenceEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ evidence: [] })).toBe(false);
	});

	it("returns false when payload.evidence is absent", () => {
		const entry = evidenceEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({})).toBe(false);
	});

	it("returns false when payload.evidence is explicitly null", () => {
		const entry = evidenceEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ evidence: null })).toBe(false);
	});

	it("returns true when payload.evidence is a truthy non-array (has() only special-cases arrays)", () => {
		// has()'s ternary only branches on Array.isArray — a non-array object falls to Boolean(value)
		const entry = evidenceEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ evidence: { type: "file", ref: "a.ts" } })).toBe(
			true,
		);
	});
});

const docEntry = () => registry.find((s) => s.id === "doc");

describe("registry — doc entry", () => {
	it("contains an entry with id 'doc'", () => {
		expect(docEntry()).toBeDefined();
	});

	it("has label 'Document' and icon 'document-text'", () => {
		const entry = docEntry();
		expect(entry).toBeDefined();
		expect(entry!.label).toBe("Document");
		expect(entry!.icon).toBe("document-text");
	});

	it("returns true when payload.doc is a non-empty array of blocks", () => {
		const entry = docEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ doc: [{ type: "prose", text: "hi" }] })).toBe(true);
	});

	it("returns false when payload.doc is an empty array", () => {
		const entry = docEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ doc: [] })).toBe(false);
	});

	it("returns false when payload.doc is absent", () => {
		const entry = docEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({})).toBe(false);
	});

	it("returns false when payload.doc is null", () => {
		const entry = docEntry();
		expect(entry).toBeDefined();
		expect(entry!.applies({ doc: null })).toBe(false);
	});

	it("is positioned after review and before scope", () => {
		const reviewIdx = registry.findIndex((s) => s.id === "review");
		const docIdx = registry.findIndex((s) => s.id === "doc");
		const scopeIdx = registry.findIndex((s) => s.id === "scope");
		expect(reviewIdx).toBeGreaterThanOrEqual(0);
		expect(docIdx).toBeGreaterThan(reviewIdx);
		expect(docIdx).toBeLessThan(scopeIdx);
	});

	it("does not fire for a plan-shaped payload without doc (no-regress guard)", () => {
		const entry = docEntry();
		expect(entry).toBeDefined();
		expect(
			entry!.applies({
				scope: "x",
				phases: [{ id: "p1", label: "R", status: "done" }],
			}),
		).toBe(false);
	});
});

describe("LineageEdge type contract — required fields", () => {
	it("accepts a minimal valid edge with source and confidence", () => {
		// satisfies is a compile sentinel — tsc/astro check catches shape regressions
		const edge = {
			from: "node_a",
			to: "node_b",
			source: "dbt_manifest",
			confidence: "proven",
		} satisfies LineageEdge;
		expect(edge.from).toBe("node_a");
		expect(edge.to).toBe("node_b");
		expect(edge.source).toBe("dbt_manifest");
		expect(edge.confidence).toBe("proven");
	});

	it("edge with confidence 'inferred' is also valid", () => {
		// 'inferred' must remain an accepted literal for confidence
		const edge = {
			from: "raw_s3",
			to: "stg_model",
			source: "sql_parse",
			confidence: "inferred",
		} satisfies LineageEdge;
		expect(edge.confidence).toBe("inferred");
		expect(edge.from).toBe("raw_s3");
	});

	it("edge carries optional kind field when present", () => {
		// kind:'back' must remain accepted (not required) on LineageEdge
		const edge = {
			from: "a",
			to: "b",
			source: "manual",
			confidence: "proven",
			kind: "back",
		} satisfies LineageEdge;
		expect(edge.kind).toBe("back");
		expect(edge.confidence).toBe("proven");
	});
});
