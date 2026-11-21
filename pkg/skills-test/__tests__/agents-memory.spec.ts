import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { REPO_ROOT, readRepoFile } from "./test-support";

const MEMORY_TAIL =
	"When `.agents/decisions/README.md` exists, run `dg adr relevant <files you will touch> --json` " +
	"and read only the listed decisions. Never load `docs/adr` as context; it is for people.";

const MEMORY_LINE = new RegExp(
	`Read \`\\.agents/school/[a-z]+\\.md\` \\(if present\\)\\. ${MEMORY_TAIL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
);

const NO_MEMORY = ["checkpoint", "copilot-antagonist", "thrash", "thrash-consolidate", "thrash-verify"];

const BUILD_SKILLS = ["sdlc", "spec", "pickup", "kick", "address", "land"];

const READS_HUMAN_ADR = /\b(?:read|open|consult|load)s?\b.*docs\/adr/i;

const NEGATED_ADR = /never (?:read|load) `docs\/adr`/gi;

const AGENTS_DIR = join("plugins", "dg", "agents");

function agents(): { name: string; path: string }[] {
	return [...new Bun.Glob("*.md").scanSync(join(REPO_ROOT, AGENTS_DIR))]
		.sort()
		.map((file) => ({ name: file.replace(/\.md$/, ""), path: join(AGENTS_DIR, file) }));
}

function buildSkillFiles(): string[] {
	return BUILD_SKILLS.flatMap((skill) => {
		const dir = join("plugins", "dg", "skills", skill);
		const files = [...new Bun.Glob("**/*.md").scanSync(join(REPO_ROOT, dir))];
		if (files.length === 0) throw new Error(`build skill ${skill} has no markdown files`);
		return files.map((file) => join(dir, file));
	});
}

function readsHumanAdr(text: string): string[] {
	return text.split("\n").filter((line) => READS_HUMAN_ADR.test(line.replace(NEGATED_ADR, "")));
}

describe("agents read .agents, not docs/adr", () => {
	test("every persona carries the shared memory line", () => {
		const missing = agents()
			.filter(({ name }) => !NO_MEMORY.includes(name))
			.filter(({ path }) => !MEMORY_LINE.test(readRepoFile(path)))
			.map(({ name }) => name);
		expect(missing).toEqual([]);
	});

	test("the exempt personas exist, so the list stays honest", () => {
		const names = agents().map(({ name }) => name);
		for (const name of NO_MEMORY) expect(names).toContain(name);
	});

	test("no persona or build skill tells an agent to read docs/adr", () => {
		const files = [...agents().map(({ path }) => path), ...buildSkillFiles()];
		const hits = files.flatMap((file) => readsHumanAdr(readRepoFile(file)).map((line) => ({ file, line })));
		expect(hits).toEqual([]);
	});

	test("the docs/adr guard catches a read instruction after a dotted path", () => {
		expect(readsHumanAdr("Read `.agents/decisions/README.md` and `docs/adr`.")).toHaveLength(1);
		expect(readsHumanAdr("never load `docs/adr` as context")).toHaveLength(0);
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
