import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "./test-support";

const SKILLS_DIR = join(REPO_ROOT, "plugins", "dg", "skills");
const PENDING_LOCAL_MODE = ["chat", "demo", "overwatch"];
const FLAG_TABLE_SKILLS = ["browser", "proto", "demo", "chat", "overwatch"];
const LOCAL_DEFAULT = /off \(local is the default\)/;
const EXT_FLAG = /(^|[\s`(])--ext($|[\s`:,.;)])/;
const GATE_COMMAND = /dg-skills\s+require-extension\s+\S+\s*\|\|/;
const REQUIRES_EXTENSION = /^requires:(?:[^\n]|\n[ \t]+-)*?extension/m;
const AGENT_INSTALL = join(REPO_ROOT, "docs", "AGENT-INSTALL.md");

type Doc = { path: string; text: string };

function markdownFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		if (entry === "node_modules") return [];
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return markdownFiles(path);
		return entry.endsWith(".md") ? [path] : [];
	});
}

function skillOf(path: string): string {
	return relative(SKILLS_DIR, path).split(/[\\/]/)[0] ?? "";
}

function frontmatter(text: string): string {
	return /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
}

const DOCS: Doc[] = markdownFiles(SKILLS_DIR).map((path) => ({
	path: relative(SKILLS_DIR, path).replaceAll("\\", "/"),
	text: readFileSync(path, "utf8"),
}));

function requiresExtensionOffenders(docs: Doc[]): string[] {
	return docs
		.filter(({ path }) => path.endsWith("SKILL.md"))
		.filter(
			({ path }) =>
				!PENDING_LOCAL_MODE.includes(skillOf(join(SKILLS_DIR, path))),
		)
		.filter(({ text }) => REQUIRES_EXTENSION.test(frontmatter(text)))
		.map(({ path }) => path);
}

function gateWithoutExtOffenders(
	docs: Doc[],
	invocation: RegExp = GATE_COMMAND,
): string[] {
	return docs.flatMap(({ path, text }) =>
		text
			.split("\n")
			.filter((line) => invocation.test(line))
			.filter((line) => !EXT_FLAG.test(line))
			.map((line) => `${path}: ${line.trim()}`),
	);
}

function flagsTable(text: string): string[][] {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line === "## Flags");
	if (start === -1) return [];
	const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
	return lines
		.slice(start + 1, end === -1 ? undefined : end)
		.filter((line) => line.startsWith("|"))
		.map((row) =>
			row
				.trim()
				.replace(/^\||\|$/g, "")
				.split(/(?<!\\)\|/)
				.map((cell) => cell.trim()),
		);
}

function groupWithoutExtLines(text: string): string[] {
	const lines = text.split("\n");
	return lines
		.map((line, i) => {
			const next = lines[i + 1] ?? "";
			const continued =
				next.trimStart().startsWith("--") || line.trimEnd().endsWith("\\");
			return { line, window: continued ? `${line}\n${next}` : line };
		})
		.filter(({ line }) => line.includes("batch-open"))
		.filter(
			({ window }) => window.includes("--group") && !EXT_FLAG.test(window),
		)
		.map(({ line }) => line);
}

