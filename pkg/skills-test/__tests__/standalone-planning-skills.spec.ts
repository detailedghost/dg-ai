import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILL_ROOT = join(REPO_ROOT, "plugins", "dg", "skills");
const STANDALONE = ["kick", "pickup", "prd", "wayfinder", "refactor", "agent-seed", "grill-me"];

/** Commands and files that do not ship with dg. `.agents/spec/` is a directory, not one of these. */
const UNSHIPPED = [
	/(?<![\w.])\/spec\b/,
	/(?<![\w.])\/assign\b/,
	/(?<![\w.])\/viz\b/,
	/(?<![\w.])\/create-spec\b/,
	/(?<![\w.])\/spring-break\b/,
	/(?<![\w.])\/monolith\b/,
	/(?<![\w.])\/jot\b/,
	/(?<![\w.])\/prototype\b/,
	/\bspec-cli\b/,
	/spec\/references\/(?:plan|execute)\.md/,
	/create-specs/,
];

function markdownFiles(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
		else if (name.endsWith(".md")) out.push(path);
	}
	return out;
}

describe("planning skills stand alone", () => {
	test("kick, pickup, prd, wayfinder, refactor, agent-seed, and grill-me do not require unshipped commands", () => {
		const hits: string[] = [];
		for (const skill of STANDALONE) {
			for (const file of markdownFiles(join(SKILL_ROOT, skill))) {
				const text = readFileSync(file, "utf8");
				for (const pattern of UNSHIPPED) {
					if (pattern.test(text)) hits.push(`${relative(REPO_ROOT, file)} matches ${pattern}`);
				}
			}
		}
		expect(hits).toEqual([]);
	});

	test("kick and pickup describe the bundle they write without a missing reference", () => {
		const kick = readFileSync(join(SKILL_ROOT, "kick", "SKILL.md"), "utf8");
		const pickup = readFileSync(join(SKILL_ROOT, "pickup", "SKILL.md"), "utf8");
		expect(kick).toContain("status: deferred");
		expect(kick).toContain("/grill-me");
		expect(kick).toContain(".agents/spec/");
		expect(pickup).toContain("status");
		expect(pickup).toContain("plan.md");
		expect(pickup).toContain("context.md");
		expect(pickup).not.toContain("execute.md");
		expect(kick).not.toContain("plan.md](");
	});
});
