import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { projectHash } from "../../common/src/node/scratch-paths";
import * as helper from "../src/deps-upgrade/index";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeGitRepo, makeTempDir } from "./git-repo-fixtures";

const CLI = join(import.meta.dir, "../src/index.ts");
const MODULE = join(import.meta.dir, "../src/deps-upgrade/index.ts");
const BUN_BIN = process.execPath;
cliFixtures.isolateCliTests();
const REAL_SED = Bun.which("sed");
let createdDirs: string[] = [];
let ORIGINAL_PATH: string;

beforeEach(() => {
	createdDirs = [];
	ORIGINAL_PATH = process.env.PATH ?? "";
	if (REAL_SED) {
		const bin = cliFixtures.tmp(createdDirs, "deps-text-tools-");
		symlinkSync(REAL_SED, join(bin, "sed"));
		ORIGINAL_PATH = `${bin}:${ORIGINAL_PATH}`;
	}
});

afterEach(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	cwd: string;
	stateDir: string;
}

function baseEnv(): Record<string, string> {
	const env: Record<string, string | undefined> = {
		...process.env,
		PATH: ORIGINAL_PATH,
	};
	for (const key of [
		"AI_VCS_PROVIDER",
		"AI_VCS_GITLAB_HOSTS",
		"GH_BIN",
		"GLAB_BIN",
		"AI_RENOVATE_BOT_LOGIN",
	])
		delete env[key];
	return env as Record<string, string>;
}

async function runCli(
	args: string[],
	opts: {
		env?: Record<string, string>;
		cwd?: string;
		stdin?: string;
		stateDir?: string;
		preload?: string;
	} = {},
): Promise<RunResult> {
	const cwd = opts.cwd ?? cliFixtures.tmp(createdDirs, "deps-upgrade-cwd-");
	const stateDir =
		opts.stateDir ?? cliFixtures.tmp(createdDirs, "deps-upgrade-state-");
	const env: Record<string, string> = {
		...baseEnv(),
		AI_STATE_DIR: stateDir,
		...opts.env,
	};
	const proc = Bun.spawn(
		[
			BUN_BIN,
			"run",
			...(opts.preload ? ["--preload", opts.preload] : []),
			CLI,
			"deps-upgrade",
			...args,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			stdin: opts.stdin !== undefined ? "pipe" : undefined,
			env,
			cwd,
		},
	);
	if (opts.stdin !== undefined) {
		proc.stdin.write(opts.stdin);
		proc.stdin.end();
	}
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode, cwd, stateDir };
}

function fakeGhDir(script: string): string {
	const dir = cliFixtures.tmp(createdDirs, "deps-upgrade-fake-gh-");
	writeFakeCli(dir, "gh", script);
	return dir;
}

function fakeGlabDir(script: string): string {
	const dir = cliFixtures.tmp(createdDirs, "deps-upgrade-fake-glab-");
	writeFakeCli(dir, "glab", script);
	return dir;
}

function fakeGitDir(script: string): string {
	const dir = cliFixtures.tmp(createdDirs, "deps-upgrade-fake-git-");
	writeFakeCli(dir, "git", script);
	return dir;
}

function ghBin(script: string): string {
	return join(fakeGhDir(script), "gh");
}

function glabBin(script: string): string {
	return join(fakeGlabDir(script), "glab");
}

function pathWithFakeGit(script: string): string {
	return `${fakeGitDir(script)}:${ORIGINAL_PATH}`;
}

const shScript = cliFixtures.shScript;

function newCallLog(): string {
	return cliFixtures.callLogPath(createdDirs, "deps-upgrade-log-");
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

function closedLogPath(stateDir: string, cwd: string): string {
	const hash = projectHash(cwd);
	return join(stateDir, "deps-upgrade", hash, "closed-prs.txt");
}

function readClosedLog(stateDir: string, cwd: string): string[] {
	try {
		return readFileSync(closedLogPath(stateDir, cwd), "utf8")
			.split("\n")
			.filter(Boolean);
	} catch {
		return [];
	}
}

function ghPrViewJson(
	number: number,
	body: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		number,
		title: `PR #${number}`,
		url: `https://github.com/acme/widgets/pull/${number}`,
		state: "OPEN",
		headRefName: `feature-${number}`,
		baseRefName: "main",
		body,
		mergedAt: null,
		...overrides,
	};
}

function glMrViewJson(
	iid: number,
	body: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		iid,
		title: `MR !${iid}`,
		web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${iid}`,
		state: "opened",
		source_branch: `feature-${iid}`,
		target_branch: "main",
		description: body,
		merged_at: null,
		...overrides,
	};
}

function glMr(
	iid: number,
	sourceBranch: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		iid,
		title: `MR !${iid}: bump a dependency`,
		web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${iid}`,
		state: "opened",
		source_branch: sourceBranch,
		target_branch: "main",
		description: `Bumps a dependency (MR ${iid})`,
		merged_at: null,
		...overrides,
	};
}

const CATCH_ALL_GIT_SCRIPT = shScript(`
  *"rev-parse --abbrev-ref HEAD"*)
    echo "chore/deps_update_20260101-000000"
    exit 0
    ;;
  *"symbolic-ref refs/remotes/origin/HEAD"*)
    echo "refs/remotes/origin/main"
    exit 0
    ;;`);

function gitScriptForBranch(branch: string): string {
	return shScript(`
  *"rev-parse --abbrev-ref HEAD"*)
    echo "${branch}"
    exit 0
    ;;
  *"symbolic-ref refs/remotes/origin/HEAD"*)
    echo "refs/remotes/origin/main"
    exit 0
    ;;`);
}