function plainBatchOpenLines(text: string): string[] {
	return text
		.split("\n")
		.filter((line) => /dg-skills batch-open (?!--)["<]/.test(line))
		.filter((line) => !line.includes("--group"));
}

describe("ext opt-in rule A: no SKILL.md requires the extension outside the allowlist", () => {
	test("every packaged SKILL.md outside PENDING_LOCAL_MODE has no requires extension line", () => {
		expect(requiresExtensionOffenders(DOCS)).toEqual([]);
	});

	test("a frontmatter requires block list naming extension is an offender", () => {
		const block: Doc[] = [
			{
				path: "block/SKILL.md",
				text: "---\nname: block\nrequires:\n  - extension\n---\nbody\n",
			},
		];
		expect(requiresExtensionOffenders(block)).toEqual(["block/SKILL.md"]);
	});

	test("a requires line in the body, outside the frontmatter, is not an offender", () => {
		const body: Doc[] = [
			{
				path: "body/SKILL.md",
				text: "---\nname: body\n---\nrequires: [extension]\n",
			},
		];
		expect(requiresExtensionOffenders(body)).toEqual([]);
	});

	for (const skill of PENDING_LOCAL_MODE) {
		test(`${skill} is still on the allowlist because it still declares requires: [extension]`, () => {
			const doc = DOCS.find(({ path }) => path === `${skill}/SKILL.md`);
			expect(doc).toBeDefined();
			const stillRequires = REQUIRES_EXTENSION.test(
				frontmatter(doc?.text ?? ""),
			);
			if (!stillRequires) {
				throw new Error(
					`${skill} no longer declares requires: [extension]. Remove "${skill}" from PENDING_LOCAL_MODE (and FLAG_TABLE_SKILLS coverage) in ext-opt-in.spec.ts and from the cli-only.spec.ts requires list.`,
				);
			}
			expect(stillRequires).toBe(true);
		});
	}

	test("a fixture SKILL.md with requires: [extension] is reported with its path", () => {
		const fixture: Doc[] = [
			{
				path: "fixture/SKILL.md",
				text: "---\nname: fixture\nrequires: [extension]\n---\n",
			},
			{ path: "clean/SKILL.md", text: "---\nname: clean\n---\n" },
			{ path: "chat/SKILL.md", text: "---\nrequires: [extension]\n---\n" },
		];
		expect(requiresExtensionOffenders(fixture)).toEqual(["fixture/SKILL.md"]);
	});
});

describe("ext opt-in rule B: the require-extension gate runs only with --ext", () => {
	const gate = "dg-skills require-extension chat || exit 1";

	test("a gate line without --ext is reported", () => {
		const offenders = gateWithoutExtOffenders([
			{ path: "x/SKILL.md", text: gate },
		]);
		expect(offenders).toHaveLength(1);
		expect(offenders[0]).toContain("x/SKILL.md");
	});

	test("the same gate line prefixed with --ext only: passes", () => {
		expect(
			gateWithoutExtOffenders([
				{ path: "x/SKILL.md", text: `--ext only: ${gate}` },
			]),
		).toEqual([]);
	});

	test("a double-spaced invocation without --ext is reported", () => {
		const offenders = gateWithoutExtOffenders([
			{ path: "x/SKILL.md", text: "dg-skills  require-extension x || exit 1" },
		]);
		expect(offenders).toHaveLength(1);
	});

	test("--extension is not accepted as --ext", () => {
		const text = "--extension only: dg-skills require-extension x || exit 1";
		expect(
			gateWithoutExtOffenders([{ path: "x/SKILL.md", text }]),
		).toHaveLength(1);
	});

	test("the generated doctor line is not an offender", () => {
		const doctor =
			"If a step fails, run dg-skills doctor require-extension install.";
		expect(
			gateWithoutExtOffenders([{ path: "x/SKILL.md", text: doctor }]),
		).toEqual([]);
	});

	test("a prose mention of the gate is not a command, so it does not pass by carrying --ext", () => {
		const prose =
			"`proto --ext` and the `dg-skills require-extension <skill>` check stop";
		expect(
			gateWithoutExtOffenders([
				{ path: "x.md", text: prose.replace("--ext", "") },
			]),
		).toEqual([]);
		expect(GATE_COMMAND.test(prose)).toBe(false);
		expect(
			gateWithoutExtOffenders([
				{ path: "x.md", text: "dg-skills require-extension x || exit 1" },
			]),
		).toHaveLength(1);
	});

	test("docs/AGENT-INSTALL.md has no ungated require-extension line", () => {
		const doc = {
			path: "docs/AGENT-INSTALL.md",
			text: readFileSync(AGENT_INSTALL, "utf8"),
		};
		expect(gateWithoutExtOffenders([doc])).toEqual([]);
	});

	test("no packaged skill document outside PENDING_LOCAL_MODE has an ungated require-extension line", () => {
		const docs = DOCS.filter(
			({ path }) => !PENDING_LOCAL_MODE.includes(path.split(/[\\/]/)[0] ?? ""),
		);
		expect(gateWithoutExtOffenders(docs)).toEqual([]);
	});
});

describe("ext opt-in rule C: Flags tables document --ext with the local default", () => {
	const covered = FLAG_TABLE_SKILLS.filter(
		(skill) => !PENDING_LOCAL_MODE.includes(skill),
	);

	test("browser and proto are the covered skills while the others are pending", () => {
		expect(covered).toEqual(["browser", "proto"]);
	});

	for (const skill of covered) {
		test(`${skill}/SKILL.md has an --ext row whose Default cell says local is the default`, () => {
			const file = join(SKILLS_DIR, skill, "SKILL.md");
			expect(existsSync(file)).toBe(true);
			const row = flagsTable(readFileSync(file, "utf8")).find((cells) =>
				cells[0]?.includes("--ext"),
			);
			expect(row).toBeDefined();
			expect(row?.[3] ?? "").toMatch(LOCAL_DEFAULT);
		});
	}
});

describe("ext opt-in user docs: launch and grouped batch-open examples carry --ext", () => {
	const USER_DOCS = ["docs/browser.md", "docs/AGENT-INSTALL.md"];
	const needsExt = (line: string) =>
		/dg-skills launch\b|dg:browser launch\b|batch-open.*--group/.test(line);

	test("the line check flags launch and grouped batch-open without --ext", () => {
		expect(needsExt("dg-skills launch --browser brave <refs>")).toBe(true);
		expect(needsExt("/dg:browser batch-open --group x a")).toBe(true);
		expect(needsExt("/dg:browser batch-open a")).toBe(false);
	});

	for (const file of USER_DOCS) {
		test(`${file} has no launch or grouped batch-open example without --ext`, () => {
			const offenders = readFileSync(join(REPO_ROOT, file), "utf8")
				.split("\n")
				.filter((line) => needsExt(line) && !line.includes("--ext"));
			expect(offenders).toEqual([]);
		});
	}
});

describe("ext opt-in doc grep gate: batch-open callers never group without --ext", () => {
	const CALLERS = [
		"pushup/SKILL.md",
		"deps-upgrade/references/steps.md",
		"sdlc/references/finish.md",
		"spec/references/execute.md",
		"spec/SKILL.md",
	];

	test("the line check flags --group without --ext and accepts the other forms", () => {
		expect(
			groupWithoutExtLines("dg-skills batch-open --group pr <url>"),
		).toHaveLength(1);
		expect(
			groupWithoutExtLines("dg-skills batch-open --ext --group pr <url>"),
		).toEqual([]);
		expect(groupWithoutExtLines("dg-skills batch-open <url>")).toEqual([]);
	});

	test("a --group wrapped onto the next line without --ext is flagged", () => {
		expect(
			groupWithoutExtLines("dg-skills batch-open <url>\n  --group pr"),
		).toHaveLength(1);
		expect(
			groupWithoutExtLines("dg-skills batch-open --ext\n  --group pr <url>"),
		).toEqual([]);
	});

	test("an --ext on the next, separate command does not cover a grouped batch-open", () => {
		expect(
			groupWithoutExtLines(
				"dg-skills batch-open --group pr <url>\ndg-skills launch --ext <url>",
			),
		).toHaveLength(1);
		expect(
			groupWithoutExtLines(
				"  dg-skills batch-open --group pr <url>\n  dg-skills launch --ext <url>",
			),
		).toHaveLength(1);
	});

	for (const file of CALLERS) {
		test(`${file} uses batch-open with no --group unless --ext is on the same line`, () => {
			const text = readFileSync(join(SKILLS_DIR, file), "utf8");
			expect(groupWithoutExtLines(text)).toEqual([]);
		});
	}

	test("a prose-only batch-open mention is not a plain command line", () => {
		expect(plainBatchOpenLines("when batch-open fails, print the URL")).toEqual(
			[],
		);
		expect(plainBatchOpenLines("batch-open opens tabs")).toEqual([]);
		expect(plainBatchOpenLines("dg-skills batch-open <url>")).toHaveLength(1);
		expect(
			plainBatchOpenLines("dg-skills batch-open --ext --group pr <url>"),
		).toEqual([]);
	});

	for (const file of CALLERS) {
		test(`${file} has a plain batch-open line with no --group`, () => {
			const text = readFileSync(join(SKILLS_DIR, file), "utf8");
			expect(plainBatchOpenLines(text).length).toBeGreaterThan(0);
		});
	}
});

describe("ext opt-in passthrough: a skill whose references name batch-open --ext documents the flag", () => {
	const skills = readdirSync(SKILLS_DIR).filter((entry) =>
		existsSync(join(SKILLS_DIR, entry, "SKILL.md")),
	);
	const passthrough = skills.filter((skill) =>
		DOCS.some(
			({ path, text }) =>
				path.startsWith(`${skill}/`) && /batch-open\s+--ext/.test(text),
		),
	);

	test("pushup and deps-upgrade are the passthrough skills", () => {
		expect(passthrough).toEqual(
			expect.arrayContaining(["pushup", "deps-upgrade"]),
		);
	});

	for (const skill of passthrough) {
		test(`${skill}/SKILL.md has an --ext row in its Flags table with the local default`, () => {
			const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
			const row = flagsTable(text).find((cells) => cells[0]?.includes("--ext"));
			expect(row).toBeDefined();
			expect(row?.[3] ?? "").toMatch(LOCAL_DEFAULT);
		});
	}
});
