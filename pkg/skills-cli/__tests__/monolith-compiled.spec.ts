import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeEnv } from "./module-call";
import {
	BILLING_VOCABULARY,
	domainRows,
	parseGeneratedScan,
	runMonolith,
	vocabulary,
	writeTree,
} from "./monolith-fixtures";
import {
	collectRun,
	disposeSpecContext,
	newSpecContext,
	SOURCE_SKILLS,
	type SpecContext,
	type SpecRun,
} from "./spec-fixtures";

const BILLING_TERMS = BILLING_VOCABULARY.map((row) => row.term).join("\n");

let context: SpecContext;
let binary: string;
let skills: string;
let marketplaceHome: string;
let emptyBin: string;
let elsewhere: string;
let worktree: string;

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
		SCRIPTS_ROOT: undefined,
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
		Bun.spawn([binary, "monolith", ...args], {
			cwd: elsewhere,
			env: installedEnv(extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
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
	cpSync(join(SOURCE_SKILLS, "monolith"), join(skills, "monolith"), {
		recursive: true,
	});
	marketplaceHome = join(context.base, "marketplace home");
	cpSync(
		join(SOURCE_SKILLS, "monolith"),
		join(
			marketplaceHome,
			".claude/plugins/cache/detailedghost/dg/1.15.0/plugins/dg/skills/monolith",
		),
		{ recursive: true },
	);
	emptyBin = join(context.base, "only nothing");
	elsewhere = join(context.base, "elsewhere");
	mkdirSync(emptyBin, { recursive: true });
	mkdirSync(elsewhere, { recursive: true });
	worktree = context.root;
	writeTree(worktree, {
		".agents/monolith.md": vocabulary(BILLING_VOCABULARY),
		"go.mod": "module example\n",
	});
}, 240_000);

afterAll(() => disposeSpecContext(context));

describe("compiled dg-skills monolith worktree-gen from a relocated plugin", () => {
	test("generates the worktree script from an external cwd with the installed assets and no helper on PATH", async () => {
		const out = join(context.base, "compiled-scan.mjs");
		const run = await compiled(["worktree-gen", worktree, "--out", out]);
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`${out}\n`);
		const consts = parseGeneratedScan(readFileSync(out, "utf8"));
		expect(consts.existingTerms).toBe(BILLING_TERMS);
		expect(consts.agentTypes).toEqual({
			domain: "general-purpose",
			naming: "Explore",
			concept: "general-purpose",
		});
		expect(consts.SCAN_ROOT).toBe(worktree);
		expect(consts.template).toBe(
			readFileSync(
				join(skills, "monolith", "references", "template.md"),
				"utf8",
			),
		);
	});

	test("emits the same script as the source entry point", async () => {
		const fromBinary = join(context.base, "binary-scan.mjs");
		const fromSource = join(context.base, "source-scan.mjs");
		const args = [
			"worktree-gen",
			worktree,
			"--mode",
			"shallow",
			"--monolith-path",
			join(context.state, "live.md"),
		];
		const compiledRun = await compiled([...args, "--out", fromBinary]);
		const sourceRun = await runMonolith(context, [
			...args,
			"--out",
			fromSource,
		]);
		expect(compiledRun.exitCode).toBe(0);
		expect(sourceRun.exitCode).toBe(0);
		expect(readFileSync(fromBinary, "utf8")).toBe(
			readFileSync(fromSource, "utf8"),
		);
	});

	test("writes under the scratch root when no --out is given", async () => {
		const run = await compiled(["worktree-gen", worktree]);
		expect(run.exitCode).toBe(0);
		const path = run.stdout.trim();
		expect(path.startsWith(join(context.scratch, "monolith"))).toBe(true);
		expect(path.endsWith("scan.worktree.mjs")).toBe(true);
		expect(parseGeneratedScan(readFileSync(path, "utf8")).mode).toBe("full");
	});

	test("a marketplace install locates the assets from HOME alone", async () => {
		const out = join(context.base, "marketplace-scan.mjs");
		const run = await compiled(["worktree-gen", worktree, "--out", out], {
			HOME: marketplaceHome,
			DG_SKILLS_DIR: undefined,
		});
		expect(run.stderr).toBe("");
		expect(run.exitCode).toBe(0);
		expect(parseGeneratedScan(readFileSync(out, "utf8")).existingTerms).toBe(
			BILLING_TERMS,
		);
	});

	test("with no installed skill the generator exits 1 naming DG_SKILLS_DIR and never searches its own virtual path", async () => {
		const run = await compiled(["worktree-gen", worktree], {
			DG_SKILLS_DIR: undefined,
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("DG_SKILLS_DIR");
		expect(run.stderr).not.toContain("$bunfs");
	});

	test("an explicit DG_SKILLS_DIR wins over the marketplace install", async () => {
		const empty = join(context.base, "empty skills");
		mkdirSync(empty, { recursive: true });
		const run = await compiled(["worktree-gen", worktree], {
			HOME: marketplaceHome,
			DG_SKILLS_DIR: empty,
		});
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain(empty);
	});

	test("--help needs no installed skill", async () => {
		const run = await compiled(["worktree-gen", "--help"], {
			DG_SKILLS_DIR: undefined,
		});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("--monolith-path");
	});
});

describe("compiled dg-skills monolith helper operations", () => {
	let helperTree: string;
	const live = () => join(helperTree, ".agents", "monolith.md");

	beforeAll(() => {
		helperTree = join(context.base, "helper work");
		writeTree(helperTree, {
			".agents/monolith.md": vocabulary(BILLING_VOCABULARY),
			"go.mod": "module example\n",
		});
	});

	test("bootstrap, list-terms, validate and cap-report run with only the binary", async () => {
		const bootstrap = await compiled(["bootstrap", helperTree]);
		expect(bootstrap.stdout).toBe(
			`APPEND_MODE=1\nMONOLITH_PATH='${live()}'\nLIGHT_MODE=0\n`,
		);
		const terms = await compiled(["list-terms", live()]);
		expect(terms.stdout).toBe(`${BILLING_TERMS}\n`);
		expect((await compiled(["validate", live()])).exitCode).toBe(0);
		const caps = await compiled(["cap-report", live()]);
		expect(caps.exitCode).toBe(0);
		expect(caps.stdout).toContain("SECTION_ROWS_domain_terms=3\n");
	});

	test("split and re-read work on a relocated tree and generator reads the split terms", async () => {
		const split = join(context.base, "split work");
		writeTree(split, {
			".agents/monolith.md": vocabulary([
				...domainRows("billing", 3),
				...domainRows("orders", 3),
				{ section: "Naming Conventions", term: "Stray" },
				{ section: "Architectural Patterns", term: "Loose" },
				{ section: "Concepts", term: "Idea" },
			]),
		});
		const file = join(split, ".agents", "monolith.md");
		const run = await compiled(["split", file]);
		expect(run.exitCode).toBe(0);
		expect(readdirSync(join(split, ".agents", "monolith")).sort()).toEqual([
			"billing.md",
			"general.md",
			"orders.md",
		]);
		const out = join(context.base, "split-scan.mjs");
		const gen = await compiled(["worktree-gen", split, "--out", out]);
		expect(gen.exitCode).toBe(0);
		expect(
			parseGeneratedScan(readFileSync(out, "utf8")).existingTerms.split("\n"),
		).toContain("ordersTerm2");
	});

	test("helper exit statuses survive the binary", async () => {
		const missing = await compiled(["list-terms", join(helperTree, "absent.md")]);
		expect(missing.exitCode).toBe(1);
		const unknown = await compiled(["bogus"]);
		expect(unknown.exitCode).toBe(2);
	});
});