describe("deps-upgrade list-prs — GitHub, label-based Dependabot lookup", () => {
	test("still invokes the exact unmigrated gh command, bypassing any GH_BIN provider indirection", async () => {
		const fixture = [
			{
				number: 5,
				title: "chore(deps): bump lodash from 1.0.0 to 1.0.1",
				headRefName: "dependabot/npm_and_yarn/lodash-1.0.1",
				body: "Bumps lodash from 1.0.0 to 1.0.1.",
			},
		];
		const dir = fakeGhDir(
			shScript(`
  *"pr list --label dependencies --state open --limit 50 --json number,title,headRefName"*)
    cat <<'JSON'
${JSON.stringify(fixture)}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: {
				AI_VCS_PROVIDER: "github",
				PATH: `${dir}:${ORIGINAL_PATH}`,
				GH_BIN: "/nonexistent/deps-upgrade-test-gh-bin",
			},
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual(fixture);
	});

	test("prints no warning when the label lookup finds zero PRs — a GitHub zero-result is unambiguous", async () => {
		const dir = fakeGhDir(
			shScript(`
  *"pr list --label dependencies --state open --limit 50 --json number,title,headRefName"*)
    echo '[]'
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: { AI_VCS_PROVIDER: "github", PATH: `${dir}:${ORIGINAL_PATH}` },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("");
		expect(JSON.parse(result.stdout.trim())).toEqual([]);
	});

	test("AI_RENOVATE_BOT_LOGIN has no effect on the GitHub label-based lookup — the exact unmigrated gh command runs unaltered", async () => {
		const log = newCallLog();
		const fixture = [
			{
				number: 6,
				title: "chore(deps): bump express from 4.0.0 to 4.0.1",
				headRefName: "dependabot/npm_and_yarn/express-4.0.1",
				body: "Bumps express from 4.0.0 to 4.0.1.",
			},
		];
		const dir = fakeGhDir(
			shScript(`
  *"pr list --label dependencies --state open --limit 50 --json number,title,headRefName"*)
    cat <<'JSON'
${JSON.stringify(fixture)}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: {
				AI_VCS_PROVIDER: "github",
				PATH: `${dir}:${ORIGINAL_PATH}`,
				AI_RENOVATE_BOT_LOGIN: "some-custom-login",
				FAKE_CALL_LOG: log,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toEqual(fixture);
		const calls = readCalls(log);
		expect(calls).toHaveLength(1);
		expect(calls[0]).not.toContain("--author");
		expect(calls[0]).not.toContain("some-custom-login");
	});
});

describe("deps-upgrade list-prs — GitLab, Renovate author lookup", () => {
	test("looks up open MRs authored by the default renovate-bot login via provider.listPullRequests", async () => {
		const all = [
			glMr(201, "renovate/bump-lodash"),
			glMr(202, "renovate/bump-express"),
		];
		const log = newCallLog();
		const bin = glabBin(
			shScript(`
  *"mr list"*"--author renovate-bot"*)
    cat <<'JSON'
${JSON.stringify(all)}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: bin, FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		const parsed = JSON.parse(result.stdout.trim());
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed).toHaveLength(2);
		const mr201 = parsed.find((p: { number: number }) => p.number === 201);
		expect(mr201).toMatchObject({
			number: 201,
			headRefName: "renovate/bump-lodash",
		});

		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("--author renovate-bot"))).toBe(true);
		expect(calls.some((c) => c.includes("--all"))).toBe(false);
		expect(result.stderr.trim()).toBe("");
	});

	test("AI_RENOVATE_BOT_LOGIN overrides the default login used for the author filter", async () => {
		const all = [glMr(301, "renovate/bump-express")];
		const log = newCallLog();
		const bin = glabBin(
			shScript(`
  *"mr list"*"--author custom-deps-bot"*)
    cat <<'JSON'
${JSON.stringify(all)}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				AI_RENOVATE_BOT_LOGIN: "custom-deps-bot",
				FAKE_CALL_LOG: log,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.trim())).toHaveLength(1);
		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("--author custom-deps-bot"))).toBe(
			true,
		);
		expect(calls.some((c) => c.includes("--author renovate-bot"))).toBe(false);
	});

	test("a zero-result author lookup prints an explicit warning naming the login before the empty result", async () => {
		const bin = glabBin(
			shScript(`
  *"mr list"*"--author renovate-bot"*)
    echo '[]'
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: bin },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("found 0 open MRs authored by renovate-bot");
		expect(JSON.parse(result.stdout.trim())).toEqual([]);
	});

	test("a non-zero result prints no zero-result warning", async () => {
		const bin = glabBin(
			shScript(`
  *"mr list"*"--author renovate-bot"*)
    cat <<'JSON'
${JSON.stringify([glMr(401, "renovate/bump-jest")])}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: bin },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr.trim()).toBe("");
	});

	test("a zero-result author lookup with AI_RENOVATE_BOT_LOGIN set names the overridden login in the warning, not the default", async () => {
		const bin = glabBin(
			shScript(`
  *"mr list"*"--author custom-deps-bot"*)
    echo '[]'
    exit 0
    ;;`),
		);

		const result = await runCli(["list-prs"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				AI_RENOVATE_BOT_LOGIN: "custom-deps-bot",
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("0 open MRs authored by custom-deps-bot");
		expect(result.stderr).not.toContain("renovate-bot");
		expect(JSON.parse(result.stdout.trim())).toEqual([]);
	});
});

describe("deps-upgrade pr-body", () => {
	test("on GitHub, prints the PR body fetched via provider.getPullRequestBody", async () => {
		const bin = ghBin(
			shScript(`
  *"pr view 55"*"--json number,title,url,state"*)
    cat <<'JSON'
${JSON.stringify(ghPrViewJson(55, "release notes for v2"))}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["pr-body", "55"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: bin },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("release notes for v2");
	});

	test("on GitLab, prints the MR body via glab rather than dying on gh not applying there", async () => {
		const bin = glabBin(
			shScript(`
  *"mr view 55"*"--output json"*)
    cat <<'JSON'
${JSON.stringify(glMrViewJson(55, "gitlab release notes"))}
JSON
    exit 0
    ;;`),
		);

		const result = await runCli(["pr-body", "55"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: bin },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("gitlab release notes");
	});

	test("a failed provider lookup on GitLab exits non-zero via glab specifically, not by falling through to gh", async () => {
		const poisonGhDir = fakeGhDir(
			shScript(`
  *)
    echo "POISON: reached gh instead of the GitLab provider" >&2
    exit 1
    ;;`),
		);
		const bin = glabBin(
			shScript(`
  *"mr view 55"*"--output json"*)
    echo "glab: 404 Not Found" >&2
    exit 1
    ;;`),
		);

		const result = await runCli(["pr-body", "55"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				PATH: `${poisonGhDir}:${ORIGINAL_PATH}`,
			},
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).not.toContain("POISON");
		expect(result.stderr.length).toBeGreaterThan(0);
		expect(result.stdout.trim()).toBe("");
	});

	test("a missing PR number argument dies before attempting any provider call", async () => {
		const result = await runCli(["pr-body"], {
			env: { AI_VCS_PROVIDER: "github" },
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toLowerCase()).toContain("pr number");
	});

	test("a failed provider lookup on GitLab surfaces through the CLI's own structured error handling, not an unhandled crash", async () => {
		const bin = glabBin(
			shScript(`
  *"mr view 77"*"--output json"*)
    echo "glab: 500 Internal Server Error" >&2
    exit 1
    ;;`),
		);

		const result = await runCli(["pr-body", "77"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: bin },
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toStartWith("deps-upgrade pr-body: ");
		expect(result.stderr).toContain("500 Internal Server Error");
	});
});

describe("deps-upgrade close-prs", () => {
	test("on GitLab, closes the given MR numbers via provider.closePullRequest and logs them", async () => {
		const log = newCallLog();
		const bin = glabBin(
			shScript(`
  *"merge_requests/12/notes"*"body=Included in combined deps branch: chore/deps_update_20260101-000000"*)
    exit 0
    ;;
  *"mr close 12"*)
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["close-prs", "12"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
		});

		expect(result.exitCode).toBe(0);
		const calls = readCalls(log);
		const noteIndex = calls.findIndex((c) =>
			c.includes("merge_requests/12/notes"),
		);
		const closeIndex = calls.findIndex((c) => c.includes("mr close 12"));
		expect(noteIndex).toBeGreaterThanOrEqual(0);
		expect(closeIndex).toBeGreaterThanOrEqual(0);
		expect(noteIndex).toBeLessThan(closeIndex);
		expect(calls[noteIndex]).toContain(
			"body=Included in combined deps branch: chore/deps_update_20260101-000000",
		);
		expect(readClosedLog(result.stateDir, result.cwd)).toEqual(["12"]);
	});

	test("on GitHub, closes the given PR via provider.closePullRequest carrying the combined-branch comment in the same call", async () => {
		const log = newCallLog();
		const bin = ghBin(
			shScript(`
  *"pr close 12 --comment Included in combined deps branch: chore/deps_update_20260101-000000"*)
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["close-prs", "12"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(
			readCalls(log).some((c) =>
				c.includes(
					"pr close 12 --comment Included in combined deps branch: chore/deps_update_20260101-000000",
				),
			),
		).toBe(true);
		expect(readClosedLog(result.stateDir, result.cwd)).toEqual(["12"]);
	});

	test("one failing close among several does not abort the batch — the failure is warned, the rest still close and log", async () => {
		const bin = glabBin(
			shScript(`
  *"mr close 21"*)
    exit 0
    ;;
  *"mr close 22"*)
    echo "glab: 403 Forbidden" >&2
    exit 1
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["close-prs", "21", "22"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: bin, PATH: gitPath },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("warning: failed to close PR #22");
		expect(readClosedLog(result.stateDir, result.cwd)).toEqual(["21"]);
	});

	test("on GitHub, the close comment reflects the real current branch and attaches to every PR closed in the batch", async () => {
		const branch = "chore/deps_update_20260815-093000";
		const log = newCallLog();
		const bin = ghBin(
			shScript(`
  *"pr close 40 --comment Included in combined deps branch: ${branch}"*)
    exit 0
    ;;
  *"pr close 41 --comment Included in combined deps branch: ${branch}"*)
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(gitScriptForBranch(branch));

		const result = await runCli(["close-prs", "40", "41"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
		});

		expect(result.exitCode).toBe(0);
		const calls = readCalls(log);
		expect(
			calls.filter((c) =>
				c.includes(`--comment Included in combined deps branch: ${branch}`),
			),
		).toHaveLength(2);
		expect(readClosedLog(result.stateDir, result.cwd)).toEqual(["40", "41"]);
	});

	test("on GitLab, the close note reflects the real current branch and attaches to every MR closed in the batch", async () => {
		const branch = "chore/deps_update_20260815-093000";
		const log = newCallLog();
		const bin = glabBin(
			shScript(`
  *"merge_requests/50/notes"*"body=Included in combined deps branch: ${branch}"*)
    exit 0
    ;;
  *"mr close 50"*)
    exit 0
    ;;
  *"merge_requests/51/notes"*"body=Included in combined deps branch: ${branch}"*)
    exit 0
    ;;
  *"mr close 51"*)
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(gitScriptForBranch(branch));

		const result = await runCli(["close-prs", "50", "51"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
		});

		expect(result.exitCode).toBe(0);
		const calls = readCalls(log);
		expect(
			calls.filter((c) =>
				c.includes(`body=Included in combined deps branch: ${branch}`),
			),
		).toHaveLength(2);
		expect(readClosedLog(result.stateDir, result.cwd)).toEqual(["50", "51"]);
	});
});

describe("deps-upgrade push-pr", () => {
	test("on GitLab, opens the combined MR via provider.createPullRequest and prints its URL", async () => {
		const log = newCallLog();
		const bin = glabBin(
			shScript(`
  *"mr create"*"--title chore(deps): batch dependency upgrade"*"--description=combined upgrade body"*)
    echo "https://gitlab.com/acme/widgets/-/merge_requests/99"
    exit 0
    ;;
  *"mr view 99"*"--output json"*)
    cat <<'JSON'
${JSON.stringify(glMrViewJson(99, "combined upgrade body", { web_url: "https://gitlab.com/acme/widgets/-/merge_requests/99" }))}
JSON
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["push-pr"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
			stdin: "combined upgrade body",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(
			"PR created: https://gitlab.com/acme/widgets/-/merge_requests/99",
		);
	});

	test("on GitHub, opens the combined PR via provider.createPullRequest and prints its URL", async () => {
		const bin = ghBin(
			shScript(`
  *"pr create"*"--title chore(deps): batch dependency upgrade"*"--body-file -"*)
    echo "https://github.com/acme/widgets/pull/88"
    exit 0
    ;;
  *"pr view 88"*"--json number,title,url,state"*)
    cat <<'JSON'
${JSON.stringify(ghPrViewJson(88, "combined upgrade body", { url: "https://github.com/acme/widgets/pull/88" }))}
JSON
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["push-pr"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: bin, PATH: gitPath },
			stdin: "combined upgrade body",
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe(
			"PR created: https://github.com/acme/widgets/pull/88",
		);
	});

	test("a custom title argument reaches the created MR instead of the default batch title", async () => {
		const log = newCallLog();
		const bin = glabBin(
			shScript(`
  *"mr create"*"--title chore: custom batch title"*"--description=body"*)
    echo "https://gitlab.com/acme/widgets/-/merge_requests/100"
    exit 0
    ;;
  *"mr view 100"*"--output json"*)
    cat <<'JSON'
${JSON.stringify(glMrViewJson(100, "body"))}
JSON
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["push-pr", "chore: custom batch title"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
			stdin: "body",
		});

		expect(result.exitCode).toBe(0);
		expect(
			readCalls(log).some((c) =>
				c.includes("--title chore: custom batch title"),
			),
		).toBe(true);
	});

	test("the stdin body is threaded through to the create call unmodified", async () => {
		const captureDir = cliFixtures.tmp(
			createdDirs,
			"deps-upgrade-stdin-capture-",
		);
		const capturePath = join(captureDir, "captured-body.txt");
		const bin = glabBin(
			shScript(`
  *"mr create"*"--description"*)
    printf '%s' "$ARGS" > "$FAKE_STDIN_CAPTURE"
    echo "https://gitlab.com/acme/widgets/-/merge_requests/101"
    exit 0
    ;;
  *"mr view 101"*"--output json"*)
    cat <<'JSON'
${JSON.stringify(glMrViewJson(101, "irrelevant"))}
JSON
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);
		const body = "## Summary\nBatch dependency upgrade — 3 packages updated.\n";

		const result = await runCli(["push-pr"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: bin,
				PATH: gitPath,
				FAKE_STDIN_CAPTURE: capturePath,
			},
			stdin: body,
		});

		expect(result.exitCode).toBe(0);
		expect(readFileSync(capturePath, "utf8")).toContain(
			`--description=${body}`,
		);
	});

	test("opens the PR as a draft by default", async () => {
		const log = newCallLog();
		const bin = ghBin(
			shScript(`
  *"pr create"*)
    echo "https://github.com/acme/widgets/pull/90"
    exit 0
    ;;
  *"pr view 90"*)
    cat <<'JSON'
${JSON.stringify(ghPrViewJson(90, "body"))}
JSON
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["push-pr"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
			stdin: "body",
		});

		expect(result.exitCode).toBe(0);
		expect(readCalls(log).some((c) => c.startsWith("pr create --draft "))).toBe(
			true,
		);
	});

	test("--ready opens the PR without the draft flag", async () => {
		const log = newCallLog();
		const bin = ghBin(
			shScript(`
  *"pr create"*)
    echo "https://github.com/acme/widgets/pull/91"
    exit 0
    ;;
  *"pr view 91"*)
    cat <<'JSON'
${JSON.stringify(ghPrViewJson(91, "body"))}
JSON
    exit 0
    ;;`),
		);
		const gitPath = pathWithFakeGit(CATCH_ALL_GIT_SCRIPT);

		const result = await runCli(["push-pr", "--ready"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: bin,
				PATH: gitPath,
				FAKE_CALL_LOG: log,
			},
			stdin: "body",
		});

		expect(result.exitCode).toBe(0);
		const create = readCalls(log).find((c) => c.startsWith("pr create"));
		expect(create).toBeDefined();
		expect(create).not.toContain("--draft");
	});
});

describe("deps-upgrade ready-when-green", () => {
	const PR_URL = "https://github.com/acme/widgets/pull/90";

	function ghChecksPath(
		checks: unknown,
		exitCode: number,
		log: string,
	): Record<string, string> {
		const dir = fakeGhDir(
			shScript(`
  *"pr view"*)
    echo "${PR_URL}"
    exit 0
    ;;
  *"pr checks"*)
    printf '%s' '${JSON.stringify(checks)}'
    exit ${exitCode}
    ;;`),
		);
		return { PATH: `${dir}:${ORIGINAL_PATH}`, FAKE_CALL_LOG: log };
	}

	test("marks the PR ready and exits 0 when every check passes", async () => {
		const log = newCallLog();
		const env = ghChecksPath(
			[
				{ name: "build", bucket: "pass" },
				{ name: "lint", bucket: "skipping" },
			],
			0,
			log,
		);

		const result = await runCli(
			["ready-when-green", "90", "--interval-seconds", "1"],
			{ env },
		);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ status: "ready", url: PR_URL });
		expect(readCalls(log)).toContain("pr ready 90");
	});

	test("does not mark ready, lists failing checks and exits 1 when a check fails", async () => {
		const log = newCallLog();
		const env = ghChecksPath(
			[
				{ name: "build", bucket: "pass" },
				{ name: "test", bucket: "fail" },
			],
			1,
			log,
		);

		const result = await runCli(
			["ready-when-green", "90", "--interval-seconds", "1"],
			{ env },
		);

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.stdout)).toEqual({
			status: "failed",
			url: PR_URL,
			failing: ["test"],
		});
		expect(readCalls(log).some((c) => c.startsWith("pr ready"))).toBe(false);
	});

	test("reports a timeout and exits 2 while checks stay pending", async () => {
		const log = newCallLog();
		const env = ghChecksPath([{ name: "build", bucket: "pending" }], 8, log);

		const result = await runCli(
			[
				"ready-when-green",
				"90",
				"--timeout-minutes",
				"0",
				"--interval-seconds",
				"1",
			],
			{
				env,
			},
		);

		expect(result.exitCode).toBe(2);
		expect(JSON.parse(result.stdout)).toEqual({
			status: "timeout",
			url: PR_URL,
		});
		expect(readCalls(log).some((c) => c.startsWith("pr ready"))).toBe(false);
	});

	test("rejects a missing PR reference", async () => {
		const result = await runCli(["ready-when-green"]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("usage: ready-when-green");
	});
});

describe("pollChecks", () => {
	function clock() {
		let t = 0;
		return { now: () => t, sleep: async (ms: number) => void (t += ms) };
	}
	const opts = (c: ReturnType<typeof clock>) => ({
		intervalMs: 30_000,
		timeoutMs: 60 * 60_000,
		graceMs: helper.CHECKS_GRACE_MS,
		...c,
	});

	test("waits through pending checks, then reports green", async () => {
		const c = clock();
		const rounds = [
			[{ name: "build", bucket: "pending" }],
			[{ name: "build", bucket: "pending" }],
			[{ name: "build", bucket: "pass" }],
		];
		let i = 0;

		const verdict = await helper.pollChecks(async () => rounds[i++], opts(c));

		expect(verdict).toEqual({ status: "green" });
		expect(c.now()).toBe(60_000);
	});

	test("waits for pending checks before reporting a failure", async () => {
		const c = clock();
		const rounds = [
			[
				{ name: "a", bucket: "fail" },
				{ name: "b", bucket: "pending" },
			],
			[
				{ name: "a", bucket: "fail" },
				{ name: "b", bucket: "cancel" },
			],
		];
		let i = 0;

		const verdict = await helper.pollChecks(async () => rounds[i++], opts(c));

		expect(verdict).toEqual({ status: "failed", failing: ["a", "b"] });
	});

	test("times out when checks never finish", async () => {
		const c = clock();

		const verdict = await helper.pollChecks(
			async () => [{ name: "build", bucket: "pending" }],
			opts(c),
		);

		expect(verdict).toEqual({ status: "timeout" });
		expect(c.now()).toBe(60 * 60_000);
	});

	test("treats no checks as green only after the grace period", async () => {
		const c = clock();

		const verdict = await helper.pollChecks(async () => [], opts(c));

		expect(verdict).toEqual({ status: "green", noChecks: true });
		expect(c.now()).toBe(helper.CHECKS_GRACE_MS);
	});

	test("picks up checks that appear during the grace period", async () => {
		const c = clock();
		let calls = 0;

		const verdict = await helper.pollChecks(
			async () => (++calls < 3 ? [] : [{ name: "build", bucket: "fail" }]),
			opts(c),
		);

		expect(verdict).toEqual({ status: "failed", failing: ["build"] });
	});
});

