import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTempDir } from "./git-repo-fixtures";
import {
	baseEnv,
	disposeSpecContext,
	newSpecContext,
	runFixtureGit,
	runSourceSpec,
	type SpecContext,
	type SpecRun,
	splitFrontmatter,
} from "./spec-fixtures";

const slices = (complexity?: string) => `slices:
  - id: 1
    name: "Model"
    depends_on: []
    files: ["src/model/**"]
    agents:
      primary: js
${complexity === undefined ? "" : `      complexity: ${complexity}\n`}  - id: 2
    name: "Api"
    depends_on: [1]
    files: ["src/api/**"]
    agents:
      primary: js
`;

function plan(options: { execution?: string; complexity?: string } = {}): string {
	return `---
feature: "Auth Rewrite"
date: "2026-01-15"
status: draft
current_slice: 0
${options.execution === undefined ? "" : `${options.execution}\n`}${slices(options.complexity)}---

# Auth Rewrite
`;
}

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

function spec(args: string[], cwd = context.root): Promise<SpecRun> {
	return runSourceSpec(args, { cwd, env: baseEnv(context) });
}

describe("dg-skills spec validate execution.profile", () => {
	test("reports one enum_violation on execution.profile for a profile outside the enum", async () => {
		put("plan.md", plan({ execution: "execution:\n  profile: turbo" }));
		const run = await spec(["validate", "plan.md"]);
		expect(run.exitCode).toBe(1);
		const diagnostics = JSON.parse(run.stdout) as {
			field: string;
			kind: string;
		}[];
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({
			field: "execution.profile",
			kind: "enum_violation",
		});
	});

	test.each(["balance", "cheap", "expensive"])(
		"accepts execution.profile %s",
		async (profile) => {
			put("plan.md", plan({ execution: `execution:\n  profile: ${profile}` }));
			const run = await spec(["validate", "plan.md"]);
			expect(run.stdout).toContain(": ok");
			expect(run.exitCode).toBe(0);
		},
	);

	test.each([
		["a scalar execution", "execution: cheap", "execution"],
		["a numeric profile", "execution:\n  profile: 5", "execution.profile"],
	])("reports wrong_type for %s", async (_name, execution, field) => {
		put("plan.md", plan({ execution }));
		const run = await spec(["validate", "plan.md"]);
		expect(run.exitCode).toBe(1);
		const diagnostics = JSON.parse(run.stdout) as { field: string; kind: string }[];
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ field, kind: "wrong_type" });
	});

	test("an empty profile value stays valid", async () => {
		put("plan.md", plan({ execution: "execution:\n  profile:" }));
		expect((await spec(["validate", "plan.md"])).exitCode).toBe(0);
	});

	test("a plan with no execution block stays valid", async () => {
		put("plan.md", plan());
		expect((await spec(["validate", "plan.md"])).exitCode).toBe(0);
	});
});

describe("dg-skills spec set execution.profile", () => {
	test("adds an execution block to a plan without one and changes nothing else", async () => {
		const original = plan();
		put("plan.md", original);
		const run = await spec(["set", "plan.md", "execution.profile", "expensive"]);
		expect(run.exitCode).toBe(0);
		const text = read("plan.md");
		expect(text).toContain("execution:\n  profile: expensive\n");
		expect(text.replace("execution:\n  profile: expensive\n", "")).toBe(
			original,
		);
		expect((await spec(["validate", "plan.md"])).exitCode).toBe(0);
	});
});

describe("dg-skills spec context execution and complexity", () => {
	function projection(text: string) {
		return splitFrontmatter(text).data as {
			execution?: { profile?: string };
			slices: { agents: { complexity?: string } }[];
		};
	}

	test("writes execution.profile and agents.complexity into context.md when present", async () => {
		put(
			"bundle/plan.md",
			plan({ execution: "execution:\n  profile: cheap", complexity: "high" }),
		);
		const run = await spec(["context", "bundle"]);
		expect(run.exitCode).toBe(0);
		const data = projection(read("bundle/context.md"));
		expect(data.execution).toEqual({ profile: "cheap" });
		expect(data.slices[0]?.agents.complexity).toBe("high");
		expect(data.slices[1]?.agents).not.toHaveProperty("complexity");
	});

	test("omits both keys when the plan sets neither", async () => {
		put("bundle/plan.md", plan());
		const run = await spec(["context", "bundle"]);
		expect(run.exitCode).toBe(0);
		const data = projection(read("bundle/context.md"));
		expect(data).not.toHaveProperty("execution");
		for (const entry of data.slices)
			expect(entry.agents).not.toHaveProperty("complexity");
	});

	test("--json carries the same projection", async () => {
		put(
			"bundle/plan.md",
			plan({ execution: "execution:\n  profile: expensive", complexity: "low" }),
		);
		const run = await spec(["context", "bundle", "--json"]);
		const data = JSON.parse(run.stdout) as ReturnType<typeof projection>;
		expect(data.execution).toEqual({ profile: "expensive" });
		expect(data.slices[0]?.agents.complexity).toBe("low");
	});
});

