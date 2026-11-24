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

	test("withPermission keeps CRLF line endings on every line it writes", () => {
		const cases = ["---\r\nname: x\r\n---\r\nbody\r\n", "---\r\npermissions:\r\n  a: 1\r\n---\r\nbody\r\n", "no front\r\n"];
		for (const text of cases) {
			const out = specFrontmatter.withPermission(text, "b", "2");
			expect(out).toContain("  b: 2\r\n");
			expect(out.replace(/\r\n/g, "")).not.toContain("\n");
		}
		expect(specFrontmatter.withPermission("---\r\npermissions:\r\n  b: 1\r\n---\r\n", "b", "2")).toBe("---\r\npermissions:\r\n  b: 2\r\n---\r\n");
	});

	test("frontOf returns the front matter mapping, or an empty record", () => {
		expect(utils.frontOf("---\nlevel: phd\ncovers: [a]\n---\nbody\n")).toEqual({ level: "phd", covers: ["a"] });
		for (const text of ["no front", "---\n- a\n- b\n---\n", "---\n: : [\n---\n", ""]) {
			expect(utils.frontOf(text)).toEqual({});
		}
	});
});

describe("splitDocument with CRLF", () => {
	test("accepts CRLF fences and keeps front matter parseable", () => {
		const split = utils.splitDocument("---\r\ncovers: [a]\r\n---\r\nBody\r\n");
		expect(utils.frontOf("---\r\ncovers: [a]\r\n---\r\nBody\r\n")).toEqual({ covers: ["a"] });
		expect(split.body).toBe("Body\r\n");
	});

	describe("parseYaml keeps the yaml-package rules it replaced", () => {
		test("a repeated key keeps the last value", () => {
			expect(utils.parseYaml("a: 1\na: 2")).toEqual({ ok: true, value: { a: 2 } });
		});

		test("a second document is an error, not an array", () => {
			expect(utils.parseYaml("a: 1\n---\nb: 2").ok).toBe(false);
		});

		test("one document after a leading marker still parses", () => {
			expect(utils.parseYaml("# schema\n---\na: 1\n")).toEqual({ ok: true, value: { a: 1 } });
		});

		test("a top-level list still parses", () => {
			expect(utils.parseYaml("- a\n- b")).toEqual({ ok: true, value: ["a", "b"] });
		});

		test("tab indentation is an error", () => {
			expect(utils.parseYaml("\tk: v").ok).toBe(false);
		});

		test("yes stays a string", () => {
			expect(utils.parseYaml("on: yes")).toEqual({ ok: true, value: { on: "yes" } });
		});

		test("a date stays a string", () => {
			expect(utils.parseYaml("d: 2026-11-23")).toEqual({ ok: true, value: { d: "2026-11-23" } });
		});

		test("012 is the number 12", () => {
			expect(utils.parseYaml("n: 012")).toEqual({ ok: true, value: { n: 12 } });
		});

		test("a document that ends with ... still parses", () => {
			expect(utils.parseYaml("a: 1\n...\n")).toEqual({ ok: true, value: { a: 1 } });
		});

		test("a leading marker after a CRLF blank line still parses", () => {
			expect(utils.parseYaml("\r\n---\r\na: 1\r\n")).toEqual({ ok: true, value: { a: 1 } });
		});

		test("content after a closing ... is a second document", () => {
			expect(utils.parseYaml("a: 1\n...\nb: 2\n").ok).toBe(false);
		});

		test("a CRLF second document is an error", () => {
			expect(utils.parseYaml("a: 1\r\n---\r\nb: 2\r\n").ok).toBe(false);
		});

		test("a second document after a %YAML directive is an error", () => {
			expect(utils.parseYaml("%YAML 1.2\n---\na: 1\n---\nb: 2\n").ok).toBe(false);
		});

		test("a %YAML directive before the marker still parses", () => {
			expect(utils.parseYaml("%YAML 1.2\n---\na: 1\n")).toEqual({ ok: true, value: { a: 1 } });
		});
	});
});
