import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import * as shared from "../src/spec/shared";
import * as specFrontmatter from "../src/spec/frontmatter";
import * as utils from "../src/utils/frontmatter";

const HOISTED = ["splitDocument", "parseYaml", "scalarField", "nestedScalar", "records"] as const;

describe("src/utils/frontmatter", () => {
	test.each(HOISTED)("exports %s as a function", (name) => {
		expect(typeof (utils as Record<string, unknown>)[name]).toBe("function");
	});

	test.each(["splitDocument", "parseYaml", "scalarField", "nestedScalar"] as const)(
		"spec/frontmatter re-exports the same %s",
		(name) => {
			expect(specFrontmatter[name]).toBe(utils[name]);
		},
	);

	test("spec/frontmatter keeps frontmatterOf and withPermission", () => {
		expect(typeof specFrontmatter.frontmatterOf).toBe("function");
		expect(typeof specFrontmatter.withPermission).toBe("function");
	});

	test("spec/shared re-exports the same records", () => {
		expect(shared.records).toBe(utils.records);
	});

	test("skill/audit still imports its helpers from ../spec/frontmatter", () => {
		const source = readFileSync(join(import.meta.dir, "../src/skill/audit.ts"), "utf8");
		expect(source).toMatch(/from\s+["']\.\.\/spec\/frontmatter["']/);
	});

	test("frontOf returns the front matter mapping, or an empty record", () => {
		expect(utils.frontOf("---\nlevel: phd\ncovers: [a]\n---\nbody\n")).toEqual({ level: "phd", covers: ["a"] });
		for (const text of ["no front", "---\n- a\n- b\n---\n", "---\n: : [\n---\n", ""]) {
			expect(utils.frontOf(text)).toEqual({});
		}
	});
});
