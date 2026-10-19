import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	HELPER_SUBCOMMANDS,
	SCAN_ASSET,
	TEMPLATE_ASSET,
	TERM_SECTIONS,
} from "./monolith-fixtures";
import { SOURCE_SKILLS, splitFrontmatter } from "./spec-fixtures";

const SKILLS = ["monolith", "spring-break"] as const;

const REQUIRED_FILES: Record<(typeof SKILLS)[number], string[]> = {
	monolith: [
		"SKILL.md",
		"references/protocol.md",
		"references/performance.md",
		"references/scan.workflow.mjs",
		"references/template.md",
	],
	"spring-break": ["SKILL.md", "references/structure.md"],
};

const REQUIRED_MONOLITH_CALLS = [
	"bootstrap",
	"list-terms",
	"detect-conflicts",
	"apply-conflict-resolution",
	"validate",
	"cap-report",
	"split",
	"prune",
	"worktree-gen",
];

const KNOWN_MONOLITH_CALLS = new Set<string>([
	...HELPER_SUBCOMMANDS,
	"worktree-gen",
]);

function walk(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.flatMap((name) => {
			const path = join(dir, name);
			return statSync(path).isDirectory() ? walk(path) : [path];
		});
}

const trees = SKILLS.map((skill) => ({
	skill,
	files: walk(join(SOURCE_SKILLS, skill)).map((path) => ({
		path,
		name: relative(SOURCE_SKILLS, path),
		text: readFileSync(path, "utf8"),
	})),
}));

const allText = (skill: string) =>
	trees
		.find((tree) => tree.skill === skill)
		?.files.map((file) => file.text)
		.join("\n") ?? "";

function skillMd(skill: string): string {
	return readFileSync(join(SOURCE_SKILLS, skill, "SKILL.md"), "utf8");
}

describe("migrated monolith and spring-break skill trees", () => {
	test.each(SKILLS)("%s ships every file the skill reads", (skill) => {
		for (const name of REQUIRED_FILES[skill])
			expect(existsSync(join(SOURCE_SKILLS, skill, name))).toBe(true);
	});

	test.each(SKILLS)(
		"%s has a SKILL.md named for its folder with no host-only keys",
		(skill) => {
			const { data } = splitFrontmatter(skillMd(skill)) as {
				data: Record<string, unknown>;
			};
			expect(data.name).toBe(skill);
			expect(typeof data.description).toBe("string");
			expect(data).not.toHaveProperty("argument-hint");
			expect(data).not.toHaveProperty("user-invocable");
		},
	);

	test.each(trees)(
		"$skill carries no retired command, private path or user-local helper",
		({ files }) => {
			expect(files.length).toBeGreaterThan(0);
			const banned =
				/spec-cli|monolith-helper|monolith-worktree-gen|~\/scripts|~\/\.claude\/skills|\/home\/|scripts\/bin/;
			expect(
				files.filter((file) => banned.test(file.text)).map((file) => file.name),
			).toEqual([]);
		},
	);

	test.each(trees)(
		"$skill bootstraps the CLI before any quoted call",
		({ skill }) => {
			expect(skillMd(skill)).toMatch(
				/DG="\$\{DG_HOME:-\$HOME\/\.dg\}\/bin\/dg-skills"/,
			);
		},
	);

	test("every dg-skills call is quoted and every monolith verb exists", () => {
		const called = new Set<string>();
		for (const { files } of trees)
			for (const file of files) {
				expect(file.text).not.toMatch(/(?<!")\$DG(?![A-Za-z_"])/);
				for (const match of file.text.matchAll(/"\$DG" monolith ([a-z-]+)/g))
					called.add(match[1] ?? "");
			}
		for (const verb of REQUIRED_MONOLITH_CALLS)
			expect(called.has(verb)).toBe(true);
		expect(
			[...called].filter((verb) => !KNOWN_MONOLITH_CALLS.has(verb)),
		).toEqual([]);
	});

	test("the monolith protocol routes worktrees through the generator with the live and staging paths", () => {
		const protocol = readFileSync(
			join(SOURCE_SKILLS, "monolith", "references", "protocol.md"),
			"utf8",
		);
		expect(protocol).toMatch(
			/"\$DG" monolith worktree-gen "\$REPO_ROOT" --mode "\$M"[\s\S]*?--monolith-path "\$MONOLITH_PATH"[\s\S]*?--staging-path/,
		);
	});

	test("the monolith skill stays explicit-only and keeps its sub-agent isolation rule", () => {
		const { data } = splitFrontmatter(skillMd("monolith")) as {
			data: Record<string, unknown>;
		};
		expect(data["disable-model-invocation"]).toBe(true);
		expect(skillMd("monolith")).toMatch(/Self-contained sub-agent prompts/);
	});

	test("every relative link resolves", () => {
		const missing: string[] = [];
		for (const { files } of trees)
			for (const file of files)
				for (const match of file.text.matchAll(/\]\((\.{1,2}\/[^)#\s]+)/g)) {
					if (!existsSync(resolve(dirname(file.path), match[1] ?? "")))
						missing.push(`${file.name} -> ${match[1]}`);
				}
		expect(missing).toEqual([]);
	});

	test("grill-me's monolith template pointer resolves to the shipped template", () => {
		const protocol = join(
			SOURCE_SKILLS,
			"grill-me",
			"references",
			"protocol.md",
		);
		const link = readFileSync(protocol, "utf8").match(
			/\]\((\.{1,2}\/[^)\s]*monolith\/references\/template\.md)\)/,
		);
		expect(link).not.toBeNull();
		expect(resolve(dirname(protocol), link?.[1] ?? "")).toBe(
			join(SOURCE_SKILLS, "monolith", "references", "template.md"),
		);
		expect(existsSync(TEMPLATE_ASSET)).toBe(true);
	});
});

