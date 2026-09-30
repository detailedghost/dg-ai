import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBuildScripts, resolveLocalRepo } from "../src/commands/install";

describe("localBuildScripts", () => {
	test("installs dependencies first when they are missing", () => {
		expect(localBuildScripts("chrome", false)).toEqual([
			["install"],
			["run", "build"],
		]);
	});

	test("skips the install when dependencies are present", () => {
		expect(localBuildScripts("chrome", true)).toEqual([["run", "build"]]);
	});

	test("builds the firefox bundle for the firefox target", () => {
		expect(localBuildScripts("firefox", true)).toEqual([
			["run", "build:firefox"],
		]);
	});
});

describe("resolveLocalRepo", () => {
	const fakeRepo = () => {
		const root = mkdtempSync(join(tmpdir(), "dg-repo-"));
		mkdirSync(join(root, "pkg", "extension"), { recursive: true });
		writeFileSync(join(root, "pkg", "extension", "package.json"), "{}");
		return root;
	};

	test("uses the repo passed with --repo", () => {
		const repo = fakeRepo();
		expect(resolveLocalRepo(repo, tmpdir())).toBe(repo);
	});

	test("walks up from the working directory to find the repo", () => {
		const repo = fakeRepo();
		const nested = join(repo, "pkg", "extension");
		expect(resolveLocalRepo(undefined, nested)).toBe(repo);
	});

	test("names the fix when --repo does not point at a dg repo", () => {
		expect(() => resolveLocalRepo(tmpdir(), tmpdir())).toThrow(
			"run this from inside the dg repo or pass --repo <path>",
		);
	});

	test("names the fix when the working directory is outside a dg repo", () => {
		const outside = mkdtempSync(join(tmpdir(), "dg-outside-"));
		expect(() => resolveLocalRepo(undefined, outside, outside)).toThrow(
			"no pkg/extension to build from: run this from inside the dg repo or pass --repo <path>",
		);
	});
});
