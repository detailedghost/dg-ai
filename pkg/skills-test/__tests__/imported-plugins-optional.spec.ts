import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	importedPlugins,
	optionalPluginViolations,
	readMarketplace,
} from "./marketplace-support";
import { makeTempDir, removeTempDirs } from "./test-support";

afterEach(removeTempDirs);

function fixtureTree(files: Record<string, string>): string {
	const root = makeTempDir("dg-optional-plugins-");
	for (const [rel, text] of Object.entries(files)) {
		const path = join(root, rel);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, text);
	}
	return root;
}

describe("imported plugins stay optional in plugins/dg", () => {
	const names = importedPlugins(readMarketplace()).map((plugin) => plugin.name);

	test("the marketplace lists both imported plugins", () => {
		expect(names).toEqual(expect.arrayContaining(["unslop", "mattpocock-skills"]));
	});

	test("the tree passes", () => {
		expect(optionalPluginViolations(names)).toEqual([]);
	});
});

describe("optionalPluginViolations", () => {
	test("fails when a skill says Run /unslop:unslop without the guard sentence", () => {
		const root = fixtureTree({
			"skills/x/SKILL.md": "---\nname: x\n---\nRun /unslop:unslop over the draft.\n",
		});
		const problems = optionalPluginViolations(["unslop"], root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("skills/x/SKILL.md");
	});

	test("fails when a file names P@detailedghost without the guard sentence", () => {
		const root = fixtureTree({
			"skills/x/ref.md": "Install with unslop@detailedghost.\n",
		});
		expect(optionalPluginViolations(["unslop"], root)).toHaveLength(1);
	});

	test("fails for a mention in a non-markdown file", () => {
		const root = fixtureTree({ "skills/x/run.ts": "const cmd = '/unslop:unslop';\n" });
		const problems = optionalPluginViolations(["unslop"], root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("skills/x/run.ts");
	});

	test("passes when the same file carries the guard sentence", () => {
		const root = fixtureTree({
			"skills/x/SKILL.md":
				"When /unslop:unslop is not installed, skip this step.\nRun /unslop:unslop.\n",
		});
		expect(optionalPluginViolations(["unslop"], root)).toEqual([]);
	});

	test("a guard sentence in a different file does not cover the mention", () => {
		const root = fixtureTree({
			"skills/a/SKILL.md": "Run /unslop:unslop.\n",
			"skills/b/SKILL.md": "unslop is not installed, skip it.\n",
		});
		expect(optionalPluginViolations(["unslop"], root)).toHaveLength(1);
	});

	test("a guard naming one plugin does not cover a mention of another", () => {
		const root = fixtureTree({
			"skills/x/SKILL.md":
				"Run /unslop:unslop and /mattpocock-skills:grill-me.\nunslop is not installed, skip it.\n",
		});
		const problems = optionalPluginViolations(["unslop", "mattpocock-skills"], root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("mattpocock-skills");
	});

	test("fails when requires: frontmatter names the plugin", () => {
		const root = fixtureTree({
			"skills/x/SKILL.md":
				"---\nname: x\nrequires:\n  - unslop\n---\nBody is not installed, skip.\n",
		});
		const problems = optionalPluginViolations(["unslop"], root);
		expect(problems.join("\n")).toMatch(/requires:/);
	});

	test("ignores requires: entries that only contain the name as a substring", () => {
		const root = fixtureTree({
			"skills/x/SKILL.md": "---\nname: x\nrequires:\n  - unslop-extra\n---\nBody.\n",
		});
		expect(optionalPluginViolations(["unslop"], root)).toEqual([]);
	});

	test("checks the plugin named, not other plugins", () => {
		const root = fixtureTree({ "skills/x/SKILL.md": "Run /mattpocock-skills:grill-me.\n" });
		expect(optionalPluginViolations(["unslop"], root)).toEqual([]);
		expect(optionalPluginViolations(["mattpocock-skills"], root)).toHaveLength(1);
	});
});
