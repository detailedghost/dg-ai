import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILL_ROOT = join(REPO_ROOT, "plugins", "dg", "skills");

const SKILL_COMMANDS = [
	"spec",
	"assign",
	"create-spec",
	"spring-break",
	"monolith",
	"jot",
	"prototype",
];

const PENDING_UNSHIPPED_COMMANDS: string[] = [];

const RETIRED = [/\bspec-cli\b/, /create-specs/];

const MIGRATION_SKILLS = new Set(["spring-break"]);

function appliesTo(skill: string, pattern: RegExp): boolean {
	return !(MIGRATION_SKILLS.has(skill) && /create-spec/.test(pattern.source));
}

function isShipped(command: string): boolean {
	return existsSync(join(SKILL_ROOT, command, "SKILL.md"));
}

function bannedPatterns(): RegExp[] {
	return [
		...SKILL_COMMANDS.filter(
			(command) =>
				!isShipped(command) && !PENDING_UNSHIPPED_COMMANDS.includes(command),
		).map((command) => new RegExp(`(?<![\\w.])/${command}\\b`)),
		...RETIRED,
	];
}

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
	test("no shipped skill requires an unshipped command", () => {
		const hits: string[] = [];
		const banned = bannedPatterns();
		const skills = readdirSync(SKILL_ROOT).filter((name) =>
			statSync(join(SKILL_ROOT, name)).isDirectory(),
		);
		for (const skill of skills) {
			for (const file of markdownFiles(join(SKILL_ROOT, skill))) {
				const text = readFileSync(file, "utf8");
				for (const pattern of banned) {
					if (appliesTo(skill, pattern) && pattern.test(text))
						hits.push(`${relative(REPO_ROOT, file)} matches ${pattern}`);
				}
			}
		}
		expect(hits).toEqual([]);
	});

	test("pending allowances name only commands that have not shipped yet", () => {
		expect(PENDING_UNSHIPPED_COMMANDS.filter(isShipped)).toEqual([]);
	});

	test("kick and pickup describe the bundle they write and hand off to the shipped skills", () => {
		const kick = readFileSync(join(SKILL_ROOT, "kick", "SKILL.md"), "utf8");
		const pickup = readFileSync(join(SKILL_ROOT, "pickup", "SKILL.md"), "utf8");
		expect(kick).toContain("status: deferred");
		expect(kick).toContain("/grill-me");
		expect(kick).toContain(".agents/spec/");
		expect(pickup).toContain("plan.md status in-progress");
		expect(pickup).toContain("plan.md");
		expect(pickup).toContain("context.md");
		expect(kick).toContain("../spec/references/plan.md");
		expect(pickup).toContain("../spec/references/execute.md");
	});
});