describe("dg-skills spec ready --cwd", () => {
	const SPEC_TEXT = `---
slices:
  - id: 1
    depends_on: []
  - id: 2
    depends_on: [1]
---
`;

	function repoWithOldMarker() {
		const repo = makeTempDir("dg-ready-cwd-");
		runFixtureGit(["init", "-q", "-b", "main"], repo);
		runFixtureGit(
			["commit", "-q", "--allow-empty", "-m", "feat(cli): slice-1: from an earlier run"],
			repo,
		);
		runFixtureGit(["checkout", "-q", "-b", "feat"], repo);
		return repo;
	}

	test("a slice-1 subject below the merge-base does not satisfy the dependency under --cwd", async () => {
		const repo = repoWithOldMarker();
		const specPath = put("spec.md", SPEC_TEXT);
		const run = await spec(["ready", specPath, "2", "--cwd", repo]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("slice 2 BLOCKED by uncommitted deps: 1\n");
	});

	test("a slice-1 subject above the merge-base satisfies the dependency under --cwd", async () => {
		const repo = repoWithOldMarker();
		runFixtureGit(
			["commit", "-q", "--allow-empty", "-m", "feat(cli): slice-1: model"],
			repo,
		);
		const specPath = put("spec.md", SPEC_TEXT);
		const run = await spec(["ready", specPath, "2", "--cwd", repo]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("slice 2 ready");
	});

	test("exits 1 when --cwd is not inside a git repo", async () => {
		const outside = makeTempDir("dg-ready-norepo-");
		const specPath = put("spec.md", SPEC_TEXT);
		const run = await spec(["ready", specPath, "2", "--cwd", outside]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).not.toContain("ready");
	});

	test("on the default branch the merge-base range is empty so no dependency is satisfied", async () => {
		const repo = makeTempDir("dg-ready-default-");
		runFixtureGit(["init", "-q", "-b", "main"], repo);
		runFixtureGit(["commit", "-q", "--allow-empty", "-m", "feat(cli): slice-1: model"], repo);
		const specPath = put("spec.md", SPEC_TEXT);
		const run = await spec(["ready", specPath, "2", "--cwd", repo]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("slice 2 BLOCKED by uncommitted deps: 1\n");
	});

	test.each([
		["a revert prefix", "fix: revert slice-1: model"],
		["a git revert subject", 'Revert "feat(cli): slice-1: model"'],
		["a bare marker without a type", "slice-1: model"],
		["a longer slice id", "feat(cli): slice-10: model"],
	])("%s does not satisfy the dependency", async (_name, subject) => {
		const repo = repoWithOldMarker();
		runFixtureGit(["commit", "-q", "--allow-empty", "-m", subject], repo);
		const specPath = put("spec.md", SPEC_TEXT);
		const run = await spec(["ready", specPath, "2", "--cwd", repo]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("slice 2 BLOCKED by uncommitted deps: 1\n");
	});

	test.each(["feat(cli): slice-1: model", "fix: slice-1: model", "feat(cli)!: slice-1: model"])(
		"the conventional subject %s satisfies the dependency",
		async (subject) => {
			const repo = repoWithOldMarker();
			runFixtureGit(["commit", "-q", "--allow-empty", "-m", subject], repo);
			const specPath = put("spec.md", SPEC_TEXT);
			const run = await spec(["ready", specPath, "2", "--cwd", repo]);
			expect(run.exitCode).toBe(0);
		},
	);

	test("without --cwd a revert subject does not satisfy the dependency", async () => {
		const repo = makeTempDir("dg-ready-revert-");
		runFixtureGit(["init", "-q", "-b", "main"], repo);
		runFixtureGit(["commit", "-q", "--allow-empty", "-m", "fix: revert slice-1: model"], repo);
		const specPath = join(repo, "spec.md");
		writeFileSync(specPath, SPEC_TEXT);
		const run = await spec(["ready", specPath, "2"]);
		expect(run.exitCode).toBe(1);
		expect(run.stdout).toBe("slice 2 BLOCKED by uncommitted deps: 1\n");
	});

	test("without --cwd the whole log of the spec's repo is read", async () => {
		const repo = repoWithOldMarker();
		const specPath = join(repo, "spec.md");
		writeFileSync(specPath, SPEC_TEXT);
		const run = await spec(["ready", specPath, "2"]);
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("slice 2 ready");
	});
});
