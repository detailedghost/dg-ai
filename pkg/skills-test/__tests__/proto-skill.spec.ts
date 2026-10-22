import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROTO_SKILL = join(
	import.meta.dir,
	"..",
	"..",
	"..",
	"plugins",
	"dg",
	"skills",
	"proto",
);

const REFERENCE_DOCS = [
	"references/build.md",
	"references/commands.md",
	"references/contracts.md",
	"references/logic.md",
	"references/plan.md",
	"references/ui-generate.md",
	"references/ui.md",
];

function skillFile(path: string): string {
	const absolute = join(PROTO_SKILL, path);
	expect(existsSync(absolute)).toBe(true);
	return readFileSync(absolute, "utf8");
}

describe("proto skill", () => {
	test("is local by default, with --ext opting into the live-page flow", () => {
		const skill = skillFile("SKILL.md");
		expect(skill).toMatch(/default[^.\n]*:?\s*prototype\s*\*\*locally\*\*/i);
		expect(skill).toMatch(/\*\*`--ext`\*\*/);
		expect(skill).not.toMatch(/^requires:/m);
	});

	test("every reference doc exists, is linked one level deep, and carries no TODO", () => {
		const skill = skillFile("SKILL.md");
		for (const doc of REFERENCE_DOCS) {
			expect(skillFile(doc)).not.toContain("TODO");
			expect(skill).toContain(doc);
		}

		const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((match) => match[1]);
		expect(links.length).toBeGreaterThan(0);
		for (const link of links) {
			expect(link.split("/")).toHaveLength(2);
			expect(REFERENCE_DOCS).toContain(link);
		}
	});

	test("never tells an agent to run the unshipped /prototype slash command", () => {
		const skill = skillFile("SKILL.md");
		expect(skill).not.toMatch(/(?<![\w.])\/prototype\b/);
	});

	test("--ext documents the ordered workflow and explicit same-slug reject loop", () => {
		const full = skillFile("SKILL.md");
		const heading = /^## --ext\b/m.exec(full);
		expect(heading).not.toBeNull();
		const skill = full.slice(heading!.index);
		const orderedPhases = [
			"Understand",
			"Scrape",
			"Generate",
			"Approval",
			"Plant",
			"Claim",
			"Export",
			"Cleanup",
		];
		let prior = -1;
		for (const phase of orderedPhases) {
			const index = skill.indexOf(phase);
			expect(index).toBeGreaterThan(prior);
			prior = index;
		}
		expect(skill).toMatch(/Reject[\s\S]*feedback[\s\S]*same slug[\s\S]*re-plant[\s\S]*claim/i);
	});

	test("--ext keeps generation, safety, scratch, and cwd contracts explicit", () => {
		const all = [skillFile("SKILL.md"), skillFile("references/commands.md"), skillFile("references/contracts.md")].join(
			"\n",
		);

		expect(all).toMatch(/default[^.\n]*3/i);
		expect(all).toMatch(/(?:cap|maximum)[^.\n]*5/i);
		expect(all).toMatch(/tokens?[^.\n]*verbatim/i);
		expect(all).toMatch(/structurally different|layout.+hierarchy.+affordance/is);
		expect(all).toContain("/tmp/ai/proto/<slug>/plan.json");
		expect(all).toMatch(/target project root/i);
		expect(all).toMatch(/authenticated|private page/i);
		expect(all).toMatch(/explicit\s+confirmation/i);
	});

	test("--ext documents the optional mount selector and browser picker fallback", () => {
		const skill = skillFile("SKILL.md");
		const contracts = skillFile("references/contracts.md");

		expect(skill).toMatch(/`mountSelector`[\s\S]{0,300}optional[\s\S]{0,300}omit[\s\S]{0,300}in-browser region picker/i);
		expect(contracts).toMatch(
			/`mountSelector`[\s\S]{0,300}optional[\s\S]{0,300}omit[\s\S]{0,300}in-browser region picker/i,
		);
	});

	test("--ext documents bootstrap, precondition, timeout recovery, and all contracts", () => {
		const commands = skillFile("references/commands.md");
		const contracts = skillFile("references/contracts.md");

		expect(commands).toContain("~/.dg/bin/dg-skills");
		expect(commands).toContain("pkg/skills-cli");
		expect(commands).toContain("bootstrap.sh");
		expect(commands).toContain("browser-batch-installed");
		expect(commands).toMatch(/browser skill.+install/i);
		expect(commands).toMatch(/timed out|times out/i);
		for (const command of ["proto scrape", "proto plant", "proto cleanup"]) {
			expect(commands).toContain(command);
		}
		for (const contract of ["StyleGuide", "ProtoPlan", "Verdict"]) {
			expect(contracts).toContain(contract);
		}
	});

	test("local branches document their CLI surface through dg-skills prototype, not the retired shell tools", () => {
		const all = REFERENCE_DOCS.map((doc) => skillFile(doc)).join("\n");
		expect(all).toContain("dg-skills prototype");
		for (const retired of ["prototype-cli", "prototype-serve.ts", "prototype-ui-cli", "/home/detailedghost/scripts/bin/prototype"]) {
			expect(all).not.toContain(retired);
		}
	});

	test("rendering never routes through the retired /viz skill", () => {
		const all = [skillFile("SKILL.md"), ...REFERENCE_DOCS.map((doc) => skillFile(doc))].join("\n");
		expect(all).not.toMatch(/route[\s\S]{0,40}`?\/viz|\/viz['’]s\s+local/i);
	});

	test("has valid UI invocation metadata for both the local default and --ext", () => {
		const metadata = skillFile("agents/openai.yaml");
		expect(metadata).toContain("$proto");
		expect(metadata.toLowerCase()).toContain("--ext");
		expect(skillFile("SKILL.md")).not.toContain("TODO");
	});
});
