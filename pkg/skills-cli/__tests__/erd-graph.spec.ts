import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectCodeGraph } from "../src/erd/code-graph";
import { mergeGraph } from "../src/erd/graph";
import { collectImportGraph } from "../src/erd/import-graph";
import { writeScopedFile } from "./cli-fixtures";

const fixture = join(import.meta.dir, "fixtures", "erd", "code-graph");

let scopeDir: string;

beforeEach(() => {
	scopeDir = mkdtempSync(join(tmpdir(), "erd-graph-"));
});

afterEach(() => {
	chmodSync(scopeDir, 0o700);
	rmSync(scopeDir, { recursive: true, force: true });
});

function writeFile(relPath: string, content: string): string {
	return writeScopedFile(scopeDir, relPath, content);
}

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

describe("collectImportGraph edge cases", () => {
	test("detects export...from re-exports and bare side-effect imports", () => {
		writeFile("src/a.ts", 'export { helper } from "./b";\nimport "./c";\n');
		writeFile("src/b.ts", 'export const helper = () => "ok";\n');
		writeFile("src/c.ts", "export const sideEffect = true;\n");

		const result = collectImportGraph({ scopePath: scopeDir });

		expect(result.edges).toContainEqual(
			expect.objectContaining({ from: "src/a.ts", to: "src/b.ts", kind: "import" }),
		);
		expect(result.edges).toContainEqual(
			expect.objectContaining({ from: "src/a.ts", to: "src/c.ts", kind: "import" }),
		);
	});

	test("does not create a phantom edge to a file dropped by a depth cap", () => {
		writeFile("src/a.ts", 'import { leaf } from "./deep/leaf";\nexport const used = leaf;\n');
		writeFile("src/deep/leaf.ts", 'export const leaf = "ok";\n');

		const result = collectImportGraph({ scopePath: scopeDir, depth: 1 });

		expect(result.edges.some((edge) => edge.from === "src/a.ts")).toBe(false);
	});
});

describe("directory read failures", () => {
	function writeBlockedDir(): string {
		writeFile("src/ok.ts", "export const ok = true;\n");
		const blockedDir = join(scopeDir, "src", "blocked");
		mkdirSync(blockedDir);
		writeFileSync(join(blockedDir, "secret.ts"), "export const secret = true;\n");
		chmodSync(blockedDir, 0o000);
		return blockedDir;
	}

	test("collectCodeGraph records evidence instead of throwing when a subdirectory is unreadable", () => {
		const blockedDir = writeBlockedDir();
		try {
			let result: ReturnType<typeof collectCodeGraph> | undefined;
			expect(() => {
				result = collectCodeGraph({ scopePath: scopeDir });
			}).not.toThrow();
			expect(result?.nodes.some((node) => node.id === "src/ok.ts")).toBe(true);
			expect(result?.evidence.some((e) => e.detail?.includes("could not read directory"))).toBe(true);
		} finally {
			chmodSync(blockedDir, 0o700);
		}
	});

	test("collectImportGraph records evidence instead of throwing when a subdirectory is unreadable", () => {
		const blockedDir = writeBlockedDir();
		try {
			let result: ReturnType<typeof collectImportGraph> | undefined;
			expect(() => {
				result = collectImportGraph({ scopePath: scopeDir });
			}).not.toThrow();
			expect(result?.evidence.some((e) => e.detail?.includes("could not read directory"))).toBe(true);
		} finally {
			chmodSync(blockedDir, 0o700);
		}
	});

	test("collectImportGraph records evidence instead of throwing when a file cannot be read", () => {
		writeFile("src/ok.ts", "export const ok = true;\n");
		const blockedFile = writeFile("src/blocked.ts", "export const blocked = true;\n");
		chmodSync(blockedFile, 0o000);
		try {
			let result: ReturnType<typeof collectImportGraph> | undefined;
			expect(() => {
				result = collectImportGraph({ scopePath: scopeDir });
			}).not.toThrow();
			expect(result?.evidence.some((e) => e.ref === "src/blocked.ts" && e.detail?.includes("could not read file"))).toBe(
				true,
			);
		} finally {
			chmodSync(blockedFile, 0o700);
		}
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

	test("singularizes an -ies plural table name to match its code file", () => {
		const result = mergeGraph({
			scope: "fixture",
			code: {
				nodes: [{ id: "src/Library.ts", label: "Library.ts", kind: "file" }],
				edges: [],
				evidence: [],
				truncated: { nodes: 0, edges: 0 },
			},
			db: {
				nodes: [{ id: "public.libraries", label: "libraries", schema: "public", columns: [], source: "live" }],
				edges: [],
				evidence: [],
				truncated: { nodes: 0 },
			},
		});
		expect(result.crossLinks).toHaveLength(1);
		expect(result.crossLinks[0]).toMatchObject({ codeNodeId: "src/Library.ts", dbNodeId: "public.libraries" });
	});
});
