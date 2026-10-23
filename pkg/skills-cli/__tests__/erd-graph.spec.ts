import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	function writeBlockedDirFixture(): string {
		writeFile("src/ok.ts", "export const ok = true;\n");
		const blockedDir = join(scopeDir, "src", "blocked");
		mkdirSync(blockedDir);
		writeFileSync(join(blockedDir, "secret.ts"), "export const secret = true;\n");
		return blockedDir;
	}

	function mockReaddirThrowsFor(blockedDir: string): string {
		return `const originalReaddirSync = fs.readdirSync;
mock.module("node:fs", () => ({ ...fs, readdirSync(path, options) {
	if (String(path) === ${JSON.stringify(blockedDir)}) throw new Error("EACCES: permission denied, scandir '" + path + "'");
	return originalReaddirSync(path, options);
} }));`;
	}

	async function runInMockedFsProcess(
		mockBody: string,
		scriptBody: string,
	): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const script = `
import { mock } from "bun:test";
import * as fs from "node:fs";
${mockBody}
${scriptBody}
`;
		const child = Bun.spawn([process.execPath, "-e", script], {
			cwd: import.meta.dir,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	test("collectCodeGraph records evidence instead of throwing when a subdirectory is unreadable", async () => {
		const blockedDir = writeBlockedDirFixture();
		const { stdout, stderr, exitCode } = await runInMockedFsProcess(
			mockReaddirThrowsFor(blockedDir),
			`const { collectCodeGraph } = await import(${JSON.stringify(new URL("../src/erd/code-graph.ts", import.meta.url).pathname)});
const result = collectCodeGraph({ scopePath: ${JSON.stringify(scopeDir)} });
console.log(JSON.stringify({ nodeIds: result.nodes.map((n) => n.id), evidence: result.evidence }));`,
		);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const { nodeIds, evidence } = JSON.parse(stdout) as {
			nodeIds: string[];
			evidence: { ref: string; detail?: string }[];
		};
		expect(nodeIds).toContain("src/ok.ts");
		expect(evidence.some((e) => e.detail?.includes("could not read directory"))).toBe(true);
	});

	test("collectImportGraph records evidence instead of throwing when a subdirectory is unreadable", async () => {
		const blockedDir = writeBlockedDirFixture();
		const { stdout, stderr, exitCode } = await runInMockedFsProcess(
			mockReaddirThrowsFor(blockedDir),
			`const { collectImportGraph } = await import(${JSON.stringify(new URL("../src/erd/import-graph.ts", import.meta.url).pathname)});
const result = collectImportGraph({ scopePath: ${JSON.stringify(scopeDir)} });
console.log(JSON.stringify({ evidence: result.evidence }));`,
		);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const { evidence } = JSON.parse(stdout) as { evidence: { ref: string; detail?: string }[] };
		expect(evidence.some((e) => e.detail?.includes("could not read directory"))).toBe(true);
	});

	test("collectImportGraph records evidence instead of throwing when a file cannot be read", async () => {
		writeFile("src/ok.ts", "export const ok = true;\n");
		writeFile("src/blocked.ts", "export const blocked = true;\n");
		const { stdout, stderr, exitCode } = await runInMockedFsProcess(
			`const originalReadFileSync = fs.readFileSync;
mock.module("node:fs", () => ({ ...fs, readFileSync(path, options) {
	if (String(path).endsWith("blocked.ts")) throw new Error("EACCES: permission denied, open 'blocked.ts'");
	return originalReadFileSync(path, options);
} }));`,
			`const { collectImportGraph } = await import(${JSON.stringify(new URL("../src/erd/import-graph.ts", import.meta.url).pathname)});
const result = collectImportGraph({ scopePath: ${JSON.stringify(scopeDir)} });
console.log(JSON.stringify({ evidence: result.evidence }));`,
		);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const { evidence } = JSON.parse(stdout) as { evidence: { ref: string; detail?: string }[] };
		expect(evidence.some((e) => e.ref === "src/blocked.ts" && e.detail?.includes("could not read file"))).toBe(true);
	});

	test("collectCodeGraph records evidence instead of throwing when statSync fails on a file", async () => {
		writeFile("src/ok.ts", "export const ok = true;\n");
		writeFile("src/blocked.ts", "export const blocked = true;\n");
		const { stdout, stderr, exitCode } = await runInMockedFsProcess(
			`const originalStatSync = fs.statSync;
mock.module("node:fs", () => ({ ...fs, statSync(path, options) {
	if (String(path).endsWith("blocked.ts")) throw new Error("EACCES: permission denied, stat 'blocked.ts'");
	return originalStatSync(path, options);
} }));`,
			`const { collectCodeGraph } = await import(${JSON.stringify(new URL("../src/erd/code-graph.ts", import.meta.url).pathname)});
const result = collectCodeGraph({ scopePath: ${JSON.stringify(scopeDir)} });
console.log(JSON.stringify({ nodeIds: result.nodes.map((n) => n.id), evidence: result.evidence }));`,
		);
		expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
		const { nodeIds, evidence } = JSON.parse(stdout) as {
			nodeIds: string[];
			evidence: { ref: string; detail?: string }[];
		};
		expect(nodeIds).toContain("src/ok.ts");
		expect(nodeIds).not.toContain("src/blocked.ts");
		expect(evidence.some((e) => e.ref === "src/blocked.ts" && e.detail?.includes("could not stat file"))).toBe(true);
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
