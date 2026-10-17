import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import {
	makeGitRepo as createGitRepo,
	makeGitRepoWithOrigin as createGitRepoWithOrigin,
} from "./git-repo-fixtures";

const CLI_TS = `${import.meta.dir}/../src/index.ts`;

cliFixtures.isolateCliTests();
const NONEXISTENT_BIN =
	"/nonexistent/definitely-missing-vcs-provider-cli-test-bin";

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

let createdDirs: string[] = [];

beforeEach(() => {
	createdDirs = [];
});

afterEach(() => {
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeGitRepo(): string {
	const dir = createGitRepo();
	createdDirs.push(dir);
	return dir;
}
function makeGitRepoWithOrigin(url: string): string {
	const dir = createGitRepoWithOrigin(url);
	createdDirs.push(dir);
	return dir;
}

function tmp(prefix: string): string {
	return cliFixtures.tmp(createdDirs, prefix);
}

function writeJson(name: string, data: unknown): string {
	return cliFixtures.writeJson(
		createdDirs,
		"vcs-provider-cli-fixture-",
		name,
		data,
	);
}

function baseEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	delete env.AI_VCS_PROVIDER;
	delete env.AI_VCS_GITLAB_HOSTS;
	delete env.GH_BIN;
	delete env.GLAB_BIN;
	return env;
}

function runCli(
	args: string[],
	opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
): RunResult {
	const proc = Bun.spawnSync(
		[process.execPath, "run", CLI_TS, "vcs-provider", ...args],
		{
			cwd: opts.cwd,
			env: { ...baseEnv(), ...opts.env },
		},
	);
	return {
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
		exitCode: proc.exitCode,
	};
}

function fakeBin(binName: string, script: string): string {
	const dir = tmp(`fake-${binName}-bin-`);
	writeFakeCli(dir, binName, script, { scope: "test" });
	return join(dir, binName);
}

const shScript = cliFixtures.shScript;

function callLogPath(): { path: string; env: Record<string, string> } {
	const path = cliFixtures.callLogPath(createdDirs, "vcs-provider-cli-log-");
	return { path, env: { FAKE_CALL_LOG: path } };
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

function ghRepoViewJson(owner: string, repo: string): unknown {
	return {
		owner: { login: owner },
		name: repo,
		defaultBranchRef: { name: "main" },
		url: `https://github.com/${owner}/${repo}`,
	};
}

function glabRepoViewJson(owner: string, repo: string, host: string): unknown {
	return {
		path_with_namespace: `${owner}/${repo}`,
		namespace: { full_path: owner },
		path: repo,
		name: repo,
		default_branch: "main",
		web_url: `https://${host}/${owner}/${repo}`,
	};
}

function ghIssue(
	number: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		number,
		title: `Issue #${number}`,
		url: `https://github.com/acme/widgets/issues/${number}`,
		state: "OPEN",
		body: `body of issue ${number}`,
		labels: [{ name: "bug" }],
		createdAt: "2026-08-28T00:00:00Z",
		comments: [{ id: "one" }],
		...overrides,
	};
}

function glIssue(
	iid: number,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		iid,
		title: `Issue #${iid}`,
		web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
		state: "opened",
		description: `body of issue ${iid}`,
		labels: ["bug"],
		created_at: "2026-08-28T00:00:00Z",
		user_notes_count: 2,
		...overrides,
	};
}

function expectFullyResolved(
	json: Record<string, unknown>,
	expected: { kind: string; owner: string; repo: string; url: string },
): void {
	expect(json.resolved).toBe(true);
	expect(json.kind).toBe(expected.kind);
	expect(json.owner).toBe(expected.owner);
	expect(json.repo).toBe(expected.repo);
	expect(json.url).toBe(expected.url);
}

function expectKindOnlyDegrade(
	json: Record<string, unknown>,
	kind: string,
): void {
	expect(json.resolved).toBe(true);
	expect(json.kind).toBe(kind);
	expect(json.owner).toBeNull();
	expect(json.repo).toBeNull();
	expect(json.url).toBeNull();
	expect(typeof json.reason).toBe("string");
	expect((json.reason as string).length).toBeGreaterThan(0);
}

function expectUnresolved(json: Record<string, unknown>): void {
	expect(json.resolved).toBe(false);
	expect(json.kind).toBeNull();
	expect(json.owner).toBeNull();
	expect(json.repo).toBeNull();
	expect(json.url).toBeNull();
	expect(typeof json.reason).toBe("string");
	expect((json.reason as string).length).toBeGreaterThan(0);
}

describe("vcs-provider-cli detect — kind resolution is independent of any provider binary", () => {
	test("resolves kind from the git remote alone when gh is unreachable", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GH_BIN: NONEXISTENT_BIN },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json.kind).toBe("github");
	});

	test("resolves kind from the git remote alone when glab is unreachable", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GLAB_BIN: NONEXISTENT_BIN },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json.kind).toBe("gitlab");
	});
});

