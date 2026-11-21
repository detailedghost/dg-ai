import { describe, expect, test } from "bun:test";
import { REPO_ROOT, readRepoFile } from "./test-support";

function gitGrep(pattern: string, ...paths: string[]): string[] {
	const run = Bun.spawnSync(["git", "grep", "-nE", pattern, "--", ...paths], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	return run.stdout.toString().split("\n").filter(Boolean);
}

describe("the generated completion trees", () => {
	test("bun scripts/completion-trees.ts --check exits 0", () => {
		const run = Bun.spawnSync([process.execPath, "scripts/completion-trees.ts", "--check"], {
			cwd: REPO_ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});

		expect({ code: run.exitCode, stderr: run.stderr.toString() }).toEqual({ code: 0, stderr: "" });
	}, 60_000);
});

describe("no released skill calls dg in the legacy ~/.dg/bin folder", () => {
	test("plugins holds no .dg/bin/dg path", () => {
		expect(gitGrep(String.raw`\.dg/bin/dg\b`, "plugins")).toEqual([]);
	});
});
