import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const MEMORY_TAIL =
	"When `.agents/decisions/README.md` exists, run `dg-skills adr relevant <files> --json` and read only the listed decisions. Never read `docs/adr`; it is for people.";

const MEMORY_LINE = new RegExp(
	`Memory: read \`\\.agents/school/[a-z]+\\.md\`\\. ${MEMORY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

const NO_MEMORY = ["checkpoint", "copilot-antagonist", "thrash", "thrash-consolidate", "thrash-verify"];

const BUILD_SKILLS = ["sdlc", "spec", "pickup", "kick", "address", "land"];

const READS_HUMAN_ADR = /\b(?:read|open|consult|load)s?\b[^.\n]*`?docs\/adr/i;

function agentFiles(): string[] {
	return [...new Bun.Glob("*.md").scanSync(join(REPO_ROOT, "plugins", "dg", "agents"))].sort();
}

function buildSkillFiles(): string[] {
	return BUILD_SKILLS.flatMap((skill) =>
		[...new Bun.Glob("**/*.md").scanSync(join(REPO_ROOT, "plugins", "dg", "skills", skill))].map((file) =>
			join("plugins", "dg", "skills", skill, file),
		),
	);
}

function readsHumanAdr(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => READS_HUMAN_ADR.test(line.replace(/Never read `docs\/adr`/g, "")));
}

describe("agents read .agents, not docs/adr", () => {
	test("every persona carries the shared memory line", () => {
		const missing = agentFiles()
			.filter((file) => !NO_MEMORY.includes(file.replace(/\.md$/, "")))
			.filter((file) => !MEMORY_LINE.test(readRepoFile("plugins", "dg", "agents", file)));
		expect(missing).toEqual([]);
	});

	test("the exempt personas exist, so the list stays honest", () => {
		const names = agentFiles().map((file) => file.replace(/\.md$/, ""));
		for (const name of NO_MEMORY) expect(names).toContain(name);
	});

	test("no persona or build skill tells an agent to read docs/adr", () => {
		const files = [...agentFiles().map((file) => join("plugins", "dg", "agents", file)), ...buildSkillFiles()];
		const hits = files.flatMap((file) => readsHumanAdr(readRepoFile(file)).map((line) => ({ file, line })));
		expect(hits).toEqual([]);
	});

	test("the AGENTS.md template routes agents to .agents and keeps docs/adr human-only", () => {
		const templates = readRepoFile("plugins", "dg", "skills", "agent-seed", "references", "templates.md");
		expect(templates).toContain(
			"Agents read `.agents/`: decisions, school, references, monolith, paths. `docs/adr` is human-only.",
		);
	});

	test("the lore template promotes durable learnings into school", () => {
		const lore = readRepoFile("plugins", "dg", "skills", "sdlc", "references", "templates", "lore.md");
		expect(lore).toContain("`.agents/school/<topic>.md`");
		expect(lore).toMatch(/one dated line/);
		expect(lore).toMatch(/dedup/i);
		expect(lore).toMatch(/decision pair/);
		expect(lore).toMatch(/prune the oldest/i);
	});

	test("structure.md and write-decision.md carry the token caps", () => {
		const structure = readRepoFile("plugins", "dg", "skills", "spring-break", "references", "structure.md");
		expect(structure).toMatch(/\| `\.agents\/decisions\/NNNN-\*\.md` \| 25 non-blank lines/);
		expect(structure).toMatch(/\| `\.agents\/references\/\*\.md` \| 150 lines, then split by topic/);
		const decision = readRepoFile("plugins", "dg", "skills", "adr", "references", "write-decision.md");
		expect(decision).toMatch(/25 non-blank lines/);
	});
});
