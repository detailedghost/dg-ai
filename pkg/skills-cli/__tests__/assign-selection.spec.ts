import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveArgs, runAssign } from "./assign-plan-builder";
import { makeTempDir } from "./git-repo-fixtures";
import { runFixtureGit } from "./spec-fixtures";

const SKILLS = join(import.meta.dir, "../../../plugins/dg/skills");
const PLAN = join(import.meta.dir, "fixtures", "assign", "plan-high.md");

const priorSkillsDir = process.env.DG_SKILLS_DIR;
beforeAll(() => {
	process.env.DG_SKILLS_DIR = SKILLS;
});
afterAll(() => {
	if (priorSkillsDir === undefined) delete process.env.DG_SKILLS_DIR;
	else process.env.DG_SKILLS_DIR = priorSkillsDir;
});

const temps: string[] = [];
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "assign-selection-"));
	temps.push(dir);
	return dir;
}

function commit(repo: string, subject: string): void {
	runFixtureGit(["commit", "-q", "--allow-empty", "-m", subject], repo);
}

interface Repo {
	dir: string;
}

function repoOnMain(subjects: string[]): Repo {
	const dir = makeTempDir("assign-selection-repo-");
	temps.push(dir);
	runFixtureGit(["init", "-q", "-b", "main"], dir);
	commit(dir, "chore: initial");
	for (const subject of subjects) commit(dir, subject);
	return { dir };
}

function featureBranch(base: string[], onBranch: string[]): Repo {
	const repo = repoOnMain(base);
	runFixtureGit(["checkout", "-q", "-b", "feat"], repo.dir);
	for (const subject of onBranch) commit(repo.dir, subject);
	return repo;
}

const ids = (args: { slices: { id: number }[] }) => args.slices.map((s) => s.id);

describe("assign resolve default selection", () => {
	test("selects only slices lacking a slice-<id>: subject in the merge-base range", async () => {
		const repo = featureBranch([], ["feat(cli): slice-2: migration"]);
		const args = await resolveArgs([PLAN, "--cwd", repo.dir]);
		expect(ids(args)).toEqual([1, 3]);
	});

	test("ignores a slice-1 subject below the merge-base", async () => {
		const repo = featureBranch(["feat(cli): slice-1: from an earlier run"], ["feat(cli): slice-2: migration"]);
		const args = await resolveArgs([PLAN, "--cwd", repo.dir]);
		expect(ids(args)).toEqual([1, 3]);
	});

	test("on the default branch every slice is pending", async () => {
		const repo = repoOnMain(["feat(cli): slice-1: parser", "feat(cli): slice-2: migration", "feat(cli): slice-3: report"]);
		const args = await resolveArgs([PLAN, "--cwd", repo.dir]);
		expect(ids(args)).toEqual([1, 2, 3]);
	});

	test("limits dependsOn to the pending slices", async () => {
		const repo = featureBranch([], ["feat(cli): slice-2: migration"]);
		const args = await resolveArgs([PLAN, "--cwd", repo.dir]);
		expect(args.slices.map((s) => [s.id, s.dependsOn])).toEqual([
			[1, []],
			[3, [1]],
		]);
	});

	test("prints no pending slices, writes no runner and exits 0 when every slice has a marker", async () => {
		const repo = featureBranch([], ["feat(cli): slice-1: a", "feat(cli): slice-2: b", "feat(cli): slice-3: c"]);
		const wave = join(scratch(), "wave");
		const result = await runAssign(["resolve", PLAN, "--cwd", repo.dir, "--wave", wave]);
		expect(result.status).toBe(0);
		expect(result.out.trim()).toBe("no pending slices");
		expect(existsSync(wave) ? readdirSync(wave) : []).toEqual([]);
	});

	test("exits 1 and selects nothing when --cwd is outside a repository", async () => {
		const outside = makeTempDir("assign-selection-norepo-");
		temps.push(outside);
		const result = await runAssign(["resolve", PLAN, "--cwd", outside]);
		expect(result.status).toBe(1);
		expect(result.out).not.toContain('"slices"');
	});
});

describe("assign resolve --slices and --layer", () => {
	test("--slices selects exactly the named ids", async () => {
		const args = await resolveArgs([PLAN, "--slices", "1,3"]);
		expect(ids(args)).toEqual([1, 3]);
	});

	test("--layer still selects the layer", async () => {
		expect(ids(await resolveArgs([PLAN, "--layer", "1"]))).toEqual([3]);
		expect(ids(await resolveArgs([PLAN, "--layer", "0"]))).toEqual([1, 2]);
	});

	test("--layer together with --slices exits 2", async () => {
		const result = await runAssign(["resolve", PLAN, "--layer", "0", "--slices", "1"]);
		expect(result.status).toBe(2);
	});

	test("--slices naming an unknown id exits 1 and names the id", async () => {
		const result = await runAssign(["resolve", PLAN, "--slices", "1,9"]);
		expect(result.status).toBe(1);
		expect(result.err).toContain("slice 9 is not in");
	});

	test("--slices with an empty entry or an empty value exits 2", async () => {
		expect((await runAssign(["resolve", PLAN, "--slices", "1,,3"])).status).toBe(2);
		expect((await runAssign(["resolve", PLAN, "--slices", ""])).status).toBe(2);
	});

	test("--slices with a duplicate id selects the slice once", async () => {
		expect(ids(await resolveArgs([PLAN, "--slices", "1,1"]))).toEqual([1]);
	});
});