describe("vcs-provider-cli detect — owner/repo/url degrade instead of crashing when the binary is absent", () => {
	test("a missing gh binary: resolved stays true, kind stays populated, owner/repo/url become null, reason is set", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { stdout, stderr, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GH_BIN: NONEXISTENT_BIN },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectKindOnlyDegrade(json, "github");
		expect(stderr).not.toMatch(/ENOENT/i);
	});

	test("a missing glab binary: resolved stays true, kind stays populated, owner/repo/url become null, reason is set", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { stdout, stderr, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GLAB_BIN: NONEXISTENT_BIN },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectKindOnlyDegrade(json, "gitlab");
		expect(stderr).not.toMatch(/ENOENT/i);
	});
});

describe("vcs-provider-cli detect — repo view fails even though the binary is present", () => {
	test("degrades the same way as a missing binary rather than crashing on the CLI's own failure", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    echo "gh: authentication required" >&2
    exit 1
    ;;`),
		);

		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectKindOnlyDegrade(json, "github");
	});

	test("degrades the same way when gh exits 0 but repo view's stdout is not parseable JSON", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    echo "not json"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectKindOnlyDegrade(json, "github");
	});
});

describe("vcs-provider-cli detect — given a GitHub repo with gh reachable", () => {
	test("prints all five keys fully populated as JSON with exit 0, url synthesized as https://<host>/<owner>/<repo>", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat <<'JSON'
${JSON.stringify(ghRepoViewJson("acme", "widgets"))}
JSON
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectFullyResolved(json, {
			kind: "github",
			owner: "acme",
			repo: "widgets",
			url: "https://github.com/acme/widgets",
		});
	});

	test("--json is a no-op — output is identical with or without the flag", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat <<'JSON'
${JSON.stringify(ghRepoViewJson("acme", "widgets"))}
JSON
    exit 0
    ;;`),
		);

		const plain = runCli(["detect"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});
		const withFlag = runCli(["detect", "--json"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(withFlag.exitCode).toBe(0);
		expect(withFlag.stdout).toBe(plain.stdout);
	});
});

describe("vcs-provider-cli detect — given a self-hosted GitLab repo with glab reachable", () => {
	test("synthesizes url from RepoInfo.host, not a github.com/gitlab.com literal", async () => {
		const repo = makeGitRepoWithOrigin(
			"https://git.example.internal/acme/widgets.git",
		);
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"repo view"*)
    cat <<'JSON'
${JSON.stringify(glabRepoViewJson("acme", "widgets", "git.example.internal"))}
JSON
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, AI_VCS_GITLAB_HOSTS: "git.example.internal" },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectFullyResolved(json, {
			kind: "gitlab",
			owner: "acme",
			repo: "widgets",
			url: "https://git.example.internal/acme/widgets",
		});
	});
});

describe("vcs-provider-cli detect — given an unresolvable provider", () => {
	test("a host not in the recognized set still exits 0 and reports the failure with all five keys, kind included, null", async () => {
		const repo = makeGitRepoWithOrigin(
			"https://example-vcs.internal/acme/widgets.git",
		);
		const { stdout, exitCode } = runCli(["detect"], { cwd: repo });

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectUnresolved(json);
	});

	test("no origin remote configured still exits 0 and reports the failure with all five keys, kind included, null", async () => {
		const repo = makeGitRepo();
		const { stdout, exitCode } = runCli(["detect"], { cwd: repo });

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectUnresolved(json);
	});

	test("no git repository at all still exits 0 and reports the failure with all five keys, kind included, null", async () => {
		const dir = tmp("no-git-repo-");
		const { stdout, exitCode } = runCli(["detect"], { cwd: dir });

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectUnresolved(json);
	});

	test("an invalid AI_VCS_PROVIDER value still exits 0 and reports the failure with all five keys, kind included, null", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["detect"], {
			cwd: repo,
			env: { AI_VCS_PROVIDER: "bitbucket" },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expectUnresolved(json);
	});
});

describe("vcs-provider-cli capabilities — reflects the calling repo's actual detected provider", () => {
	test("a GitHub-origin repo prints {kind, aiReviewBot, aiReviewBotNames, nativeStacking} verbatim, no wrapper", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["capabilities"], { cwd: repo });

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json).toEqual({
			kind: "github",
			aiReviewBot: true,
			aiReviewBotNames: ["copilot"],
			nativeStacking: true,
		});
	});

	test("a GitLab-origin repo prints {kind, aiReviewBot, aiReviewBotNames, nativeStacking} verbatim, no wrapper", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["capabilities"], { cwd: repo });

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json).toEqual({
			kind: "gitlab",
			aiReviewBot: false,
			aiReviewBotNames: [],
			nativeStacking: false,
		});
	});
});

