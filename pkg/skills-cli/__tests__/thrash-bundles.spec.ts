import { describe, expect, test } from "bun:test";
import {
	BUNDLE_TARGET_LINES,
	planBundles,
	planReviewChunks,
	renderBundleContext,
	TINY_DIFF_LINES,
} from "../src/thrash/bundles";
import { type DiffFile, type DiffLine, LARGE_DIFF_LINES, MAX_CHUNKS, sumChanged } from "../src/thrash/core";
import type { InvestigatedFile, Investigation } from "../src/thrash/investigate";

type HunkSpec = number | { count: number; prefix: string };

function diffFile(path: string, hunks: HunkSpec | HunkSpec[], status: DiffFile["status"] = "modified"): DiffFile {
	const specs = Array.isArray(hunks) ? hunks : [hunks];
	const lines: DiffLine[] = [];
	const hunkStarts: number[] = [];
	let next = 1;
	for (const spec of specs) {
		const { count, prefix } = typeof spec === "number" ? { count: spec, prefix: "row" } : spec;
		hunkStarts.push(lines.length);
		lines.push({ kind: "context", oldLine: next, newLine: next, text: "ctx" });
		for (let i = 0; i < count; i++) {
			lines.push({ kind: "add", newLine: next + 1 + i, text: `${prefix} ${next + 1 + i}` });
		}
		next += count + 2;
	}
	return {
		path,
		oldPath: path,
		status,
		hunkHeaders: hunkStarts.map((_, i) => `@@ -${i},1 +${i},1 @@`),
		hunkStarts,
		lines,
	};
}

function entry(path: string, extra: Partial<InvestigatedFile> = {}): InvestigatedFile {
	return { path, symbols: [], dependents: [], callers: [], tests: [], truncated: false, ...extra };
}

function investigation(...files: InvestigatedFile[]): Investigation {
	return { root: "/repo", files };
}

function changedKeys(files: DiffFile[]): string[] {
	return files
		.flatMap((f) => f.lines.filter((l) => l.kind !== "context").map((l) => `${f.path}|${l.kind}|${l.newLine}|${l.oldLine}`))
		.sort();
}

function expectConserved(input: DiffFile[], plan: ReturnType<typeof planBundles>) {
	const skipped = new Set(plan.skipped);
	const expected = changedKeys(input.filter((f) => !skipped.has(f.path)));
	const actual = changedKeys(plan.chunks.flatMap((c) => c.files));
	expect(actual).toEqual(expected);
	expect(new Set(actual).size).toBe(actual.length);
}

function concerns(count: number, lines: number): DiffFile[] {
	return Array.from({ length: count }, (_, i) => diffFile(`src/m${String(i).padStart(2, "0")}/index.ts`, lines));
}

function pathsOf(chunk: { files: DiffFile[] }): string[] {
	return [...new Set(chunk.files.map((f) => f.path))];
}

describe("constants", () => {
	test("exposes the tiny-diff and bundle target limits", () => {
		expect(TINY_DIFF_LINES).toBe(100);
		expect(BUNDLE_TARGET_LINES).toBe(400);
	});
});

describe("planBundles tiny diff", () => {
	test("puts 99 changed lines of 3 unrelated concerns in one whole diff bundle", () => {
		const files = [diffFile("src/a.ts", 33), diffFile("src/b.ts", 33), diffFile("src/c.ts", 33)];
		const plan = planBundles(files, investigation());
		expect(plan.chunks).toHaveLength(1);
		expect(plan.chunks[0].label).toBe("whole diff");
		expect(plan.chunks[0].changed).toBe(99);
		expectConserved(files, plan);
	});

	test("keeps 100 changed lines of 2 concerns in one bundle and splits at 101", () => {
		const at100 = [diffFile("src/a.ts", 50), diffFile("src/b.ts", 50)];
		const at101 = [diffFile("src/a.ts", 51), diffFile("src/b.ts", 50)];
		expect(planBundles(at100, investigation()).chunks).toHaveLength(1);
		const split = planBundles(at101, investigation());
		expect(split.chunks).toHaveLength(2);
		expectConserved(at101, split);
	});

	test("counts a skipped lock file toward the tiny-diff limit", () => {
		const files = [diffFile("src/a.ts", 90), diffFile("bun.lock", 20)];
		const plan = planBundles(files, investigation());
		expect(plan.chunks.length).toBeGreaterThan(1);
		expect(plan.chunks[0].label).not.toBe("whole diff");
	});

	test("returns an empty plan for no files", () => {
		expect(planBundles([], investigation())).toEqual({ chunks: [], skipped: [] });
	});

	test("gives the whole diff bundle fields", () => {
		const files = [diffFile("src/a.ts", 10), diffFile("src/b.ts", 10)];
		const plan = planBundles(files, investigation(entry("src/a.ts", { dependents: ["src/z.ts"] })));
		expect(plan.chunks[0].bundle?.files).toEqual(["src/a.ts", "src/b.ts"]);
		expect(plan.chunks[0].bundle?.dependents).toEqual(["src/z.ts"]);
	});
});

