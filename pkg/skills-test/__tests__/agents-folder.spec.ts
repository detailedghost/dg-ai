import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

function trackedAgentFiles(): string[] {
	const out = Bun.spawnSync(["git", "ls-files", "-z", ".agents"], {
		cwd: REPO_ROOT,
	}).stdout.toString();
	return out.split("\0").filter(Boolean);
}

describe(".agents folder", () => {
	test("holds tracked files", () => {
		expect(trackedAgentFiles().length).toBeGreaterThan(0);
	});

	test("commits no empty file", () => {
		const empty = trackedAgentFiles().filter(
			(file) => statSync(join(REPO_ROOT, file)).size === 0,
		);
		expect(empty).toEqual([]);
	});
});
