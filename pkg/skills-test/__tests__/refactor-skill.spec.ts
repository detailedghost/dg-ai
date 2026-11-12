import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, REPO_ROOT, removeTempDirs } from "./test-support";

const SKILL_DIR = join(REPO_ROOT, "plugins", "dg", "skills", "refactor");
const CLI_DIR = join(REPO_ROOT, "pkg", "skills-cli");

const read = (path: string): string => readFileSync(path, "utf8");
const collapse = (text: string): string => text.replace(/\s+/g, " ");

const skill = read(join(SKILL_DIR, "SKILL.md"));
const discovery = read(join(SKILL_DIR, "references", "discovery.md"));

afterAll(removeTempDirs);

describe("refactor first-run block", () => {
	const fence = /```bash\n([\s\S]*?)\n```/.exec(skill)?.[1] ?? "";

	test("probes thrash --help for investigate inside the first-run fence", () => {
		expect(fence).toContain("dg-skills thrash --help 2>/dev/null | grep -q investigate");
		expect(fence).toContain("dg-skills stash --help");
	});

	test("names stash and thrash in the doctor line", () => {
		expect(skill).toContain("If a step fails, run dg-skills doctor stash thrash.");
	});

	test("the real thrash help lists investigate", () => {
		const home = makeTempDir("refactor-help-home-");
		const proc = Bun.spawnSync(["bun", "run", "src/index.ts", "thrash", "--help"], {
			cwd: CLI_DIR,
			env: { PATH: process.env.PATH ?? "", HOME: home },
		});
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		expect(proc.stdout.toString()).toContain("investigate");
	});
});

describe("refactor SKILL.md phase sequence", () => {
	const text = collapse(skill);

	test("says 4 at most and never exactly 4", () => {
		expect(text).toContain("4 at most");
		expect(text).not.toMatch(/exactly 4/i);
		expect(text).toContain("surfaces up to 4 verified");
	});

	test("runs one investigate call and skips the attach step on a non-zero exit", () => {
		expect(text).toContain("dg-skills thrash investigate");
		expect(text).toContain("Never pass a directory");
		expect(text).toContain("40 paths at most");
		expect(text).toMatch(/exits non-zero .* skip the attach step, say so, and continue/);
	});

	test("verifies each candidate before it is shown", () => {
		expect(text).toContain("`dg:thrash-verify`");
		expect(text).toContain("one message");
		expect(text).toContain("`root` of the investigate JSON, or the scope path");
		expect(text).toContain("Never resume a verifier");
		expect(text).toContain("`confirmed` or `adjusted`");
	});

	test("covers the 2 to 4, 1 and 0 candidate cases", () => {
		expect(text).toContain("2 to 4 verified candidates");
		expect(text).toMatch(/1 verified candidate: `AskUserQuestion` has two options/);
		expect(text).toMatch(/0 verified candidates: send a plain message, with no `AskUserQuestion`/);
		expect(text).toContain("how many had no verdict");
	});
});

describe("refactor discovery.md", () => {
	const text = collapse(discovery);

	test("names the investigate call and the verifier", () => {
		expect(discovery).toContain("dg-skills thrash investigate");
		expect(discovery).toContain("dg:thrash-verify");
	});

	for (const field of [
		"root",
		"files[].path",
		"symbols",
		"dependents",
		"callers[].path",
		"callers[].line",
		"callers[].symbol",
		"tests",
		"truncated",
	]) {
		test(`names the investigate field ${field}`, () => {
			expect(discovery).toContain(`\`${field}\``);
		});
	}

	test("names the task and verdict stash paths", () => {
		expect(discovery).toContain("$(dg-skills stash refactor <id>.task.json)");
		expect(discovery).toContain("$(dg-skills stash refactor <id>.verdict.json)");
	});

	test("removes old verdict files before the verifiers launch", () => {
		const remove = 'rm -f "$(dg-skills stash refactor <id>.verdict.json)"';
		expect(discovery).toContain(remove);
		expect(discovery.indexOf(remove)).toBeLessThan(discovery.indexOf("Launch one `dg:thrash-verify`"));
	});

	test("lists the task fields with no tier and the verifier prompt line", () => {
		expect(text).toContain("`id`, `path`, `line`, `title`, `body`, `evidence`");
		expect(text).toContain("It has no `tier`");
		expect(text).toContain("verify the facts in title and body about the code");
		expect(text).toContain("5 entries at most");
	});

	test("gives the verifier no shell step", () => {
		expect(text).toContain("no shell step");
		expect(text).toContain("writes only the verdict file");
	});

	test("has the Verified and Callers lines with the N+ form", () => {
		expect(discovery).toContain("**Verified**");
		expect(discovery).toContain("**Callers**");
		expect(discovery).toContain("`N+`");
	});

	test("drops the exactly 4 rule and the low-confidence fill", () => {
		expect(text).not.toMatch(/exactly 4/i);
		expect(discovery).not.toContain("[low-confidence]");
		expect(discovery).toContain("decline each candidate");
		expect(discovery).not.toContain("decline all four");
	});
});
