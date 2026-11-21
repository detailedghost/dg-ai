import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILLS = join(REPO_ROOT, "plugins", "dg", "skills");
const read = (path: string): string => readFileSync(path, "utf8");
const collapse = (text: string): string => text.replace(/\s+/g, " ");

const thrash = read(join(SKILLS, "thrash", "SKILL.md"));
const address = collapse(read(join(SKILLS, "address", "SKILL.md")));
const workflow = collapse(read(join(SKILLS, "address", "references", "workflow.md")));
const reviewLoop = collapse(read(join(SKILLS, "review-loop", "SKILL.md")));

function section(text: string, heading: string): string {
	const start = text.search(new RegExp(`^${heading}$`, "m"));
	expect(start, `${heading} is missing`).toBeGreaterThanOrEqual(0);
	const rest = text.slice(start + heading.length);
	const end = rest.search(/\n## /);
	return collapse(end === -1 ? rest : rest.slice(0, end));
}

describe("thrash nested run", () => {
	const nested = (): string => section(thrash, "## Nested run");

	test("names both stage personas", () => {
		expect(nested()).toContain("dg:thrash-verify");
		expect(nested()).toContain("dg:thrash-consolidate");
	});

	test("falls back to the persona file in the plugin agents folder", () => {
		expect(nested()).toMatch(/persona file/);
		expect(nested()).toMatch(/plugin `agents\/` folder/);
		expect(nested()).toMatch(/one item at a time/);
	});

	test("falls back to a proxy job for each stage persona", () => {
		expect(nested()).toContain("dg proxy codex --subagent thrash-verify");
		expect(nested()).toContain("thrash-consolidate");
		expect(nested()).toMatch(/--subagent thrash-verify\|thrash-consolidate/);
	});

	test("prints the exact stop line when no path works", () => {
		expect(nested()).toContain(
			"thrash cannot run nested here: <reason>; run /dg:thrash . from the main loop",
		);
	});

	test("never lets a stage be skipped", () => {
		expect(nested()).toMatch(/triage, verify, apply, consolidate and compile never get skipped/i);
		expect(collapse(thrash)).not.toMatch(
			/(verify|consolidate)[^.]*(may|can) be skipped/i,
		);
	});
});

describe("nested run pointers", () => {
	test("address says phase 7 cleanup also runs in a subagent", () => {
		expect(address).toMatch(/Phase 7[^.]*also runs in a subagent/);
		expect(workflow).toMatch(/Phase 7[^.]*also runs in a subagent/);
	});

	test("review-loop points a subagent at the nested run rule", () => {
		expect(reviewLoop).toMatch(/subagent[^.]*"Nested run" rule/);
	});
});
