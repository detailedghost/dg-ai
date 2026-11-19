import { describe, expect, test } from "bun:test";
import { readRepoFile } from "./test-support";

const skillFile = (...parts: string[]) =>
	readRepoFile("plugins", "dg", "skills", ...parts);

const TEMPLATES = ["sdlc", "references", "templates"];
const ENGINEERING = skillFile(...TEMPLATES, "slice-engineering.md");
const ENGINEERING_PROXY = skillFile(...TEMPLATES, "slice-engineering-proxy.md");
const LORE = skillFile(...TEMPLATES, "lore.md");
const FINISH = skillFile("sdlc", "references", "finish.md");
const EXECUTE = skillFile("spec", "references", "execute.md");
const LAND_SKILL = skillFile("land", "SKILL.md");
const LAND_WORKFLOW = skillFile("land", "references", "workflow.md");
const LAND = `${LAND_SKILL}\n${LAND_WORKFLOW}`;
const OPT_IN = ".agents/decisions/README.md";

describe("adr build wiring: slice engineering templates", () => {
	for (const [name, text] of [
		["slice-engineering.md", ENGINEERING],
		["slice-engineering-proxy.md", ENGINEERING_PROXY],
	] as const) {
		test(`${name} reads relevant decisions when opted in`, () => {
			expect(text).toContain(OPT_IN);
			expect(text).toContain("dg-skills adr relevant");
			expect(text).toContain("--json");
		});
	}
});

describe("adr build wiring: lore template", () => {
	test("updates records, then indexes and lints before the docs commit", () => {
		expect(LORE).toContain(OPT_IN);
		expect(LORE).toContain("dg-skills adr relevant");
		expect(LORE).toContain("dg-skills adr index");
		expect(LORE).toContain("dg-skills adr lint --changed");
	});

	test("ratifies a new pair and never writes one", () => {
		expect(LORE).toContain('⚑ RATIFY: new ADR "<title>"');
		expect(LORE).not.toContain("adr new");
	});
});

describe("adr build wiring: finish and execute", () => {
	test("finish step 6 points at the lore template without repeating commands", () => {
		const from = FINISH.indexOf("## Step 6");
		const to = FINISH.indexOf("## Step 7");
		expect(from).toBeGreaterThanOrEqual(0);
		expect(to).toBeGreaterThan(from);
		const step6 = FINISH.slice(from, to);
		expect(step6).toContain("templates/lore.md");
		expect(step6).toContain(OPT_IN);
		expect(step6).not.toContain("adr relevant");
		expect(step6).not.toContain("adr lint");
		expect(step6).not.toContain("adr index");
	});

	test("spec execute.md points at the sdlc adr steps", () => {
		expect(EXECUTE).toContain("finish.md");
		expect(EXECUTE).toContain("Opted-in repos (`.agents/decisions/README.md` exists)");
	});
});

describe("adr build wiring: land", () => {
	test("gates on the opt-in file and the CLI probe", () => {
		expect(LAND_WORKFLOW).toContain(OPT_IN);
		expect(LAND_WORKFLOW).toContain("dg-skills adr --help");
		expect(LAND).toContain("adr-cli-missing");
		expect(LAND_WORKFLOW).toContain("land: adr-cli-missing");
	});

	test("lints against the PR base branch, never the -b value", () => {
		expect(LAND_WORKFLOW).toContain("git fetch");
		expect(LAND_WORKFLOW).toContain("dg-skills adr lint --changed --base 'origin/<baseRefName>'");
		expect(LAND_WORKFLOW).toMatch(/never[^\n]*`-b`/i);
	});

	test("routes lint failures through /dg:address -l and stops on a repeat", () => {
		expect(LAND_WORKFLOW).toContain(".agents/code-review/");
		expect(LAND_WORKFLOW).toContain("/dg:address -l");
		expect(LAND_WORKFLOW).toMatch(/CI-fix cycle/);
		expect(LAND).toContain("adr-lint-repeat");
		expect(LAND_WORKFLOW).toContain("land: adr-lint-repeat");
	});

	test("the Flow table and step 3 mention the adr lint", () => {
		const from = LAND_SKILL.indexOf("## Flow");
		const to = LAND_SKILL.indexOf("Read [references/workflow.md]");
		expect(from).toBeGreaterThanOrEqual(0);
		expect(to).toBeGreaterThan(from);
		const flow = LAND_SKILL.slice(from, to);
		expect(flow).toContain("adr lint");
		expect(flow).toContain("adr-lint-repeat");
	});
});
