import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import {
	baseEnv,
	disposeSpecContext,
	FIXED_DATE,
	FIXED_STAMP,
	newSpecContext,
	runFixtureGit,
	runSourceSpec,
	SOURCE_SKILLS,
	type SpecContext,
	type SpecRun,
	splitFrontmatter,
} from "./spec-fixtures";

const SUBCOMMANDS = [
	"perms",
	"perms-batch",
	"next-nnn",
	"roundtable",
	"review",
	"slice",
	"context",
	"brief",
	"diff-bundle",
	"audit",
	"ready",
	"pr-body",
	"issues",
	"slugify",
	"resolve-path",
	"validate",
	"get",
	"set",
	"append-section",
	"roster",
	"scaffold",
	"lint-waves",
	"prototype-ref",
];

const SPEC = `---
feature: "Auth Rewrite"
date: "2026-01-15"
status: draft
current_slice: 0
slices:
  - id: 1
    name: "Model"
    depends_on: []
    files: ["src/model/**"]
  - id: 2
    name: "Api"
    depends_on: [1]
    files: ["src/api/**"]
---

# Auth Rewrite

## Purpose
Distinctive purpose text.

## Slice Summaries

### Slice 1 — Model (abc1234)
Done.

## Agent Notes
`;

const MID_PERMISSIONS = `---
status: draft
permissions:
  run_commands: true
  git_push: false
current_slice: 1
---

# Mid
`;

let context: SpecContext;
beforeEach(() => {
	context = newSpecContext();
});
afterEach(() => disposeSpecContext(context));

