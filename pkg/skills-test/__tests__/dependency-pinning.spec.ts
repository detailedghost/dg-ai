import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const PKG_DIR = join(REPO_ROOT, "pkg");

function packageJsons(): { name: string; json: Record<string, unknown> }[] {
	return readdirSync(PKG_DIR)
		.filter(
			(entry) =>
				statSync(join(PKG_DIR, entry)).isDirectory() &&
				existsSync(join(PKG_DIR, entry, "package.json")),
		)
		.map((entry) => ({
			name: entry,
			json: JSON.parse(readRepoFile("pkg", entry, "package.json")) as Record<
				string,
				unknown
			>,
		}));
}

const MOVING_TAGS = new Set(["latest", "next", "canary", "*", ""]);
const DEP_FIELDS = [
	"dependencies",
	"devDependencies",
	"optionalDependencies",
	"peerDependencies",
] as const;

function assertNoMovingTags(deps: Record<string, string>): void {
	const moving = Object.entries(deps).filter(([, range]) =>
		MOVING_TAGS.has(range),
	);
	expect(moving).toEqual([]);
}

describe("no workspace package pins a dependency to a moving tag", () => {
	const packages = packageJsons();

	test("there are packages to check", () => {
		expect(packages.length).toBeGreaterThan(3);
	});

	for (const { name, json } of packages) {
		for (const field of DEP_FIELDS) {
			const deps = (json[field] ?? {}) as Record<string, string>;
			test(`pkg/${name}'s ${field} carry resolvable ranges, not moving tags`, () => {
				assertNoMovingTags(deps);
			});
		}
	}

	test("the root package.json is clean too", () => {
		const root = JSON.parse(readRepoFile("package.json")) as Record<
			string,
			unknown
		>;
		for (const field of DEP_FIELDS) {
			const deps = (root[field] ?? {}) as Record<string, string>;
			assertNoMovingTags(deps);
		}
	});

	test("workspace: protocol is still allowed — it resolves locally, not from the registry", () => {
		const withWorkspace = packages.filter(({ json }) =>
			Object.values((json.dependencies ?? {}) as Record<string, string>).some(
				(range) => range.startsWith("workspace:"),
			),
		);
		expect(withWorkspace.length).toBeGreaterThan(0);
	});
});
