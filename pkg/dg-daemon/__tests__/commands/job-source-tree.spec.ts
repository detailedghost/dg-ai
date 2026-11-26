import { describe, expect, it } from "bun:test";
import { defaultJobSourceDeps, git, type JobSourceDeps, treeOf } from "../../src/commands/job-source";

const depsGiving = (stdout: string): JobSourceDeps => ({
	...defaultJobSourceDeps(),
	isTerminal: () => false,
	runGit: async () => ({ code: 0, stdout: `${stdout}\n`, stderr: "" }),
});

const runnerGiving = (stdout: string) => (args: string[], cwd: string) => git(depsGiving(stdout), args, cwd);

describe("treeOf", () => {
	it("returns a sha1 tree id", async () => {
		expect(await treeOf(runnerGiving("a".repeat(40)), "/x")).toBe("a".repeat(40));
	});

	it("returns a sha256 tree id", async () => {
		expect(await treeOf(runnerGiving("b".repeat(64)), "/x")).toBe("b".repeat(64));
	});

	it("refuses output that is not a tree id", async () => {
		await expect(treeOf(runnerGiving("fatal: nope"), "/x")).rejects.toThrow(/did not give a tree id/);
	});
});