function put(name: string, text: string, root = context.root): string {
	const path = join(root, name);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

function read(name: string): string {
	return readFileSync(join(context.root, name), "utf8");
}

function spec(
	args: string[],
	options: {
		cwd?: string;
		env?: Record<string, string>;
		stdin?: string;
	} = {},
): Promise<SpecRun> {
	return runSourceSpec(args, {
		cwd: options.cwd ?? context.root,
		env: { ...baseEnv(context), ...options.env },
		stdin: options.stdin,
	});
}

function sha8(value: string): string {
	return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function initRepo(root: string): void {
	runFixtureGit(["init", "-q", "-b", "main"], root);
	runFixtureGit(["add", "-A"], root);
	runFixtureGit(["commit", "-q", "-m", "chore: initial"], root);
}

function emptySkillsDir(): string {
	const dir = join(context.base, "empty skills");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function relocatedSkills(): string {
	const dir = join(context.base, "relocated skills");
	cpSync(join(SOURCE_SKILLS, "spec"), join(dir, "spec"), { recursive: true });
	return dir;
}

describe("dg-skills spec dispatch", () => {
	test("bare spec prints every subcommand on stdout and exits 2", async () => {
		const run = await spec([]);
		expect(run.exitCode).toBe(2);
		for (const verb of SUBCOMMANDS) expect(run.stdout).toContain(verb);
	});

	test.each(["--help", "-h", "help"])(
		"%s prints every subcommand and exits 0",
		async (flag) => {
			const run = await spec([flag]);
			expect(run.exitCode).toBe(0);
			for (const verb of SUBCOMMANDS) expect(run.stdout).toContain(verb);
		},
	);

	test("an unknown subcommand names itself on stderr and exits 2", async () => {
		const run = await spec(["frobnicate"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("unknown subcommand: frobnicate");
	});

	test("help and slugify need no installed schema", async () => {
		const env = { DG_SKILLS_DIR: emptySkillsDir() };
		expect((await spec(["--help"], { env })).exitCode).toBe(0);
		const slug = await spec(["slugify", "Plain Words"], { env });
		expect(slug.exitCode).toBe(0);
		expect(slug.stdout).toBe("plain_words\n");
	});

	test("registerSpec adds one spec command and prints nothing on import", async () => {
		const written: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		try {
			const { registerSpec } = await import("../src/commands/spec");
			const program = new Command().enablePositionalOptions();
			registerSpec(program);
			expect(program.commands.map((command) => command.name())).toEqual([
				"spec",
			]);
		} finally {
			process.stdout.write = original;
		}
		expect(written).toEqual([]);
	});
});

describe("dg-skills spec installed schema lookup", () => {
	test("schema-backed commands fail with the override variable named when no skill is installed", async () => {
		put("spec.md", SPEC);
		const run = await spec(["validate", "spec.md"], {
			env: { DG_SKILLS_DIR: emptySkillsDir() },
		});
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("DG_SKILLS_DIR");
	});

	test("DG_SKILLS_DIR selects the schema that validate enforces", async () => {
		put("extra.md", "---\nstatus: draft\nextra_field: yes\n---\nbody\n");
		const skills = relocatedSkills();
		const schema = join(
			skills,
			"spec",
			"spec-schema",
			"frontmatter-schema.yaml",
		);
		writeFileSync(
			schema,
			`${readFileSync(schema, "utf8").trimEnd()}\n\n  extra_field:\n    type: string\n    mutability: mutable\n`,
		);
		const custom = await spec(["validate", "extra.md"], {
			env: { DG_SKILLS_DIR: skills },
		});
		expect(custom.exitCode).toBe(0);
		const stock = await spec(["validate", "extra.md"]);
		expect(stock.exitCode).toBe(1);
		expect(JSON.parse(stock.stdout)).toEqual([
			expect.objectContaining({ field: "extra_field", kind: "unknown_field" }),
		]);
	});

	test("roundtable reads its templates from the installed skill", async () => {
		put("plan.md", "# plan\n");
		const skills = relocatedSkills();
		writeFileSync(
			join(skills, "spec", "spec-schema", "templates", "spec-review.md"),
			"## Reviewer\n\n> Custom installed prompt for <spec_path>\n",
		);
		const run = await spec(
			[
				"roundtable",
				"plan.md",
				"--phase",
				"5",
				"--agents",
				"reviewer",
				"--dry-run",
			],
			{ env: { DG_SKILLS_DIR: skills } },
		);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain(
			`Custom installed prompt for ${join(context.root, "plan.md")}`,
		);
	});
});

describe("dg-skills spec scaffold date", () => {
	const blob = JSON.stringify({
		feature: "Dated",
		slug: "dated",
		purpose: "p",
		scope: { included: [], excluded: [] },
		slices: [{ id: 1, name: "only" }],
	});

	test("stamps the fixed local date", async () => {
		put("blob.json", blob);
		const run = await spec([
			"scaffold",
			"--home",
			"specs",
			"--slug",
			"dated",
			"--from-json",
			"blob.json",
		]);
		expect(run.exitCode).toBe(0);
		expect(read("specs/001_dated/plan.md")).toContain(`date: "${FIXED_DATE}"`);
	});

	test("uses the local calendar day, not the UTC day", async () => {
		put("blob.json", blob);
		const run = await spec(
			[
				"scaffold",
				"--home",
				"specs",
				"--slug",
				"dated",
				"--from-json",
				"blob.json",
			],
			{
				env: {
					TZ: "Pacific/Auckland",
					DG_TEST_NOW: "2026-01-15T23:30:00.000Z",
				},
			},
		);
		expect(run.exitCode).toBe(0);
		expect(read("specs/001_dated/plan.md")).toContain('date: "2026-01-16"');
	});

	test("numbers bundles in sequence and prints each absolute path", async () => {
		put("blob.json", blob);
		const args = [
			"scaffold",
			"--home",
			"specs",
			"--slug",
			"dated",
			"--from-json",
			"blob.json",
		];
		const first = await spec(args);
		const second = await spec(args);
		expect(first.stdout).toBe(`${join(context.root, "specs", "001_dated")}\n`);
		expect(second.stdout).toBe(`${join(context.root, "specs", "002_dated")}\n`);
	});
});

describe("dg-skills spec immutable and append-only fields", () => {
	test.each([
		["feature", "Other"],
		["date", "2030-01-01"],
	])(
		"set refuses to rewrite the already-set immutable field %s",
		async (field, value) => {
			put("plan.md", SPEC);
			const run = await spec(["set", "plan.md", field, value]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain("immutable");
			expect(read("plan.md")).toBe(SPEC);
		},
	);

	test("an immutable field may be written once and then locks", async () => {
		put("plan.md", SPEC);
		const first = await spec(["set", "plan.md", "origin_repo", "/repo/a"]);
		expect(first.exitCode).toBe(0);
		const written = read("plan.md");
		expect(splitFrontmatter(written).data).toMatchObject({
			origin_repo: "/repo/a",
		});
		const second = await spec(["set", "plan.md", "origin_repo", "/repo/b"]);
		expect(second.exitCode).toBe(1);
		expect(read("plan.md")).toBe(written);
	});

	test.each([
		["references", "append-only"],
		["not_a_field", "not in schema"],
	])(
		"set denies %s and leaves the file byte-identical",
		async (field, reason) => {
			put("plan.md", SPEC);
			const run = await spec(["set", "plan.md", field, "x"]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(reason);
			expect(read("plan.md")).toBe(SPEC);
		},
	);

	test("a mutable write replaces that one value and leaves every other byte of the file alone", async () => {
		put("plan.md", SPEC);
		const run = await spec(["set", "plan.md", "current_slice", "2"]);
		expect(run.exitCode).toBe(0);
		expect(read("plan.md")).toBe(
			SPEC.replace("current_slice: 0", "current_slice: 2"),
		);
	});

	test("a nested write keeps the quoting, key order and blank lines around the value", async () => {
		put("plan.md", SPEC);
		const run = await spec(["set", "plan.md", "slices[1].name", "Renamed"]);
		expect(run.exitCode).toBe(0);
		expect(read("plan.md")).toBe(
			SPEC.replace('name: "Api"', 'name: "Renamed"'),
		);
	});

	test("a write re-spaces a compact flow list and changes nothing else", async () => {
		const compact = SPEC.replace(
			'files: ["src/model/**"]',
			'files: ["src/model/**","src/model.md"]',
		);
		put("plan.md", compact);
		const run = await spec(["set", "plan.md", "status", "in-progress"]);
		expect(run.exitCode).toBe(0);
		expect(read("plan.md")).toBe(
			compact
				.replace("status: draft", "status: in-progress")
				.replace(
					'["src/model/**","src/model.md"]',
					'["src/model/**", "src/model.md"]',
				),
		);
	});

	test("get reads nested and indexed paths from a spec that is not at the schema root", async () => {
		put("plan.md", SPEC);
		expect((await spec(["get", "plan.md", "slices[1].name"])).stdout).toBe(
			"Api\n",
		);
	});
});

describe("dg-skills spec field path indices", () => {
	test("a negative index counts from the end of the list for get and set", async () => {
		put("plan.md", SPEC);
		const fetched = await spec(["get", "plan.md", "slices[-1].name"]);
		expect(fetched.exitCode).toBe(0);
		expect(fetched.stdout).toBe("Api\n");
		const write = await spec(["set", "plan.md", "slices[-1].name", "Renamed"]);
		expect(write.exitCode).toBe(0);
		expect(read("plan.md")).toBe(
			SPEC.replace('name: "Api"', 'name: "Renamed"'),
		);
	});

	test("get on an index that does not exist is absent with exit 1, not a parse error", async () => {
		put("plan.md", SPEC);
		for (const path of ["slices[-5].name", "slices[x]", "slices[1"]) {
			const run = await spec(["get", "plan.md", path]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain(`field absent in spec: ${path}`);
		}
	});

	test("set on an unusable index exits 2 and leaves the file byte-identical", async () => {
		put("plan.md", SPEC);
		for (const path of ["slices[-5].name", "slices[x].name", "slices[-1"]) {
			const run = await spec(["set", "plan.md", path, "v"]);
			expect(run.exitCode).toBe(2);
			expect(read("plan.md")).toBe(SPEC);
		}
	});

	test("a path with no root is a parse error with exit 2", async () => {
		put("plan.md", SPEC);
		const run = await spec(["get", "plan.md", "..slices"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("could not parse root of field-path");
	});
});

describe("dg-skills spec prototype-ref", () => {
	const PROTOTYPE_LINES =
		"    prototype:\n      path: prototype/slice_2_proto.html\n      variant: a\n";

	test("copies the asset and inserts only the two prototype lines under the target slice", async () => {
		put("bundle/plan.md", SPEC);
		put("proto.html", "<html></html>\n");
		const run = await spec([
			"prototype-ref",
			"bundle",
			"--slice",
			"2",
			"--path",
			"proto.html",
			"--variant",
			"a",
		]);
		expect(run.exitCode).toBe(0);
		expect(read("bundle/prototype/slice_2_proto.html")).toBe("<html></html>\n");
		expect(read("bundle/plan.md")).toBe(
			SPEC.replace(
				'    files: ["src/api/**"]\n',
				`    files: ["src/api/**"]\n${PROTOTYPE_LINES}`,
			),
		);
	});

	test("recording a second variant changes only the variant line", async () => {
		put("bundle/plan.md", SPEC);
		put("proto.html", "<html></html>\n");
		const record = (variant: string) =>
			spec([
				"prototype-ref",
				"bundle",
				"--slice",
				"2",
				"--path",
				"proto.html",
				"--variant",
				variant,
			]);
		await record("a");
		const first = read("bundle/plan.md");
		expect((await record("b")).exitCode).toBe(0);
		expect(read("bundle/plan.md")).toBe(
			first.replace("variant: a", "variant: b"),
		);
	});
});

describe("dg-skills spec permissions", () => {
	test("perms --deny rewrites a permissions block that is not last in the frontmatter in place", async () => {
		put("spec.md", MID_PERMISSIONS);
		const run = await spec(["perms", "spec.md", "--deny"]);
		expect(run.exitCode).toBe(0);
		const text = read("spec.md");
		expect(text.match(/^permissions:/gm)).toHaveLength(1);
		expect(splitFrontmatter(text).data).toEqual({
			status: "draft",
			permissions: { run_commands: false, git_push: false },
			current_slice: 1,
		});
	});

	test("perms-batch --grant-all keeps one permissions block, grants six keys and is idempotent", async () => {
		put("spec.md", MID_PERMISSIONS);
		await spec(["perms-batch", "spec.md", "--grant-all"]);
		const once = read("spec.md");
		expect(once.match(/^permissions:/gm)).toHaveLength(1);
		expect(
			(splitFrontmatter(once).data as { permissions: unknown }).permissions,
		).toEqual({
			run_commands: true,
			git_push: true,
			gh_pr_create: true,
			auto_cleanup_worktree: true,
			slice_commits: true,
			housekeeping_commit: true,
		});
		await spec(["perms-batch", "spec.md", "--grant-all"]);
		expect(read("spec.md")).toBe(once);
	});

	test("--from-scratch reads <state>/spec/<project-hash>/<slug>.perms and reports the path", async () => {
		put("spec.md", "---\nstatus: draft\n---\n# t\n");
		initRepo(context.root);
		const perms = put(
			join("spec", sha8(context.root), "grants.perms"),
			"git_push=true\nrun_commands=false\n",
			context.state,
		);
		const run = await spec([
			"perms-batch",
			"spec.md",
			"--from-scratch",
			"grants",
		]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(`applied permissions from ${perms}\n`);
		expect(splitFrontmatter(read("spec.md")).data).toMatchObject({
			permissions: { git_push: true, run_commands: false },
		});
	});

	test("a missing scratch file is a usage error that names the file", async () => {
		put("spec.md", "---\nstatus: draft\n---\n# t\n");
		const run = await spec([
			"perms-batch",
			"spec.md",
			"--from-scratch",
			"absent",
		]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("file not found");
	});

	test("--from-file without a path is a usage error, not a crash", async () => {
		put("spec.md", "---\nstatus: draft\n---\n# t\n");
		const run = await spec(["perms-batch", "spec.md", "--from-file"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).not.toContain("unbound variable");
	});
});

describe("dg-skills spec resolve-path hashes", () => {
	test("--ephemeral keys the state path by the main worktree and pickup scratch by the working directory", async () => {
		put("seed.txt", "x");
		initRepo(context.root);
		const linked = join(context.base, "linked tree");
		runFixtureGit(
			["worktree", "add", "-q", "-b", "feat", linked],
			context.root,
		);
		const state = await spec(["resolve-path", "--slug", "s", "--ephemeral"], {
			cwd: linked,
		});
		expect(state.stdout).toBe(
			`${join(context.state, "spec", sha8(context.root), "s.md")}\n`,
		);
		const todo = await spec(
			["resolve-path", "--slug", "s", "--pickup", "-e", "--phase", "start"],
			{ cwd: linked },
		);
		expect(todo.stdout).toBe(
			`${join(context.scratch, "todo", sha8(linked), "s.md")}\n`,
		);
	});
});

describe("dg-skills spec lint-waves", () => {
	const slice = (
		id: number | string,
		files: string[],
		dependsOn: Array<number | string> = [],
	) => ({ id, name: `s${id}`, depends_on: dependsOn, files });

	function frontmatterPlan(slices: ReturnType<typeof slice>[]): string {
		return `---\nslices:\n${slices
			.map(
				(entry) =>
					`  - id: ${JSON.stringify(entry.id)}\n    name: ${entry.name}\n    depends_on: ${JSON.stringify(entry.depends_on)}\n    files: ${JSON.stringify(entry.files)}\n`,
			)
			.join("")}---\n`;
	}

	test("a plan.md and a blob with the same slices produce identical reports", async () => {
		const slices = [
			slice(1, ["src/**"]),
			slice(2, ["src/api/*.ts"]),
			slice(3, ["docs/*.md"], [1]),
		];
		put("blob.json", JSON.stringify({ slices }));
		put("plan.md", frontmatterPlan(slices));
		const fromBlob = await spec(["lint-waves", "blob.json"]);
		const fromPlan = await spec(["lint-waves", "plan.md"]);
		expect(fromBlob.exitCode).toBe(1);
		expect(fromPlan).toEqual(fromBlob);
		expect(fromBlob.stdout).toContain("FAIL: same-layer slices share files");
		expect(fromBlob.stdout).toContain("fix: add 1 to slice 2 depends_on");
	});

	test("a depends_on edge serializes a generator collision away", async () => {
		const serializing = [{ writes: ["gen/out/*.ts"], when: ["schema/*.json"] }];
		const parallel = [
			slice(1, ["schema/*.json"]),
			slice(2, ["gen/out/api.ts"]),
		];
		put("parallel.json", JSON.stringify({ slices: parallel, serializing }));
		const serial = [
			slice(1, ["schema/*.json"]),
			slice(2, ["gen/out/api.ts"], [1]),
		];
		put("serial.json", JSON.stringify({ slices: serial, serializing }));
		const collide = await spec(["lint-waves", "parallel.json"]);
		expect(collide.exitCode).toBe(1);
		expect(collide.stdout).toContain(
			"generator output, triggered by schema/*.json",
		);
		const clear = await spec(["lint-waves", "serial.json"]);
		expect(clear.exitCode).toBe(0);
		expect(clear.stdout).toBe(
			"layer 0: 1\nlayer 1: 2\nok: no same-layer overlap\n",
		);
	});

	test("numeric and string ids refer to the same slice", async () => {
		put(
			"blob.json",
			JSON.stringify({
				slices: [slice(1, ["a/**"]), slice(2, ["a/**"], ["1"])],
			}),
		);
		const run = await spec(["lint-waves", "blob.json"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe(
			"layer 0: 1\nlayer 1: 2\nok: no same-layer overlap\n",
		);
	});

	test("scaffold --allow-overlap proceeds past an overlap but never past a cycle", async () => {
		const blob = (slices: unknown[]) => ({
			feature: "F",
			slug: "f",
			purpose: "p",
			scope: {},
			slices,
		});
		put(
			"overlap.json",
			JSON.stringify(blob([slice(1, ["a/**"]), slice(2, ["a/x.ts"])])),
		);
		put(
			"cycle.json",
			JSON.stringify(blob([slice(1, ["a/**"], [2]), slice(2, ["b/**"], [1])])),
		);
		const common = [
			"scaffold",
			"--home",
			"specs",
			"--slug",
			"f",
			"--allow-overlap",
			"--from-json",
		];
		expect((await spec([...common, "overlap.json"])).exitCode).toBe(0);
		const cycle = await spec([...common, "cycle.json"]);
		expect(cycle.exitCode).toBe(2);
		expect(readdirSync(join(context.root, "specs"))).toEqual(["001_f"]);
	});
});

describe("dg-skills spec lean context", () => {
	test("context <bundle> writes frontmatter plus summaries, never the plan body, and is repeatable", async () => {
		put("bundle/plan.md", SPEC);
		put(".agents/paths.md", "# Paths marker\n");
		initRepo(context.root);
		const first = await spec(["context", "bundle"]);
		expect(first.exitCode).toBe(0);
		expect(first.stdout).toBe(
			`${join(context.root, "bundle", "context.md")}\n`,
		);
		const text = read("bundle/context.md");
		expect(text).toContain("# Paths marker");
		expect(text).toContain("## Slice Summaries");
		expect(text).not.toContain("Distinctive purpose text");
		expect(text).not.toContain("# Auth Rewrite");
		await spec(["context", "bundle"]);
		expect(read("bundle/context.md")).toBe(text);
		expect(readdirSync(join(context.root, "bundle")).sort()).toEqual([
			"context.md",
			"plan.md",
		]);
	});

	test("context <bundle> --json prints the projection and writes nothing", async () => {
		put("bundle/plan.md", SPEC);
		const run = await spec(["context", "bundle", "--json"]);
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(run.stdout)).toMatchObject({
			feature: "Auth Rewrite",
			bundle: join(context.root, "bundle"),
			plan_path: join(context.root, "bundle", "plan.md"),
		});
		expect(existsSync(join(context.root, "bundle", "context.md"))).toBe(false);
	});
});

describe("dg-skills spec roundtable", () => {
	function outputsDir(stdout: string): string {
		const match = /^_Outputs: (.+)_$/m.exec(stdout);
		if (!match?.[1]) throw new Error(`no _Outputs line in ${stdout}`);
		return match[1];
	}

	test("a dry run records each agent prompt under a stamped scratch directory", async () => {
		put("plan.md", "# plan\n");
		const run = await spec([
			"roundtable",
			"plan.md",
			"--phase",
			"3b",
			"--dry-run",
		]);
		expect(run.exitCode).toBe(0);
		const directory = outputsDir(run.stdout);
		expect(directory.startsWith(join(context.scratch, "spec", "roundtable"))).toBe(
			true,
		);
		expect(directory).not.toContain("spec-cli");
		expect(basename(directory)).toBe(`plan-p3b-${FIXED_STAMP}`);
		for (const agent of ["reviewer", "qa-perf", "security"]) {
			expect(readFileSync(join(directory, `${agent}.md`), "utf8")).toStartWith(
				`[DRY] claude -p --agent dg:${agent} --permission-mode plan --output-format text <<<\n`,
			);
		}
	});

	test("a failing reviewer is recorded and does not fail the roundtable", async () => {
		put("plan.md", "# plan\n");
		const bin = join(context.base, "failing bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 3\n");
		chmodSync(join(bin, "claude"), 0o755);
		const run = await spec(
			["roundtable", "plan.md", "--phase", "5", "--agents", "reviewer"],
			{ env: { PATH: `${bin}:${process.env.PATH}` } },
		);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("[FAILED exit=3]");
	});

	test("a reviewer that leaves a background process holding its output does not hang the roundtable", async () => {
		put("plan.md", "# plan\n");
		const bin = join(context.base, "lingering bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(
			join(bin, "claude"),
			"#!/bin/sh\nsleep 8 &\nprintf 'reviewed\\n'\n",
		);
		chmodSync(join(bin, "claude"), 0o755);
		const started = performance.now();
		const run = await spec(
			["roundtable", "plan.md", "--phase", "5", "--agents", "reviewer"],
			{ env: { PATH: `${bin}:${process.env.PATH}` } },
		);
		expect(performance.now() - started).toBeLessThan(6000);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("reviewed");
	}, 20_000);

	test("a missing claude binary is recorded as exit 127 with the reason in the err file", async () => {
		put("plan.md", "# plan\n");
		const bin = join(context.base, "no claude bin");
		mkdirSync(bin, { recursive: true });
		const run = await spec(
			["roundtable", "plan.md", "--phase", "5", "--agents", "reviewer"],
			{ env: { PATH: bin } },
		);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("[FAILED exit=127]");
	});
});

describe("dg-skills spec legacy status parity", () => {
	test("ready reads only dependsOn, so the depends_on edge scaffold writes never blocks", async () => {
		put("spec.md", SPEC);
		initRepo(context.root);
		const run = await spec(["ready", "spec.md", "2"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toBe("slice 2 has no dependencies — ready\n");
	});
});

describe("dg-skills spec defects the TypeScript port must not carry over", () => {
	test("ready requires every dependency written as a YAML block list", async () => {
		put(
			"spec.md",
			"---\nslices:\n  - id: 1\n    dependsOn: []\n  - id: 2\n    dependsOn: []\n  - id: 3\n    dependsOn:\n      - 1\n      - 2\n---\n",
		);
		initRepo(context.root);
		runFixtureGit(
			["commit", "-q", "--allow-empty", "-m", "slice-1: model"],
			context.root,
		);
		const run = await spec(["ready", "spec.md", "3"]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("slice 3 BLOCKED by uncommitted deps: 2\n");
	});

	test("diff-bundle maps flow-style files lists like block-style ones", async () => {
		put("spec.md", SPEC);
		put("src/model/a.ts", "a");
		runFixtureGit(["init", "-q", "-b", "main"], context.root);
		runFixtureGit(["add", "spec.md"], context.root);
		runFixtureGit(["commit", "-q", "-m", "init"], context.root);
		runFixtureGit(["checkout", "-q", "-b", "feat"], context.root);
		runFixtureGit(["add", "-A"], context.root);
		runFixtureGit(["commit", "-q", "-m", "work"], context.root);
		const run = await spec(["diff-bundle", "spec.md"]);
		expect(run.stdout).toBe(
			"## Slice 1\n  src/model/a.ts\n## Slice 2\n  (none)\n## (unmapped)\n  (none)\n",
		);
	});

	test("validate rejects a second spec argument instead of ignoring it", async () => {
		put("a.md", SPEC);
		put("b.md", SPEC);
		const run = await spec(["validate", "a.md", "b.md"]);
		expect(run.exitCode).toBe(2);
		expect(run.stderr).toContain("single <spec> argument");
	});

	test("prototype-ref refuses slice 0 instead of writing onto the last slice", async () => {
		put("bundle/plan.md", SPEC);
		put("proto.html", "<p>x</p>");
		const run = await spec([
			"prototype-ref",
			"bundle",
			"--slice",
			"0",
			"--path",
			"proto.html",
			"--variant",
			"a",
		]);
		expect(run.exitCode).toBe(2);
		expect(read("bundle/plan.md")).toBe(SPEC);
		expect(existsSync(join(context.root, "bundle/prototype"))).toBe(false);
	});

	test("perms rewrites an empty permissions flow map in place without a duplicate key", async () => {
		put(
			"spec.md",
			"---\nstatus: draft\npermissions: {}\ncurrent_slice: 1\n---\n\n# T\n",
		);
		const run = await spec(["perms", "spec.md", "--allow"]);
		expect(run.exitCode).toBe(0);
		const text = read("spec.md");
		expect(text.match(/^permissions:/gm)).toHaveLength(1);
		expect(splitFrontmatter(text).data).toMatchObject({
			permissions: { run_commands: true },
			current_slice: 1,
		});
	});

	test("set keeps the body's trailing newline byte for byte", async () => {
		put("plan.md", SPEC);
		await spec(["set", "plan.md", "current_slice", "2"]);
		const text = read("plan.md");
		expect(text.endsWith(`\n---\n${splitFrontmatter(SPEC).body}`)).toBe(true);
		expect(text.endsWith("## Agent Notes\n")).toBe(true);
	});
});
