import { describe, expect, test } from "bun:test";
import {
	importedPlugins,
	type Marketplace,
	pinViolations,
	readMarketplace,
} from "./marketplace-support";

const SHA = "a496f5513d4a4cf889bc48e189e579f4b0bdf6aa";

function marketplaceWith(source: Record<string, unknown> | string): Marketplace {
	return {
		name: "detailedghost",
		plugins: [
			{ name: "dg", source: "." },
			{ name: "extra", source: source as never },
		],
	};
}

describe("marketplace.json plugin pins", () => {
	const marketplace = readMarketplace();

	test("the dg entry installs from the repository root", () => {
		expect(marketplace.plugins.find((p) => p.name === "dg")?.source).toBe(".");
	});

	test("every imported entry is a github source with a 40-hex sha and a ref", () => {
		expect(pinViolations(marketplace)).toEqual([]);
		const imported = importedPlugins(marketplace);
		expect(imported.length).toBeGreaterThan(0);
		for (const plugin of imported) {
			expect(typeof plugin.source).toBe("object");
			const source = plugin.source as { source: string; sha?: string; ref?: string };
			expect(source.source).toBe("github");
			expect(source.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(source.ref?.length).toBeGreaterThan(0);
		}
	});

	test("mattpocock-skills is pinned without a skills key", () => {
		const entry = marketplace.plugins.find((p) => p.name === "mattpocock-skills");
		expect(entry).toBeDefined();
		expect(entry?.skills).toBeUndefined();
		expect(entry?.source).toMatchObject({
			source: "github",
			repo: "mattpocock/skills",
			ref: "main",
			sha: SHA,
		});
		expect(entry?.description?.length).toBeGreaterThan(0);
	});

	test("unslop keeps skills ['./'] at its pinned sha", () => {
		const entry = marketplace.plugins.find((p) => p.name === "unslop");
		expect(entry?.skills).toEqual(["./"]);
		expect(entry?.source).toMatchObject({
			repo: "theclaymethod/unslop",
			sha: "17ed39c9d0b522f44190ff0c6233867eadee192a",
		});
	});
});

describe("pinViolations", () => {
	test("accepts a full sha with a ref", () => {
		expect(
			pinViolations(
				marketplaceWith({ source: "github", repo: "o/r", ref: "main", sha: SHA }),
			),
		).toEqual([]);
	});

	test("fails when the sha is short", () => {
		const problems = pinViolations(
			marketplaceWith({ source: "github", repo: "o/r", ref: "main", sha: SHA.slice(0, 7) }),
		);
		expect(problems.join("\n")).toMatch(/extra: sha/);
	});

	test("fails when the sha is missing", () => {
		const problems = pinViolations(
			marketplaceWith({ source: "github", repo: "o/r", ref: "main" }),
		);
		expect(problems.join("\n")).toMatch(/extra: sha/);
	});

	test("fails when the sha is not hex", () => {
		const problems = pinViolations(
			marketplaceWith({ source: "github", repo: "o/r", ref: "main", sha: "z".repeat(40) }),
		);
		expect(problems.join("\n")).toMatch(/extra: sha/);
	});

	test("fails when the ref is missing", () => {
		const problems = pinViolations(
			marketplaceWith({ source: "github", repo: "o/r", sha: SHA }),
		);
		expect(problems.join("\n")).toMatch(/extra: ref/);
	});

	test("fails when the dg entry is not source '.'", () => {
		const marketplace = marketplaceWith({ source: "github", repo: "o/r", ref: "main", sha: SHA });
		marketplace.plugins[0] = { name: "dg", source: "./plugins/dg" };
		expect(pinViolations(marketplace).join("\n")).toMatch(/dg: source/);
	});
});
