import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type DiffFile, parseUnifiedDiff } from "../src/thrash/core";
import {
	INVESTIGATE_BUDGET_MS,
	InvestigateError,
	investigate,
	MAX_HITS_DEFAULT,
	MAX_SYMBOLS_PER_FILE,
	symbolsFromDiffLines,
} from "../src/thrash/investigate";

let root: string;

function git(...args: string[]): void {
	const result = Bun.spawnSync(["git", "-C", root, ...args], {
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
	});
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
}

function write(rel: string, content: string): void {
	const abs = join(root, rel);
	mkdirSync(dirname(abs), { recursive: true });
	writeFileSync(abs, content);
}

function commitAll(files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) write(rel, content);
	git("add", "-A");
	git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init");
}

function options(extra: Partial<Parameters<typeof investigate>[2]> = {}) {
	return { maxHits: MAX_HITS_DEFAULT, budgetMs: Number.POSITIVE_INFINITY, ...extra };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "thrash-investigate-"));
	git("init", "-q");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function diffFor(text: string): Map<string, DiffFile> {
	return new Map(parseUnifiedDiff(text).map((file) => [file.path, file]));
}

describe("investigate", () => {
	test("returns dependents and a caller hit with the correct line", () => {
		commitAll({
			"a.ts": "export const total = 1;\n",
			"b.ts": 'import { total } from "./a";\n\nexport const doubled = total * 2;\n',
		});
		const result = investigate(root, ["a.ts"], options());
		expect(result.root).toBe(root);
		const [file] = result.files;
		expect(file.path).toBe("a.ts");
		expect(file.symbols).toEqual(["total"]);
		expect(file.dependents).toEqual(["b.ts"]);
		expect(file.callers).toContainEqual({ path: "b.ts", line: 3, symbol: "total" });
		expect(file.truncated).toBe(false);
	});

	test("drops hits in the file itself and pairs a.spec.ts as a test", () => {
		commitAll({
			"a.ts": "export function total() {\n  return total;\n}\n",
			"a.spec.ts": 'import { total } from "./a";\ntotal();\n',
		});
		const [file] = investigate(root, ["a.ts"], options()).files;
		expect(file.callers.every((hit) => hit.path !== "a.ts")).toBe(true);
		expect(file.tests).toEqual(["a.spec.ts"]);
	});

	test("pairs src/thrash/core.ts with __tests__/thrash-core.spec.ts", () => {
		commitAll({
			"src/thrash/core.ts": "export const unrelated = 1;\n",
			"__tests__/thrash-core.spec.ts": "export {};\n",
			"__tests__/other.spec.ts": "export {};\n",
		});
		const [file] = investigate(root, ["src/thrash/core.ts"], options()).files;
		expect(file.tests).toEqual(["__tests__/thrash-core.spec.ts"]);
	});

	test("pairs python and suffix test names and test files that import the file", () => {
		commitAll({
			"lib/util.py": "def helper():\n    return 1\n",
			"lib/test_util.py": "x = 1\n",
			"lib/util_test.py": "x = 1\n",
			"checks/uses_util.test.ts": "x\n",
			"app.ts": "export const x = 1;\n",
			"__tests__/imports-app.spec.ts": 'import { x } from "../app";\n',
		});
		const util = investigate(root, ["lib/util.py"], options()).files[0];
		expect(util.tests).toEqual(["lib/test_util.py", "lib/util_test.py"]);
		const app = investigate(root, ["app.ts"], options()).files[0];
		expect(app.tests).toEqual(["__tests__/imports-app.spec.ts"]);
	});

	test("cuts callers at maxHits and sets truncated", () => {
		commitAll({
			"a.ts": "export const total = 1;\n",
			"b1.ts": "total;\n",
			"b2.ts": "total;\n",
			"b3.ts": "total;\n",
		});
		const [file] = investigate(root, ["a.ts"], options({ maxHits: 1 })).files;
		expect(file.callers).toHaveLength(1);
		expect(file.truncated).toBe(true);
	});

	test("does not set truncated when hits equal maxHits", () => {
		commitAll({ "a.ts": "export const total = 1;\n", "b1.ts": "total;\n", "b2.ts": "total;\n" });
		const [file] = investigate(root, ["a.ts"], options({ maxHits: 2 })).files;
		expect(file.callers).toHaveLength(2);
		expect(file.truncated).toBe(false);
	});

	test("passes a symbol with regex characters as a fixed string", () => {
		commitAll({
			"a.ts": "export function $get() {}\n",
			"b.ts": "$get();\n",
			"c.ts": "xget();\n",
		});
		const [file] = investigate(root, ["a.ts"], options()).files;
		expect(file.symbols).toEqual(["$get"]);
		expect(file.callers.map((hit) => hit.path)).toEqual(["b.ts"]);
	});

	test("truncates every file and empties the lists with a budget of 0", () => {
		commitAll({
			"a.ts": "export const total = 1;\n",
			"b.ts": 'import { total } from "./a";\ntotal;\n',
			"a.spec.ts": "x\n",
		});
		const result = investigate(root, ["a.ts", "b.ts"], options({ budgetMs: 0 }));
		for (const file of result.files) {
			expect(file.truncated).toBe(true);
			expect(file.dependents).toEqual([]);
			expect(file.callers).toEqual([]);
			expect(file.tests).toEqual([]);
		}
	});

	test("truncates only the files after the deadline passes", () => {
		commitAll({ "a.ts": "export const one = 1;\n", "b.ts": "export const two = 2;\n" });
		let calls = 0;
		const now = () => calls++ * 250;
		const result = investigate(root, ["a.ts", "b.ts"], options({ budgetMs: 1000, now }));
		expect(result.files.map((file) => file.truncated)).toEqual([false, true]);
		expect(result.files[1].callers).toEqual([]);
	});

	test("gives empty arrays and truncated false for deleted, binary and unknown extensions", () => {
		commitAll({ "bin.dat": "a\0b", "notes.md": "# total\n" });
		const diffFiles = diffFor(
			"diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-export const gone = 1;\n",
		);
		const result = investigate(root, ["gone.ts", "bin.dat", "notes.md", "missing.ts"], options({ diffFiles }));
		for (const file of result.files) {
			expect(file.symbols).toEqual([]);
			expect(file.callers).toEqual([]);
			expect(file.truncated).toBe(false);
		}
	});

	test("rejects a path outside the root", () => {
		commitAll({ "a.ts": "export const x = 1;\n" });
		expect(() => investigate(root, ["../escape.ts"], options())).toThrow(InvestigateError);
	});

	test("throws InvestigateError when git grep fails", () => {
		const plain = mkdtempSync(join(tmpdir(), "thrash-investigate-plain-"));
		try {
			writeFileSync(join(plain, "a.ts"), "export const total = 1;\n");
			expect(() => investigate(plain, ["a.ts"], options())).toThrow(InvestigateError);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});

	test("exposes the budget and symbol constants", () => {
		expect(INVESTIGATE_BUDGET_MS).toBe(60_000);
		expect(MAX_HITS_DEFAULT).toBe(20);
		expect(MAX_SYMBOLS_PER_FILE).toBe(50);
	});
});

function withGitShim(script: (realGit: string) => string, run: () => void): void {
	const realGit = Bun.which("git") as string;
	const shimDir = mkdtempSync(join(tmpdir(), "thrash-git-shim-"));
	const shim = join(shimDir, "git");
	writeFileSync(shim, script(realGit));
	chmodSync(shim, 0o755);
	const previous = process.env.PATH;
	process.env.PATH = `${shimDir}:${previous}`;
	try {
		run();
	} finally {
		process.env.PATH = previous;
		rmSync(shimDir, { recursive: true, force: true });
	}
}

describe("investigate git behavior", () => {
	test("reports a caller in a non-ASCII file name unquoted", () => {
		commitAll({ "a.ts": "export const total = 1;\n", "caf\u00e9.ts": "total;\n" });
		const [file] = investigate(root, ["a.ts"], options()).files;
		expect(file.callers).toEqual([{ path: "caf\u00e9.ts", line: 1, symbol: "total" }]);
	});

	test("stops the symbol loop once a file is truncated by hits", () => {
		commitAll({
			"a.ts": "export const one = 1;\nexport const two = 2;\n",
			"b.ts": "one;\ntwo;\n",
			"c.ts": "one;\n",
		});
		const log = join(root, "..", `grep-count-${Date.now()}.log`);
		withGitShim(
			(realGit) =>
				`#!/bin/sh\nfor a in "$@"; do [ "$a" = grep ] && echo x >> "${log}"; done\nexec "${realGit}" "$@"\n`,
			() => {
				const [file] = investigate(root, ["a.ts"], options({ maxHits: 1 })).files;
				expect(file.truncated).toBe(true);
			},
		);
		expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
		rmSync(log, { force: true });
	});

	test("truncates and drops earlier hits when git grep times out", () => {
		commitAll({
			"a.ts": "export const one = 1;\nexport const two = 2;\n",
			"b.ts": "one;\ntwo;\n",
			"a.spec.ts": "x\n",
		});
		withGitShim(
			(realGit) =>
				`#!/bin/sh\nfor a in "$@"; do if [ "$a" = grep ]; then case "$*" in *two*) sleep 5;; esac; fi; done\nexec "${realGit}" "$@"\n`,
			() => {
				const [file] = investigate(root, ["a.ts"], options({ budgetMs: 1500 })).files;
				expect(file.truncated).toBe(true);
				expect(file.callers).toEqual([]);
				expect(file.dependents).toEqual([]);
				expect(file.tests).toEqual([]);
			},
		);
	});

	test("runs git without prompts or submodule recursion and drops ls-files rows outside the root", () => {
		commitAll({ "a.ts": "export const total = 1;\n", "a.spec.ts": "x\n" });
		const log = join(root, "..", `git-calls-${Date.now()}.log`);
		withGitShim(
			(realGit) =>
				`#!/bin/sh\necho "PROMPT=$GIT_TERMINAL_PROMPT ARGS=$*" >> "${log}"\ncase "$*" in *ls-files*) "${realGit}" "$@"; printf '../outside.spec.ts\\0'; exit 0;; esac\nexec "${realGit}" "$@"\n`,
			() => {
				const [file] = investigate(root, ["a.ts"], options()).files;
				expect(file.tests).toEqual(["a.spec.ts"]);
			},
		);
		const calls = readFileSync(log, "utf8");
		rmSync(log, { force: true });
		expect(calls).toContain("PROMPT=0");
		expect(calls).not.toContain("--recurse-submodules");
		expect(calls.trim().split("\n").every((row) => row.startsWith("PROMPT=0"))).toBe(true);
	});
});

describe("symbols", () => {
	test("reads TypeScript declarations from the whole file in path mode", () => {
		commitAll({
			"a.ts": [
				"export default function main() {}",
				"export class Box {",
				"  static build(): Box {",
				"    if (x) {",
				"    }",
				"  }",
				"}",
				"interface Shape {}",
				"export type Id = string;",
				"enum Color { Red }",
				"let counter = 0;",
				"var legacy = 1;",
				"export default Box;",
				"",
			].join("\n"),
		});
		const [file] = investigate(root, ["a.ts"], options()).files;
		expect(file.symbols).toEqual(["main", "Box", "build", "Shape", "Id", "Color", "counter", "legacy"]);
	});

	test("reads Python def and class", () => {
		commitAll({
			"m.py": "class Repo:\n    async def load(self):\n        pass\n\ndef top():\n    return 1\n",
		});
		const [file] = investigate(root, ["m.py"], options()).files;
		expect(file.symbols).toEqual(["Repo", "load", "top"]);
	});

	test("ignores an unchanged declaration in the same file in diff mode", () => {
		commitAll({ "a.ts": "export const kept = 1;\nexport const changed = 2;\n" });
		const diffFiles = diffFor(
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n export const kept = 1;\n-export const changed = 2;\n+export const changed = 3;\n",
		);
		const [file] = investigate(root, ["a.ts"], options({ diffFiles })).files;
		expect(file.symbols).toEqual(["changed"]);
	});

	test("treats a deleted declaration as a symbol and searches it at the head", () => {
		commitAll({ "a.ts": "export const kept = 1;\n", "b.ts": "removed();\n" });
		const diffFiles = diffFor(
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1 @@\n export const kept = 1;\n-export function removed() {}\n",
		);
		const [file] = investigate(root, ["a.ts"], options({ diffFiles })).files;
		expect(file.symbols).toEqual(["removed"]);
		expect(file.callers).toEqual([{ path: "b.ts", line: 1, symbol: "removed" }]);
	});

	test("reads Python declarations in diff mode", () => {
		commitAll({ "m.py": "def kept():\n    pass\n\ndef added():\n    pass\n" });
		const diffFiles = diffFor(
			"diff --git a/m.py b/m.py\n--- a/m.py\n+++ b/m.py\n@@ -1,3 +1,5 @@\n def kept():\n     pass\n \n+def added():\n+    pass\n",
		);
		const [file] = investigate(root, ["m.py"], options({ diffFiles })).files;
		expect(file.symbols).toEqual(["added"]);
	});

	test("caps symbols per file", () => {
		const source = Array.from({ length: MAX_SYMBOLS_PER_FILE + 10 }, (_, i) => `export const s${i} = ${i};`);
		commitAll({ "a.ts": `${source.join("\n")}\n` });
		const [file] = investigate(root, ["a.ts"], options()).files;
		expect(file.symbols).toHaveLength(MAX_SYMBOLS_PER_FILE);
	});

	test("symbolsFromDiffLines reads only the lines it is given", () => {
		const [file] = parseUnifiedDiff(
			"diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-export const one = 1;\n+export const two = 2;\n export const kept = 3;\n",
		);
		expect(symbolsFromDiffLines("a.ts", file.lines)).toEqual(["one", "two"]);
		expect(symbolsFromDiffLines("a.ts", file.lines.slice(1, 2))).toEqual(["two"]);
	});
});
