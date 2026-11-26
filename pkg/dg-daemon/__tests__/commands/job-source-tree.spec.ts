import { describe, expect, it } from "bun:test";
import { defaultJobSourceDeps, type JobSourceDeps, treeOf } from "../../src/commands/job-source";

const depsGiving = (stdout: string): JobSourceDeps => ({
	...defaultJobSourceDeps(),
	isTerminal: () => false,
	runGit: async () => ({ code: 0, stdout: `${stdout}\n`, stderr: "" }),
});

describe("treeOf", () => {
	it("returns a sha1 tree id", async () => {
		expect(await treeOf(depsGiving("a".repeat(40)), "/x")).toBe("a".repeat(40));
	});

	it("returns a sha256 tree id", async () => {
		expect(await treeOf(depsGiving("b".repeat(64)), "/x")).toBe("b".repeat(64));
	});

	it("refuses output that is not a tree id", async () => {
		await expect(treeOf(depsGiving("fatal: nope"), "/x")).rejects.toThrow(/did not give a tree id/);
	});
});