describe("planBundles concerns", () => {
	test("gives two unlinked concerns of 250 lines their own bundles", () => {
		const files = [diffFile("src/a/one.ts", 250), diffFile("src/b/two.ts", 250)];
		const plan = planBundles(files, investigation());
		expect(plan.chunks).toHaveLength(2);
		expect(plan.chunks.map(pathsOf)).toEqual([["src/a/one.ts"], ["src/b/two.ts"]]);
		expectConserved(files, plan);
	});

	test("gives 150 lines of 2 unrelated concerns 2 bundles", () => {
		const files = [diffFile("src/a.ts", 75), diffFile("src/b.ts", 75)];
		const plan = planBundles(files, investigation());
		expect(plan.chunks).toHaveLength(2);
		expectConserved(files, plan);
	});

	test("keeps a source file, its paired test and a caller in one bundle in a 600-line diff", () => {
		const files = [
			diffFile("src/a.ts", 100),
			diffFile("__tests__/a.spec.ts", 50),
			diffFile("src/caller.ts", 50),
			diffFile("docs/other/x.ts", 200),
			diffFile("src/zzz/y.ts", 200),
		];
		const inv = investigation(
			entry("src/a.ts", {
				symbols: ["total"],
				tests: ["__tests__/a.spec.ts"],
				callers: [{ path: "src/caller.ts", line: 4, symbol: "total" }],
			}),
		);
		const plan = planBundles(files, inv);
		const holder = plan.chunks.find((c) => pathsOf(c).includes("src/a.ts"));
		expect(pathsOf(holder as { files: DiffFile[] }).sort()).toEqual(["__tests__/a.spec.ts", "src/a.ts", "src/caller.ts"]);
		expectConserved(files, plan);
	});

	test("links an importer through dependents and a paired test through the second file", () => {
		const files = [diffFile("src/a.ts", 60), diffFile("src/b.ts", 60), diffFile("__tests__/b.spec.ts", 60), diffFile("src/z.ts", 60)];
		const inv = investigation(
			entry("src/b.ts", { dependents: ["src/a.ts"], tests: ["__tests__/b.spec.ts"] }),
		);
		const plan = planBundles(files, inv);
		expect(plan.chunks).toHaveLength(2);
		expect(pathsOf(plan.chunks[0]).sort()).toEqual(["__tests__/b.spec.ts", "src/a.ts", "src/b.ts"]);
		expect(pathsOf(plan.chunks[1])).toEqual(["src/z.ts"]);
	});

	test("links no files for a file whose callers were truncated", () => {
		const files = [diffFile("src/a.ts", 60), diffFile("src/b.ts", 60)];
		const inv = investigation(
			entry("src/a.ts", { symbols: ["total"], truncated: true, callers: [{ path: "src/b.ts", line: 1, symbol: "total" }] }),
		);
		expect(planBundles(files, inv).chunks).toHaveLength(2);
	});

	test("links a caller when the callers are complete", () => {
		const files = [diffFile("src/a.ts", 60), diffFile("src/b.ts", 60)];
		const inv = investigation(
			entry("src/a.ts", { symbols: ["total"], callers: [{ path: "src/b.ts", line: 1, symbol: "total" }] }),
		);
		expect(planBundles(files, inv).chunks).toHaveLength(1);
	});

	test("links are transitive and undirected", () => {
		const files = [diffFile("src/a.ts", 40), diffFile("src/b.ts", 40), diffFile("src/c.ts", 40), diffFile("src/d.ts", 40)];
		const inv = investigation(entry("src/b.ts", { dependents: ["src/a.ts"] }), entry("src/c.ts", { dependents: ["src/b.ts"] }));
		const plan = planBundles(files, inv);
		expect(plan.chunks).toHaveLength(2);
		expect(pathsOf(plan.chunks[0]).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
	});

	test("orders bundles by category and then by path", () => {
		const files = [
			diffFile("docs/guide.md", 40),
			diffFile("src/z.ts", 40),
			diffFile("__tests__/a.spec.ts", 40),
			diffFile("src/a.ts", 40),
		];
		const plan = planBundles(files, investigation());
		expect(plan.chunks.map((c) => c.id)).toEqual([1, 2, 3, 4]);
		expect(plan.chunks.map((c) => pathsOf(c)[0])).toEqual(["src/a.ts", "src/z.ts", "__tests__/a.spec.ts", "docs/guide.md"]);
	});

	test("orders split parts of mixed concerns by category before path", () => {
		const files = [
			diffFile("src/a.ts", 350),
			diffFile("__tests__/a.spec.ts", 350),
			diffFile("src/b.ts", 350),
			diffFile("docs/b.md", 350),
		];
		const inv = investigation(
			entry("src/a.ts", { tests: ["__tests__/a.spec.ts"] }),
			entry("src/b.ts", { dependents: ["docs/b.md"] }),
		);
		const plan = planBundles(files, inv);
		expect(plan.chunks.map((c) => pathsOf(c)[0])).toEqual(["src/a.ts", "src/b.ts", "__tests__/a.spec.ts", "docs/b.md"]);
	});

	test("labels a bundle by category and common directory, and a mixed one as mixed", () => {
		const files = [diffFile("src/a.ts", 60), diffFile("src/a.spec.ts", 60), diffFile("lib/b.ts", 60)];
		const inv = investigation(entry("src/a.ts", { tests: ["src/a.spec.ts"] }));
		const plan = planBundles(files, inv);
		expect(plan.chunks[0].label).toBe("source: lib");
		expect(plan.chunks[1].label).toBe("mixed: src");
	});
});

describe("planBundles size and cap", () => {
	test("splits a 1000-line concern of several files into bundles of 400 lines at most", () => {
		const files = [diffFile("src/a.ts", 250), diffFile("src/b.ts", 250), diffFile("src/c.ts", 250), diffFile("src/d.ts", 250)];
		const inv = investigation(
			entry("src/a.ts", { dependents: ["src/b.ts", "src/c.ts", "src/d.ts"] }),
		);
		const plan = planBundles(files, inv);
		expect(plan.chunks.length).toBeGreaterThan(1);
		for (const chunk of plan.chunks) expect(chunk.changed).toBeLessThanOrEqual(400);
		expectConserved(files, plan);
	});

	test("splits one 1000-line file by hunks with no line in two bundles", () => {
		const files = [diffFile("src/big.ts", [250, 250, 250, 250])];
		const plan = planBundles(files, investigation());
		expect(plan.chunks.length).toBeGreaterThan(1);
		for (const chunk of plan.chunks) expect(chunk.changed).toBeLessThanOrEqual(400);
		expectConserved(files, plan);
		for (const chunk of plan.chunks) expect(chunk.bundle?.files).toEqual(["src/big.ts"]);
	});

	test("cuts a hunk larger than the target without losing a line", () => {
		const files = [diffFile("src/big.ts", 1000)];
		const plan = planBundles(files, investigation());
		for (const chunk of plan.chunks) expect(chunk.changed).toBeLessThanOrEqual(400);
		expectConserved(files, plan);
	});

	test("splits lib/a.ts, lib/a.spec.ts and lib/b.ts into 2 parts and keeps the paired test with its source", () => {
		const files = [diffFile("lib/a.spec.ts", 100), diffFile("lib/a.ts", 150), diffFile("lib/b.ts", 350)];
		const inv = investigation(
			entry("lib/a.ts", { tests: ["lib/a.spec.ts"], dependents: ["lib/b.ts"] }),
		);
		const plan = planBundles(files, inv);
		expect(plan.chunks).toHaveLength(2);
		const holder = plan.chunks.find((c) => pathsOf(c).includes("lib/a.ts"));
		expect(pathsOf(holder as { files: DiffFile[] })).toContain("lib/a.spec.ts");
		expectConserved(files, plan);
	});

	test("merges 20 unrelated concerns of 50 lines into exactly 8 bundles", () => {
		const files = concerns(20, 50);
		const plan = planBundles(files, investigation());
		expect(plan.chunks).toHaveLength(MAX_CHUNKS);
		expectConserved(files, plan);
	});

	test("merges 9 unrelated concerns of 450 lines into 8 bundles, some over the target", () => {
		const files = concerns(9, 450);
		const plan = planBundles(files, investigation());
		expect(plan.chunks).toHaveLength(MAX_CHUNKS);
		expect(plan.chunks.some((c) => c.changed > BUNDLE_TARGET_LINES)).toBe(true);
		expectConserved(files, plan);
	});

	test("keeps the cap and the sum when merging counts the generated bundle", () => {
		const files = [...concerns(10, 50), diffFile("bun.lock", 30)];
		const plan = planBundles(files, investigation());
		expect(plan.chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
		expectConserved(files, plan);
	});
});

describe("planBundles generated files", () => {
	test("puts a lock file in a bundle of its own and skips a generated file past the large-diff limit", () => {
		const files = [diffFile("src/a.ts", 150), diffFile("bun.lock", 40), diffFile("dist/huge.js", LARGE_DIFF_LINES + 1)];
		const plan = planBundles(files, investigation());
		expect(plan.skipped).toEqual(["dist/huge.js"]);
		const lock = plan.chunks.find((c) => pathsOf(c).includes("bun.lock"));
		expect(pathsOf(lock as { files: DiffFile[] })).toEqual(["bun.lock"]);
		expectConserved(files, plan);
	});

	test("keeps generated files out of concerns", () => {
		const files = [diffFile("src/a.ts", 80), diffFile("bun.lock", 80)];
		const inv = investigation(entry("src/a.ts", { dependents: ["bun.lock"] }));
		const plan = planBundles(files, inv);
		expect(plan.chunks).toHaveLength(2);
	});
});

describe("planBundles bundle fields", () => {
	test("lists a caller path without an import edge as related and leaves dependents out of related", () => {
		const files = [diffFile("src/a.ts", 150), diffFile("src/other.ts", 150)];
		const inv = investigation(
			entry("src/a.ts", {
				symbols: ["row"],
				dependents: ["src/imp.ts"],
				tests: ["__tests__/a.spec.ts"],
				callers: [
					{ path: "src/imp.ts", line: 2, symbol: "row" },
					{ path: "src/far.ts", line: 9, symbol: "row" },
				],
			}),
		);
		const plan = planBundles(files, inv);
		const bundle = plan.chunks[0].bundle;
		expect(bundle?.files).toEqual(["src/a.ts"]);
		expect(bundle?.dependents).toEqual(["src/imp.ts"]);
		expect(bundle?.related).toEqual(["src/far.ts"]);
		expect(bundle?.tests).toEqual(["__tests__/a.spec.ts"]);
	});

	test("leaves a path of its own bundle out of dependents, tests and related", () => {
		const files = [diffFile("src/a.ts", 60), diffFile("src/b.ts", 60), diffFile("__tests__/a.spec.ts", 60)];
		const inv = investigation(
			entry("src/a.ts", {
				symbols: ["row"],
				dependents: ["src/b.ts"],
				tests: ["__tests__/a.spec.ts"],
				callers: [{ path: "src/b.ts", line: 3, symbol: "row" }],
			}),
		);
		const bundle = planBundles(files, inv).chunks[0].bundle;
		expect(bundle?.dependents).toEqual([]);
		expect(bundle?.tests).toEqual([]);
		expect(bundle?.related).toEqual([]);
	});

	test("holds each file path once in bundle.files when a file spans two parts of one bundle", () => {
		const files = [diffFile("src/a.ts", [200, 200])];
		const plan = planBundles(files, investigation());
		for (const chunk of plan.chunks) {
			expect(new Set(chunk.bundle?.files).size).toBe(chunk.bundle?.files.length ?? -1);
		}
	});

	test("takes symbols and callers of a file split by hunks from the lines of each part", () => {
		const files = [diffFile("src/x.ts", [{ count: 300, prefix: "alpha" }, { count: 300, prefix: "beta" }])];
		const inv = investigation(
			entry("src/x.ts", {
				symbols: ["alpha", "beta"],
				callers: [
					{ path: "src/c.ts", line: 1, symbol: "alpha" },
					{ path: "src/d.ts", line: 2, symbol: "beta" },
				],
			}),
		);
		const plan = planBundles(files, inv);
		expect(plan.chunks).toHaveLength(2);
		expect(plan.chunks[0].bundle?.symbols).toEqual(["alpha"]);
		expect(plan.chunks[0].bundle?.related).toEqual(["src/c.ts"]);
		expect(plan.chunks[1].bundle?.symbols).toEqual(["beta"]);
		expect(plan.chunks[1].bundle?.related).toEqual(["src/d.ts"]);
		expectConserved(files, plan);
	});

	test("gives every chunk a bundle field", () => {
		const plan = planBundles(concerns(3, 60), investigation());
		for (const chunk of plan.chunks) expect(chunk.bundle).toBeDefined();
		expect(sumChanged(plan.chunks.flatMap((c) => c.files))).toBe(180);
	});
});

describe("renderBundleContext", () => {
	const files = [diffFile("src/a.ts", 150), diffFile("src/other.ts", 150)];
	const inv = investigation(
		entry("src/a.ts", {
			symbols: ["row"],
			dependents: ["src/imp.ts"],
			tests: ["__tests__/a.spec.ts"],
			callers: [{ path: "src/far.ts", line: 9, symbol: "row" }],
		}),
		entry("src/other.ts", { truncated: true }),
	);

	test("lists dependents, callers with line numbers and tests", () => {
		const plan = planBundles(files, inv);
		const text = renderBundleContext(plan.chunks[0], inv);
		expect(text).toContain("src/imp.ts");
		expect(text).toContain("src/far.ts:9");
		expect(text).toContain("__tests__/a.spec.ts");
	});

	test("names the truncated files of the bundle", () => {
		const plan = planBundles(files, inv);
		expect(renderBundleContext(plan.chunks[1], inv)).toContain("src/other.ts");
		expect(renderBundleContext(plan.chunks[1], inv).toLowerCase()).toContain("truncated");
		expect(renderBundleContext(plan.chunks[0], inv).toLowerCase()).not.toContain("truncated");
	});
});

describe("planReviewChunks", () => {
	const files = [diffFile("src/a.ts", 150), diffFile("src/b.ts", 150)];
	const cwd = { root: "/repo", headSha: "abc", source: "cwd" as const };

	function deps(result: Investigation | Error) {
		const calls: Array<{ root: string; paths: string[] }> = [];
		return {
			calls,
			deps: {
				maxHits: 20,
				budgetMs: 1000,
				investigate: (root: string, paths: string[]) => {
					calls.push({ root, paths });
					if (result instanceof Error) throw result;
					return result;
				},
			},
		};
	}

	test("plans bundles and renders one context per bundle for a cwd checkout", () => {
		const { deps: d, calls } = deps(investigation(entry("src/a.ts"), entry("src/b.ts")));
		const out = planReviewChunks(files, cwd, d);
		expect(calls).toEqual([{ root: "/repo", paths: ["src/a.ts", "src/b.ts"] }]);
		expect(out.plan.chunks).toHaveLength(2);
		expect(out.plan.chunks.every((c) => c.bundle)).toBe(true);
		expect([...out.contexts.keys()].sort()).toEqual([1, 2]);
		expect(out.warnings).toEqual([]);
	});

	test("plans bundles for a clone checkout", () => {
		const { deps: d } = deps(investigation());
		const out = planReviewChunks(files, { ...cwd, source: "clone" }, d);
		expect(out.plan.chunks[0].bundle).toBeDefined();
	});

	test.each(["api", "none"] as const)("plans with planChunks and skips investigate for source %s", (source) => {
		const { deps: d, calls } = deps(investigation());
		const out = planReviewChunks(files, { ...cwd, source }, d);
		expect(calls).toHaveLength(0);
		expect(out.plan.chunks.some((c) => c.bundle !== undefined)).toBe(false);
		expect(out.contexts.size).toBe(0);
		expect(out.warnings).toEqual([]);
	});

	test("plans with planChunks when there is no repo", () => {
		const { deps: d, calls } = deps(investigation());
		const out = planReviewChunks(files, undefined, d);
		expect(calls).toHaveLength(0);
		expect(out.plan.chunks.some((c) => c.bundle !== undefined)).toBe(false);
	});

	test("falls back to planChunks with one warning when investigate throws", () => {
		const { deps: d } = deps(new Error("git grep exited 2"));
		const out = planReviewChunks(files, cwd, d);
		expect(out.warnings).toHaveLength(1);
		expect(out.warnings[0]).toContain("git grep exited 2");
		expect(out.plan.chunks.some((c) => c.bundle !== undefined)).toBe(false);
		expect(out.contexts.size).toBe(0);
	});

	test("warns with the count of budget-cut files and still plans bundles", () => {
		const { deps: d } = deps(investigation(entry("src/a.ts", { truncated: true }), entry("src/b.ts", { truncated: true })));
		const out = planReviewChunks(files, cwd, d);
		expect(out.warnings).toHaveLength(1);
		expect(out.warnings[0]).toContain("2");
		expect(out.plan.chunks.every((c) => c.bundle)).toBe(true);
		expect(out.contexts.get(1)?.toLowerCase()).toContain("truncated");
	});

	test("does not warn when a file is only cut at the hit limit", () => {
		const callers = [{ path: "src/z.ts", line: 1, symbol: "row" }];
		const { deps: d } = deps(investigation(entry("src/a.ts", { truncated: true, callers }), entry("src/b.ts")));
		expect(planReviewChunks(files, cwd, d).warnings).toEqual([]);
	});
});