describe("package cooldown", () => {
	const NOW = Date.parse("2026-10-16T00:00:00Z");
	const registry = (releases: Record<string, string>) => async () => ({
		time: releases,
	});
	const run = (
		releases: Record<string, string>,
		over: Partial<helper.CooldownInput> = {},
	) =>
		helper.evaluateCooldown({
			eco: "npm",
			pkg: "left-pad",
			oldVersion: "1.0.0",
			version: "2.0.0",
			days: 7,
			now: () => NOW,
			fetchJson: registry(releases),
			...over,
		});

	test("upgrades when the target version is old enough", async () => {
		const verdict = await run({
			"1.0.0": "2026-01-01T00:00:00Z",
			"2.0.0": "2026-10-01T00:00:00Z",
		});

		expect(verdict).toEqual({ status: "ok", version: "2.0.0" });
	});

	test("holds a too-new version and falls back to the newest eligible one", async () => {
		const verdict = await run({
			"1.0.0": "2026-01-01T00:00:00Z",
			"1.5.0": "2026-09-01T00:00:00Z",
			"1.6.0-beta.1": "2026-09-20T00:00:00Z",
			"1.9.0": "2026-10-14T00:00:00Z",
			"2.0.0": "2026-10-15T00:00:00Z",
		});

		expect(verdict).toEqual({
			status: "fallback",
			version: "1.5.0",
			requested: "2.0.0",
			published: "2026-10-15T00:00:00Z",
			eligible: "2026-10-22T00:00:00.000Z",
		});
	});

	test("holds when no eligible version is newer than the current one", async () => {
		const verdict = await run({
			"1.0.0": "2026-01-01T00:00:00Z",
			"2.0.0": "2026-10-15T00:00:00Z",
		});

		expect(verdict).toEqual({
			status: "held",
			requested: "2.0.0",
			published: "2026-10-15T00:00:00Z",
			eligible: "2026-10-22T00:00:00.000Z",
		});
	});

	test("skips a package whose publish time is unknown", async () => {
		expect(await run({ "1.0.0": "2026-01-01T00:00:00Z" })).toEqual({
			status: "unknown",
			requested: "2.0.0",
		});
		expect(await run({}, { fetchJson: async () => null })).toEqual({
			status: "unknown",
			requested: "2.0.0",
		});
	});

	test("a cooldown of 0 turns the check off without calling the registry", async () => {
		const verdict = await run(
			{},
			{
				days: 0,
				fetchJson: async () => Promise.reject(new Error("no network")),
			},
		);

		expect(verdict).toEqual({ status: "ok", version: "2.0.0" });
	});

	test("reads PyPI upload times", async () => {
		const verdict = await run(
			{},
			{
				eco: "python",
				fetchJson: async () => ({
					releases: {
						"2.0.0": [{ upload_time_iso_8601: "2026-10-15T00:00:00.000000Z" }],
						"1.0.0": [],
					},
				}),
			},
		);

		expect(verdict).toEqual({
			status: "held",
			requested: "2.0.0",
			published: "2026-10-15T00:00:00.000000Z",
			eligible: "2026-10-22T00:00:00.000Z",
		});
	});

	test("reads NuGet registration pages, fetching pages that are not inlined", async () => {
		const pages: Record<string, unknown> = {
			"https://api.nuget.org/v3/registration5-gz-semver2/newtonsoft.json/index.json":
				{
					items: [{ "@id": "https://page/1" }],
				},
			"https://page/1": {
				items: [
					{
						catalogEntry: {
							version: "2.0.0",
							published: "2026-01-01T00:00:00Z",
						},
					},
				],
			},
		};

		const verdict = await run(
			{},
			{
				eco: "dotnet",
				pkg: "Newtonsoft.Json",
				fetchJson: async (u: string) => pages[u] ?? null,
			},
		);

		expect(verdict).toEqual({ status: "ok", version: "2.0.0" });
	});

	test("heldEntry records held, fallback and unknown verdicts but not ok", () => {
		expect(helper.heldEntry("a", { status: "ok", version: "1" })).toBeNull();
		expect(
			helper.heldEntry("a", { status: "unknown", requested: "2" }),
		).toEqual({
			pkg: "a",
			version: "2",
			published: null,
			eligible: null,
		});
		expect(
			helper.heldEntry("a", {
				status: "fallback",
				version: "1.5",
				requested: "2",
				published: "p",
				eligible: "e",
			}),
		).toEqual({
			pkg: "a",
			version: "2",
			published: "p",
			eligible: "e",
			usedVersion: "1.5",
		});
	});

	test("summary lists packages held by cooldown", () => {
		const out = helper.renderSummary({
			ecosystem: "npm",
			branch: "b",
			defaultBranch: "main",
			commits: [],
			closed: [],
			before: null,
			after: null,
			held: [
				{
					pkg: "a",
					version: "2.0.0",
					published: "2026-10-15T00:00:00Z",
					eligible: "2026-10-22T00:00:00.000Z",
				},
				{ pkg: "b", version: "3.0.0", published: null, eligible: null },
			],
		});

		expect(out).toContain("Held by cooldown (2):");
		expect(out).toContain(
			"  - a@2.0.0 — published 2026-10-15, eligible 2026-10-22",
		);
		expect(out).toContain("  - b@3.0.0 — unknown age");
	});

	test("the cooldown subcommand with --cooldown-days 0 reports ok and logs nothing", async () => {
		const result = await runCli([
			"cooldown",
			"left-pad",
			"1.0.0",
			"2.0.0",
			"--cooldown-days",
			"0",
			"--ecosystem",
			"npm",
		]);

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			pkg: "left-pad",
			status: "ok",
			version: "2.0.0",
		});
		expect(
			existsSync(
				stateFile(result.stateDir, result.cwd, "held-by-cooldown.jsonl"),
			),
		).toBe(false);
	});

	test("the cooldown subcommand rejects a negative day count", async () => {
		const result = await runCli([
			"cooldown",
			"p",
			"1",
			"2",
			"--cooldown-days",
			"-1",
			"--ecosystem",
			"npm",
		]);

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("--cooldown-days");
	});
});

function expectDies(fn: () => unknown, message: string): void {
	const exit = spyOn(process, "exit").mockImplementation((() => {
		throw new Error("process.exit");
	}) as never);
	const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		expect(fn).toThrow("process.exit");
		expect(stderr).toHaveBeenCalledWith(`error: ${message}\n`);
		expect(exit).toHaveBeenCalledWith(1);
	} finally {
		exit.mockRestore();
		stderr.mockRestore();
	}
}

