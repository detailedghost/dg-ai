import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { mergeEnv } from "./module-call";
import {
	collectRun,
	disposeSpecContext,
	FIXED_DATE,
	newSpecContext,
	SOURCE_SKILLS,
	type SpecContext,
	type SpecGolden,
	type SpecRun,
} from "./spec-fixtures";

const goldens: SpecGolden[] = JSON.parse(
	readFileSync(
		join(import.meta.dir, "fixtures", "spec", "goldens.json"),
		"utf8",
	),
);
const scaffold = goldens.find((golden) => golden.id === "scaffold-from-blob");
if (!scaffold) throw new Error("scaffold-from-blob golden is missing");

const BUNDLE = ".agents/spec/001_auth_rewrite";
const FIXTURE_BUNDLE = ".agents/fixture/001_auth_rewrite";

let context: SpecContext;
let binary: string;
let skills: string;
let marketplaceHome: string;
let emptyBin: string;

function installedEnv(extra: Record<string, string | undefined> = {}) {
	return mergeEnv({
		HOME: context.home,
		AI_SCRATCH_DIR: context.scratch,
		AI_STATE_DIR: context.state,
		PATH: emptyBin,
		TZ: "UTC",
		LC_ALL: "C",
		DG_SKILLS_DIR: skills,
		DG_SKILLS_DEST: undefined,
		DG_HOME: undefined,
		CLAUDE_PLUGIN_ROOT: undefined,
		CODEX_PLUGIN_ROOT: undefined,
		DG_PLUGIN_ROOT: undefined,
		...extra,
	});
}

function compiled(
	args: string[],
	extra: Record<string, string | undefined> = {},
): Promise<SpecRun> {
	return collectRun(
		Bun.spawn([binary, "spec", ...args], {
			cwd: context.root,
			env: installedEnv(extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
}

function utcDay(): string {
	return new Date().toISOString().slice(0, 10);
}

beforeAll(() => {
	context = newSpecContext();
	binary = join(context.base, "moved ' install", "dg-skills");
	mkdirSync(join(binary, ".."), { recursive: true });
	const build = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../build.ts"),
			"--outfile",
			binary,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (build.exitCode !== 0) throw new Error(build.stderr.toString());
	skills = join(context.base, "relocated plugin", "skills");
	cpSync(join(SOURCE_SKILLS, "spec"), join(skills, "spec"), {
		recursive: true,
	});
	marketplaceHome = join(context.base, "marketplace home");
	cpSync(
		join(SOURCE_SKILLS, "spec"),
		join(
			marketplaceHome,
			".claude/plugins/cache/detailedghost/dg/1.15.0/plugins/dg/skills/spec",
		),
		{ recursive: true },
	);
	emptyBin = join(context.base, "only claude");
	mkdirSync(emptyBin, { recursive: true });
	writeFileSync(
		join(emptyBin, "claude"),
		`#!/bin/sh\nprintf 'reviewed by %s\\n' "$3"\n`,
	);
	chmodSync(join(emptyBin, "claude"), 0o755);
	writeFileSync(
		join(context.root, "blob.json"),
		scaffold.files?.["blob.json"] ?? "",
	);
	const fixture = Bun.spawnSync(
		[
			binary,
			"spec",
			"scaffold",
			"--home",
			".agents/fixture",
			"--slug",
			"Auth Rewrite!",
			"--from-json",
			"blob.json",
		],
		{ cwd: context.root, env: installedEnv(), stdout: "pipe", stderr: "pipe" },
	);
	if (fixture.exitCode !== 0) throw new Error(fixture.stderr.toString());
}, 240_000);

afterAll(() => disposeSpecContext(context));

describe("compiled dg-skills spec from a relocated plugin", () => {
	test("scaffold writes plan, initial notes and roundtable shells byte-identical to the legacy output", async () => {
		const before = utcDay();
		const run = await compiled([
			"scaffold",
			"--home",
			".agents/spec",
			"--slug",
			"Auth Rewrite!",
			"--from-json",
			"blob.json",
		]);
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`${join(context.root, BUNDLE)}\n`);
		const after = utcDay();
		for (const [name, text] of Object.entries(scaffold.expect.tree)) {
			if (!name.startsWith(BUNDLE)) continue;
			const actual = readFileSync(join(context.root, name), "utf8");
			expect([
				text.replace(FIXED_DATE, before),
				text.replace(FIXED_DATE, after),
			]).toContain(actual);
		}
		expect(
			readdirSync(join(context.root, BUNDLE, "roundtable")).sort(),
		).toEqual(["slice-1.md", "slice-2.md", "slice-3.md"]);
	});

	test("validate accepts the scaffolded plan using only the installed schema", async () => {
		const plan = join(context.root, FIXTURE_BUNDLE, "plan.md");
		const run = await compiled(["validate", plan]);
		expect(run.stdout).toBe(`${plan}: ok\n`);
		expect(run.exitCode).toBe(0);
	});

	test("validate reports a violation as JSON and exits 1", async () => {
		writeFileSync(join(context.root, "bad.md"), "---\nstatus: finished\n---\n");
		const run = await compiled(["validate", "bad.md"]);
		expect(run.exitCode).toBe(1);
		expect(JSON.parse(run.stdout)).toEqual([
			expect.objectContaining({ field: "status", kind: "enum_violation" }),
		]);
	});

	test("roundtable runs the installed templates with a claude-only PATH", async () => {
		const plan = join(context.root, FIXTURE_BUNDLE, "plan.md");
		const dry = await compiled([
			"roundtable",
			plan,
			"--phase",
			"5",
			"--agents",
			"reviewer",
			"--dry-run",
		]);
		expect(dry.exitCode).toBe(0);
		expect(dry.stdout).toContain(
			"[DRY] claude -p --agent dg:reviewer --permission-mode plan --output-format text <<<",
		);
		expect(dry.stdout).toContain(`full spec at \`${plan}\``);
		const live = await compiled([
			"roundtable",
			plan,
			"--phase",
			"5",
			"--agents",
			"reviewer,security",
		]);
		expect(live.exitCode).toBe(0);
		expect(live.stdout).toContain("### reviewer\n\nreviewed by dg:reviewer\n");
		expect(live.stdout).toContain("### security\n\nreviewed by dg:security\n");
	});

	test("a marketplace install locates the schema from HOME alone", async () => {
		const plan = join(context.root, FIXTURE_BUNDLE, "plan.md");
		const run = await compiled(["validate", plan], {
			HOME: marketplaceHome,
			DG_SKILLS_DIR: undefined,
		});
		expect(run.stderr).toBe("");
		expect(run.stdout).toBe(`${plan}: ok\n`);
	});

	test("an explicit DG_SKILLS_DIR wins over the marketplace install", async () => {
		const empty = join(context.base, "empty skills");
		mkdirSync(empty, { recursive: true });
		const run = await compiled(["validate", join(BUNDLE, "plan.md")], {
			HOME: marketplaceHome,
			DG_SKILLS_DIR: empty,
		});
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain(empty);
	});

	test("with no installed skill the binary names DG_SKILLS_DIR and never searches its own virtual path", async () => {
		const run = await compiled(["validate", join(BUNDLE, "plan.md")], {
			DG_SKILLS_DIR: undefined,
		});
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("DG_SKILLS_DIR");
		expect(run.stderr).not.toContain("$bunfs");
	});
});
