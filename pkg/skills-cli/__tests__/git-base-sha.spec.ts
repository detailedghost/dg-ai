import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { resolveBaseSha } from "../src/utils/git";
import { git, makeGitRepo } from "./git-repo-fixtures";

let repo: string;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	repo = makeGitRepo();
	git(["commit", "-q", "--allow-empty", "-m", "base"], repo);
	process.chdir(repo);
});

afterEach(() => {
	process.chdir(originalCwd);
	rmSync(repo, { recursive: true, force: true });
});

describe("resolveBaseSha", () => {
	test("rejects an override ref that looks like an option", async () => {
		await expect(resolveBaseSha("--exec-path")).rejects.toThrow();
	});

	test("resolves an override ref to its commit", async () => {
		const sha = git(["rev-parse", "HEAD"], repo).trim();
		expect(await resolveBaseSha("HEAD")).toBe(sha);
	});

	test("uses the local branch when the remote is configured but unreachable", async () => {
		git(["remote", "add", "origin", "/nonexistent/offline-remote"], repo);
		git(["branch", "-m", "master"], repo);
		git(["commit", "-q", "--allow-empty", "-m", "ahead"], repo);
		git(["update-ref", "refs/remotes/origin/master", "HEAD~1"], repo);
		const base = git(["rev-parse", "HEAD~1"], repo).trim();
		expect(await resolveBaseSha()).toBe(base);
	});

	test("probes origin/master when origin/HEAD is unset and origin/main is absent", async () => {
		git(["remote", "add", "origin", "/nonexistent/offline-remote"], repo);
		git(["branch", "-m", "master"], repo);
		const base = git(["rev-parse", "HEAD"], repo).trim();
		git(["update-ref", "refs/remotes/origin/master", base], repo);
		git(["commit", "-q", "--allow-empty", "-m", "ahead"], repo);
		expect(await resolveBaseSha()).toBe(base);
	});
});