function inTempDir<T>(files: Record<string, string>, fn: () => T): T {
	const dir = cliFixtures.tmp(createdDirs, "deps-upgrade-unit-");
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	const previous = process.cwd();
	process.chdir(dir);
	try {
		return fn();
	} finally {
		process.chdir(previous);
	}
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

describe("ecosystem table", () => {
	test("lists ecosystems in detection order", () => {
		expect(helper.ECOSYSTEM_NAMES).toEqual([
			"bun",
			"pnpm",
			"yarn",
			"npm",
			"go",
			"rust",
			"dotnet",
			"ruby",
			"python",
		]);
	});

	test.each([
		[["bun.lockb"], "bun"],
		[["bun.lock"], "bun"],
		[["pnpm-lock.yaml"], "pnpm"],
		[["yarn.lock"], "yarn"],
		[["package-lock.json"], "npm"],
		[["go.mod"], "go"],
		[["Cargo.toml"], "rust"],
		[["app.csproj"], "dotnet"],
		[["solution.sln"], "dotnet"],
		[["Gemfile"], "ruby"],
		[["pyproject.toml"], "python"],
		[["requirements.txt"], "python"],
	] as const)("detects %j as %s", (entries, expected) => {
		expect(helper.detectEcosystem(entries)).toBe(expected);
	});

	test("returns null when no marker is present", () => {
		expect(helper.detectEcosystem(["README.md", "src"])).toBeNull();
		expect(helper.detectEcosystem([])).toBeNull();
	});

	test("does not treat a name that merely contains a marker as a match", () => {
		expect(
			helper.detectEcosystem(["go.mod.bak", "notyarn.lock", "app.csproj.user"]),
		).toBeNull();
	});

	test.each([
		[["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock"], "bun"],
		[["package-lock.json", "yarn.lock", "pnpm-lock.yaml"], "pnpm"],
		[["package-lock.json", "yarn.lock"], "yarn"],
		[["go.mod", "Cargo.toml", "package-lock.json"], "npm"],
		[["Cargo.toml", "go.mod"], "go"],
		[["Cargo.toml", "app.csproj", "Gemfile"], "rust"],
		[["app.csproj", "Gemfile", "pyproject.toml"], "dotnet"],
		[["Gemfile", "pyproject.toml"], "ruby"],
	] as const)("prefers the earlier ecosystem for %j", (entries, expected) => {
		expect(helper.detectEcosystem(entries)).toBe(expected);
	});

	test("parseEcosystem accepts every known name and rejects unknown or inherited ones", () => {
		for (const name of helper.ECOSYSTEM_NAMES)
			expect(helper.parseEcosystem(name)).toBe(name);
		expect(helper.parseEcosystem("java")).toBeNull();
		expect(helper.parseEcosystem("toString")).toBeNull();
		expect(helper.parseEcosystem("")).toBeNull();
	});

	test("resolveEcosystem lets a valid override win over detected markers", () => {
		expect(helper.resolveEcosystem("rust", ["go.mod"])).toBe("rust");
	});

	test("resolveEcosystem detects from the given entries without an override", () => {
		expect(helper.resolveEcosystem(undefined, ["yarn.lock"])).toBe("yarn");
	});

	test("resolveEcosystem reads the current directory by default", () => {
		expect(
			inTempDir({ "Cargo.toml": "" }, () => helper.resolveEcosystem()),
		).toBe("rust");
	});

	test("resolveEcosystem dies on an unknown override", () => {
		expectDies(
			() => helper.resolveEcosystem("java", ["go.mod"]),
			"unknown --ecosystem: java",
		);
	});

	test("resolveEcosystem dies when nothing is detected", () => {
		expectDies(
			() => helper.resolveEcosystem(undefined, ["README.md"]),
			"no supported ecosystem detected (pass --ecosystem to override)",
		);
	});

	test.each([
		["bun", ["bun.lock"], "bun.lock"],
		["bun", ["bun.lockb"], "bun.lockb"],
		["bun", [], "bun.lockb"],
		["bun", ["bun.lock", "bun.lockb"], "bun.lock"],
		["pnpm", [], "pnpm-lock.yaml"],
		["yarn", [], "yarn.lock"],
		["npm", [], "package-lock.json"],
		["go", [], "go.sum"],
		["rust", [], "Cargo.lock"],
		["dotnet", ["app.csproj"], null],
		["ruby", [], "Gemfile.lock"],
		["python", ["poetry.lock"], "poetry.lock"],
		["python", ["uv.lock"], "uv.lock"],
		["python", ["poetry.lock", "uv.lock"], "poetry.lock"],
		["python", ["requirements.txt"], null],
	] as const)("%s lockfile for %j is %p", (eco, entries, expected) => {
		expect(helper.ECOSYSTEMS[eco].lockFile(entries)).toBe(expected);
	});

	test.each([
		["bun", [], ["bun", "install"]],
		["pnpm", [], ["pnpm", "install"]],
		["yarn", [], ["yarn", "install"]],
		["npm", [], ["npm", "install"]],
		["go", [], ["go", "mod", "tidy"]],
		["rust", [], ["cargo", "build", "--locked"]],
		["dotnet", [], ["dotnet", "restore"]],
		["ruby", [], ["bundle", "install"]],
		["python", ["uv.lock", "poetry.lock", "requirements.txt"], ["uv", "sync"]],
		["python", ["poetry.lock", "requirements.txt"], ["poetry", "install"]],
		[
			"python",
			["requirements.txt"],
			["pip", "install", "-r", "requirements.txt"],
		],
		["python", ["pyproject.toml"], null],
	] as const)("%s install command for %j is %j", (eco, entries, expected) => {
		expect(helper.ECOSYSTEMS[eco].installCommand(entries)).toEqual(expected);
	});

	test.each([
		["bun", ["bun", "audit", "--json"]],
		["pnpm", ["pnpm", "audit", "--json"]],
		["yarn", ["yarn", "npm", "audit", "--json"]],
		["npm", ["npm", "audit", "--json"]],
		["go", ["govulncheck", "-json", "./..."]],
		["rust", ["cargo", "audit", "--json"]],
		[
			"dotnet",
			[
				"dotnet",
				"list",
				"package",
				"--vulnerable",
				"--include-transitive",
				"--format",
				"json",
			],
		],
		["ruby", ["bundle-audit", "check", "--format", "json"]],
		["python", ["pip-audit", "--format", "json"]],
	] as const)("%s audit command is %j", (eco, expected) => {
		expect(helper.ECOSYSTEMS[eco].audit.command).toEqual(expected);
	});

	test.each([
		["bun", ["bun", "audit", "fix"]],
		["pnpm", ["pnpm", "audit", "--fix"]],
		["yarn", ["yarn", "npm", "audit", "--fix"]],
		["npm", ["npm", "audit", "fix"]],
		["go", null],
		["rust", null],
		["dotnet", null],
		["ruby", null],
		["python", null],
	] as const)("%s audit-fix command is %j", (eco, expected) => {
		expect(helper.ECOSYSTEMS[eco].auditFix).toEqual(expected);
	});

	test("ruby and python audit summaries wrap the raw output", () => {
		expect(helper.ECOSYSTEMS.ruby.audit.summarize("out")).toBe(
			"=== bundle audit ===\nout",
		);
		expect(helper.ECOSYSTEMS.ruby.audit.summarize("")).toBe(
			"=== bundle audit ===\n(no output)",
		);
		expect(
			helper.ECOSYSTEMS.python.audit.summarize(
				json({ dependencies: [{ vulns: [{}] }, {}] }),
			),
		).toBe("=== pip-audit ===\nvulnerable packages: 1");
	});

	test("node ecosystems share the npm audit summarizer", () => {
		const raw = json({ metadata: { vulnerabilities: { high: 1, total: 1 } } });
		for (const eco of ["bun", "pnpm", "yarn", "npm"] as const) {
			expect(helper.ECOSYSTEMS[eco].audit.summarize(raw)).toBe(
				helper.summarizeNpmAudit(raw),
			);
		}
	});
});

describe("withBumpedVersion", () => {
	test.each([
		"dependencies",
		"devDependencies",
		"peerDependencies",
		"optionalDependencies",
	] as const)("bumps a dependency listed in %s", (section) => {
		const result = helper.withBumpedVersion(
			{ name: "x", [section]: { lodash: "1.0.0", other: "9.9.9" } },
			"lodash",
			"2.0.0",
		);
		expect(result[section]).toEqual({ lodash: "2.0.0", other: "9.9.9" });
		expect(result.name).toBe("x");
	});

	test.each([
		["^1.0.0", "^2.0.0"],
		["~1.0.0", "~2.0.0"],
		["1.0.0", "2.0.0"],
	])("turns range %s into %s", (range, expected) => {
		const result = helper.withBumpedVersion(
			{ dependencies: { lodash: range } },
			"lodash",
			"2.0.0",
		);
		expect(result.dependencies?.lodash).toBe(expected);
	});

	test("bumps the package in every section that lists it", () => {
		const result = helper.withBumpedVersion(
			{
				dependencies: { lodash: "^1.0.0" },
				devDependencies: { lodash: "~1.0.0" },
				peerDependencies: { react: "18" },
			},
			"lodash",
			"3.0.0",
		);
		expect(result.dependencies?.lodash).toBe("^3.0.0");
		expect(result.devDependencies?.lodash).toBe("~3.0.0");
		expect(result.peerDependencies).toEqual({ react: "18" });
	});

	test("returns the same manifest object when the package is absent", () => {
		const manifest = { dependencies: { other: "1.0.0" } };
		expect(helper.withBumpedVersion(manifest, "lodash", "2.0.0")).toBe(
			manifest,
		);
		const empty = { name: "x" };
		expect(helper.withBumpedVersion(empty, "lodash", "2.0.0")).toBe(empty);
	});

	test("does not mutate the input manifest", () => {
		const manifest = { dependencies: { lodash: "^1.0.0" } };
		const snapshot = structuredClone(manifest);
		const result = helper.withBumpedVersion(manifest, "lodash", "2.0.0");
		expect(manifest).toEqual(snapshot);
		expect(result).not.toBe(manifest);
		expect(result.dependencies).not.toBe(manifest.dependencies);
	});

	test("ignores inherited property names", () => {
		const manifest = { dependencies: { lodash: "1.0.0" } };
		expect(helper.withBumpedVersion(manifest, "toString", "2.0.0")).toBe(
			manifest,
		);
	});
});

describe("nodeManifests", () => {
	test("returns only the root manifest without workspaces", () => {
		expect(
			inTempDir({ "package.json": json({ name: "root" }) }, () =>
				helper.nodeManifests(),
			),
		).toEqual(["package.json"]);
	});

	test("adds the manifest of each literal workspace path", () => {
		const files = {
			"package.json": json({ workspaces: ["packages/a", "packages/b"] }),
			"packages/a/package.json": "{}",
			"packages/b/package.json": "{}",
		};
		expect(inTempDir(files, () => helper.nodeManifests())).toEqual([
			"package.json",
			join("packages/a", "package.json"),
			join("packages/b", "package.json"),
		]);
	});

	test("skips workspace directories that have no manifest", () => {
		const files = {
			"package.json": json({ workspaces: ["packages/a", "packages/missing"] }),
			"packages/a/package.json": "{}",
		};
		expect(inTempDir(files, () => helper.nodeManifests())).toEqual([
			"package.json",
			join("packages/a", "package.json"),
		]);
	});

	test("reads the object form of workspaces", () => {
		const files = {
			"package.json": json({ workspaces: { packages: ["packages/a"] } }),
			"packages/a/package.json": "{}",
		};
		expect(inTempDir(files, () => helper.nodeManifests())).toEqual([
			"package.json",
			join("packages/a", "package.json"),
		]);
	});

	test("expands glob workspaces and skips negations", () => {
		const files = {
			"package.json": json({ workspaces: ["pkg/*", "!pkg/skip"] }),
			"pkg/a/package.json": "{}",
			"pkg/b/package.json": "{}",
			"pkg/skip/package.json": "{}",
			"pkg/readme.md": "",
		};
		expect(inTempDir(files, () => helper.nodeManifests())).toEqual([
			"package.json",
			join("pkg/a", "package.json"),
			join("pkg/b", "package.json"),
		]);
	});
});

describe("bumpNodePackage", () => {
	const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

	test("bumps the root manifest only", () => {
		const files = {
			"package.json": json({
				dependencies: { lodash: "^1.0.0" },
				workspaces: ["packages/a"],
			}),
			"packages/a/package.json": json({ dependencies: { other: "1.0.0" } }),
		};
		inTempDir(files, () => {
			expect(helper.bumpNodePackage("lodash", "1.0.0", "2.0.0")).toEqual([
				"package.json",
			]);
			expect(read("package.json").dependencies.lodash).toBe("^2.0.0");
			expect(read("packages/a/package.json").dependencies).toEqual({
				other: "1.0.0",
			});
		});
	});

	test("bumps a workspace manifest only", () => {
		const files = {
			"package.json": json({ workspaces: ["packages/a"] }),
			"packages/a/package.json": json({
				devDependencies: { lodash: "~1.0.0" },
			}),
		};
		inTempDir(files, () => {
			expect(helper.bumpNodePackage("lodash", "1.0.0", "2.0.0")).toEqual([
				join("packages/a", "package.json"),
			]);
			expect(read("packages/a/package.json").devDependencies.lodash).toBe(
				"~2.0.0",
			);
			expect(read("package.json")).toEqual({ workspaces: ["packages/a"] });
		});
	});

	test("bumps root and workspace manifests together", () => {
		const files = {
			"package.json": json({
				dependencies: { lodash: "1.0.0" },
				workspaces: ["packages/a"],
			}),
			"packages/a/package.json": json({ dependencies: { lodash: "^1.0.0" } }),
		};
		inTempDir(files, () => {
			expect(helper.bumpNodePackage("lodash", "1.0.0", "2.0.0")).toEqual([
				"package.json",
				join("packages/a", "package.json"),
			]);
			expect(read("package.json").dependencies.lodash).toBe("2.0.0");
			expect(read("packages/a/package.json").dependencies.lodash).toBe(
				"^2.0.0",
			);
		});
	});

	test("writes bumped manifests as two-space JSON with a trailing newline", () => {
		inTempDir(
			{ "package.json": json({ dependencies: { lodash: "1.0.0" } }) },
			() => {
				helper.bumpNodePackage("lodash", "1.0.0", "2.0.0");
				expect(readFileSync("package.json", "utf8")).toBe(
					`${json({ dependencies: { lodash: "2.0.0" } })}\n`,
				);
			},
		);
	});

	test("dies and leaves manifests untouched when no manifest lists the package", () => {
		const original = json({
			dependencies: { other: "1.0.0" },
			workspaces: ["packages/a"],
		});
		inTempDir(
			{ "package.json": original, "packages/a/package.json": "{}" },
			() => {
				expectDies(
					() => helper.bumpNodePackage("lodash", "1.0.0", "2.0.0"),
					"lodash not found in package.json or its workspaces",
				);
				expect(readFileSync("package.json", "utf8")).toBe(original);
			},
		);
	});
});

describe("text transforms", () => {
	test("bumpCargoToml rewrites a simple dependency", () => {
		const src = '[dependencies]\nserde = "1.0.100"\nserde_json = "1.0.0"\n';
		expect(helper.bumpCargoToml(src, "serde", "1.0.200")).toBe(
			'[dependencies]\nserde = "1.0.200"\nserde_json = "1.0.0"\n',
		);
	});

	test("bumpCargoToml rewrites every entry of the crate", () => {
		const src =
			'[dependencies]\nserde = "1.0.100"\n[dev-dependencies]\nserde = "1.0.100"\n[build-dependencies]\nserde = { version = "1.0.100" }\n';
		expect(helper.bumpCargoToml(src, "serde", "1.0.200")).toBe(
			'[dependencies]\nserde = "1.0.200"\n[dev-dependencies]\nserde = "1.0.200"\n[build-dependencies]\nserde = { version = "1.0.200" }\n',
		);
	});

	test("bumpCargoToml rewrites the version inside an inline table", () => {
		const src = 'tokio = { features = ["full"], version = "1.0.0" }\n';
		expect(helper.bumpCargoToml(src, "tokio", "1.5.0")).toBe(
			'tokio = { features = ["full"], version = "1.5.0" }\n',
		);
	});

	test("bumpCargoToml returns the source unchanged when the crate is absent", () => {
		const src = 'serde = "1.0.0"\n';
		expect(helper.bumpCargoToml(src, "tokio", "1.5.0")).toBe(src);
	});

	test("bumpCargoToml escapes regex characters in the crate name", () => {
		const src = 'a-b = "1.0.0"\nazb = "1.0.0"\n';
		expect(helper.bumpCargoToml(src, "a.b", "2.0.0")).toBe(src);
	});

	test("bumpGemfile rewrites the pinned version of the gem", () => {
		const src = "gem 'rails', '7.0.0'\ngem \"puma\", \"5.0.0\"\n";
		expect(helper.bumpGemfile(src, "rails", "7.1.0")).toBe(
			"gem 'rails', '7.1.0'\ngem \"puma\", \"5.0.0\"\n",
		);
		expect(helper.bumpGemfile(src, "puma", "6.0.0")).toBe(
			"gem 'rails', '7.0.0'\ngem \"puma\", \"6.0.0\"\n",
		);
	});

	test("bumpGemfile keeps the version operator", () => {
		const src = "gem 'rails', '~> 7.0.0'\ngem \"puma\", \">= 5.0\"\n";
		expect(helper.bumpGemfile(src, "rails", "7.1.0")).toBe(
			"gem 'rails', '~> 7.1.0'\ngem \"puma\", \">= 5.0\"\n",
		);
		expect(helper.bumpGemfile(src, "puma", "6.0")).toBe(
			"gem 'rails', '~> 7.0.0'\ngem \"puma\", \">= 6.0\"\n",
		);
	});

	test("bumpGemfile leaves the source unchanged when the gem is absent", () => {
		const src = "gem 'rails', '7.0.0'\n";
		expect(helper.bumpGemfile(src, "puma", "6.0.0")).toBe(src);
	});

	test("bumpPythonSource rewrites requirements pins", () => {
		const src = "requests==2.28.0\nflask==2.0.0\n";
		expect(helper.bumpPythonSource(src, "requests", "2.28.0", "2.31.0")).toBe(
			"requests==2.31.0\nflask==2.0.0\n",
		);
	});

	test("bumpPythonSource rewrites quoted pyproject dependencies with any comparator", () => {
		const src =
			'dependencies = [\n  "requests>=2.28.0",\n  "flask~=2.0.0",\n]\n';
		expect(helper.bumpPythonSource(src, "requests", "2.28.0", "2.31.0")).toBe(
			'dependencies = [\n  "requests>=2.31.0",\n  "flask~=2.0.0",\n]\n',
		);
	});

	test("bumpPythonSource ignores a different old version", () => {
		const src = "requests==2.27.0\n";
		expect(helper.bumpPythonSource(src, "requests", "2.28.0", "2.31.0")).toBe(
			src,
		);
	});

	test("bumpActionRefs rewrites the action and its sub-path refs, keeping the v prefix", () => {
		const src =
			"- uses: actions/checkout@v3\n- uses: github/codeql-action/init@v3\n- uses: actions/cache@v3\n";
		expect(helper.bumpActionRefs(src, "actions/checkout", "3", "4")).toBe(
			"- uses: actions/checkout@v4\n- uses: github/codeql-action/init@v3\n- uses: actions/cache@v3\n",
		);
		expect(
			helper.bumpActionRefs(src, "github/codeql-action", "3", "4"),
		).toContain("github/codeql-action/init@v4");
	});

	test("bumpActionRefs does not touch other versions of the same action", () => {
		const src = "uses: actions/checkout@v3.1.0\nuses: actions/checkout@v30\n";
		expect(helper.bumpActionRefs(src, "actions/checkout", "v3", "v4")).toBe(
			src,
		);
	});
});

describe("file helpers", () => {
	test("editFiles writes only changed files and returns their names", () => {
		inTempDir({ "a.txt": "old", "b.txt": "keep" }, () => {
			const changed = helper.editFiles(
				["a.txt", "b.txt", "missing.txt"],
				(src: string) => src.replace("old", "new"),
			);
			expect(changed).toEqual(["a.txt"]);
			expect(readFileSync("a.txt", "utf8")).toBe("new");
			expect(readFileSync("b.txt", "utf8")).toBe("keep");
			expect(existsSync("missing.txt")).toBe(false);
		});
	});

	test("findWorkflowFiles lists yml and yaml workflows only", () => {
		const files = {
			".github/workflows/ci.yml": "",
			".github/workflows/release.yaml": "",
			".github/workflows/notes.md": "",
		};
		expect(inTempDir(files, () => helper.findWorkflowFiles().sort())).toEqual([
			join(".github/workflows", "ci.yml"),
			join(".github/workflows", "release.yaml"),
		]);
	});

	test("findWorkflowFiles returns an empty list without a workflows directory", () => {
		expect(
			inTempDir({ "a.txt": "" }, () => helper.findWorkflowFiles()),
		).toEqual([]);
	});
});

describe("parseArgs and splitList", () => {
	test("separates positionals from flags", () => {
		expect(helper.parseArgs(["a", "--files", "x,y", "b"], ["files="])).toEqual({
			positional: ["a", "b"],
			flags: { files: "x,y" },
		});
	});

	test("value flags consume the next argument even when it starts with dashes", () => {
		expect(
			helper.parseArgs(["--ecosystem", "--weird"], ["ecosystem="]).flags,
		).toEqual({ ecosystem: "--weird" });
	});

	test("accepts --name=value for flags, declared or not", () => {
		expect(
			helper.parseArgs(["--ecosystem=go", "--other=1"], ["ecosystem="]).flags,
		).toEqual({
			ecosystem: "go",
			other: "1",
		});
	});

	test("treats declared boolean flags and unknown flags as true", () => {
		expect(
			helper.parseArgs(["--confirm", "--unknown"], ["confirm"]).flags,
		).toEqual({ confirm: true, unknown: true });
	});

	test("returns empty results for no arguments", () => {
		expect(helper.parseArgs([])).toEqual({ positional: [], flags: {} });
	});

	test("does not mutate the argument list", () => {
		const argv = ["a", "--files", "x"];
		helper.parseArgs(argv, ["files="]);
		expect(argv).toEqual(["a", "--files", "x"]);
	});

	test("splitList trims and drops empty entries", () => {
		expect(helper.splitList(" a, b ,,c,")).toEqual(["a", "b", "c"]);
	});

	test.each([[undefined], [true], [42], [""]])(
		"splitList returns an empty list for %p",
		(value) => {
			expect(helper.splitList(value)).toEqual([]);
		},
	);
});

describe("audit summaries", () => {
	test("summarizeNpmAudit lists severities, totals, each vulnerability, and fixable ones", () => {
		const raw = json({
			metadata: {
				vulnerabilities: { critical: 0, high: 2, moderate: 1, total: 3 },
			},
			vulnerabilities: {
				lodash: { severity: "high", fixAvailable: true },
				minimist: { severity: "moderate", fixAvailable: { name: "x" } },
				ghost: {},
			},
		});
		expect(helper.summarizeNpmAudit(raw)).toBe(
			[
				"=== audit summary ===",
				"  high: 2",
				"  moderate: 1",
				"  total: 3",
				"  lodash: high; fixAvailable=true",
				'  minimist: moderate; fixAvailable={"name":"x"}',
				"  ghost: unknown; fixAvailable=false",
				"Directly fixable (non-breaking):",
				"  lodash",
			].join("\n"),
		);
	});

	test("summarizeNpmAudit prints only the header for an empty report", () => {
		expect(helper.summarizeNpmAudit("{}")).toBe("=== audit summary ===");
	});

	test("summarizeNpmAudit reports unparseable output with a raw excerpt capped at 2000 characters", () => {
		const out = helper.summarizeNpmAudit(`not json${"x".repeat(3000)}`);
		expect(
			out.startsWith(
				"=== audit ===\n(could not parse JSON; raw below)\nnot json",
			),
		).toBe(true);
		expect(out.length).toBe(
			"=== audit ===\n(could not parse JSON; raw below)\n".length + 2000,
		);
	});

	test("summarizeGovulncheck counts unique OSV ids across streamed lines and skips noise", () => {
		const raw = [
			JSON.stringify({ config: {} }),
			JSON.stringify({ finding: { osv: "GO-1" } }),
			"not json",
			"",
			JSON.stringify({ finding: { osv: "GO-2" } }),
			JSON.stringify({ finding: { osv: "GO-1" } }),
		].join("\n");
		expect(helper.summarizeGovulncheck(raw)).toBe(
			"=== govulncheck ===\n  vulnerabilities: 2\n  GO-1\n  GO-2",
		);
	});

	test("summarizeGovulncheck handles empty output", () => {
		expect(helper.summarizeGovulncheck("")).toBe(
			"=== govulncheck ===\n  vulnerabilities: 0\n  ",
		);
	});

	test("summarizeCargoAudit lists advisories", () => {
		const raw = json({
			vulnerabilities: {
				count: 2,
				list: [
					{ advisory: { id: "RUSTSEC-1" }, package: { name: "a" } },
					{ advisory: { id: "RUSTSEC-2" }, package: { name: "b" } },
				],
			},
		});
		expect(helper.summarizeCargoAudit(raw)).toBe(
			"=== cargo audit ===\n  vulnerabilities: 2\n  RUSTSEC-1 (a)\n  RUSTSEC-2 (b)",
		);
	});

	test("summarizeCargoAudit reports zero for an empty report and a parse failure for garbage", () => {
		expect(helper.summarizeCargoAudit("{}")).toBe(
			"=== cargo audit ===\n  vulnerabilities: 0",
		);
		expect(helper.summarizeCargoAudit("nope")).toBe(
			"=== cargo audit ===\n(could not parse JSON)",
		);
	});

	test("summarizeDotnetVuln lists vulnerable top-level and transitive packages", () => {
		const raw = json({
			projects: [
				{
					frameworks: [
						{
							topLevelPackages: [
								{
									id: "A",
									resolvedVersion: "1.0.0",
									vulnerabilities: [{}, {}],
								},
								{ id: "Clean", resolvedVersion: "1.0.0", vulnerabilities: [] },
							],
							transitivePackages: [
								{ id: "B", resolvedVersion: "2.0.0", vulnerabilities: [{}] },
							],
						},
					],
				},
			],
		});
		expect(helper.summarizeDotnetVuln(raw)).toBe(
			[
				"=== dotnet list package --vulnerable --include-transitive ===",
				"  A@1.0.0 — 2 advisories",
				"  B@2.0.0 — 1 advisories",
			].join("\n"),
		);
	});

	test("summarizeDotnetVuln reports no vulnerabilities or a parse failure", () => {
		expect(helper.summarizeDotnetVuln("{}")).toBe(
			"=== dotnet list package --vulnerable --include-transitive ===\n  no vulnerabilities",
		);
		expect(helper.summarizeDotnetVuln("nope")).toBe(
			"=== dotnet ===\n(could not parse JSON)",
		);
	});

	test("summarizePipAudit counts packages with vulnerabilities", () => {
		expect(
			helper.summarizePipAudit(
				json({ dependencies: [{ vulns: [{}] }, { vulns: [] }, {}] }),
			),
		).toBe("vulnerable packages: 1");
		expect(helper.summarizePipAudit("{}")).toBe("vulnerable packages: 0");
		expect(helper.summarizePipAudit("nope")).toBe("(could not parse JSON)");
	});
});

describe("summary rendering", () => {
	test("countBumps separates dependency bumps from action bumps", () => {
		const commits = [
			"abc chore(deps): bump lodash from 1 to 2",
			"def build(deps): bump react from 1 to 2",
			"123 chore(deps): bump actions/checkout from v3 to v4",
			"456 chore(deps): bump github/codeql-action from v2 to v3",
			"789 fix(app): unrelated",
		];
		expect(helper.countBumps(commits)).toEqual({ bumpDep: 2, bumpAction: 2 });
		expect(helper.countBumps([])).toEqual({ bumpDep: 0, bumpAction: 0 });
	});

	test.each([
		["", null],
		["  \n", null],
		[
			json({
				metadata: { vulnerabilities: { critical: 1, high: 2, total: 3 } },
			}),
			"3 total (1 critical, 2 high)",
		],
		[json({ metadata: { vulnerabilities: { high: 1 } } }), "? total (1 high)"],
		[json({ metadata: { vulnerabilities: { total: 0 } } }), "0 total"],
		[json({ metadata: { vulnerabilities: {} } }), "0 total"],
		[json({ other: true }), "(see scratch file)"],
		["not json", "(see scratch file)"],
	])("describeAudit(%p) is %p", (raw, expected) => {
		expect(helper.describeAudit(raw)).toBe(expected);
	});

	test("renderSummary lists commits, closed PRs, and the vulnerability delta", () => {
		expect(
			helper.renderSummary({
				ecosystem: "npm",
				branch: "drb/x",
				defaultBranch: "main",
				commits: [
					"a1 chore(deps): bump lodash from 1 to 2",
					"b2 chore(deps): bump actions/checkout from v3 to v4",
				],
				closed: ["12", "13"],
				before: "3 total",
				after: "0 total",
			}),
		).toBe(
			[
				"## Run summary",
				"",
				"Ecosystem: npm",
				"Branch: drb/x",
				"Applied: 1 dependencies, 1 GitHub Actions",
				"",
				"Commits on drb/x since origin/main:",
				"  a1 chore(deps): bump lodash from 1 to 2",
				"  b2 chore(deps): bump actions/checkout from v3 to v4",
				"",
				"Closed PRs/MRs: #12, #13",
				"",
				"Vulnerabilities: 3 total → 0 total",
			].join("\n"),
		);
	});

	test("renderSummary uses placeholders when nothing was recorded", () => {
		const out = helper.renderSummary({
			ecosystem: "(unknown)",
			branch: "b",
			defaultBranch: "main",
			commits: [],
			closed: [],
			before: null,
			after: null,
		});
		expect(out).toContain("  (none)");
		expect(out).toContain("Closed PRs/MRs: (none)");
		expect(out).toContain("Vulnerabilities: ? → (not re-audited)");
	});
});

describe("prepare helpers and environment", () => {
	test("timestampSlug formats a UTC date as YYYYMMDD-HHMMSS", () => {
		expect(helper.timestampSlug(new Date("2026-03-04T05:06:07.890Z"))).toBe(
			"20260304-050607",
		);
	});

	test("renovateLogin defaults to renovate-bot and honors AI_RENOVATE_BOT_LOGIN", () => {
		const previous = process.env.AI_RENOVATE_BOT_LOGIN;
		try {
			delete process.env.AI_RENOVATE_BOT_LOGIN;
			expect(helper.renovateLogin()).toBe("renovate-bot");
			process.env.AI_RENOVATE_BOT_LOGIN = "custom-bot";
			expect(helper.renovateLogin()).toBe("custom-bot");
		} finally {
			if (previous === undefined) delete process.env.AI_RENOVATE_BOT_LOGIN;
			else process.env.AI_RENOVATE_BOT_LOGIN = previous;
		}
	});

	test("scratchPaths creates the per-project state directory and names the snapshot files", () => {
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-scratch-");
		const previous = process.env.AI_STATE_DIR;
		process.env.AI_STATE_DIR = stateDir;
		try {
			const paths = helper.scratchPaths();
			const dir = dirname(paths.closedLog);
			expect(dir.startsWith(join(stateDir, "deps-upgrade"))).toBe(true);
			expect(existsSync(dir)).toBe(true);
			expect(paths).toEqual({
				closedLog: join(dir, "closed-prs.txt"),
				auditBefore: join(dir, "audit-before.json"),
				auditAfter: join(dir, "audit-after.json"),
				branchFile: join(dir, "branch.txt"),
				heldLog: join(dir, "held-by-cooldown.jsonl"),
			});
		} finally {
			if (previous === undefined) delete process.env.AI_STATE_DIR;
			else process.env.AI_STATE_DIR = previous;
		}
	});

	test("description returns the header usage block without the shebang", () => {
		const text = helper.description();
		expect(text).toContain("language-agnostic wrapper");
		expect(text).toContain("bump-dep <pkg> <old> <new>");
		expect(text).not.toMatch(/Bash\(|scripts\/\*\*|global.*allow rule/);
		expect(text).not.toContain("#!/usr/bin/env bun");
		expect(text).not.toContain("//");
	});
});

function gitRepo(files: Record<string, string>): string {
	const dir = makeGitRepo();
	createdDirs.push(dir);
	cliFixtures.runGit(["config", "user.email", "t@t.t"], dir);
	cliFixtures.runGit(["config", "user.name", "T"], dir);
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, name)), { recursive: true });
		writeFileSync(join(dir, name), content);
	}
	cliFixtures.runGit(["add", "."], dir);
	cliFixtures.runGit(["commit", "-q", "-m", "chore: seed"], dir);
	cliFixtures.runGit(["checkout", "-q", "-b", "chore/deps_update_test"], dir);
	return realpathSync(dir);
}