describe("monolith assets the generator consumes", () => {
	const scan = () => readFileSync(SCAN_ASSET, "utf8");

	test("scan.workflow.mjs keeps the meta export, args destructure and search hierarchy anchor", () => {
		const text = scan();
		expect(text.startsWith("export const meta = {")).toBe(true);
		expect(text).toMatch(/\nconst \{\n[\s\S]*?\n\} = args \|\| \{\}\n/);
		expect(text).toContain(
			"  'SEARCH HIERARCHY (use in this order — fall through only on failure):',",
		);
		expect(text.indexOf("}\n")).toBeGreaterThan(0);
	});

	test("the destructure names every value the generator bakes in", () => {
		const block = scan().match(/\nconst \{\n([\s\S]*?)\n\} = args \|\| \{\}\n/);
		for (const name of [
			"mode",
			"existingTerms",
			"existingFileContent",
			"monolithPath",
			"stagingPath",
			"agentTypes",
			"template",
		])
			expect(block?.[1]).toContain(name);
	});

	test("scan.workflow.mjs holds no host-local path", () => {
		expect(scan()).not.toMatch(/\/home\/|~\/scripts|~\/\.claude/);
	});

	test("template.md skeleton names the four term sections the helper reads", () => {
		const text = readFileSync(TEMPLATE_ASSET, "utf8");
		for (const section of TERM_SECTIONS)
			expect(text).toContain(`## ${section}`);
	});
});

describe("spring-break format contracts", () => {
	const structure = () =>
		readFileSync(
			join(SOURCE_SKILLS, "spring-break", "references", "structure.md"),
			"utf8",
		);

	test("the target layout lists exactly the standard school topic files", () => {
		const layout = structure().match(/```\n\.agents\/school\/\n([\s\S]*?)```/);
		const names = [...(layout?.[1] ?? "").matchAll(/^\s+(\S+\.md)/gm)].map(
			(match) => match[1],
		);
		expect(names).toEqual([
			"engineering.md",
			"quality.md",
			"performance.md",
			"infrastructure.md",
			"security.md",
			"product.md",
			"tooling.md",
			"DEPS.md",
		]);
	});

	test("the topic file format is a flat dated list capped at 100 lines", () => {
		const text = structure();
		expect(text).toContain(
			"<!-- [Topic] learnings. Max 100 lines. Prune oldest when full. -->",
		);
		expect(text).toContain("- [YYYY-MM-DD] One learning per line");
		expect(text).toContain("Max 100 lines");
	});

	test("the DEPS format keeps recurring issues first and caps at 80 lines", () => {
		const text = structure();
		expect(text).toContain(
			"<!-- Dependency upgrade history. Keep recurring issues + last 3 runs. Max 80 lines. -->",
		);
		expect(text.indexOf("## Recurring Issues")).toBeLessThan(
			text.indexOf("## YYYY-MM-DD"),
		);
	});

	test("the old-to-new mapping routes every retired topic file to a standard one", () => {
		const text = structure();
		for (const row of [
			"| `qa.md`, `reviewer.md`, `wave.md`, `qa-writer.md` | `quality.md` |",
			"| `qa-perf.md` | `performance.md` |",
			"| `devops.md`, `qa-devops.md` | `infrastructure.md` |",
			"| `shell.md`, `lore.md`, `docs.md` | `tooling.md` |",
			"| `deps/*`, `DEPS.md` | `DEPS.md` |",
		])
			expect(text).toContain(row);
	});

	test("the protected files table still guards DEPS.md and paths.md", () => {
		const text = structure();
		expect(text).toContain("## Protected Files (do NOT touch)");
		expect(text).toContain("| `.agents/school/DEPS.md` | deps-upgrade |");
		expect(text).toContain("| `.agents/paths.md` | agent-seed / manual |");
	});

	test("spec bundle migration keeps NNN, skips existing bundles and hands context to the spec CLI", () => {
		const text = structure();
		expect(text).toContain(
			"Preserve `NNN` from the old filename. Never renumber.",
		);
		expect(text).toContain("skip that bundle");
		expect(text).toMatch(/"\$DG" spec validate/);
		expect(text).toMatch(/"\$DG" spec context/);
		expect(text).toMatch(/"\$DG" spec set/);
	});

	test("the steps migrate spec bundles, validate them and run the monolith health check without editing monolith.md", () => {
		const text = skillMd("spring-break");
		expect(text).toMatch(/"\$DG" spec validate/);
		expect(text).toMatch(/"\$DG" spec context/);
		expect(text).toMatch(/"\$DG" monolith prune [^\n]*--dry-run/);
		expect(text).toContain("Do NOT auto-modify monolith.md");
		expect(text).toContain("monolith-conflicts.md");
		expect(text).toContain(
			"[references/structure.md](references/structure.md)",
		);
	});

	test("it names the monolith and spring-break skills it relates to", () => {
		expect(allText("spring-break")).toContain("/monolith --prune");
	});
});
