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

function skillFile(path: string): string {
	const absolute = join(PROTO_SKILL, path);
	expect(existsSync(absolute)).toBe(true);
	return readFileSync(absolute, "utf8");
}

describe("proto skill", () => {
	test("documents the ordered workflow and explicit same-slug reject loop", () => {
		const skill = skillFile("references/extension.md");
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
			skillFile("references/extension.md"),
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
		const skill = skillFile("references/extension.md");
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

		expect(commands).toContain("~/.dg/bin/dg-skills");
		expect(commands).toContain("pkg/skills-cli");
		expect(commands).toContain("bootstrap.sh");
		expect(commands).toContain("browser-batch-installed");
		expect(commands).toMatch(/browser skill.+install/i);
		expect(commands).toMatch(/timed out|times out/i);
		for (const command of [
			"proto --ext scrape",
			"proto --ext plant",
			"proto --ext cleanup",
		]) {
			expect(commands).toContain(command);
		}
		for (const contract of ["StyleGuide", "ProtoPlan", "Verdict"]) {
			expect(contracts).toContain(contract);
		}
	});

	test("uses one-level references that all exist, and valid UI invocation metadata", () => {
		const skill = skillFile("SKILL.md");
		const metadata = skillFile("agents/openai.yaml");
		const links = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map(
			(match) => match[1],
		);

		expect([...new Set(links)].sort()).toEqual([
			"references/extension.md",
			"references/local-build.md",
			"references/local-formats.md",
			"references/local-logic.md",
			"references/local-plan.md",
			"references/local-ui.md",
		]);
		for (const link of links) {
			expect(link.split("/")).toHaveLength(2);
			expect(skillFile(link)).not.toContain("TODO");
		}
		expect(metadata).toContain("$proto");
		expect(skill).not.toContain("TODO");
	});
});

describe("proto skill local mode", () => {
	const flagsTable = (skill: string): string[][] =>
		skill
			.split("## Flags")[1]
			?.split("\n## ")[0]
			?.split("\n")
			.filter((line) => line.startsWith("|"))
			.slice(2)
			.map((row) =>
				row
					.replace(/^\||\|$/g, "")
					.split("|")
					.map((cell) => cell.trim()),
			) ?? [];

	test("leads the description with the local mode and makes it the default", () => {
		const skill = skillFile("SKILL.md");
		const description = /^description: (.+)$/m.exec(skill)?.[1] ?? "";
		expect(description.indexOf("local mode")).toBeGreaterThanOrEqual(0);
		expect(description.indexOf("local mode")).toBeLessThan(
			description.indexOf("--ext"),
		);
		expect(skill).not.toMatch(/^requires:/m);
		const ext = flagsTable(skill).find((row) => row[0]?.includes("`--ext`"));
		expect(ext?.[3]).toMatch(/off \(local is the default\)/);
		expect(skill).toMatch(/Plain `\/dg:proto` runs the \*\*local mode\*\*/);
	});

	test("documents every skill flag with its short form and default", () => {
		const rows = flagsTable(skillFile("SKILL.md"));
		const byFlag = (flag: string) => rows.find((row) => row[0]?.includes(flag));
		expect(rows.every((row) => row.length === 4)).toBe(true);
		for (const [flag, short] of [
			["--ext", "none"],
			["--count", "`-n`"],
			["--options", "`-o`"],
			["--continue", "`-c`"],
			["--light", "none"],
			["--publish", "none"],
			["--self-contained", "none"],
			["--series", "none"],
		]) {
			expect(byFlag(flag as string)?.[1]).toBe(short as string);
		}
		expect(byFlag("--count")?.[3]).toBe("5 local, 3 with `--ext`");
	});

	test("records the behavior change for plain /dg:proto and the --ext command form", () => {
		const skill = skillFile("SKILL.md");
		expect(skill).toMatch(/Behavior change[\s\S]*now runs the local\s+mode/);
		expect(skill).toContain("dg-skills proto --ext plant <plan>");
	});

	test("has no viz dependency and no private or legacy helper paths", () => {
		const files = [
			"SKILL.md",
			"references/local-build.md",
			"references/local-formats.md",
			"references/local-logic.md",
			"references/local-plan.md",
			"references/local-ui.md",
			"assets/README.md",
		];
		for (const file of files) {
			const text = skillFile(file);
			expect(text).not.toMatch(/\/viz\b/);
			expect(text).not.toMatch(/prototype-cli|prototype-ui\b|prototype-serve\b/);
			expect(text).not.toMatch(/\$\(stash|~\/scripts|\.claude\/(skills|plans)/);
		}
	});

	test("the React switcher re-enables its buttons on every submit outcome", () => {
		const source = skillFile("assets/PrototypeSwitcher.tsx");
		expect(source).toContain(".finally(() => setSubmitting(false))");
		expect(source).not.toContain("sendBeacon");
	});

	test("ships the copyable switcher and endpoint assets", () => {
		for (const file of [
			"assets/PrototypeSwitcher.tsx",
			"assets/PrototypeSwitcher.astro",
			"assets/prototype-decision-bar.html",
			"assets/prototype-endpoint.ts",
			"assets/prototype-endpoint.next.ts",
			"assets/prototype-endpoint.astro.ts",
			"assets/webmcp-tools.json",
			"assets/README.md",
		]) {
			expect(skillFile(file).length).toBeGreaterThan(0);
		}
		expect(skillFile("references/local-build.md")).toContain(
			"prototype components",
		);
	});
});