function fakeBinPath(bins: Record<string, string>): string {
	const dir = cliFixtures.tmp(createdDirs, "deps-upgrade-fake-bins-");
	for (const [name, script] of Object.entries(bins))
		writeFakeCli(dir, name, script);
	return `${dir}:${ORIGINAL_PATH}`;
}

function lastCommit(cwd: string): { subject: string; files: string[] } {
	return {
		subject: cliFixtures.runGit(["log", "-1", "--format=%s"], cwd).trim(),
		files: cliFixtures
			.runGit(["show", "--name-only", "--format=", "HEAD"], cwd)
			.split("\n")
			.filter(Boolean)
			.sort(),
	};
}

function addDefaultOrigin(cwd: string): void {
	cliFixtures.runGit(
		["remote", "add", "origin", "https://example.invalid/widgets.git"],
		cwd,
	);
	cliFixtures.runGit(["update-ref", "refs/remotes/origin/main", "HEAD"], cwd);
	cliFixtures.runGit(
		["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"],
		cwd,
	);
}

function stateFile(stateDir: string, cwd: string, name: string): string {
	const hash = projectHash(cwd);
	return join(stateDir, "deps-upgrade", hash, name);
}

const NPM_WORKSPACE_FILES = {
	"package.json": json({
		name: "root",
		workspaces: ["packages/a", "packages/b"],
	}),
	"packages/a/package.json": json({
		name: "a",
		dependencies: { lodash: "^1.0.0" },
	}),
	"packages/b/package.json": json({
		name: "b",
		dependencies: { other: "1.0.0" },
	}),
	"package-lock.json": json({ lockfileVersion: 3 }),
	"CHANGELOG.md": "# changes\n",
};