describe("vcs-provider-cli capabilities — the GitLab AI reviewer is configurable", () => {
	test("AI_VCS_GITLAB_REVIEW_BOT names the reviewer the review loop should consume", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["capabilities"], {
			cwd: repo,
			env: { AI_VCS_GITLAB_REVIEW_BOT: "some_other_bot,gitlab_duo" },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			kind: "gitlab",
			aiReviewBot: true,
			aiReviewBotNames: ["some_other_bot", "gitlab_duo"],
			nativeStacking: false,
		});
	});

	test("AI_VCS_GITLAB_REVIEW_BOT=none reports no reviewer, which is what routes the loop to proxy mode", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["capabilities"], {
			cwd: repo,
			env: { AI_VCS_GITLAB_REVIEW_BOT: "none" },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			kind: "gitlab",
			aiReviewBot: false,
			aiReviewBotNames: [],
			nativeStacking: false,
		});
	});
});

describe("vcs-provider-cli capabilities — requires no CLI binary", () => {
	test("never shells out to gh or glab even when both are present and logging", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const ghBin = fakeBin("gh", shScript(""));
		const glabBin = fakeBin("glab", shScript(""));

		const { stdout, exitCode } = runCli(["capabilities"], {
			cwd: repo,
			env: { GH_BIN: ghBin, GLAB_BIN: glabBin, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			kind: "github",
			aiReviewBot: true,
			aiReviewBotNames: ["copilot"],
			nativeStacking: true,
		});
		expect(readCalls(log)).toEqual([]);
	});

	test("never shells out to gh or glab for a GitLab-origin repo either", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const ghBin = fakeBin("gh", shScript(""));
		const glabBin = fakeBin("glab", shScript(""));

		const { stdout, exitCode } = runCli(["capabilities"], {
			cwd: repo,
			env: { GH_BIN: ghBin, GLAB_BIN: glabBin, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			kind: "gitlab",
			aiReviewBot: false,
			aiReviewBotNames: [],
			nativeStacking: false,
		});
		expect(readCalls(log)).toEqual([]);
	});

	test("still resolves capabilities correctly when both binaries are entirely absent from the filesystem", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { stdout, exitCode } = runCli(["capabilities"], {
			cwd: repo,
			env: { GH_BIN: NONEXISTENT_BIN, GLAB_BIN: NONEXISTENT_BIN },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual({
			kind: "gitlab",
			aiReviewBot: false,
			aiReviewBotNames: [],
			nativeStacking: false,
		});
	});
});

describe("vcs-provider-cli capabilities — given an unresolvable provider", () => {
	test("fails loud through defineCommand's error path — exit 1 with the reason on stderr, unlike detect", async () => {
		const repo = makeGitRepo();
		const { stdout, stderr, exitCode } = runCli(["capabilities"], {
			cwd: repo,
		});

		expect(exitCode).toBe(1);
		expect(stderr.length).toBeGreaterThan(0);
		expect(stdout.trim()).toBe("");
	});
});

describe("vcs-provider-cli list-prs", () => {
	test("prints the provider's normalized PullRequest[] as a bare JSON array", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const all = [
			cliFixtures.restPr(21, "feature-a", { state: "open", merged_at: null }),
			cliFixtures.restPr(22, "feature-b", {
				state: "closed",
				merged_at: "2026-03-01T00:00:00Z",
			}),
		];
		const allJsonPath = writeJson("list-prs-all.json", all);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list-prs"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ALL_JSON: allJsonPath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(Array.isArray(json)).toBe(true);
		expect(json).toHaveLength(2);
		const pr21 = json.find((p: { number: number }) => p.number === 21);
		const pr22 = json.find((p: { number: number }) => p.number === 22);
		expect(pr21).toMatchObject({
			state: "OPEN",
			merged: false,
			headRefName: "feature-a",
		});
		expect(pr22).toMatchObject({
			state: "MERGED",
			merged: true,
			mergedAt: "2026-03-01T00:00:00Z",
			headRefName: "feature-b",
		});
		const calledPaths = readCalls(log).join("\n");
		expect(calledPaths).toContain("repos/{owner}/{repo}/pulls");
		expect(calledPaths).toContain("per_page=100");
	});

	test("an empty result set prints a bare [] rather than null or a wrapper", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const allJsonPath = writeJson("list-prs-empty.json", []);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list-prs"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ALL_JSON: allJsonPath },
		});

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("[]");
	});
});

describe("vcs-provider-cli list-prs — against a GitLab-origin repo", () => {
	test("maps glab's mr list output onto the same normalized PullRequest[] shape, proving the CLI has no GitHub-only assumption", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const all = [
			cliFixtures.glMr(21, "feature-a", { state: "opened", merged_at: null }),
			cliFixtures.glMr(22, "feature-b", {
				state: "merged",
				merged_at: "2026-03-01T00:00:00Z",
			}),
		];
		const allJsonPath = writeJson("gitlab-list-prs-all.json", all);
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"mr list"*"--all"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list-prs"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ALL_JSON: allJsonPath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(Array.isArray(json)).toBe(true);
		expect(json).toHaveLength(2);
		const mr21 = json.find((p: { number: number }) => p.number === 21);
		const mr22 = json.find((p: { number: number }) => p.number === 22);
		expect(mr21).toMatchObject({
			state: "OPEN",
			merged: false,
			headRefName: "feature-a",
		});
		expect(mr22).toMatchObject({
			state: "MERGED",
			merged: true,
			mergedAt: "2026-03-01T00:00:00Z",
			headRefName: "feature-b",
		});
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("mr list");
		expect(calls).toContain("--all");
	});
});

