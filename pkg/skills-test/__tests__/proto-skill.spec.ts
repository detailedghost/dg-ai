import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROTO_SKILL = join(import.meta.dir, "..", "..", "skills", "proto");

function skillFile(path: string): string {
	const absolute = join(PROTO_SKILL, path);
	expect(existsSync(absolute)).toBe(true);
	return readFileSync(absolute, "utf8");
}

describe("proto skill", () => {
	test("documents the ordered workflow and explicit same-slug reject loop", () => {
		const skill = skillFile("SKILL.md");
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
		expect(skill).toMatch(
			/Reject[\s\S]*feedback[\s\S]*same slug[\s\S]*re-plant[\s\S]*claim/i,
		);
	});

	test("keeps generation, safety, scratch, and cwd contracts explicit", () => {
		const all = [
			skillFile("SKILL.md"),
			skillFile("references/commands.md"),
			skillFile("references/contracts.md"),
		].join("\n");

		expect(all).toMatch(/default[^.\n]*3/i);
		expect(all).toMatch(/(?:cap|maximum)[^.\n]*5/i);
		expect(all).toMatch(/tokens?[^.\n]*verbatim/i);
		expect(all).toMatch(
			/structurally different|layout.+hierarchy.+affordance/is,
		);
		expect(all).toContain("/tmp/ai/proto/<slug>/plan.json");
		expect(all).toMatch(/target project root/i);
		expect(all).toMatch(/authenticated|private page/i);
		expect(all).toMatch(/explicit\s+confirmation/i);
	});

	test("documents the optional mount selector and browser picker fallback", () => {
		const skill = skillFile("SKILL.md");
		const contracts = skillFile("references/contracts.md");

		expect(skill).toMatch(
			/`mountSelector`[\s\S]{0,300}optional[\s\S]{0,300}omit[\s\S]{0,300}in-browser region picker/i,
		);
		expect(contracts).toMatch(
			/`mountSelector`[\s\S]{0,300}optional[\s\S]{0,300}omit[\s\S]{0,300}in-browser region picker/i,
		);
	});

	test("documents bootstrap, precondition, timeout recovery, and all contracts", () => {
		const commands = skillFile("references/commands.md");
		const contracts = skillFile("references/contracts.md");

		expect(commands).toContain(".dg/bin/dg-skills");
		expect(commands).toContain("pkg/skills-cli");
		expect(commands).toContain("bootstrap.sh");
		expect(commands).toContain("browser-batch-installed");
		expect(commands).toContain("/dg:browser install");
		expect(commands).toMatch(/timed out|times out/i);
		for (const command of ["proto scrape", "proto plant", "proto cleanup"]) {
			expect(commands).toContain(command);
		}
		for (const contract of ["StyleGuide", "ProtoPlan", "Verdict"]) {
			expect(contracts).toContain(contract);
		}
	});

	test("uses one-level references and valid UI invocation metadata", () => {
		const skill = skillFile("SKILL.md");
		const metadata = skillFile("agents/openai.yaml");
		const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(
			(match) => match[1],
		);

		expect(links.sort()).toEqual([
			"references/commands.md",
			"references/contracts.md",
		]);
		for (const link of links) {
			expect(link.split("/")).toHaveLength(2);
			expect(skillFile(link)).not.toContain("TODO");
		}
		expect(metadata).toContain("$proto");
		expect(skill).not.toContain("TODO");
	});
});