const FAKE_NPM = shScript(`
  *"install"*)
    echo '{"lockfileVersion":3,"installed":true}' > package-lock.json
    exit 0
    ;;`);

describe("integration: bump-dep", () => {
	test("npm workspaces: commits the workspace manifest and lockfile with the conventional subject", async () => {
		const cwd = gitRepo(NPM_WORKSPACE_FILES);
		const log = newCallLog();

		const result = await runCli(["bump-dep", "lodash", "1.0.0", "1.2.0"], {
			cwd,
			env: { PATH: fakeBinPath({ npm: FAKE_NPM }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("ecosystem: npm");
		expect(readCalls(log)).toEqual(["install"]);
		expect(lastCommit(cwd)).toEqual({
			subject: "chore(deps): bump lodash from 1.0.0 to 1.2.0",
			files: ["package-lock.json", "packages/a/package.json"],
		});
		expect(
			JSON.parse(readFileSync(join(cwd, "packages/a/package.json"), "utf8"))
				.dependencies.lodash,
		).toBe("^1.2.0");
		expect(
			JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"))
				.installed,
		).toBe(true);
		expect(cliFixtures.runGit(["status", "--porcelain"], cwd)).toBe("");
	});

	test("npm workspaces: dies without committing when no manifest lists the package", async () => {
		const cwd = gitRepo(NPM_WORKSPACE_FILES);
		const log = newCallLog();

		const result = await runCli(["bump-dep", "missing-pkg", "1.0.0", "2.0.0"], {
			cwd,
			env: { PATH: fakeBinPath({ npm: FAKE_NPM }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"error: missing-pkg not found in package.json or its workspaces",
		);
		expect(readCalls(log)).toEqual([]);
		expect(lastCommit(cwd).subject).toBe("chore: seed");
	});

	test("npm workspaces: stages --files extras alongside the manifests", async () => {
		const cwd = gitRepo(NPM_WORKSPACE_FILES);
		writeFileSync(join(cwd, "CHANGELOG.md"), "# changes\n- bump lodash\n");

		const result = await runCli(
			[
				"bump-dep",
				"lodash",
				"1.0.0",
				"1.2.0",
				"--files",
				"CHANGELOG.md,does-not-exist.md",
			],
			{
				cwd,
				env: { PATH: fakeBinPath({ npm: FAKE_NPM }) },
			},
		);

		expect(result.exitCode).toBe(0);
		expect(lastCommit(cwd).files).toEqual([
			"CHANGELOG.md",
			"package-lock.json",
			"packages/a/package.json",
		]);
	});

	test("npm: usage error when arguments are missing", async () => {
		const cwd = gitRepo(NPM_WORKSPACE_FILES);

		const result = await runCli(["bump-dep", "lodash", "1.0.0"], { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"usage: bump-dep <pkg> <old> <new> [--files a,b] [--ecosystem <name>]",
		);
	});

	test("npm: fails when the installer exits non-zero and does not commit", async () => {
		const cwd = gitRepo(NPM_WORKSPACE_FILES);

		const result = await runCli(["bump-dep", "lodash", "1.0.0", "1.2.0"], {
			cwd,
			env: {
				PATH: fakeBinPath({
					npm: shScript('  *"install"*)\n    exit 3\n    ;;'),
				}),
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: command failed: npm install");
		expect(lastCommit(cwd).subject).toBe("chore: seed");
	});

	test("go: runs get and tidy, then commits go.mod and go.sum", async () => {
		const cwd = gitRepo({ "go.mod": "module x\n", "go.sum": "sum1\n" });
		const log = newCallLog();
		const fakeGo = shScript(`
  *"get"*)
    echo "require example.com/lib v1.2.3" >> go.mod
    exit 0
    ;;
  *"mod tidy"*)
    echo "sum2" >> go.sum
    exit 0
    ;;`);

		const result = await runCli(
			["bump-dep", "example.com/lib", "1.0.0", "v1.2.3"],
			{
				cwd,
				env: { PATH: fakeBinPath({ go: fakeGo }), FAKE_CALL_LOG: log },
			},
		);

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual(["get example.com/lib@v1.2.3", "mod tidy"]);
		expect(lastCommit(cwd)).toEqual({
			subject: "chore(deps): bump example.com/lib from 1.0.0 to v1.2.3",
			files: ["go.mod", "go.sum"],
		});
	});

	test("rust: rewrites Cargo.toml, runs cargo update, and commits manifest and lockfile", async () => {
		const cwd = gitRepo({
			"Cargo.toml": '[dependencies]\nserde = "1.0.100"\n',
			"Cargo.lock": "lock1\n",
		});
		const log = newCallLog();
		const fakeCargo = shScript(`
  *"update"*)
    echo "lock2" >> Cargo.lock
    exit 0
    ;;`);

		const result = await runCli(["bump-dep", "serde", "1.0.100", "1.0.200"], {
			cwd,
			env: { PATH: fakeBinPath({ cargo: fakeCargo }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual(["update -p serde --precise 1.0.200"]);
		expect(readFileSync(join(cwd, "Cargo.toml"), "utf8")).toBe(
			'[dependencies]\nserde = "1.0.200"\n',
		);
		expect(lastCommit(cwd)).toEqual({
			subject: "chore(deps): bump serde from 1.0.100 to 1.0.200",
			files: ["Cargo.lock", "Cargo.toml"],
		});
	});

	test("dotnet: adds the package only to projects that reference it and commits them", async () => {
		const cwd = gitRepo({
			"app.csproj": '<PackageReference Include="Foo" Version="1.0.0" />\n',
			"other.csproj": '<PackageReference Include="Bar" Version="1.0.0" />\n',
		});
		const log = newCallLog();
		const fakeDotnet = shScript(`
  *"add app.csproj"*)
    sed -i 's/1.0.0/2.0.0/' app.csproj
    exit 0
    ;;`);

		const result = await runCli(["bump-dep", "Foo", "1.0.0", "2.0.0"], {
			cwd,
			env: { PATH: fakeBinPath({ dotnet: fakeDotnet }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual([
			"add app.csproj package Foo --version 2.0.0",
		]);
		expect(lastCommit(cwd)).toEqual({
			subject: "chore(deps): bump Foo from 1.0.0 to 2.0.0",
			files: ["app.csproj"],
		});
	});

	test("--ecosystem overrides detection", async () => {
		const cwd = gitRepo({
			"go.mod": "module x\n",
			"go.sum": "sum1\n",
			"package-lock.json": "{}",
			"package.json": "{}",
		});
		const log = newCallLog();
		const fakeGo = shScript(`
  *"get"*)
    echo "// bumped" >> go.mod
    exit 0
    ;;`);

		const result = await runCli(
			["bump-dep", "example.com/lib", "1", "2", "--ecosystem", "go"],
			{
				cwd,
				env: { PATH: fakeBinPath({ go: fakeGo }), FAKE_CALL_LOG: log },
			},
		);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("ecosystem: go");
		expect(readCalls(log).some((call) => call.startsWith("get"))).toBe(true);
	});

	test("rejects an unknown --ecosystem", async () => {
		const cwd = gitRepo({ "go.mod": "module x\n" });

		const result = await runCli(
			["bump-dep", "p", "1", "2", "--ecosystem", "java"],
			{ cwd },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: unknown --ecosystem: java");
	});
});

describe("integration: install and audit-fix", () => {
	test("install runs the ecosystem installer", async () => {
		const cwd = gitRepo({ "package-lock.json": "{}", "package.json": "{}" });
		const log = newCallLog();

		const result = await runCli(["install"], {
			cwd,
			env: { PATH: fakeBinPath({ npm: FAKE_NPM }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("ecosystem: npm");
		expect(readCalls(log)).toEqual(["install"]);
	});

	test("install dies when no ecosystem is detected", async () => {
		const cwd = gitRepo({ "README.md": "x" });

		const result = await runCli(["install"], { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"error: no supported ecosystem detected (pass --ecosystem to override)",
		);
	});

	test("install dies for python without a lockfile or requirements.txt", async () => {
		const cwd = gitRepo({ "pyproject.toml": "[project]\n" });

		const result = await runCli(["install"], { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"error: no python install strategy detected",
		);
	});

	test("audit-fix runs the node audit fix command", async () => {
		const cwd = gitRepo({ "yarn.lock": "" });
		const log = newCallLog();

		const result = await runCli(["audit-fix"], {
			cwd,
			env: { PATH: fakeBinPath({ yarn: shScript("") }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual(["npm audit --fix"]);
	});

	test("audit-fix dies for ecosystems without a fixer", async () => {
		const cwd = gitRepo({ "go.mod": "module x\n" });

		const result = await runCli(["audit-fix"], { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error: audit-fix is not supported for go");
	});
});

describe("integration: bump-action", () => {
	const WORKFLOWS = {
		".github/workflows/ci.yml":
			"steps:\n  - uses: actions/checkout@v3\n  - uses: actions/cache@v3\n",
		".github/workflows/release.yaml": "steps:\n  - uses: actions/checkout@v3\n",
		".github/workflows/other.yml": "steps:\n  - uses: actions/cache@v3\n",
	};

	test("rewrites every matching workflow and commits them", async () => {
		const cwd = gitRepo(WORKFLOWS);

		const result = await runCli(
			["bump-action", "actions/checkout", "v3", "v4"],
			{ cwd },
		);

		expect(result.exitCode).toBe(0);
		expect(lastCommit(cwd).subject).toBe(
			"chore(deps): bump actions/checkout from v3 to v4",
		);
		expect(readFileSync(join(cwd, ".github/workflows/ci.yml"), "utf8")).toBe(
			"steps:\n  - uses: actions/checkout@v4\n  - uses: actions/cache@v3\n",
		);
		expect(
			readFileSync(join(cwd, ".github/workflows/release.yaml"), "utf8"),
		).toContain("actions/checkout@v4");
		expect(
			readFileSync(join(cwd, ".github/workflows/other.yml"), "utf8"),
		).toContain("actions/cache@v3");
	});

	test("commits only the files that were staged, leaving explicit targets in scope", async () => {
		const cwd = gitRepo(WORKFLOWS);

		const result = await runCli(
			[
				"bump-action",
				"actions/checkout",
				"v3",
				"v4",
				".github/workflows/ci.yml",
			],
			{ cwd },
		);

		expect(result.exitCode).toBe(0);
		expect(lastCommit(cwd).files).toEqual([".github/workflows/ci.yml"]);
		expect(
			readFileSync(join(cwd, ".github/workflows/release.yaml"), "utf8"),
		).toContain("actions/checkout@v3");
	});

	test("dies with 'no workflow files changed' when the from tag matches nothing", async () => {
		const cwd = gitRepo(WORKFLOWS);

		const result = await runCli(
			["bump-action", "actions/checkout", "v2", "v4"],
			{ cwd },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"error: no workflow files changed — check <from> tag",
		);
		expect(lastCommit(cwd).subject).toBe("chore: seed");
	});

	test("dies with 'no workflow files changed' when there is no workflows directory", async () => {
		const cwd = gitRepo({ "README.md": "x" });

		const result = await runCli(
			["bump-action", "actions/checkout", "v3", "v4"],
			{ cwd },
		);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("no workflow files changed");
	});

	test("prints usage when arguments are missing", async () => {
		const cwd = gitRepo(WORKFLOWS);

		const result = await runCli(["bump-action", "actions/checkout"], { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			"usage: bump-action <action-ref> <from> <to> [workflow-files...]",
		);
	});
});

describe("integration: commit", () => {
	test("stages --files and commits with a conventional subject", async () => {
		const cwd = gitRepo({ "a.txt": "1" });
		writeFileSync(join(cwd, "a.txt"), "2");
		writeFileSync(join(cwd, "untracked.txt"), "u");

		const result = await runCli(
			["commit", "fix", "deps", "resolve", "advisory", "--files", "a.txt"],
			{ cwd },
		);

		expect(result.exitCode).toBe(0);
		expect(lastCommit(cwd)).toEqual({
			subject: "fix(deps): resolve advisory",
			files: ["a.txt"],
		});
		expect(cliFixtures.runGit(["status", "--porcelain"], cwd)).toBe(
			"?? untracked.txt\n",
		);
	});

	test("prints usage when the message is missing", async () => {
		const cwd = gitRepo({ "a.txt": "1" });

		const result = await runCli(["commit", "fix", "deps"], { cwd });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain(
			'usage: commit <type> <scope> "<message>" [--files a,b]',
		);
	});
});

describe("integration: audit snapshots", () => {
	const AUDIT_JSON = json({
		metadata: { vulnerabilities: { high: 2, total: 2 } },
		vulnerabilities: { lodash: { severity: "high", fixAvailable: true } },
	});
	const CLEAN_JSON = json({ metadata: { vulnerabilities: { total: 0 } } });

	function fakeAudit(payloadEnv: string): string {
		return shScript(`
  *"audit --json"*)
    printf '%s' "$${payloadEnv}"
    exit 0
    ;;`);
	}

	test("prints the summary and writes the first snapshot to audit-before.json", async () => {
		const cwd = gitRepo({ "package-lock.json": "{}" });
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-state-");

		const result = await runCli(["audit"], {
			cwd,
			stateDir,
			env: {
				PATH: fakeBinPath({ npm: fakeAudit("AUDIT_PAYLOAD") }),
				AUDIT_PAYLOAD: AUDIT_JSON,
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("ecosystem: npm");
		expect(result.stdout).toContain(
			"=== audit summary ===\n  high: 2\n  total: 2\n  lodash: high; fixAvailable=true",
		);
		expect(
			readFileSync(stateFile(stateDir, cwd, "audit-before.json"), "utf8"),
		).toBe(AUDIT_JSON);
		expect(existsSync(stateFile(stateDir, cwd, "audit-after.json"))).toBe(
			false,
		);
	});

	test("writes the second snapshot to audit-after.json and keeps the first", async () => {
		const cwd = gitRepo({ "package-lock.json": "{}" });
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-state-");
		const first = {
			cwd,
			stateDir,
			env: {
				PATH: fakeBinPath({ npm: fakeAudit("AUDIT_PAYLOAD") }),
				AUDIT_PAYLOAD: AUDIT_JSON,
			},
		};
		const second = {
			cwd,
			stateDir,
			env: {
				PATH: fakeBinPath({ npm: fakeAudit("AUDIT_PAYLOAD") }),
				AUDIT_PAYLOAD: CLEAN_JSON,
			},
		};

		await runCli(["audit"], first);
		const result = await runCli(["audit"], second);

		expect(result.exitCode).toBe(0);
		expect(
			readFileSync(stateFile(stateDir, cwd, "audit-before.json"), "utf8"),
		).toBe(AUDIT_JSON);
		expect(
			readFileSync(stateFile(stateDir, cwd, "audit-after.json"), "utf8"),
		).toBe(CLEAN_JSON);
	});

	test("treats a blank audit-before.json as unset and overwrites it", async () => {
		const cwd = gitRepo({ "package-lock.json": "{}" });
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-state-");
		mkdirSync(dirname(stateFile(stateDir, cwd, "audit-before.json")), {
			recursive: true,
		});
		writeFileSync(stateFile(stateDir, cwd, "audit-before.json"), "\n");

		await runCli(["audit"], {
			cwd,
			stateDir,
			env: {
				PATH: fakeBinPath({ npm: fakeAudit("AUDIT_PAYLOAD") }),
				AUDIT_PAYLOAD: AUDIT_JSON,
			},
		});

		expect(
			readFileSync(stateFile(stateDir, cwd, "audit-before.json"), "utf8"),
		).toBe(AUDIT_JSON);
	});

	test("uses the ecosystem-specific audit command and summarizer", async () => {
		const cwd = gitRepo({ "Cargo.toml": "" });
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-state-");
		const log = newCallLog();
		const fakeCargo = shScript(`
  *"audit --json"*)
    printf '%s' '{"vulnerabilities":{"count":1,"list":[{"advisory":{"id":"RUSTSEC-9"},"package":{"name":"zed"}}]}}'
    exit 0
    ;;`);

		const result = await runCli(["audit"], {
			cwd,
			stateDir,
			env: { PATH: fakeBinPath({ cargo: fakeCargo }), FAKE_CALL_LOG: log },
		});

		expect(result.exitCode).toBe(0);
		expect(readCalls(log)).toEqual(["audit --json"]);
		expect(result.stdout).toBe(
			"=== cargo audit ===\n  vulnerabilities: 1\n  RUSTSEC-9 (zed)\n",
		);
	});
});

describe("integration: summary", () => {
	function trackedRepo(): string {
		const dir = cliFixtures.tmp(createdDirs, "deps-upgrade-summary-");
		cliFixtures.initTrackedRepo(dir, "https://example.com/acme/widgets.git");
		cliFixtures.runGit(
			["checkout", "-q", "-b", "chore/deps_update_1"],
			dir,
		);
		return realpathSync(dir);
	}

	test("renders commits, closed PRs, and the audit delta from recorded state", async () => {
		const cwd = trackedRepo();
		writeFileSync(join(cwd, "package-lock.json"), "{}");
		cliFixtures.commitFile(
			cwd,
			"a.txt",
			"1",
			"chore(deps): bump lodash from 1.0.0 to 1.0.1",
		);
		cliFixtures.commitFile(
			cwd,
			"b.txt",
			"1",
			"chore(deps): bump actions/checkout from v3 to v4",
		);
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-state-");
		const stateDirFor = dirname(stateFile(stateDir, cwd, "x"));
		mkdirSync(stateDirFor, { recursive: true });
		writeFileSync(join(stateDirFor, "closed-prs.txt"), "12\n13\n");
		writeFileSync(
			join(stateDirFor, "audit-before.json"),
			json({ metadata: { vulnerabilities: { high: 2, total: 2 } } }),
		);
		writeFileSync(
			join(stateDirFor, "audit-after.json"),
			json({ metadata: { vulnerabilities: { total: 0 } } }),
		);

		const result = await runCli(["summary"], { cwd, stateDir });

		expect(result.exitCode).toBe(0);
		const lines = result.stdout.split("\n");
		expect(lines).toContain("## Run summary");
		expect(lines).toContain("Ecosystem: npm");
		expect(lines).toContain("Branch: chore/deps_update_1");
		expect(lines).toContain("Applied: 1 dependencies, 1 GitHub Actions");
		expect(lines).toContain(
			"Commits on chore/deps_update_1 since origin/main:",
		);
		expect(
			lines
				.filter((l) => l.startsWith("  "))
				.map((l) => l.slice(l.indexOf(" ", 2) + 1)),
		).toEqual([
			"chore(deps): bump actions/checkout from v3 to v4",
			"chore(deps): bump lodash from 1.0.0 to 1.0.1",
		]);
		expect(lines).toContain("Closed PRs/MRs: #12, #13");
		expect(lines).toContain("Vulnerabilities: 2 total (2 high) → 0 total");
	});

	test("falls back to placeholders when no state was recorded", async () => {
		const cwd = trackedRepo();

		const result = await runCli(["summary"], { cwd });

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Ecosystem: (unknown)");
		expect(result.stdout).toContain(
			"Applied: 0 dependencies, 0 GitHub Actions",
		);
		expect(result.stdout).toContain("  (none)");
		expect(result.stdout).toContain("Closed PRs/MRs: (none)");
		expect(result.stdout).toContain("Vulnerabilities: ? → (not re-audited)");
	});
});

describe("integration: CLI surface", () => {
	test("--help lists every subcommand and the header description", async () => {
		const result = await runCli(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(
			"Usage: deps-upgrade <subcommand> [options]",
		);
		for (const sub of [
			"prepare",
			"list-prs",
			"pr-body <number>",
			"audit",
			"install",
			"audit-fix",
			"bump-dep <pkg> <old> <new>",
			"bump-action <action-ref> <from> <to>",
			"commit <type> <scope> <msg>",
			"status",
			"reset-deps",
			"close-prs <n...>",
			"cooldown <pkg> <old> <new>",
			"push-pr",
			"ready-when-green <pr>",
			"summary",
		]) {
			expect(result.stdout).toContain(`  ${sub}`);
		}
		expect(result.stdout).toContain(
			"language-agnostic wrapper for the /deps-upgrade skill",
		);
	});

	test("an unknown subcommand exits with the usage code", async () => {
		const result = await runCli(["nope"]);

		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain("unknown subcommand 'nope'");
	});

	test("importing the module does not run the CLI or create state", () => {
		const stateDir = cliFixtures.tmp(createdDirs, "deps-upgrade-import-state-");
		const proc = Bun.spawnSync(
			[
				BUN_BIN,
				"-e",
				`await import(${JSON.stringify(MODULE)}); console.log("imported")`,
			],
			{
				env: { ...baseEnv(), AI_STATE_DIR: stateDir },
				cwd: cliFixtures.tmp(createdDirs, "deps-upgrade-import-cwd-"),
			},
		);

		expect(proc.stdout.toString().trim()).toBe("imported");
		expect(proc.exitCode).toBe(0);
		expect(existsSync(join(stateDir, "deps-upgrade"))).toBe(false);
	});
});

describe("deps-upgrade state ownership", () => {
	test("rejects a managed state symlink without touching its destination", () => {
		const target = cliFixtures.tmp(createdDirs, "deps-external-state-");
		const state = cliFixtures.tmp(createdDirs, "deps-owned-state-");
		const previous = process.env.AI_STATE_DIR;
		process.env.AI_STATE_DIR = state;
		writeFileSync(join(target, "keep.txt"), "existing data");
		symlinkSync(target, join(state, "deps-upgrade"), "dir");
		try {
			expect(() => helper.scratchPaths()).toThrow(
				/unsafe scratch\/state directory/,
			);
		} finally {
			if (previous === undefined) delete process.env.AI_STATE_DIR;
			else process.env.AI_STATE_DIR = previous;
		}
		expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe(
			"existing data",
		);
		expect(existsSync(join(target, projectHash()))).toBe(false);
	});
});

describe("cooldown registry boundaries", () => {
	const NOW = Date.parse("2026-10-16T00:00:00Z");
	const OLD = "2026-01-01T00:00:00Z";
	test.each([
		[
			"bun",
			"@scope/pkg",
			"https://registry.npmjs.org/@scope%2Fpkg",
			{ time: { "2.0.0": OLD } },
		],
		[
			"pnpm",
			"pkg",
			"https://registry.npmjs.org/pkg",
			{ time: { "2.0.0": OLD } },
		],
		[
			"yarn",
			"pkg",
			"https://registry.npmjs.org/pkg",
			{ time: { "2.0.0": OLD } },
		],
		[
			"rust",
			"some-crate",
			"https://crates.io/api/v1/crates/some-crate",
			{ versions: [{ num: "2.0.0", created_at: OLD }] },
		],
		[
			"ruby",
			"some-gem",
			"https://rubygems.org/api/v1/versions/some-gem.json",
			[{ number: "2.0.0", created_at: OLD }],
		],
		[
			"go",
			"example.com/Upper/Lib",
			"https://proxy.golang.org/example.com/!upper/!lib/@v/v2.0.0.info",
			{ Time: OLD },
		],
	] as const)(
		"%s requests the registry metadata for %s",
		async (eco, pkg, url, payload) => {
			const urls: string[] = [];
			const verdict = await helper.evaluateCooldown({
				eco,
				pkg,
				oldVersion: "1.0.0",
				version: "2.0.0",
				days: 7,
				now: () => NOW,
				fetchJson: async (requested: string) => {
					urls.push(requested);
					return payload;
				},
			});
			expect(urls).toEqual([url]);
			expect(verdict).toEqual({ status: "ok", version: "2.0.0" });
		},
	);

	test("accepts the exact cooldown boundary and ignores invalid publish timestamps", async () => {
		const atCutoff = new Date(NOW - 7 * 86_400_000).toISOString();
		const verdict = await helper.evaluateCooldown({
			eco: "npm",
			pkg: "pkg",
			oldVersion: "1",
			version: "2",
			days: 7,
			now: () => NOW,
			fetchJson: async () => ({ time: { "2": atCutoff, "3": "not a date" } }),
		});
		expect(verdict).toEqual({ status: "ok", version: "2" });
		expect(
			await helper.evaluateCooldown({
				eco: "npm",
				pkg: "pkg",
				oldVersion: "1",
				version: "3",
				days: 7,
				now: () => NOW,
				fetchJson: async () => ({ time: { "3": "not a date" } }),
			}),
		).toEqual({ status: "unknown", requested: "3" });
	});

	test("fetchJson handles successful JSON, HTTP failure, malformed JSON and transport failure", async () => {
		const fetchMock = spyOn(globalThis, "fetch");
		try {
			fetchMock.mockResolvedValueOnce(Response.json({ version: "fixture" }));
			expect(
				await helper.fetchJson("https://registry.example.invalid/package"),
			).toEqual({ version: "fixture" });
			expect(fetchMock.mock.calls[0][1]).toMatchObject({
				headers: { accept: "application/json" },
			});
			fetchMock.mockResolvedValueOnce(
				new Response("unavailable", { status: 503 }),
			);
			expect(
				await helper.fetchJson("https://registry.example.invalid/package"),
			).toBeNull();
			fetchMock.mockResolvedValueOnce(new Response("malformed"));
			expect(
				await helper.fetchJson("https://registry.example.invalid/package"),
			).toBeNull();
			fetchMock.mockRejectedValueOnce(new Error("fixture transport failure"));
			expect(
				await helper.fetchJson("https://registry.example.invalid/package"),
			).toBeNull();
		} finally {
			fetchMock.mockRestore();
		}
	});

	test("the cooldown CLI records held versions and includes them in summary", async () => {
		const cwd = gitRepo({ "package-lock.json": "{}" });
		addDefaultOrigin(cwd);
		const preload = join(
			cliFixtures.tmp(createdDirs, "deps-registry-preload-"),
			"registry.ts",
		);
		writeFileSync(
			preload,
			`Date.now = () => ${NOW}; globalThis.fetch = async () => Response.json({time:{"1.0.0":"${OLD}","2.0.0":"2026-10-15T00:00:00Z"}});`,
		);
		const stateDir = cliFixtures.tmp(createdDirs, "deps-held-state-");
		const result = await runCli(
			["cooldown", "pkg", "1.0.0", "2.0.0", "--ecosystem", "npm"],
			{ cwd, stateDir, preload },
		);
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({
			pkg: "pkg",
			status: "held",
			requested: "2.0.0",
		});
		expect(
			JSON.parse(
				readFileSync(
					stateFile(stateDir, cwd, "held-by-cooldown.jsonl"),
					"utf8",
				),
			),
		).toEqual({
			pkg: "pkg",
			version: "2.0.0",
			published: "2026-10-15T00:00:00Z",
			eligible: "2026-10-22T00:00:00.000Z",
		});
		const summary = await runCli(["summary"], { cwd, stateDir });
		expect(summary.exitCode).toBe(0);
		expect(summary.stdout).toContain("Held by cooldown (1):");
		expect(summary.stdout).toContain("pkg@2.0.0");
	});
});

describe("deps-upgrade status and reset-deps", () => {
	test("status emits status, recent log and diff sections for a disposable repository", async () => {
		const cwd = gitRepo({ "a.txt": "initial" });
		writeFileSync(join(cwd, "a.txt"), "changed");
		const result = await runCli(["status"], { cwd });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("--- git status --short ---");
		expect(result.stdout).toContain("--- git log --oneline -10 ---");
		expect(result.stdout).toContain("--- git diff --stat ---");
		expect(result.stdout).toContain(" M a.txt");
		expect(result.stdout).toContain("chore: seed");
	});

	test("reset-deps previews by default and confirmed reset preserves the working files", async () => {
		const cwd = gitRepo({ "a.txt": "initial" });
		addDefaultOrigin(cwd);
		const original = cliFixtures.runGit(["rev-parse", "HEAD"], cwd);
		cliFixtures.commitFile(
			cwd,
			"a.txt",
			"changed",
			"chore(deps): update fixture",
		);
		const tip = cliFixtures.runGit(["rev-parse", "HEAD"], cwd);
		const preview = await runCli(["reset-deps"], { cwd });
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout).toContain(
			"git reset --mixed $(git merge-base HEAD origin/main)",
		);
		expect(preview.stdout).toContain("pass --confirm to execute");
		expect(cliFixtures.runGit(["rev-parse", "HEAD"], cwd)).toBe(tip);
		const reset = await runCli(["reset-deps", "--confirm"], { cwd });
		expect(reset.exitCode).toBe(0);
		expect(cliFixtures.runGit(["rev-parse", "HEAD"], cwd)).toBe(original);
		expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("changed");
		expect(cliFixtures.runGit(["diff", "--cached", "--name-only"], cwd)).toBe(
			"",
		);
		expect(cliFixtures.runGit(["status", "--porcelain"], cwd)).toContain(
			" M a.txt",
		);
	});
});

describe("deps-upgrade command errors", () => {
	test("no subcommand prints usage on stdout and exits 2", async () => {
		const result = await runCli([]);
		expect(result.exitCode).toBe(2);
		expect(result.stdout).toContain(
			"Usage: deps-upgrade <subcommand> [options]",
		);
		expect(result.stderr).toBe("");
	});
	test.each([
		["cooldown", "usage: cooldown"],
		["close-prs", "close-prs requires at least one PR number"],
	])(
		"%s rejects missing arguments before provider access",
		async (verb, error) => {
			const result = await runCli([verb]);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain(error);
		},
	);
	test.each(["-1", "1.5", "not-a-number"])(
		"cooldown rejects invalid days %s",
		async (days) => {
			const result = await runCli([
				"cooldown",
				"pkg",
				"1",
				"2",
				"--ecosystem",
				"npm",
				"--cooldown-days",
				days,
			]);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(
				"--cooldown-days must be a whole number >= 0",
			);
		},
	);
	test.each(["timeout-minutes", "interval-seconds"])(
		"ready-when-green rejects invalid %s",
		async (flag) => {
			const bin = fakeGhDir(
				shScript(
					'  *"pr view"*)\n    echo "https://github.com/acme/widgets/pull/90"\n    exit 0\n    ;;',
				),
			);
			const result = await runCli(
				["ready-when-green", "90", `--${flag}`, "invalid"],
				{ env: { PATH: `${bin}:${ORIGINAL_PATH}` } },
			);
			expect(result.exitCode).toBe(1);
			expect(result.stderr).toContain(`--${flag}`);
		},
	);
	test("global help registers deps-upgrade", async () => {
		const proc = Bun.spawnSync([BUN_BIN, "run", CLI, "--help"], {
			env: baseEnv(),
		});
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toMatch(/^ {2}deps-upgrade\s/m);
	});
});

describe("thrash review hardening", () => {
	test("summarizeGovulncheck decodes a stream of indented JSON objects", () => {
		const raw = [
			JSON.stringify({ config: { protocol_version: "v1.0.0" } }, null, 2),
			JSON.stringify({ finding: { osv: "GO-1", trace: [{ module: "a" }] } }, null, 2),
			JSON.stringify({ finding: { osv: "GO-1" } }, null, 2),
			JSON.stringify({ finding: { osv: "GO-2", note: "}{ \"x\"" } }, null, 2),
		].join("\n");
		expect(helper.summarizeGovulncheck(raw)).toBe(
			"=== govulncheck ===\n  vulnerabilities: 2\n  GO-1\n  GO-2",
		);
	});

	test("bumpNodePackage keeps tab indentation", () => {
		const source = JSON.stringify({ dependencies: { lodash: "1.0.0" } }, null, "\t");
		inTempDir({ "package.json": source }, () => {
			helper.bumpNodePackage("lodash", "1.0.0", "2.0.0");
			expect(readFileSync("package.json", "utf8")).toBe(
				`${JSON.stringify({ dependencies: { lodash: "2.0.0" } }, null, "\t")}\n`,
			);
		});
	});

	test("bumpGemfile leaves git and option values alone", () => {
		const src = 'gem "rails", git: "https://example.com/rails.git"\ngem "rails"\n';
		expect(helper.bumpGemfile(src, "rails", "7.1.0")).toBe(src);
		expect(helper.bumpGemfile('gem "rails", "~> 7.0"\n', "rails", "7.1.0")).toBe(
			'gem "rails", "~> 7.1.0"\n',
		);
	});

	test("bumpPythonSource does not match a longer version", () => {
		const src = "requests==1.2.3\nrequests==1.2\n";
		expect(helper.bumpPythonSource(src, "requests", "1.2", "1.3")).toBe(
			"requests==1.2.3\nrequests==1.3\n",
		);
	});

	test("bumpActionRefs ignores an action with a longer owner", () => {
		const src = "uses: my-actions/checkout@v3\nuses: actions/checkout@v3\n";
		expect(helper.bumpActionRefs(src, "actions/checkout", "v3", "v4")).toBe(
			"uses: my-actions/checkout@v3\nuses: actions/checkout@v4\n",
		);
	});

	test("a backport published after the current release is not a fallback", async () => {
		const NOW = Date.parse("2026-10-16T00:00:00Z");
		const verdict = await helper.evaluateCooldown({
			eco: "npm",
			pkg: "left-pad",
			oldVersion: "2.0.0",
			version: "3.0.0",
			days: 7,
			now: () => NOW,
			fetchJson: async () => ({
				time: {
					"2.0.0": "2026-01-01T00:00:00Z",
					"1.9.9": "2026-02-01T00:00:00Z",
					"3.0.0": "2026-10-15T00:00:00Z",
				},
			}),
		});
		expect(verdict.status).toBe("held");
	});

	test("the branch prefix reads DG_DEPS_BRANCH_PREFIX", () => {
		const previous = process.env.DG_DEPS_BRANCH_PREFIX;
		try {
			delete process.env.DG_DEPS_BRANCH_PREFIX;
			expect(helper.branchPrefix()).toBe("chore/");
			process.env.DG_DEPS_BRANCH_PREFIX = "me/deps/";
			expect(helper.branchPrefix()).toBe("me/deps/");
		} finally {
			if (previous === undefined) delete process.env.DG_DEPS_BRANCH_PREFIX;
			else process.env.DG_DEPS_BRANCH_PREFIX = previous;
		}
	});

	test("ready-when-green rejects a zero polling interval", async () => {
		const result = await runCli(["ready-when-green", "1", "--interval-seconds", "0"]);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("--interval-seconds must be a number >= 1");
	});

	test("pr-body and close-prs reject a non-numeric number", async () => {
		const body = await runCli(["pr-body", "abc"]);
		expect(body.exitCode).toBe(1);
		expect(body.stderr).toContain("pull request number must be a positive integer");
		const close = await runCli(["close-prs", "12", "abc"], {
			cwd: gitRepo({ "a.txt": "a\n" }),
		});
		expect(close.exitCode).toBe(1);
		expect(close.stderr).toContain("pull request number must be a positive integer");
	});

	test("bump-action stages only the files it changed", async () => {
		const cwd = gitRepo({
			".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v3\n",
			".github/workflows/other.yml": "steps:\n  - uses: actions/cache@v3\n",
		});
		writeFileSync(join(cwd, ".github/workflows/other.yml"), "steps:\n  - uses: actions/cache@v2\n");
		const result = await runCli(
			[
				"bump-action",
				"actions/checkout",
				"v3",
				"v4",
				".github/workflows/ci.yml",
				".github/workflows/other.yml",
			],
			{ cwd },
		);
		expect(result.exitCode).toBe(0);
		expect(lastCommit(cwd).files).toEqual([".github/workflows/ci.yml"]);
	});

	test.each([
		["bump-dep", ["lodash", "1.0.0", "2.0.0"]],
		["bump-action", ["actions/checkout", "v3", "v4"]],
		["commit", ["chore", "deps", "message"]],
		["push-pr", []],
	])("%s refuses to run on the default branch", async (command, args) => {
		const cwd = gitRepo({
			"package.json": json({ dependencies: { lodash: "1.0.0" } }),
			"package-lock.json": "{}",
			".github/workflows/ci.yml": "steps:\n  - uses: actions/checkout@v3\n",
		});
		cliFixtures.runGit(["checkout", "-q", "main"], cwd);
		const result = await runCli([command, ...args], { cwd, stdin: "body" });
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("protected branch 'main'");
		expect(lastCommit(cwd).subject).toBe("chore: seed");
	});
});