test("vcs-provider-cli list-issues preserves GitHub support through the same normalized contract", () => {
	const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
	const issuesPath = writeJson("github-list-issues.json", [ghIssue(31)]);
	const ghBin = fakeBin(
		"gh",
		shScript(`
  *"issue list"*)
    cat "$FAKE_ISSUES_JSON"
    exit 0
    ;;`),
	);

	const { stdout, exitCode } = runCli(["list-issues", "--limit", "20"], {
		cwd: repo,
		env: { GH_BIN: ghBin, FAKE_ISSUES_JSON: issuesPath },
	});

	expect(exitCode).toBe(0);
	expect(JSON.parse(stdout.trim())).toEqual([
		expect.objectContaining({
			number: 31,
			state: "OPEN",
			labels: ["bug"],
			commentCount: 1,
		}),
	]);
});

describe("vcs-provider-cli issue commands — against a GitLab-origin repo", () => {
	test("list-issues normalizes glab output and honors --limit", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuesPath = writeJson("gitlab-list-issues.json", [
			glIssue(41),
			glIssue(42),
		]);
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue list"*)
    cat "$FAKE_ISSUES_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list-issues", "--limit", "1"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUES_JSON: issuesPath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toEqual([
			expect.objectContaining({
				number: 41,
				state: "OPEN",
				labels: ["bug"],
				commentCount: 2,
			}),
		]);
		expect(readCalls(log).join("\n")).toContain("issue list");
	});

	test("view-issue returns the same normalized issue shape", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const issuePath = writeJson("gitlab-view-issue.json", glIssue(42));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue view 42"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["view-issue", "42"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({
			number: 42,
			body: "body of issue 42",
			state: "OPEN",
		});
	});

	test("create-pr delegates draft MR creation to glab and prints the normalized MR", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const mrPath = writeJson("gitlab-created-mr.json", cliFixtures.glMr(77, "feature/fix"));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"mr create"*)
    printf '%s\n' 'https://gitlab.com/acme/widgets/-/merge_requests/77'
    exit 0
    ;;
  *"mr view 77"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			[
				"create-pr",
				"--draft",
				"--title",
				"Fix widget",
				"--base",
				"main",
				"--head",
				"feature/fix",
				"--body",
				"Body",
			],
			{
				cwd: repo,
				env: { GLAB_BIN: glabBin, FAKE_MR_JSON: mrPath, ...logEnv },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({
			number: 77,
			headRefName: "feature/fix",
		});
		expect(readCalls(log).join("\n")).toContain("mr create --draft");
	});
});

describe("vcs-provider-cli list-prs — given an unresolvable provider", () => {
	test("fails loud through defineCommand's error path — exit 1 with the reason on stderr, unlike detect's degrade", async () => {
		const repo = makeGitRepo();
		const { stdout, stderr, exitCode } = runCli(["list-prs"], {
			cwd: repo,
		});

		expect(exitCode).toBe(1);
		expect(stderr.length).toBeGreaterThan(0);
		expect(stdout.trim()).toBe("");
	});
});

