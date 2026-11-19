import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./test-support";

const FENCE_PRELOAD = realpathSync(
	join(REPO_ROOT, "pkg", "skills-cli", "__tests__", "test-home-fence.ts"),
);

function preloadsFence(folder: string): boolean {
	const bunfig = join(folder, "bunfig.toml");
	if (!existsSync(bunfig)) return false;
	const parsed = Bun.TOML.parse(readFileSync(bunfig, "utf8")) as {
		test?: { preload?: string | string[] };
	};
	const preload = parsed.test?.preload ?? [];
	return [preload].flat().some((entry) => {
		const target = resolve(folder, entry);
		return existsSync(target) && realpathSync(target) === FENCE_PRELOAD;
	});
}

function packagesRunningBunTest(): string[] {
	const pkgDir = join(REPO_ROOT, "pkg");
	return readdirSync(pkgDir)
		.filter((name) => existsSync(join(pkgDir, name, "package.json")))
		.filter((name) => {
			const manifest = JSON.parse(readFileSync(join(pkgDir, name, "package.json"), "utf8"));
			return /\bbun test\b/.test(manifest.scripts?.test ?? "");
		})
		.sort();
}

describe("test home fence reach", () => {
	it("finds the packages whose test script runs bun test", () => {
		const names = packagesRunningBunTest();

		for (const expected of ["common", "dg", "dg-daemon", "dg-agent", "skills-test", "skills-cli"]) {
			expect(names).toContain(expected);
		}
	});

	it("preloads the fence in the root bunfig.toml", () => {
		expect(preloadsFence(REPO_ROOT)).toBe(true);
	});

	it("preloads the fence in the bunfig.toml of every package that runs bun test", () => {
		const unfenced = packagesRunningBunTest().filter(
			(name) => !preloadsFence(join(REPO_ROOT, "pkg", name)),
		);

		expect(unfenced).toEqual([]);
	});

	it("reports a package folder with no fence preload as unfenced", () => {
		const folder = mkdtempSync(join(tmpdir(), "dg-reach-"));
		try {
			expect(preloadsFence(folder)).toBe(false);
			writeFileSync(join(folder, "bunfig.toml"), "[test]\ntimeout = 1000\n");
			expect(preloadsFence(folder)).toBe(false);
			writeFileSync(join(folder, "bunfig.toml"), '[test]\npreload = ["./other.ts"]\n');
			expect(preloadsFence(folder)).toBe(false);
			writeFileSync(join(folder, "bunfig.toml"), `[test]\npreload = [${JSON.stringify(FENCE_PRELOAD)}]\n`);
			expect(preloadsFence(folder)).toBe(true);
		} finally {
			rmSync(folder, { recursive: true, force: true });
		}
	});
});
