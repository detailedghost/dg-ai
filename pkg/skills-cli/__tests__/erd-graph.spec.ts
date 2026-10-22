import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { collectCodeGraph } from "../src/erd/code-graph";
import { mergeGraph } from "../src/erd/graph";
import { collectImportGraph } from "../src/erd/import-graph";

const fixture = join(import.meta.dir, "fixtures", "erd", "code-graph");

describe("code and import collectors", () => {
	test("prunes ignored and secret paths while retaining ordinary files", () => {
		const result = collectCodeGraph({ scopePath: fixture });
		expect(result.nodes.some((node) => node.id === "src/index.ts")).toBe(true);
		expect(result.nodes.some((node) => node.id.includes("node_modules"))).toBe(false);
		expect(result.nodes.some((node) => node.id.endsWith(".env"))).toBe(false);
	});

	test("resolves relative TypeScript and Python imports without dangling external edges", () => {
		const result = collectImportGraph({ scopePath: fixture });
		expect(result.edges).toContainEqual(
			expect.objectContaining({ from: "src/index.ts", to: "src/utils.ts", kind: "import" }),
		);
		expect(result.edges).toContainEqual(
			expect.objectContaining({ from: "src/app.py", to: "src/helpers.py", kind: "import" }),
		);
		expect(result.edges.some((edge) => edge.to.includes("node:path"))).toBe(false);
	});
});

describe("mergeGraph", () => {
	test("cross-links exact singularized file and table names without substring matches", () => {
		const result = mergeGraph({
			scope: "fixture",
			code: {
				nodes: [
					{ id: "src/User.ts", label: "User.ts", kind: "file" },
					{ id: "src/UserFactory.ts", label: "UserFactory.ts", kind: "file" },
				],
				edges: [],
				evidence: [],
				truncated: { nodes: 0, edges: 0 },
			},
			db: {
				nodes: [{ id: "public.users", label: "users", schema: "public", columns: [], source: "live" }],
				edges: [],
				evidence: [],
				truncated: { nodes: 0 },
			},
		});
		expect(result.crossLinks).toHaveLength(1);
		expect(result.crossLinks[0]).toMatchObject({ codeNodeId: "src/User.ts", dbNodeId: "public.users" });
	});
});