describe("vcs-provider-cli list-prs — the underlying provider call itself fails", () => {
	test("propagates a real gh failure as a non-zero exit rather than swallowing it into an empty array", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repos/{owner}/{repo}/pulls"*)
    echo "gh: authentication required" >&2
    exit 1
    ;;`),
		);

		const { stdout, stderr, exitCode } = runCli(["list-prs"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(1);
		expect(stderr.length).toBeGreaterThan(0);
		expect(stdout.trim()).toBe("");
	});
});

describe("vcs-provider-cli merged-pr-for-branch <branch>", () => {
	test("returns the merged PullRequest for that branch, filtered server-side by head", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const repoJsonPath = writeJson(
			"merged-repo.json",
			ghRepoViewJson("acme", "widgets"),
		);
		const all = [
			cliFixtures.restPr(31, "feature-x", { state: "open", merged_at: null }),
			cliFixtures.restPr(32, "feature-x", {
				state: "closed",
				merged_at: "2026-02-01T00:00:00Z",
			}),
		];
		const allJsonPath = writeJson("merged-branch-all.json", all);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			["merged-pr-for-branch", "feature-x"],
			{
				cwd: repo,
				env: {
					GH_BIN: ghBin,
					FAKE_REPO_JSON: repoJsonPath,
					FAKE_ALL_JSON: allJsonPath,
					...logEnv,
				},
			},
		);

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json).toMatchObject({
			number: 32,
			merged: true,
			mergedAt: "2026-02-01T00:00:00Z",
			headRefName: "feature-x",
		});
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("head=acme:feature-x");
		expect(calls).toContain("state=all");
	});

	test("returns the first matching merged PullRequest when more than one is returned for the same branch", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const repoJsonPath = writeJson(
			"merged-multi-repo.json",
			ghRepoViewJson("acme", "widgets"),
		);
		const all = [
			cliFixtures.restPr(60, "feature-multi", {
				state: "closed",
				merged_at: "2026-01-01T00:00:00Z",
			}),
			cliFixtures.restPr(61, "feature-multi", {
				state: "closed",
				merged_at: "2026-02-01T00:00:00Z",
			}),
		];
		const allJsonPath = writeJson("merged-multi-all.json", all);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			["merged-pr-for-branch", "feature-multi"],
			{
				cwd: repo,
				env: {
					GH_BIN: ghBin,
					FAKE_REPO_JSON: repoJsonPath,
					FAKE_ALL_JSON: allJsonPath,
				},
			},
		);

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json.number).toBe(60);
	});

	test("returns null when no merged pull request exists for that branch", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const repoJsonPath = writeJson(
			"merged-repo-empty.json",
			ghRepoViewJson("acme", "widgets"),
		);
		const allJsonPath = writeJson("merged-branch-empty.json", [
			cliFixtures.restPr(41, "feature-y", { state: "open", merged_at: null }),
		]);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			["merged-pr-for-branch", "feature-y"],
			{
				cwd: repo,
				env: {
					GH_BIN: ghBin,
					FAKE_REPO_JSON: repoJsonPath,
					FAKE_ALL_JSON: allJsonPath,
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("null");
	});

	test("a missing branch argument fails rather than silently querying an undefined branch", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { exitCode } = runCli(["merged-pr-for-branch"], { cwd: repo });

		expect(exitCode).not.toBe(0);
	});
});

describe("vcs-provider-cli merged-pr-for-branch — against a GitLab-origin repo", () => {
	test("filters via glab's --merged --source-branch flags with no repo-view call needed, unlike the GitHub path", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const all = [
			cliFixtures.glMr(70, "feature-multi", {
				state: "merged",
				merged_at: "2026-01-01T00:00:00Z",
			}),
		];
		const allJsonPath = writeJson("gitlab-merged-branch-all.json", all);
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"mr list"*"--merged"*"--source-branch feature-multi"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			["merged-pr-for-branch", "feature-multi"],
			{
				cwd: repo,
				env: { GLAB_BIN: glabBin, FAKE_ALL_JSON: allJsonPath, ...logEnv },
			},
		);

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json).toMatchObject({
			number: 70,
			merged: true,
			mergedAt: "2026-01-01T00:00:00Z",
			headRefName: "feature-multi",
		});
		expect(readCalls(log).join("\n")).not.toContain("repo view");
	});
});

describe("vcs-provider-cli merged-pr-for-branch — given an unresolvable provider", () => {
	test("fails loud rather than printing the JSON literal null, so a caller can tell 'unknown' from 'not merged'", async () => {
		const repo = makeGitRepo();
		const { stdout, stderr, exitCode } = runCli(
			["merged-pr-for-branch", "feature-x"],
			{ cwd: repo },
		);

		expect(exitCode).toBe(1);
		expect(stderr.length).toBeGreaterThan(0);
		expect(stdout.trim()).toBe("");
	});
});

describe("vcs-provider-cli merged-pr-for-branch — the underlying provider call itself fails", () => {
	test("propagates a real gh failure as a non-zero exit rather than printing the JSON literal null", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const repoJsonPath = writeJson(
			"merged-fail-repo.json",
			ghRepoViewJson("acme", "widgets"),
		);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    echo "gh: authentication required" >&2
    exit 1
    ;;`),
		);

		const { stdout, stderr, exitCode } = runCli(
			["merged-pr-for-branch", "feature-x"],
			{
				cwd: repo,
				env: { GH_BIN: ghBin, FAKE_REPO_JSON: repoJsonPath },
			},
		);

		expect(exitCode).toBe(1);
		expect(stderr.length).toBeGreaterThan(0);
		expect(stdout.trim()).toBe("");
	});
});

describe("vcs-provider-cli auth", () => {
	test("exits 0 and prints nothing when the provider's CLI is authenticated", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"auth status"*)
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["auth"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("");
	});

	test("exits non-zero when the provider's CLI is logged out, so it drops into an if the way gh auth status did", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"auth status"*)
    echo "not logged in" >&2
    exit 1
    ;;`),
		);

		const { stdout, stderr, exitCode } = runCli(["auth"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toBe("");
	});

	test("reports the GitLab CLI's auth state through the same exit-code contract", async () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"auth status"*)
    exit 0
    ;;`),
		);

		const { exitCode } = runCli(["auth"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
	});

	test("exits non-zero when no provider resolves at all, rather than reporting authenticated", async () => {
		const repo = makeGitRepo();

		const { exitCode } = runCli(["auth"], {
			cwd: repo,
			env: { GH_BIN: NONEXISTENT_BIN },
		});

		expect(exitCode).not.toBe(0);
	});
});

