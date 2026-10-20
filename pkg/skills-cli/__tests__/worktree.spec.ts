import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { Command } from "commander";
import { createWorktree } from "../src/deps-upgrade/worktree-compat";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { scratchFixtures } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";

cliFixtures.isolateCliTests();
const fixtures = scratchFixtures();
afterEach(() => fixtures.cleanup());

const CLI = join(import.meta.dir, "../src/index.ts");
const { runGit, commitFile, shScript } = cliFixtures;
const GITHUB_URL = "https://github.com/acme/widgets.git";
const GITLAB_URL = "https://gitlab.com/acme/widgets.git";
const ESCAPE = String.fromCharCode(27);

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function worktree(
	args: string[],
	cwd: string,
	env: Record<string, string | undefined> = {},
): Promise<RunResult> {
	const proc = Bun.spawn([process.execPath, "run", CLI, "worktree", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
		env: mergeEnv({ LC_ALL: "C", NO_COLOR: undefined, ...env }),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

function homeDir(): string {
	const home = process.env.HOME;
	if (!home) throw new Error("HOME is not set");
	return home;
}

function trackedRepo(homeCode = false) {
	const root = fixtures.tmp("worktree-");
	const upstream = join(root, "upstream origin.git");
	mkdirSync(upstream);
	runGit(["init", "-q", "--bare", "-b", "main"], upstream);
	const repo = homeCode
		? join(homeDir(), "code", "widgets")
		: join(root, "widgets repo");
	cliFixtures.initTrackedRepo(repo, upstream);
	runGit(["push", "-q", "-u", "origin", "main"], repo);
	return { root, upstream, repo };
}

function expectedPath(repo: string, slug: string, homeCode = false) {
	return join(
		homeCode ? join(homeDir(), "code", "worktrees") : dirname(repo),
		`${basename(repo)}-${slug}`,
	);
}

function unquote(value: string): string {
	return value.startsWith("'")
		? value.slice(1, -1).replaceAll("'\\''", "'")
		: value;
}

function keyValues(stdout: string): Record<string, string> {
	return Object.fromEntries(
		stdout
			.trimEnd()
			.split("\n")
			.map((line) => {
				const at = line.indexOf("=");
				return [line.slice(0, at), unquote(line.slice(at + 1))];
			}),
	);
}

async function created(repo: string, slug: string, extra: string[] = []) {
	const result = await worktree(["create", slug, ...extra], repo);
	expect(result.exitCode).toBe(0);
	return keyValues(result.stdout);
}

function branchExists(repo: string, branch: string): boolean {
	return (
		Bun.spawnSync(
			["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
			{ cwd: repo },
		).exitCode === 0
	);
}

function registered(repo: string, path: string): boolean {
	return runGit(["worktree", "list", "--porcelain"], repo)
		.split("\n")
		.includes(`worktree ${path}`);
}

function secondBranchWithSlug(repo: string, branch: string) {
	const path = join(fixtures.tmp("worktree-dup-"), "wt");
	runGit(["worktree", "add", "-q", "-b", branch, path, "main"], repo);
	return path;
}

function providerRepo(url: string) {
	const repo = fixtures.tmp("worktree-provider-");
	const { shaA } = cliFixtures.initTrackedRepo(repo, url);
	return { repo, shaA };
}

function unmergedWorktree(repo: string, branch: string, base: string) {
	const path = join(fixtures.tmp("worktree-linked-"), "wt");
	runGit(["branch", branch, base], repo);
	runGit(["worktree", "add", "-q", path, branch], repo);
	commitFile(path, "feature.txt", "feature work", "feat: unique change");
	return path;
}

function callLog(): string {
	return join(fixtures.tmp("worktree-log-"), "calls.log");
}

function fakeBin(): string {
	return fixtures.tmp("worktree-bin-");
}

function ghRepoView(): string {
	return JSON.stringify({
		owner: { login: "acme" },
		name: "widgets",
		defaultBranchRef: { name: "main" },
		url: "https://github.com/acme/widgets",
	});
}

function ghWithPulls(pullsBody: string, exitCode = 0): string {
	return shScript(`
  *"repo view"*)
    cat <<'JSON'
${ghRepoView()}
JSON
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    ${exitCode === 0 ? `cat <<'JSON'\n${pullsBody}\nJSON` : `echo "gh: authentication required" >&2`}
    exit ${exitCode}
    ;;`);
}

describe("worktree command registration", () => {
	test("registers a worktree command on the program without running a handler", async () => {
		const { registerWorktree } = await import("../src/commands/worktree");
		const program = new Command().enablePositionalOptions();
		registerWorktree(program);
		expect(program.commands.map((command) => command.name())).toContain(
			"worktree",
		);
	});
});

describe("worktree top-level dispatch", () => {
	test("no arguments prints usage on stderr, leaves stdout empty and exits 1", async () => {
		const { repo } = trackedRepo();
		const result = await worktree([], repo);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("create");
		expect(result.stderr).toContain("remove");
		expect(result.stderr).toStartWith("dg-skills worktree — ");
		expect(result.stderr).not.toContain("worktree-cli");
	});

	test("an unknown subcommand names it and exits 2", async () => {
		const { repo } = trackedRepo();
		const result = await worktree(["bogus"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe(
			"dg-skills worktree: unknown subcommand: bogus (try --help)\n",
		);
	});

	test("an inherited object property name is an unknown subcommand", async () => {
		const { repo } = trackedRepo();
		const result = await worktree(["toString"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("unknown subcommand: toString");
	});

	test.each([
		["create", "--prefix"],
		["list", "--porcelain"],
		["remove", "--keep-branch"],
		["prune", "git worktree prune"],
	])(
		"%s --help exits 0 and documents its flags without touching the repository",
		async (sub, flag) => {
			const { repo } = trackedRepo();
			const result = await worktree([sub, "--help"], repo);
			expect(result.exitCode).toBe(0);
			expect(`${result.stdout}${result.stderr}`).toContain(flag);
			expect(
				runGit(["worktree", "list", "--porcelain"], repo).match(/^worktree /gm),
			).toHaveLength(1);
		},
	);
});

describe("worktree create output contract", () => {
	test("prints exactly WORKTREE_PATH, WORKTREE_BRANCH and WORKTREE_ORIGIN in order and sends progress to stderr", async () => {
		const { repo } = trackedRepo();
		const result = await worktree(["create", "My Feature!"], repo);
		const path = expectedPath(repo, "my_feature");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(
			`WORKTREE_PATH='${path}'\nWORKTREE_BRANCH=feature/my_feature\nWORKTREE_ORIGIN='${repo}'\n`,
		);
		expect(result.stderr).toContain("fetching origin/main");
		expect(result.stderr).toContain("creating worktree");
		expect(runGit(["branch", "--show-current"], path).trim()).toBe(
			"feature/my_feature",
		);
		expect(runGit(["rev-parse", "HEAD"], path)).toBe(
			runGit(["rev-parse", "origin/main"], repo),
		);
	});

	test("stdout stays eval-safe for a path containing spaces", async () => {
		const { repo } = trackedRepo();
		expect(repo).toContain(" ");
		const proc = Bun.spawnSync(
			[
				"sh",
				"-c",
				'eval "$("$1" run "$2" worktree create spaced)" && printf "%s|%s|%s" "$WORKTREE_PATH" "$WORKTREE_BRANCH" "$WORKTREE_ORIGIN"',
				"sh",
				process.execPath,
				CLI,
			],
			{ cwd: repo, env: mergeEnv({ LC_ALL: "C" }) },
		);
		expect(proc.stdout.toString()).toBe(
			`${expectedPath(repo, "spaced")}|feature/spaced|${repo}`,
		);
	});

	test("shell-safe values print raw, byte-identical to the legacy output", async () => {
		const root = fixtures.tmp("worktree-plain-");
		const upstream = join(root, "upstream.git");
		mkdirSync(upstream);
		runGit(["init", "-q", "--bare", "-b", "main"], upstream);
		const repo = join(root, "widgets");
		cliFixtures.initTrackedRepo(repo, upstream);
		runGit(["push", "-q", "-u", "origin", "main"], repo);
		const result = await worktree(["create", "plain"], repo);
		expect(result.stdout).toBe(
			`WORKTREE_PATH=${expectedPath(repo, "plain")}\nWORKTREE_BRANCH=feature/plain\nWORKTREE_ORIGIN=${repo}\n`,
		);
	});

	test.each([
		["without spaces", "widgets"],
		["with spaces and a quote", "wid gets's repo"],
	])("stdout feeds eval for a path %s", async (_label, name) => {
		const root = fixtures.tmp("worktree-eval-");
		const upstream = join(root, "upstream.git");
		mkdirSync(upstream);
		runGit(["init", "-q", "--bare", "-b", "main"], upstream);
		const repo = join(root, name);
		cliFixtures.initTrackedRepo(repo, upstream);
		runGit(["push", "-q", "-u", "origin", "main"], repo);
		const proc = Bun.spawnSync(
			[
				"sh",
				"-c",
				'eval "$("$1" run "$2" worktree create spaced)" && printf "%s|%s|%s" "$WORKTREE_PATH" "$WORKTREE_BRANCH" "$WORKTREE_ORIGIN"',
				"sh",
				process.execPath,
				CLI,
			],
			{ cwd: repo, env: mergeEnv({ LC_ALL: "C" }) },
		);
		expect(proc.stdout.toString()).toBe(
			`${expectedPath(repo, "spaced")}|feature/spaced|${repo}`,
		);
	});

	test("emits no ANSI escapes on a piped stderr", async () => {
		const { repo } = trackedRepo();
		const result = await worktree(["create", "plain"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).not.toBe("");
		expect(result.stderr).not.toContain(ESCAPE);
	});

	test("matches the packaged createWorktree result for the same slug", async () => {
		const { repo } = trackedRepo();
		const first = await createWorktree({ slug: "shared", cwd: repo }, () => {});
		const second = await created(repo, "shared");
		expect(second).toEqual({
			WORKTREE_PATH: first.path,
			WORKTREE_BRANCH: first.branch,
			WORKTREE_ORIGIN: first.origin,
		});
	});
});

describe("worktree create options", () => {
	test.each([
		["release", "release/"],
		["release/", "release/"],
		["team/chore/", "team/chore/"],
	])("prefix %s yields one trailing slash", async (prefix, normalized) => {
		const { repo } = trackedRepo();
		const values = await created(repo, "Upgrade", ["--prefix", prefix]);
		expect(values.WORKTREE_BRANCH).toBe(`${normalized}upgrade`);
	});

	test("-p and -b are aliases for --prefix and --base", async () => {
		const { repo } = trackedRepo();
		runGit(["branch", "develop", "main"], repo);
		runGit(["push", "-q", "origin", "develop"], repo);
		const values = await created(repo, "aliased", [
			"-p",
			"hot",
			"-b",
			"develop",
		]);
		expect(values.WORKTREE_BRANCH).toBe("hot/aliased");
		expect(runGit(["rev-parse", "HEAD"], values.WORKTREE_PATH)).toBe(
			runGit(["rev-parse", "origin/develop"], repo),
		);
	});

	test("places a repository under HOME/code in HOME/code/worktrees", async () => {
		const { repo } = trackedRepo(true);
		const values = await created(repo, "homed");
		expect(values.WORKTREE_PATH).toBe(expectedPath(repo, "homed", true));
	});

	test("resolves the primary repository when run inside a linked worktree", async () => {
		const { repo } = trackedRepo();
		const first = await created(repo, "first");
		const second = await worktree(["create", "second"], first.WORKTREE_PATH);
		expect(keyValues(second.stdout)).toEqual({
			WORKTREE_PATH: expectedPath(repo, "second"),
			WORKTREE_BRANCH: "feature/second",
			WORKTREE_ORIGIN: repo,
		});
	});

	test("a failed fetch warns and proceeds from the local origin ref", async () => {
		const repo = fixtures.tmp("worktree-offline-");
		cliFixtures.initTrackedRepo(repo, join(repo, "missing remote.git"));
		const result = await worktree(["create", "offline"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("fetch origin/main failed");
		expect(keyValues(result.stdout).WORKTREE_BRANCH).toBe("feature/offline");
	});

	test("warns about uncommitted main-repo changes and .agents changes without changing stdout", async () => {
		const { repo } = trackedRepo();
		mkdirSync(join(repo, ".agents"));
		writeFileSync(join(repo, ".agents", "note.md"), "draft");
		const result = await worktree(["create", "dirty"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("uncommitted changes");
		expect(result.stderr).toContain(".agents/");
		expect(result.stdout.trimEnd().split("\n")).toHaveLength(3);
	});
});

describe("worktree create seeding", () => {
	function writeSeedSources(repo: string) {
		const put = (file: string, content: string, mode?: number) => {
			mkdirSync(dirname(join(repo, file)), { recursive: true });
			writeFileSync(join(repo, file), content);
			if (mode) chmodSync(join(repo, file), mode);
		};
		put(".env", "SECRET=1", 0o600);
		put(".env.local", "LOCAL=1");
		put(".envrc", "export A=1");
		put(".nvmrc", "20");
		put(".tool-versions", "bun 1");
		put("packages/app/.env.local", "APP=1");
		put("packages/app/.nvmrc", "18");
		put("services/group/.env", "DEEP=1");
		put("one/two/three/.env", "TOO_DEEP=1");
		put("node_modules/pkg/.env", "VENDOR=1");
		put("README.local", "not config");
	}

	test("copies root config and one- and two-level nested .env files with their modes", async () => {
		const { repo } = trackedRepo();
		writeSeedSources(repo);
		const { WORKTREE_PATH: path } = await created(repo, "seeded");
		for (const file of [
			".env",
			".env.local",
			".envrc",
			".nvmrc",
			".tool-versions",
			"packages/app/.env.local",
			"services/group/.env",
		])
			expect(existsSync(join(path, file))).toBe(true);
		expect(statSync(join(path, ".env")).mode & 0o777).toBe(0o600);
	});

	test("skips non-config files, deeper nesting, nested non-env config and node_modules", async () => {
		const { repo } = trackedRepo();
		writeSeedSources(repo);
		const { WORKTREE_PATH: path } = await created(repo, "narrow");
		for (const file of [
			"README.local",
			"packages/app/.nvmrc",
			"one/two/three/.env",
			"node_modules/pkg/.env",
		])
			expect(existsSync(join(path, file))).toBe(false);
	});

	test("--no-seed and -N copy nothing", async () => {
		const { repo } = trackedRepo();
		writeSeedSources(repo);
		const long = await created(repo, "noseed_long", ["--no-seed"]);
		const short = await created(repo, "noseed_short", ["-N"]);
		expect(existsSync(join(long.WORKTREE_PATH, ".env"))).toBe(false);
		expect(existsSync(join(short.WORKTREE_PATH, ".env"))).toBe(false);
	});
});

describe("worktree create resume semantics", () => {
	test("branch and path both present resumes the same worktree, keeps dirty files and says so on stderr", async () => {
		const { repo } = trackedRepo();
		const first = await created(repo, "again");
		writeFileSync(join(first.WORKTREE_PATH, "wip.txt"), "unsaved");
		const head = runGit(["rev-parse", "HEAD"], first.WORKTREE_PATH);
		const second = await worktree(["create", "again"], repo);
		expect(second.exitCode).toBe(0);
		expect(keyValues(second.stdout)).toEqual(first);
		expect(second.stderr).toContain("resuming existing worktree");
		expect(existsSync(join(first.WORKTREE_PATH, "wip.txt"))).toBe(true);
		expect(runGit(["rev-parse", "HEAD"], first.WORKTREE_PATH)).toBe(head);
	});

	test("branch present but path missing recreates the worktree from the branch head", async () => {
		const { repo } = trackedRepo();
		const first = await created(repo, "recreate");
		const tip = commitFile(
			first.WORKTREE_PATH,
			"kept.txt",
			"kept",
			"feat: kept",
		);
		runGit(["worktree", "remove", "--force", first.WORKTREE_PATH], repo);
		const second = await worktree(["create", "recreate"], repo);
		expect(second.exitCode).toBe(0);
		expect(keyValues(second.stdout)).toEqual(first);
		expect(second.stderr).toContain("worktree missing");
		expect(runGit(["rev-parse", "HEAD"], first.WORKTREE_PATH).trim()).toBe(tip);
	});

	test("branch checked out at another path is reported and that path is used", async () => {
		const { repo } = trackedRepo();
		const elsewhere = join(fixtures.tmp("worktree-else-"), "wt");
		runGit(
			["worktree", "add", "-q", "-b", "feature/moved", elsewhere, "main"],
			repo,
		);
		mkdirSync(expectedPath(repo, "moved"));
		const result = await worktree(["create", "moved"], repo);
		expect(result.exitCode).toBe(0);
		expect(keyValues(result.stdout).WORKTREE_PATH).toBe(elsewhere);
		expect(result.stderr).toContain("using existing");
	});

	test("path present without a matching branch fails with exit 2 and creates nothing", async () => {
		const { repo } = trackedRepo();
		mkdirSync(expectedPath(repo, "orphan"));
		const result = await worktree(["create", "orphan"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("exists but no matching branch");
		expect(branchExists(repo, "feature/orphan")).toBe(false);
	});

	test("branch present and path a plain directory fails with exit 2 and creates nothing", async () => {
		const { repo } = trackedRepo();
		runGit(["branch", "feature/plaindir", "main"], repo);
		const target = expectedPath(repo, "plaindir");
		mkdirSync(target);
		const result = await worktree(["create", "plaindir"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("is not checked out there");
		expect(registered(repo, target)).toBe(false);
		expect(readdirSync(target)).toEqual([]);
	});

	test.each([
		["branch and path", async (repo: string) => created(repo, "taken")],
		[
			"branch only",
			async (repo: string) => {
				const values = await created(repo, "taken");
				runGit(["worktree", "remove", "--force", values.WORKTREE_PATH], repo);
			},
		],
		[
			"path only",
			async (repo: string) => {
				mkdirSync(expectedPath(repo, "taken"));
			},
		],
	])(
		"--no-resume refuses existing state (%s) with exit 2",
		async (_state, arrange) => {
			const { repo } = trackedRepo();
			await arrange(repo);
			const result = await worktree(["create", "taken", "--no-resume"], repo);
			expect(result.exitCode).toBe(2);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("--no-resume was passed");
		},
	);

	test("--no-resume on a fresh slug still creates", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "fresh", ["--no-resume"]);
		expect(values.WORKTREE_BRANCH).toBe("feature/fresh");
	});
});

describe("worktree create argument and repository errors", () => {
	test.each([
		["no slug", [], "create requires a slug"],
		["two slugs", ["one", "two"], "create takes one slug positional"],
		["unknown flag", ["--bogus", "slug"], "unknown flag for create: --bogus"],
		[
			"empty slug after normalizing",
			["!!!"],
			"slug normalized to empty string",
		],
	])("%s exits 2 with an empty stdout", async (_name, args, message) => {
		const { repo } = trackedRepo();
		const result = await worktree(["create", ...args], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(message);
	});

	test("outside a git repository exits 2", async () => {
		const result = await worktree(
			["create", "slug"],
			fixtures.tmp("worktree-plain-"),
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("not in a git repo");
	});

	test("an unresolvable origin/HEAD exits 2 and prints the set-head remedy", async () => {
		const { repo } = trackedRepo();
		runGit(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo);
		const result = await worktree(["create", "nohead"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(`git -C ${repo} remote set-head origin -a`);
	});

	test("an explicit --base skips origin/HEAD resolution", async () => {
		const { repo } = trackedRepo();
		runGit(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo);
		const values = await created(repo, "based", ["--base", "main"]);
		expect(values.WORKTREE_BRANCH).toBe("feature/based");
	});
});

describe("worktree list", () => {
	test("--porcelain prints SLUG, BRANCH and PATH blocks for linked worktrees only, with full paths containing spaces", async () => {
		const { repo } = trackedRepo();
		const alpha = await created(repo, "alpha");
		const beta = await created(repo, "beta", ["--prefix", "team/x"]);
		const result = await worktree(["list", "--porcelain"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(
			`SLUG=alpha\nBRANCH=feature/alpha\nPATH=${alpha.WORKTREE_PATH}\n\nSLUG=beta\nBRANCH=team/x/beta\nPATH=${beta.WORKTREE_PATH}\n\n`,
		);
	});

	test("-p is an alias and a repository with no linked worktrees prints nothing", async () => {
		const { repo } = trackedRepo();
		const result = await worktree(["list", "-p"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
	});

	test("the table puts its header on stderr and one fixed-width row per worktree on stdout with clean, dirty, ahead and MISSING states", async () => {
		const { repo } = trackedRepo();
		const clean = await created(repo, "clean_one");
		const dirty = await created(repo, "dirty_one");
		const ahead = await created(repo, "ahead_one");
		const missing = await created(repo, "gone_one");
		writeFileSync(join(dirty.WORKTREE_PATH, "wip.txt"), "x");
		runGit(
			["push", "-q", "-u", "origin", ahead.WORKTREE_BRANCH],
			ahead.WORKTREE_PATH,
		);
		commitFile(ahead.WORKTREE_PATH, "more.txt", "more", "feat: more");
		rmSync(missing.WORKTREE_PATH, { recursive: true, force: true });
		const result = await worktree(["list"], repo);
		const row = (slug: string, branch: string, status: string, path: string) =>
			`${slug.padEnd(24)} ${branch.padEnd(30)} ${status.padEnd(10)} ${path}`;
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain(
			`${"SLUG".padEnd(24)} ${"BRANCH".padEnd(30)} ${"STATUS".padEnd(10)} PATH`,
		);
		const rows = result.stdout.trimEnd().split("\n");
		expect([...rows].sort()).toEqual(
			[
				row("clean_one", clean.WORKTREE_BRANCH, "clean", clean.WORKTREE_PATH),
				row("dirty_one", dirty.WORKTREE_BRANCH, "dirty", dirty.WORKTREE_PATH),
				row("ahead_one", ahead.WORKTREE_BRANCH, "ahead 1", ahead.WORKTREE_PATH),
				row(
					"gone_one",
					missing.WORKTREE_BRANCH,
					"MISSING",
					missing.WORKTREE_PATH,
				),
			].sort(),
		);
	});

	test("a worktree whose branch has no upstream reports no-upstream", async () => {
		const { repo } = trackedRepo();
		const branch = "local-only-branch";
		const path = unmergedWorktree(repo, branch, "main");
		const result = await worktree(["list"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			`${branch.padEnd(24)} ${branch.padEnd(30)} ${"no-upstream".padEnd(10)} ${path}`,
		);
	});

	test("ls is an alias and an unknown argument exits 2", async () => {
		const { repo } = trackedRepo();
		await created(repo, "listed");
		expect((await worktree(["ls", "-p"], repo)).stdout).toContain(
			"SLUG=listed",
		);
		const bad = await worktree(["list", "--bogus"], repo);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr).toContain("unknown arg for list: --bogus");
	});

	test("outside a git repository exits 2", async () => {
		const result = await worktree(["list"], fixtures.tmp("worktree-plain-"));
		expect(result.exitCode).toBe(2);
	});
});

describe("worktree remove slug resolution", () => {
	test.each([
		["the slug", "feature", "by_slug", ["remove", "by_slug"]],
		["a differently cased slug", "feature", "by_case", ["remove", "By-Case"]],
		["the full branch name", "team/x", "by_full", ["remove", "team/x/by_full"]],
		["the rm alias", "feature", "by_alias", ["rm", "by_alias"]],
	])("accepts %s", async (_name, prefix, slug, args) => {
		const { repo } = trackedRepo();
		const values = await created(repo, slug, ["--prefix", prefix]);
		const result = await worktree([...args, "--merged-ok"], repo);
		expect(result.exitCode).toBe(0);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(false);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(false);
	});

	test("an ambiguous slug lists every candidate, asks for the full branch name and removes nothing", async () => {
		const { repo } = trackedRepo();
		const one = await created(repo, "dup");
		const twoBranch = "team/x/dup";
		const twoPath = secondBranchWithSlug(repo, twoBranch);
		const result = await worktree(["remove", "dup", "--force"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("ambiguous");
		expect(result.stderr).toContain(one.WORKTREE_BRANCH);
		expect(result.stderr).toContain(twoBranch);
		expect(result.stderr).toContain("full branch name");
		expect(registered(repo, one.WORKTREE_PATH)).toBe(true);
		expect(registered(repo, twoPath)).toBe(true);
	});

	test("the full branch name disambiguates", async () => {
		const { repo } = trackedRepo();
		const one = await created(repo, "dup");
		const twoPath = secondBranchWithSlug(repo, "team/x/dup");
		const result = await worktree(
			["remove", "team/x/dup", "--merged-ok"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(registered(repo, twoPath)).toBe(false);
		expect(registered(repo, one.WORKTREE_PATH)).toBe(true);
	});

	test.each([
		["no slug", ["remove"], "remove requires a slug"],
		[
			"unknown slug",
			["remove", "nothing_here"],
			"no worktree found for slug: nothing_here",
		],
		["two slugs", ["remove", "a", "b"], "remove takes one slug positional"],
		[
			"unknown flag",
			["remove", "--bogus", "a"],
			"unknown flag for remove: --bogus",
		],
	])("%s exits 2", async (_name, args, message) => {
		const { repo } = trackedRepo();
		const result = await worktree(args, repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(message);
	});
});

describe("worktree remove safety guards", () => {
	test("untracked files block removal without --force and leave worktree and branch intact", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "dirty");
		writeFileSync(join(values.WORKTREE_PATH, "scratch.txt"), "x");
		const result = await worktree(["remove", "dirty", "--merged-ok"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("uncommitted changes or untracked files");
		expect(registered(repo, values.WORKTREE_PATH)).toBe(true);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(true);
	});

	test("a blocked removal keeps stdout empty and never retries with force", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "quiet_block");
		writeFileSync(join(values.WORKTREE_PATH, "scratch.txt"), "x");
		const result = await worktree(["remove", "quiet_block"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(existsSync(join(values.WORKTREE_PATH, "scratch.txt"))).toBe(true);
	});

	test("tracked modifications block removal", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "modified");
		writeFileSync(join(values.WORKTREE_PATH, "base.txt"), "changed");
		const result = await worktree(["remove", "modified", "--merged-ok"], repo);
		expect(result.exitCode).toBe(2);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(true);
	});

	test("commits ahead of the upstream block removal with their count", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "unpushed");
		runGit(
			["push", "-q", "-u", "origin", values.WORKTREE_BRANCH],
			values.WORKTREE_PATH,
		);
		commitFile(values.WORKTREE_PATH, "a.txt", "a", "feat: a");
		commitFile(values.WORKTREE_PATH, "b.txt", "b", "feat: b");
		const result = await worktree(["remove", "unpushed", "--merged-ok"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("2 unpushed commit(s)");
		expect(registered(repo, values.WORKTREE_PATH)).toBe(true);
	});

	test("a branch with no upstream that is ahead of origin/<base> blocks removal", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "noupstream");
		runGit(["branch", "--unset-upstream"], values.WORKTREE_PATH);
		commitFile(values.WORKTREE_PATH, "a.txt", "a", "feat: a");
		const result = await worktree(
			["remove", "noupstream", "--merged-ok"],
			repo,
		);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("no upstream and is ahead of origin/main");
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(true);
	});

	test("a pushed branch that is not merged into origin/<base> blocks removal and names the base", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "unmerged");
		commitFile(values.WORKTREE_PATH, "a.txt", "a", "feat: a");
		runGit(
			["push", "-q", "-u", "origin", values.WORKTREE_BRANCH],
			values.WORKTREE_PATH,
		);
		const result = await worktree(["remove", "unmerged"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			`branch ${values.WORKTREE_BRANCH} is not merged into origin/main`,
		);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(true);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(true);
	});

	test("the dirty guard reports before the unmerged guard", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "both");
		writeFileSync(join(values.WORKTREE_PATH, "scratch.txt"), "x");
		const result = await worktree(["remove", "both"], repo);
		expect(result.stderr).toContain("uncommitted changes");
		expect(result.stderr).not.toContain("not merged");
	});

	test("--merged-ok skips only the merged guard and the dirty guard still blocks", async () => {
		const { repo } = trackedRepo();
		const clean = await created(repo, "okclean");
		const dirty = await created(repo, "okdirty");
		commitFile(clean.WORKTREE_PATH, "a.txt", "a", "feat: a");
		runGit(
			["push", "-q", "-u", "origin", clean.WORKTREE_BRANCH],
			clean.WORKTREE_PATH,
		);
		writeFileSync(join(dirty.WORKTREE_PATH, "scratch.txt"), "x");
		expect((await worktree(["remove", "okclean", "-m"], repo)).exitCode).toBe(
			0,
		);
		expect((await worktree(["remove", "okdirty", "-m"], repo)).exitCode).toBe(
			2,
		);
		expect(registered(repo, dirty.WORKTREE_PATH)).toBe(true);
	});

	test("--force overrides every guard and removes the worktree and its branch", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "forced");
		commitFile(values.WORKTREE_PATH, "a.txt", "a", "feat: a");
		writeFileSync(join(values.WORKTREE_PATH, "scratch.txt"), "x");
		const result = await worktree(["remove", "forced", "-f"], repo);
		expect(result.exitCode).toBe(0);
		expect(existsSync(values.WORKTREE_PATH)).toBe(false);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(false);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(false);
	});

	test("--keep-branch removes the worktree but keeps the branch", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "keeper");
		const result = await worktree(
			["remove", "keeper", "--merged-ok", "--keep-branch"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(false);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(true);
	});

	test("a clean branch with nothing ahead of origin/<base> is removed without --force", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "nothing_ahead");
		const result = await worktree(["remove", "nothing_ahead"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain(`removed: ${values.WORKTREE_BRANCH}`);
		expect(result.stdout).toBe("");
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(false);
	});

	test("a branch whose commits exist upstream as equivalent patches counts as merged without any provider call", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "picked");
		const sha = commitFile(values.WORKTREE_PATH, "p.txt", "p", "feat: p");
		runGit(
			["push", "-q", "-u", "origin", values.WORKTREE_BRANCH],
			values.WORKTREE_PATH,
		);
		runGit(["cherry-pick", sha], repo);
		runGit(["push", "-q", "origin", "main"], repo);
		const log = callLog();
		const bin = fakeBin();
		writeFakeCli(bin, "gh", shScript(""));
		const result = await worktree(["remove", "picked"], repo, {
			FAKE_CALL_LOG: log,
		});
		expect(result.exitCode).toBe(0);
		expect(cliFixtures.readCalls(log)).toEqual([]);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(false);
	});

	test("an unresolvable origin/HEAD blocks the merged check and points at --merged-ok or --force", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "nohead");
		runGit(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], repo);
		const result = await worktree(["remove", "nohead"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(
			"could not resolve origin/HEAD for merged-check",
		);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(true);
	});

	test("a locked worktree fails removal with exit 2 and is not force-removed", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "locked");
		runGit(["worktree", "lock", values.WORKTREE_PATH], repo);
		const result = await worktree(["remove", "locked", "--merged-ok"], repo);
		expect(result.exitCode).toBe(2);
		expect(existsSync(values.WORKTREE_PATH)).toBe(true);
		expect(registered(repo, values.WORKTREE_PATH)).toBe(true);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(true);
	});
});

describe("worktree remove with a worktree directory already gone", () => {
	test("the stale record is pruned and the branch deleted when --merged-ok is passed", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "vanished");
		rmSync(values.WORKTREE_PATH, { recursive: true, force: true });
		const result = await worktree(["remove", "vanished", "--merged-ok"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("already gone");
		expect(registered(repo, values.WORKTREE_PATH)).toBe(false);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(false);
	});

	test("the merged guard still applies to an unmerged branch without --force", async () => {
		const { repo } = trackedRepo();
		const values = await created(repo, "vanished_unmerged");
		commitFile(values.WORKTREE_PATH, "a.txt", "a", "feat: a");
		rmSync(values.WORKTREE_PATH, { recursive: true, force: true });
		const blocked = await worktree(["remove", "vanished_unmerged"], repo);
		expect(blocked.exitCode).toBe(2);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(true);
		const forced = await worktree(
			["remove", "vanished_unmerged", "--force"],
			repo,
		);
		expect(forced.exitCode).toBe(0);
		expect(branchExists(repo, values.WORKTREE_BRANCH)).toBe(false);
	});
});

describe("worktree remove provider merge fallback", () => {
	test("a GitHub merged pull request for the branch lets removal proceed through the REST pulls endpoint", async () => {
		const { repo, shaA } = providerRepo(GITHUB_URL);
		const branch = "gh-merged-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		const log = callLog();
		writeFakeCli(
			fakeBin(),
			"gh",
			ghWithPulls(
				JSON.stringify([
					cliFixtures.restPr(101, branch, {
						state: "closed",
						merged_at: "2026-02-01T00:00:00Z",
					}),
				]),
			),
		);
		const result = await worktree(["remove", branch], repo, {
			FAKE_CALL_LOG: log,
		});
		expect(result.exitCode).toBe(0);
		expect(registered(repo, path)).toBe(false);
		expect(branchExists(repo, branch)).toBe(false);
		const calls = cliFixtures.readCalls(log);
		expect(
			calls.some((call) => call.includes("repos/{owner}/{repo}/pulls")),
		).toBe(true);
		expect(calls.some((call) => call.includes("pr list"))).toBe(false);
	});

	test("a GitLab merged merge request for the branch lets removal proceed through glab", async () => {
		const { repo, shaA } = providerRepo(GITLAB_URL);
		const branch = "gl-merged-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		const log = callLog();
		const bin = fakeBin();
		writeFakeCli(bin, "gh", shScript(""));
		writeFakeCli(
			bin,
			"glab",
			shScript(`
  *"mr list"*"--merged"*"--source-branch ${branch}"*)
    cat <<'JSON'
${JSON.stringify([cliFixtures.glMr(202, branch, { state: "merged", merged_at: "2026-02-02T00:00:00Z" })])}
JSON
    exit 0
    ;;`),
		);
		const result = await worktree(["remove", branch], repo, {
			FAKE_CALL_LOG: log,
		});
		expect(result.exitCode).toBe(0);
		expect(registered(repo, path)).toBe(false);
		expect(branchExists(repo, branch)).toBe(false);
		expect(
			cliFixtures
				.readCalls(log)
				.some(
					(call) =>
						call.includes("mr list") &&
						call.includes(`--source-branch ${branch}`),
				),
		).toBe(true);
	});

	test("no merged pull request (JSON null) blocks removal without a lookup-failed diagnostic", async () => {
		const { repo, shaA } = providerRepo(GITHUB_URL);
		const branch = "gh-unmerged-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		writeFakeCli(fakeBin(), "gh", ghWithPulls("[]"));
		const result = await worktree(["remove", branch], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("not merged into origin/main");
		expect(result.stderr).not.toContain("lookup failed");
		expect(registered(repo, path)).toBe(true);
		expect(branchExists(repo, branch)).toBe(true);
	});

	test("a failed provider lookup blocks removal and names the failure distinctly from a confirmed non-merge", async () => {
		const { repo, shaA } = providerRepo(GITHUB_URL);
		const branch = "gh-lookup-failed-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		writeFakeCli(fakeBin(), "gh", ghWithPulls("", 1));
		const result = await worktree(["remove", branch], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain(`lookup failed for ${branch}`);
		expect(registered(repo, path)).toBe(true);
		expect(branchExists(repo, branch)).toBe(true);
	});

	test("a failed provider lookup keeps stdout empty so no KEY=value line leaks", async () => {
		const { repo, shaA } = providerRepo(GITHUB_URL);
		const branch = "gh-quiet-branch";
		unmergedWorktree(repo, branch, shaA);
		writeFakeCli(fakeBin(), "gh", ghWithPulls("", 1));
		const result = await worktree(["remove", branch], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
	});

	test("with no provider CLI on PATH removal is blocked and the branch is kept", async () => {
		const { repo, shaA } = providerRepo(GITHUB_URL);
		const branch = "no-provider-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		const result = await worktree(["remove", branch], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("not merged into origin/");
		expect(result.stderr).not.toContain("lookup failed");
		expect(result.stdout).toBe("");
		expect(registered(repo, path)).toBe(true);
		expect(branchExists(repo, branch)).toBe(true);
	});

	test("with a GitLab remote and no glab on PATH removal is blocked quietly and the branch is kept", async () => {
		const { repo, shaA } = providerRepo(GITLAB_URL);
		const branch = "no-glab-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		const result = await worktree(["remove", branch], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("not merged into origin/");
		expect(result.stderr).not.toContain("lookup failed");
		expect(result.stdout).toBe("");
		expect(registered(repo, path)).toBe(true);
		expect(branchExists(repo, branch)).toBe(true);
	});

	test("a failed git cherry blocks removal with exit 2 and keeps the worktree and branch", async () => {
		const { repo } = trackedRepo();
		const made = await created(repo, "cherryfail");
		const path = made.WORKTREE_PATH;
		const branch = made.WORKTREE_BRANCH;
		commitFile(path, "feature.txt", "work", "feat: unique change");
		runGit(["push", "-q", "-u", "origin", branch], path);
		runGit(["update-ref", "-d", "refs/remotes/origin/main"], repo);
		const result = await worktree(["remove", "cherryfail"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("git cherry failed");
		expect(registered(repo, path)).toBe(true);
		expect(branchExists(repo, branch)).toBe(true);
	});

	test("an unrecognized remote host blocks removal quietly like a missing provider CLI", async () => {
		const { repo, shaA } = providerRepo(
			"https://git.example.com/acme/widgets.git",
		);
		const branch = "unknown-host-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		const result = await worktree(["remove", branch], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("not merged into origin/");
		expect(result.stderr).not.toContain("lookup failed");
		expect(result.stdout).toBe("");
		expect(registered(repo, path)).toBe(true);
		expect(branchExists(repo, branch)).toBe(true);
	});

	test("an unreadable worktree status blocks removal without --force", async () => {
		const { repo } = trackedRepo();
		const made = await created(repo, "corrupt");
		writeFileSync(join(made.WORKTREE_PATH, ".git"), "garbage\n");
		const result = await worktree(["remove", "corrupt", "--merged-ok"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("could not read worktree status");
		expect(result.stderr).toContain("Use --force");
		expect(existsSync(made.WORKTREE_PATH)).toBe(true);
		expect(branchExists(repo, made.WORKTREE_BRANCH)).toBe(true);
	});

	test("a failed branch delete warns, keeps the branch and still exits 0 after removing the worktree", async () => {
		const { repo } = trackedRepo();
		const made = await created(repo, "locked_ref");
		writeFileSync(
			join(repo, ".git", "refs", "heads", "feature", "locked_ref.lock"),
			"",
		);
		const result = await worktree(
			["remove", "locked_ref", "--merged-ok"],
			repo,
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("branch delete failed (continuing)");
		expect(result.stderr).toContain("kept branch: feature/locked_ref");
		expect(result.stdout).toBe("");
		expect(existsSync(made.WORKTREE_PATH)).toBe(false);
		expect(branchExists(repo, made.WORKTREE_BRANCH)).toBe(true);
	});

	test("a detached linked worktree is skipped by list and cannot be removed by slug", async () => {
		const { repo } = trackedRepo();
		const path = join(fixtures.tmp("worktree-detached-"), "detached_wt");
		runGit(["worktree", "add", "-q", "--detach", path, "main"], repo);
		const listed = await worktree(["list", "--porcelain"], repo);
		expect(listed.exitCode).toBe(0);
		expect(listed.stdout).toBe("");
		const result = await worktree(["remove", "detached_wt", "--force"], repo);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("no worktree found for slug: detached_wt");
		expect(registered(repo, path)).toBe(true);
	});

	test("--merged-ok never consults the provider", async () => {
		const { repo, shaA } = providerRepo(GITHUB_URL);
		const branch = "skip-lookup-branch";
		const path = unmergedWorktree(repo, branch, shaA);
		commitFile(path, "extra.txt", "extra", "feat: extra");
		const log = callLog();
		writeFakeCli(fakeBin(), "gh", shScript(""));
		const result = await worktree(
			["remove", branch, "--merged-ok", "--force"],
			repo,
			{
				FAKE_CALL_LOG: log,
			},
		);
		expect(result.exitCode).toBe(0);
		expect(cliFixtures.readCalls(log)).toEqual([]);
	});
});

describe("worktree prune", () => {
	test("drops stale records, keeps the branch, reports the count on stderr and prints nothing on stdout", async () => {
		const { repo } = trackedRepo();
		const stale = await created(repo, "stale");
		const live = await created(repo, "live");
		rmSync(stale.WORKTREE_PATH, { recursive: true, force: true });
		const result = await worktree(["prune"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("pruned 1 stale worktree record(s)");
		expect(registered(repo, stale.WORKTREE_PATH)).toBe(false);
		expect(registered(repo, live.WORKTREE_PATH)).toBe(true);
		expect(branchExists(repo, stale.WORKTREE_BRANCH)).toBe(true);
	});

	test("with nothing stale it says so and exits 0", async () => {
		const { repo } = trackedRepo();
		await created(repo, "live");
		const result = await worktree(["prune"], repo);
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("nothing to prune");
	});

	test("an unknown argument exits 2 and outside a repository exits 2", async () => {
		const { repo } = trackedRepo();
		const bad = await worktree(["prune", "--bogus"], repo);
		expect(bad.exitCode).toBe(2);
		expect(bad.stderr).toContain("unknown arg for prune: --bogus");
		expect(
			(await worktree(["prune"], fixtures.tmp("worktree-plain-"))).exitCode,
		).toBe(2);
	});
});