describe("assign resolve default branch resolution", () => {
	test("resolves a master default branch", async () => {
		const dir = makeTempDir("assign-selection-master-");
		temps.push(dir);
		runFixtureGit(["init", "-q", "-b", "master"], dir);
		commit(dir, "chore: initial");
		runFixtureGit(["checkout", "-q", "-b", "feat"], dir);
		commit(dir, "feat(cli): slice-2: migration");
		expect(ids(await resolveArgs([PLAN, "--cwd", dir]))).toEqual([1, 3]);
	});

	test("resolves origin/HEAD when it names a branch other than main or master", async () => {
		const upstream = makeTempDir("assign-selection-upstream-");
		temps.push(upstream);
		runFixtureGit(["init", "-q", "-b", "trunk"], upstream);
		commit(upstream, "chore: initial");
		commit(upstream, "feat(cli): slice-1: from trunk");
		const clone = join(scratch(), "clone");
		runFixtureGit(["clone", "-q", upstream, clone], upstream);
		runFixtureGit(["checkout", "-q", "-b", "feat"], clone);
		commit(clone, "feat(cli): slice-2: migration");
		expect(ids(await resolveArgs([PLAN, "--cwd", clone]))).toEqual([1, 3]);
	});

	test("exits 1 and selects nothing when no default branch can be resolved", async () => {
		const dir = makeTempDir("assign-selection-trunk-");
		temps.push(dir);
		runFixtureGit(["init", "-q", "-b", "trunk"], dir);
		commit(dir, "chore: initial");
		const result = await runAssign(["resolve", PLAN, "--cwd", dir]);
		expect(result.status).toBe(1);
		expect(result.out).not.toContain('"slices"');
		expect(result.err).toContain("cannot resolve the default branch");
	});

	test("exits 1 and selects nothing when the branch shares no history with the default", async () => {
		const repo = repoOnMain([]);
		runFixtureGit(["checkout", "-q", "--orphan", "unrelated"], repo.dir);
		commit(repo.dir, "chore: unrelated root");
		const result = await runAssign(["resolve", PLAN, "--cwd", repo.dir]);
		expect(result.status).toBe(1);
		expect(result.out).not.toContain('"slices"');
		expect(result.err).toContain("cannot find merge-base");
	});

	test("a slice-10: subject does not mark slice 1 done", async () => {
		const repo = featureBranch([], ["feat(cli): slice-10: other work"]);
		expect(ids(await resolveArgs([PLAN, "--cwd", repo.dir]))).toEqual([1, 2, 3]);
	});
});

describe("assign resolve commit marker matching", () => {
	test.each([
		["a scoped conventional subject", "feat(cli): slice-1: parser", [2, 3]],
		["an unscoped conventional subject", "fix: slice-1: parser", [2, 3]],
		["a breaking conventional subject", "feat(cli)!: slice-1: parser", [2, 3]],
		["a revert prefix", "fix: revert slice-1: parser", [1, 2, 3]],
		["a git revert subject", 'Revert "feat(cli): slice-1: parser"', [1, 2, 3]],
		["a bare marker without a type", "slice-1: parser", [1, 2, 3]],
		["a marker mid-subject", "feat(cli): add slice-1: parser", [1, 2, 3]],
		["a longer slice id", "feat(cli): slice-10: parser", [1, 2, 3]],
	])("%s", async (_name, subject, pending) => {
		const repo = featureBranch([], [subject]);
		expect(ids(await resolveArgs([PLAN, "--cwd", repo.dir]))).toEqual(pending);
	});
});

describe("assign resolve runner file name", () => {
	async function runnerName(args: string[], repo?: Repo): Promise<string> {
		const wave = join(scratch(), "wave");
		const cwd = repo ? ["--cwd", repo.dir] : [];
		const result = await runAssign(["resolve", PLAN, ...args, ...cwd, "--wave", wave]);
		expect(result.err).toBe("");
		expect(result.status).toBe(0);
		const names = readdirSync(wave);
		expect(result.out.trim()).toBe(join(wave, names[0] as string));
		return names[0] as string;
	}

	test("names a layer selection layer<N>", async () => {
		expect(await runnerName(["--layer", "1"])).toBe("slice-wave.layer1.workflow.js");
	});

	test("names a --slices selection s<id>-<id>", async () => {
		expect(await runnerName(["--slices", "1,3"])).toBe("slice-wave.s1-3.workflow.js");
	});

	test("names the default selection pending", async () => {
		const repo = featureBranch([], ["feat(cli): slice-2: migration"]);
		expect(await runnerName([], repo)).toBe("slice-wave.pending.workflow.js");
	});
});