describe("vcs-provider-cli list-prs --limit", () => {
	test("caps the returned array at the requested count", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const all = [
			cliFixtures.restPr(1, "a"),
			cliFixtures.restPr(2, "b"),
			cliFixtures.restPr(3, "c"),
			cliFixtures.restPr(4, "d"),
		];
		const allJsonPath = writeJson("limit-all.json", all);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list-prs", "--limit", "2"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ALL_JSON: allJsonPath },
		});

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json).toHaveLength(2);
		expect(json.map((p: { number: number }) => p.number)).toEqual([1, 2]);
	});

	test("returns the whole list when no limit is given", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const allJsonPath = writeJson("nolimit-all.json", [
			cliFixtures.restPr(1, "a"),
			cliFixtures.restPr(2, "b"),
			cliFixtures.restPr(3, "c"),
		]);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout } = runCli(["list-prs"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ALL_JSON: allJsonPath },
		});

		expect(JSON.parse(stdout.trim())).toHaveLength(3);
	});

	test("rejects a non-numeric limit loudly instead of silently ignoring it", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin("gh", shScript(""));

		const { exitCode, stderr } = runCli(["list-prs", "--limit", "many"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("--limit");
	});
});

describe("vcs-provider-cli list-prs --head", () => {
	test("pushes the branch filter down to the provider call instead of fetching every PR and filtering after", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const allJsonPath = writeJson("head-all.json", [cliFixtures.restPr(7, "feature/auth")]);
		const log = callLogPath();
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat <<'JSON'
${JSON.stringify(ghRepoViewJson("acme", "widgets"))}
JSON
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			["list-prs", "--head", "feature/auth"],
			{
				cwd: repo,
				env: { GH_BIN: ghBin, FAKE_ALL_JSON: allJsonPath, ...log.env },
			},
		);

		expect(exitCode).toBe(0);
		const json = JSON.parse(stdout.trim());
		expect(json).toHaveLength(1);
		expect(json[0].headRefName).toBe("feature/auth");
		expect(readCalls(log.path).join("\n")).toContain("head=acme:feature/auth");
	});

	test("composes with --limit rather than one flag shadowing the other", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const allJsonPath = writeJson("head-limit-all.json", [
			cliFixtures.restPr(7, "feature/auth"),
			cliFixtures.restPr(8, "feature/auth"),
		]);
		const log = callLogPath();
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"repo view"*)
    cat <<'JSON'
${JSON.stringify(ghRepoViewJson("acme", "widgets"))}
JSON
    exit 0
    ;;
  *"repos/{owner}/{repo}/pulls"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			["list-prs", "--head", "feature/auth", "--limit", "1"],
			{
				cwd: repo,
				env: { GH_BIN: ghBin, FAKE_ALL_JSON: allJsonPath, ...log.env },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toHaveLength(1);
		expect(readCalls(log.path).join("\n")).toContain("head=acme:feature/auth");
	});

	test("rejects a valueless --head loudly instead of silently listing every PR", async () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin("gh", shScript(""));

		const { exitCode, stderr } = runCli(["list-prs", "--head"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("--head");
	});
});

