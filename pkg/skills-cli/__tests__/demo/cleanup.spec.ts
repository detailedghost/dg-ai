import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { captureBaseline, cleanupOwnedArtifacts } from "../../src/demo/cleanup";
import { git, makeGitRepo } from "../git-repo-fixtures";

const DEMO_ARTIFACT_PATTERNS = [/^before-(light|dark)\.png$/, /^after-(light|dark)\.png$/, /^recording\.webm$/];

describe("owned-artifact cleanup", () => {
	test("removes only new files matching an owned pattern, never a pre-existing untracked file", async () => {
		const repo = makeGitRepo();
		Bun.write(join(repo, "notes.txt"), "pre-existing, unrelated work in progress");

		const baseline = await captureBaseline(repo);

		Bun.write(join(repo, "before-light.png"), "x");
		Bun.write(join(repo, "after-dark.png"), "x");
		Bun.write(join(repo, "recording.webm"), "x");

		const removed = await cleanupOwnedArtifacts(repo, baseline, DEMO_ARTIFACT_PATTERNS);

		expect(new Set(removed)).toEqual(
			new Set(["before-light.png", "after-dark.png", "recording.webm"]),
		);
		expect(existsSync(join(repo, "before-light.png"))).toBe(false);
		expect(existsSync(join(repo, "after-dark.png"))).toBe(false);
		expect(existsSync(join(repo, "recording.webm"))).toBe(false);
		expect(existsSync(join(repo, "notes.txt"))).toBe(true);
	});

	test("never deletes a path present in the baseline, even if it matches an owned pattern", async () => {
		const repo = makeGitRepo();
		Bun.write(join(repo, "before-light.png"), "already here before this run started");

		const baseline = await captureBaseline(repo);
		const removed = await cleanupOwnedArtifacts(repo, baseline, DEMO_ARTIFACT_PATTERNS);

		expect(removed).toEqual([]);
		expect(existsSync(join(repo, "before-light.png"))).toBe(true);
	});

	test("never deletes a new file that doesn't match an owned pattern", async () => {
		const repo = makeGitRepo();
		const baseline = await captureBaseline(repo);

		Bun.write(join(repo, "unrelated-new-file.txt"), "something else wrote this mid-run");
		const removed = await cleanupOwnedArtifacts(repo, baseline, DEMO_ARTIFACT_PATTERNS);

		expect(removed).toEqual([]);
		expect(existsSync(join(repo, "unrelated-new-file.txt"))).toBe(true);
	});

	test("baseline includes tracked-but-modified files, so an owned-looking edit to a tracked file is never swept", async () => {
		const repo = makeGitRepo();
		Bun.write(join(repo, "recording.webm"), "v1");
		git(["add", "recording.webm"], repo);
		git(["commit", "-q", "-m", "seed"], repo);
		Bun.write(join(repo, "recording.webm"), "v2 modified before baseline");

		const baseline = await captureBaseline(repo);
		Bun.write(join(repo, "recording.webm"), "v3 modified again during the run");
		const removed = await cleanupOwnedArtifacts(repo, baseline, DEMO_ARTIFACT_PATTERNS);

		expect(removed).toEqual([]);
		expect(existsSync(join(repo, "recording.webm"))).toBe(true);
	});

	test("resolves to an empty, harmless baseline outside a git repository", async () => {
		const { makeTempDir } = await import("../git-repo-fixtures");
		const notARepo = makeTempDir();
		const baseline = await captureBaseline(notARepo);
		expect(baseline.size).toBe(0);
		Bun.write(join(notARepo, "before-light.png"), "x");
		const removed = await cleanupOwnedArtifacts(notARepo, baseline, DEMO_ARTIFACT_PATTERNS);
		expect(removed).toEqual([]);
		expect(existsSync(join(notARepo, "before-light.png"))).toBe(true);
	});
});