describe("vcs-provider view-pr and list-threads", () => {
	for (const kind of ["github", "gitlab"] as const) {
		test(`${kind} view-pr returns the normalized request for the explicit number`, () => {
			const repo = makeGitRepoWithOrigin(
				`https://${kind}.com/acme/widgets.git`,
			);
			const raw =
				kind === "github"
					? {
							number: 83,
							title: "PR 83",
							url: "https://github.com/acme/widgets/pull/83",
							state: "OPEN",
							headRefName: "feature/view",
							baseRefName: "main",
							body: "body",
							mergedAt: null,
						}
					: cliFixtures.glMr(83, "feature/view");
			const fixture = writeJson("view-pr.json", raw);
			const { path: log, env } = callLogPath();
			const bin = fakeBin(
				kind === "github" ? "gh" : "glab",
				shScript(`
  *"${kind === "github" ? "pr" : "mr"} view 83"*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
			);
			const result = runCli(["view-pr", "83"], {
				cwd: repo,
				env: {
					...env,
					[kind === "github" ? "GH_BIN" : "GLAB_BIN"]: bin,
					FAKE_PR_JSON: fixture,
				},
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toMatchObject({
				number: 83,
				state: "OPEN",
				merged: false,
				headRefName: "feature/view",
			});
			expect(readCalls(log).join("\n")).toContain(
				`${kind === "github" ? "pr" : "mr"} view 83`,
			);
		});

		test(`${kind} list-threads returns unresolved normalized threads for the explicit request`, () => {
			const repo = makeGitRepoWithOrigin(
				`https://${kind}.com/acme/widgets.git`,
			);
			const raw =
				kind === "github"
					? {
							data: {
								repository: {
									pullRequest: {
										reviewThreads: {
											nodes: [false, true].map((resolved) => ({
												id: resolved ? "closed" : "open",
												isResolved: resolved,
												comments: {
													nodes: [
														{
															databaseId: 91,
															author: { login: "reviewer" },
															body: "fix",
															createdAt: "2026-01-01T00:00:00Z",
														},
													],
												},
											})),
											pageInfo: { hasNextPage: false, endCursor: null },
										},
									},
								},
							},
						}
					: [false, true].map((resolved) => ({
							id: resolved ? "closed" : "open",
							individual_note: false,
							notes: [
								{
									id: 91,
									author: { username: "reviewer" },
									body: "fix",
									created_at: "2026-01-01T00:00:00Z",
									resolvable: true,
									resolved,
								},
							],
						}));
			const fixture = writeJson("threads.json", raw);
			const { path: log, env } = callLogPath();
			const bin = fakeBin(
				kind === "github" ? "gh" : "glab",
				shScript(`
  *${kind === "github" ? "graphql" : '"merge_requests/83/discussions"'}*)
    cat "$FAKE_THREADS_JSON"
    exit 0
    ;;`),
			);
			const result = runCli(["list-threads", "83"], {
				cwd: repo,
				env: {
					...env,
					[kind === "github" ? "GH_BIN" : "GLAB_BIN"]: bin,
					FAKE_THREADS_JSON: fixture,
				},
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			const threads = JSON.parse(result.stdout);
			expect(threads).toHaveLength(1);
			expect(threads[0]).toMatchObject({
				threadId: "open",
				resolved: false,
				commentId: "91",
				comments: [
					expect.objectContaining({
						id: "91",
						author: "reviewer",
						body: "fix",
					}),
				],
			});
			expect(readCalls(log).join("\n")).toContain(
				kind === "github" ? "number=83" : "merge_requests/83/discussions",
			);
		});
	}
	for (const command of ["view-issue", "view-pr", "list-threads"]) {
		for (const number of [undefined, "0", "-1", "1.5", "many"]) {
			test(`${command} rejects invalid request number ${number ?? "<missing>"} without invoking a provider CLI`, () => {
				const repo = makeGitRepoWithOrigin(
					"https://github.com/acme/widgets.git",
				);
				const { path: log, env } = callLogPath();
				const gh = fakeBin("gh", shScript(""));
				const result = runCli(
					[command, ...(number === undefined ? [] : [number])],
					{ cwd: repo, env: { ...env, GH_BIN: gh } },
				);
				expect(result.exitCode).toBe(1);
				expect(result.stdout).toBe("");
				expect(result.stderr).toContain("positive issue/PR number");
				expect(readCalls(log)).toEqual([]);
			});
		}
	}
});

describe("vcs-provider import isolation", () => {
	test("importing registration and domain helpers does not dispatch argv or invoke tools", () => {
		const external = tmp("vcs-provider-import-");
		const log = callLogPath();
		for (const tool of ["git", "gh", "glab"])
			fakeBin(tool, shScript("  *) exit 99 ;;"));
		const scratch = join(external, "absent-scratch");
		const state = join(external, "absent-state");
		const script = `await import(${JSON.stringify(`${import.meta.dir}/../src/commands/vcs-provider.ts`)}); await import(${JSON.stringify(`${import.meta.dir}/../src/vcs-provider/index.ts`)}); process.stdout.write("imported\\n");`;
		const proc = Bun.spawnSync(
			[process.execPath, "--eval", script, "--", "vcs-provider", "detect"],
			{
				cwd: external,
				env: {
					...baseEnv(),
					...log.env,
					AI_SCRATCH_DIR: scratch,
					AI_STATE_DIR: state,
				},
			},
		);
		expect(proc.exitCode, proc.stderr.toString()).toBe(0);
		expect(proc.stdout.toString()).toBe("imported\n");
		expect(proc.stderr.toString()).toBe("");
		expect(readCalls(log.path)).toEqual([]);
		expect(existsSync(scratch)).toBe(false);
		expect(existsSync(state)).toBe(false);
	});
});

describe("compiled vcs-provider", () => {
	test("runs both adapters after relocation with isolated tools, preserving stdin, queries and quiet degradation", () => {
		const buildDir = tmp("vcs-provider-build-");
		const originalBinary = join(buildDir, "dg-skills");
		const build = Bun.spawnSync([
			process.execPath,
			`${import.meta.dir}/../build.ts`,
			"--outfile",
			originalBinary,
		]);
		expect(build.exitCode, build.stderr.toString()).toBe(0);
		const binary = join(tmp("vcs-provider-relocated-"), "dg-skills");
		renameSync(originalBinary, binary);
		rmSync(buildDir, { recursive: true, force: true });
		const external = tmp("vcs-provider-external-");
		const run = (
			args: string[],
			cwd: string,
			env: Record<string, string | undefined> = {},
		): RunResult => {
			const proc = Bun.spawnSync([binary, "vcs-provider", ...args], {
				cwd,
				env: { ...baseEnv(), ...env },
			});
			return {
				stdout: proc.stdout.toString(),
				stderr: proc.stderr.toString(),
				exitCode: proc.exitCode,
			};
		};
		const title = "A title with spaces; $(touch should-not-exist) `literal`";
		const body =
			"A quoted 'body' with $variables and `backticks`\nsecond line 🦊\n";
		for (const kind of ["github", "gitlab"] as const) {
			const isGithub = kind === "github";
			const repo = makeGitRepoWithOrigin(
				`https://${kind}.com/acme/widgets.git`,
			);
			const verb = isGithub ? "pr" : "mr";
			const url = `https://${kind}.com/acme/widgets/${isGithub ? "pull" : "-/merge_requests"}/83`;
			const raw = isGithub
				? {
						number: 83,
						title,
						url,
						state: "OPEN",
						headRefName: "feature/compiled",
						baseRefName: "main",
						body,
						mergedAt: null,
					}
				: cliFixtures.glMr(83, "feature/compiled", { title, description: body });
			const prFixture = writeJson("compiled-pr.json", raw);
			const repoFixture = writeJson(
				"compiled-repo.json",
				isGithub
					? ghRepoViewJson("acme", "widgets")
					: glabRepoViewJson("acme", "widgets", "gitlab.com"),
			);
			const threadsFixture = writeJson(
				"compiled-threads.json",
				isGithub
					? {
							data: {
								repository: {
									pullRequest: {
										reviewThreads: {
											nodes: [],
											pageInfo: { hasNextPage: false, endCursor: null },
										},
									},
								},
							},
						}
					: [],
			);
			const capture = tmp("vcs-provider-capture-");
			const argvPath = join(capture, "argv");
			const stdinPath = join(capture, "stdin");
			const log = callLogPath();
			fakeBin(
				isGithub ? "gh" : "glab",
				shScript(`
  "auth status")
    printf 'provider diagnostic\\n'
    printf 'provider diagnostic\\n' >&2
    exit "\${FAKE_AUTH_STATUS:-0}"
    ;;
  "repo view "*) cat "$FAKE_REPO_JSON" ;;
  "${verb} create "*)
    printf '%s\\0' "$@" > "$FAKE_ARGV"
    ${isGithub ? 'cat > "$FAKE_STDIN"' : ":"}
    printf '%s\\n' "$FAKE_CREATED_URL"
    ;;
  "${verb} view 83 "*) cat "$FAKE_PR_JSON" ;;
  ${isGithub ? '"api graphql "*' : '"api projects/"*"/merge_requests/83/discussions "*'}) cat "$FAKE_THREADS_JSON" ;;
  *) exit 99 ;;
`),
			);
			const env = {
				...log.env,
				FAKE_REPO_JSON: repoFixture,
				FAKE_PR_JSON: prFixture,
				FAKE_THREADS_JSON: threadsFixture,
				FAKE_ARGV: argvPath,
				FAKE_STDIN: stdinPath,
				FAKE_CREATED_URL: url,
			};
			const detect = run(["detect"], repo, env);
			expect(detect.exitCode, detect.stderr).toBe(0);
			expect(detect.stderr).toBe("");
			expectFullyResolved(JSON.parse(detect.stdout), {
				kind,
				owner: "acme",
				repo: "widgets",
				url: `https://${kind}.com/acme/widgets`,
			});
			for (const status of [0, 1]) {
				expect(
					run(["auth"], repo, { ...env, FAKE_AUTH_STATUS: String(status) }),
				).toEqual({ exitCode: status, stdout: "", stderr: "" });
			}
			const created = run(
				[
					"create-pr",
					"--title",
					title,
					"--base",
					"main",
					"--head",
					"feature/compiled",
					"--body",
					body,
					"--draft",
				],
				repo,
				env,
			);
			expect(created.exitCode, created.stderr).toBe(0);
			expect(created.stderr).toBe("");
			expect(JSON.parse(created.stdout)).toMatchObject({
				number: 83,
				title,
				body,
				headRefName: "feature/compiled",
				merged: false,
			});
			const argv = readFileSync(argvPath, "utf8").split("\0").slice(0, -1);
			expect(argv).toContain("--draft");
			expect(argv[argv.indexOf("--title") + 1]).toBe(title);
			if (isGithub) {
				expect(argv[argv.indexOf("--body-file") + 1]).toBe("-");
				expect(readFileSync(stdinPath, "utf8")).toBe(body);
			} else {
				expect(argv).toContain(`--description=${body}`);
			}
			expect(run(["list-threads", "83"], repo, env)).toEqual({
				exitCode: 0,
				stdout: "[]\n",
				stderr: "",
			});
			const calls = readCalls(log.path).join("\n");
			expect(calls).toContain(
				isGithub ? "query=query(" : "/merge_requests/83/discussions --paginate",
			);
			expect(existsSync(join(repo, "should-not-exist"))).toBe(false);
			const missing = run(["detect"], repo, {
				[isGithub ? "GH_BIN" : "GLAB_BIN"]: NONEXISTENT_BIN,
			});
			expect(missing.exitCode).toBe(0);
			expect(missing.stderr).toBe("");
			expectKindOnlyDegrade(JSON.parse(missing.stdout), kind);
		}
		const unresolved = run(["detect"], external);
		expect(unresolved.exitCode).toBe(0);
		expect(unresolved.stderr).toBe("");
		expectUnresolved(JSON.parse(unresolved.stdout));
	}, 30_000);
});
