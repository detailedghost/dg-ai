import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { scratchFixtures } from "./git-repo-fixtures";

const CLI_TS = join(import.meta.dir, "../src/index.ts");
const BUN_BIN = process.execPath;
cliFixtures.isolateCliTests();
const repos = scratchFixtures();

function makeGitRepo(): string {
	const dir = repos.tmp("file-repo-");
	repos.git(["init", "-q", "-b", "main"], dir);
	return dir;
}

function makeGitRepoWithOrigin(url: string): string {
	const dir = makeGitRepo();
	repos.git(["remote", "add", "origin", url], dir);
	return dir;
}

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
	repos.cleanup();
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmp(prefix: string): string {
	return cliFixtures.tmp(createdDirs, prefix);
}

function writeJson(name: string, data: unknown): string {
	return cliFixtures.writeJson(createdDirs, "file-cli-fixture-", name, data);
}

function baseEnv(): Record<string, string | undefined> {
	const env = { ...process.env };
	delete env.AI_VCS_PROVIDER;
	delete env.AI_VCS_GITLAB_HOSTS;
	delete env.GH_BIN;
	delete env.GLAB_BIN;
	return env;
}

function runCli(args: readonly string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): RunResult {
	const proc = Bun.spawnSync([BUN_BIN, "run", CLI_TS, "file", ...args], {
		cwd: opts.cwd ?? tmp("file-cwd-"),
		env: { ...baseEnv(), ...opts.env },
	});
	return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode };
}

function fakeBin(binName: string, script: string): string {
	const dir = tmp(`fake-${binName}-bin-`);
	writeFakeCli(dir, binName, script, { scope: "test" });
	return join(dir, binName);
}

function shScript(caseBody: string): string {
	return cliFixtures.shScript(caseBody);
}

function callLogPath(): { path: string; env: Record<string, string> } {
	const path = cliFixtures.callLogPath(createdDirs, "file-cli-log-");
	return { path, env: { FAKE_CALL_LOG: path } };
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

function ghIssue(number: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		number,
		title: `Issue #${number}`,
		url: `https://github.com/acme/widgets/issues/${number}`,
		state: "OPEN",
		body: `body of issue ${number}`,
		labels: [{ name: "bug" }],
		createdAt: "2026-08-28T00:00:00Z",
		comments: [],
		...overrides,
	};
}

function glIssue(iid: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iid,
		title: `Issue #${iid}`,
		web_url: `https://gitlab.com/acme/widgets/-/issues/${iid}`,
		state: "opened",
		description: `body of issue ${iid}`,
		labels: ["bug"],
		created_at: "2026-08-28T00:00:00Z",
		user_notes_count: 0,
		...overrides,
	};
}

describe("file create — GitHub", () => {
	test("creates an issue with title, body, labels and assignees, then prints the normalized issue", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuePath = writeJson(
			"gh-created-issue.json",
			ghIssue(101, { labels: [{ name: "bug" }, { name: "triage" }] }),
		);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"issue create"*)
    printf '%s\\n' 'https://github.com/acme/widgets/issues/101'
    exit 0
    ;;
  *"issue view 101"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(
			[
				"create",
				"--title",
				"Fix widget",
				"--body",
				"Steps to repro",
				"--label",
				"bug",
				"--label",
				"triage",
				"--assignee",
				"dave",
			],
			{ cwd: repo, env: { GH_BIN: ghBin, FAKE_ISSUE_JSON: issuePath, ...logEnv } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({ number: 101, labels: ["bug", "triage"] });
		const calls = readCalls(log);
		expect(calls[0]).toBe("issue create --title Fix widget --body-file - --label bug --label triage --assignee dave");
	});

	test("omitting --title fails before any provider call, same as create-pr's --title contract", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { stdout, stderr, exitCode } = runCli(["create", "--body", "no title given"], { cwd: repo });

		expect(exitCode).toBe(1);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("--title requires a value");
	});
});

describe("file create — GitLab", () => {
	test("an empty --body still reaches glab as a well-formed --description= token, not a dangling flag", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuePath = writeJson("gl-created-issue.json", glIssue(55, { description: "" }));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue create"*)
    printf '%s\\n' 'https://gitlab.com/acme/widgets/-/issues/55'
    exit 0
    ;;
  *"issue view 55"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["create", "--title", "Fix widget", "--label", "bug", "--label", "triage"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({ number: 55 });
		expect(readCalls(log)[0]).toBe("issue create --title Fix widget --description= --label bug,triage --yes");
	});

	test("a non-empty --body is glued into one --description=<body> token, preserving spaces", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuePath = writeJson("gl-created-issue-body.json", glIssue(56));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue create"*)
    printf '%s\\n' 'https://gitlab.com/acme/widgets/-/issues/56'
    exit 0
    ;;
  *"issue view 56"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { exitCode } = runCli(["create", "--title", "Fix widget", "--body", "Steps to repro: click X"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(readCalls(log)[0]).toContain("--description=Steps to repro: click X");
	});

	test("a /-/work_items/<n> create URL yields the issue number, since GitLab moved issues onto that path", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const issuePath = writeJson(
			"gl-created-work-item.json",
			glIssue(65, { web_url: "https://gitlab.com/acme/widgets/-/work_items/65" }),
		);
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue create"*)
    printf '%s\\n' 'https://gitlab.com/acme/widgets/-/work_items/65'
    exit 0
    ;;
  *"issue view 65"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["create", "--title", "Fix widget"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({
			number: 65,
			url: "https://gitlab.com/acme/widgets/-/work_items/65",
		});
	});

	test("a path missing GitLab's /-/ segment is not mistaken for an issue URL", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue create"*)
    printf '%s\\n' 'https://gitlab.com/acme/issues/12'
    exit 0
    ;;`),
		);

		const { stdout, stderr, exitCode } = runCli(["create", "--title", "Fix widget"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(1);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("could not parse a number from glab issue create output");
	});

	test("digits that run into trailing characters do not parse as a truncated issue number", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue create"*)
    printf '%s\\n' 'https://gitlab.com/acme/widgets/-/issues/12abc'
    exit 0
    ;;`),
		);

		const { stderr, exitCode } = runCli(["create", "--title", "Fix widget"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(1);
		expect(stderr).toContain("could not parse a number from glab issue create output");
	});
});

describe("file list", () => {
	test("forwards --state/--label/--limit to the provider", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuesPath = writeJson("gh-list-issues.json", [ghIssue(1), ghIssue(2)]);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"issue list"*)
    cat "$FAKE_ISSUES_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list", "--state", "all", "--label", "bug", "--limit", "2"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUES_JSON: issuesPath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toHaveLength(2);
		const call = readCalls(log)[0];
		expect(call).toContain("--state all");
		expect(call).toContain("--label bug");
		expect(call).toContain("--limit 2");
	});

	test("--group-by-label buckets issues by shared label, fanning a multi-labeled issue into every bucket it belongs to", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const issuesPath = writeJson("gh-list-issues-grouped.json", [
			ghIssue(1, { labels: [{ name: "bug" }, { name: "flaky-tests" }] }),
			ghIssue(2, { labels: [{ name: "flaky-tests" }] }),
			ghIssue(3, { labels: [] }),
		]);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"issue list"*)
    cat "$FAKE_ISSUES_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list", "--group-by-label"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUES_JSON: issuesPath },
		});

		expect(exitCode).toBe(0);
		const buckets = JSON.parse(stdout.trim());
		expect(buckets.bug.map((i: { number: number }) => i.number)).toEqual([1]);
		expect(buckets["flaky-tests"].map((i: { number: number }) => i.number)).toEqual([1, 2]);
		expect(buckets._unlabeled.map((i: { number: number }) => i.number)).toEqual([3]);
	});
});

describe("file list — GitLab", () => {
	test("forwards --state/--label/--limit as glab's --all/--label/--per-page flags", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuesPath = writeJson("gl-list-issues.json", [glIssue(1), glIssue(2)]);
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue list"*)
    cat "$FAKE_ISSUES_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list", "--state", "all", "--label", "bug", "--limit", "2"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUES_JSON: issuesPath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toHaveLength(2);
		const call = readCalls(log)[0];
		expect(call).toContain("--all");
		expect(call).toContain("--label bug");
		expect(call).toContain("--per-page 2");
	});
});

describe("file — provider and repo overrides", () => {
	test("--provider gitlab --repo wins over a GitHub-origin repo's auto-detection", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuePath = writeJson("gl-override-issue.json", glIssue(42));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue view 42"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["view", "42", "--provider", "gitlab", "--repo", "acme/widgets"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({ number: 42 });
		expect(readCalls(log)[0]).toBe("issue view 42 --output json -R acme/widgets");
	});
});

describe("file view", () => {
	test("prints one normalized issue for a GitLab-origin repo", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const issuePath = writeJson("gl-view-issue.json", glIssue(42));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue view 42"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["view", "42"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({ number: 42, state: "OPEN" });
	});
});

describe("file bucket", () => {
	test("--create ensures the label first (no --force recolor), then adds it to every given issue", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issue1 = writeJson("gh-bucket-issue-1.json", ghIssue(1, { labels: [{ name: "flaky-tests" }] }));
		const issue2 = writeJson("gh-bucket-issue-2.json", ghIssue(2, { labels: [{ name: "flaky-tests" }] }));
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"label create flaky-tests"*)
    exit 0
    ;;
  *"issue edit 1"*)
    exit 0
    ;;
  *"issue edit 2"*)
    exit 0
    ;;
  *"issue view 1"*)
    cat "$FAKE_ISSUE_1"
    exit 0
    ;;
  *"issue view 2"*)
    cat "$FAKE_ISSUE_2"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["bucket", "flaky-tests", "1", "2", "--create"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUE_1: issue1, FAKE_ISSUE_2: issue2, ...logEnv },
		});

		expect(exitCode).toBe(0);
		const results = JSON.parse(stdout.trim());
		expect(results.map((r: { number: number }) => r.number)).toEqual([1, 2]);
		const calls = readCalls(log);
		expect(calls[0]).toBe("label create flaky-tests");
		expect(calls[1]).toBe("issue edit 1 --add-label flaky-tests");
		expect(calls.find((call) => call.startsWith("issue edit 2"))).toBe(
			"issue edit 2 --add-label flaky-tests",
		);
	});

	test("without --create, skips label creation and only attaches the (assumed-existing) label", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const { path: log, env: logEnv } = callLogPath();
		const issuePath = writeJson("gl-bucket-issue.json", glIssue(9, { labels: ["security"] }));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"issue update 9"*)
    exit 0
    ;;
  *"issue view 9"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { exitCode } = runCli(["bucket", "security", "9"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath, ...logEnv },
		});

		expect(exitCode).toBe(0);
		const calls = readCalls(log);
		expect(calls.some((c) => c.startsWith("label"))).toBe(false);
		expect(calls[0]).toBe("issue update 9 --label security");
	});

	test("a duplicate label on --create is swallowed on GitLab's real 'already been taken' wording", () => {
		const repo = makeGitRepoWithOrigin("https://gitlab.com/acme/widgets.git");
		const issuePath = writeJson("gl-bucket-dup-label.json", glIssue(9, { labels: ["security"] }));
		const glabBin = fakeBin(
			"glab",
			shScript(`
  *"label create"*)
    echo "POST https://gitlab.com/api/v4/projects/acme%2Fwidgets/labels: 400 Name has already been taken" >&2
    exit 1
    ;;
  *"issue update 9"*)
    exit 0
    ;;
  *"issue view 9"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["bucket", "security", "9", "--create"], {
			cwd: repo,
			env: { GLAB_BIN: glabBin, FAKE_ISSUE_JSON: issuePath },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())[0]).toMatchObject({ number: 9 });
	});

	test("a duplicate label on --create is swallowed (idempotent bucket), not surfaced as a failure", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const issuePath = writeJson("gh-bucket-dup-label.json", ghIssue(7, { labels: [{ name: "flaky-tests" }] }));
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"label create"*)
    echo "gh: a label with this name already exists" >&2
    exit 1
    ;;
  *"issue edit 7"*)
    exit 0
    ;;
  *"issue view 7"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["bucket", "flaky-tests", "7", "--create"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUE_JSON: issuePath },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())[0]).toMatchObject({ number: 7 });
	});

	test("a real (non-duplicate) label-create failure still propagates as a hard error", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"label create"*)
    echo "gh: authentication required" >&2
    exit 1
    ;;`),
		);

		const { stdout, stderr, exitCode } = runCli(["bucket", "flaky-tests", "1", "--create"], {
			cwd: repo,
			env: { GH_BIN: ghBin },
		});

		expect(exitCode).toBe(1);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("authentication required");
	});

	test("no issue numbers given fails before any provider call", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const { stdout, stderr, exitCode } = runCli(["bucket", "flaky-tests"], { cwd: repo });

		expect(exitCode).toBe(1);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain("at least one issue number");
	});
});

describe("file — no resolvable provider", () => {
	test("fails loud through defineCommand's error path rather than printing anything", () => {
		const repo = makeGitRepo();
		const { stdout, stderr, exitCode } = runCli(["list"], { cwd: repo });

		expect(exitCode).toBe(1);
		expect(stdout.trim()).toBe("");
		expect(stderr).toContain(`no "origin" remote configured`);
	});
});

describe("file dispatch and validation", () => {
	test.each([
		{ args: [], status: 2, stdout: true },
		{ args: ["--help"], status: 0, stdout: true },
		{ args: ["-h"], status: 0, stdout: true },
		{ args: ["bogus"], status: 2, stdout: false },
	])("preserves usage status and streams for $args", ({ args, status, stdout }) => {
		const { path, env } = callLogPath();
		const ghBin = fakeBin("gh", shScript(""));
		const glabBin = fakeBin("glab", shScript(""));
		const result = runCli(args, { env: { ...env, GH_BIN: ghBin, GLAB_BIN: glabBin } });
		expect(result.exitCode).toBe(status);
		expect(stdout ? result.stdout : result.stderr).toContain("Usage:");
		expect(stdout ? result.stderr : result.stdout).toBe("");
		expect(readCalls(path)).toEqual([]);
	});

	test.each([
		{ args: ["create", "--title"], message: "--title requires a value" },
		{ args: ["create", "--title", "title", "--body"], message: "--body requires a value" },
		{ args: ["create", "--title", "title", "--label"], message: "--label requires a value" },
		{ args: ["create", "--title", "title", "--assignee"], message: "--assignee requires a value" },
		{ args: ["list", "--limit", "0"], message: "positive whole number" },
		{ args: ["list", "--limit", "1.5"], message: "positive whole number" },
		{ args: ["list", "--limit", "NaN"], message: "positive whole number" },
		{ args: ["list", "--limit"], message: "--limit requires a value" },
		{ args: ["view", "0"], message: "positive issue number" },
		{ args: ["view", "1.5"], message: "positive issue number" },
		{ args: ["view"], message: "positive issue number" },
		{ args: ["bucket"], message: "requires a <label>" },
		{ args: ["bucket", "bug", "0"], message: "positive whole issue numbers" },
		{ args: ["bucket", "bug", "1.5"], message: "positive whole issue numbers" },
		{ args: ["list", "--provider", "other"], message: "--provider must be" },
		{ args: ["list", "--repo"], message: "--repo requires a value" },
	])("rejects invalid arguments before provider calls: $args", ({ args, message }) => {
		const { path, env } = callLogPath();
		const bin = fakeBin("gh", shScript(""));
		const result = runCli(args, { env: { ...env, AI_VCS_PROVIDER: "github", GH_BIN: bin } });
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain(message);
		expect(readCalls(path)).toEqual([]);
	});

	test("imports the file domain without dispatching or exiting", () => {
		const proc = Bun.spawnSync([BUN_BIN, "-e", `await import(${JSON.stringify(join(import.meta.dir, "../src/file/index.ts"))}); console.log("import complete");`], { cwd: tmp("file-import-cwd-"), env: process.env });
		expect(proc.exitCode).toBe(0);
		expect(proc.stdout.toString()).toBe("import complete\n");
		expect(proc.stderr.toString()).toBe("");
	});
});

interface IssueCall { args: string[]; stdin?: string }
function literalIssueProvider(provider: "github" | "gitlab") {
	const callsPath = join(tmp("file-argv-"), "calls.jsonl");
	const issue = provider === "github" ? ghIssue(71) : glIssue(71);
	const secondIssue = provider === "github" ? ghIssue(72) : glIssue(72);
	const url = provider === "github" ? "https://github.com/acme/widgets/issues/71" : "https://gitlab.com/acme/widgets/-/issues/71";
	const bin = fakeBin(provider === "github" ? "gh" : "glab", `#!${BUN_BIN}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const stdin = args.includes("--body-file") ? await Bun.stdin.text() : undefined;
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, stdin }) + "\\n");
if (args[1] === "create") console.log(${JSON.stringify(url)});
else if (args[1] === "list") console.log(JSON.stringify([${JSON.stringify(issue)}, ${JSON.stringify(secondIssue)}]));
else console.log(JSON.stringify(${JSON.stringify(issue)}));
`);
	return {
		env: { AI_VCS_PROVIDER: provider, [provider === "github" ? "GH_BIN" : "GLAB_BIN"]: bin },
		calls: (): IssueCall[] => readCalls(callsPath).map((line) => JSON.parse(line)),
	};
}

describe.each(["github", "gitlab"] as const)("file native argument boundaries on %s", (provider) => {
	test("creates with literal Unicode, newlines, quotes and metacharacters and preserves repeated options", () => {
		const fixture = literalIssueProvider(provider);
		const title = 'Fix 🔧 "quoted" `literal` $(touch never) & ; \' apostrophe';
		const body = 'First line ✨\nSecond "line"\n$(touch never) `literal` & <html>\n';
		const result = runCli([
			"create", "--title", title, "--body", body,
			"--label", "needs triage", "--label", "bug", "--assignee", "alice", "--assignee", "bob", "--repo", "acme/widgets",
		], { env: fixture.env });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ number: 71 });
		const [create, view] = fixture.calls();
		if (provider === "github") {
			expect(create).toEqual({ args: ["issue", "create", "--title", title, "--body-file", "-", "--label", "needs triage", "--label", "bug", "--assignee", "alice", "--assignee", "bob", "-R", "acme/widgets"], stdin: body });
		} else {
			expect(create).toEqual({ args: ["issue", "create", "--title", title, `--description=${body}`, "--label", "needs triage,bug", "--assignee", "alice,bob", "--yes", "-R", "acme/widgets"] });
		}
		expect(view.args.slice(0, 3)).toEqual(["issue", "view", "71"]);
		expect(view.args.slice(-2)).toEqual(["-R", "acme/widgets"]);
	});

	test("forwards explicit repo, state, label and limit to list and caps returned results", () => {
		const fixture = literalIssueProvider(provider);
		const result = runCli(["list", "--repo", "acme/widgets", "--state", "all", "--label", "needs triage", "--limit", "1"], { env: fixture.env });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).map((issue: { number: number }) => issue.number)).toEqual([71]);
		const args = fixture.calls()[0].args;
		expect(args.slice(-2)).toEqual(["-R", "acme/widgets"]);
		expect(args.slice(args.indexOf("--label"), args.indexOf("--label") + 2)).toEqual(["--label", "needs triage"]);
		const limitFlag = provider === "github" ? "--limit" : "--per-page";
		expect(args.slice(args.indexOf(limitFlag), args.indexOf(limitFlag) + 2)).toEqual([limitFlag, "1"]);
	});

	test("strips provider and repo options before bucket positionals and creates a label only when requested", () => {
		const fixture = literalIssueProvider(provider);
		const result = runCli(["bucket", "--repo", "acme/widgets", "--provider", provider, "needs triage", "71", "--create"], { env: fixture.env });
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout).map((issue: { number: number }) => issue.number)).toEqual([71]);
		const calls = fixture.calls();
		expect(calls).toHaveLength(3);
		expect(calls[0].args).toEqual(provider === "github"
			? ["label", "create", "needs triage", "-R", "acme/widgets"]
			: ["label", "create", "--name", "needs triage", "-R", "acme/widgets"]);
		expect(calls[0].args).not.toContain("--force");
		expect(calls[1].args).toEqual(provider === "github"
			? ["issue", "edit", "71", "--add-label", "needs triage", "-R", "acme/widgets"]
			: ["issue", "update", "71", "--label", "needs triage", "-R", "acme/widgets"]);
	});
});

describe("file review hardening", () => {
	test("--group-by-label keeps labels named like object members", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const issuesPath = writeJson("gh-list-issues-proto.json", [
			ghIssue(1, { labels: [{ name: "constructor" }, { name: "__proto__" }, { name: "toString" }] }),
		]);
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"issue list"*)
    cat "$FAKE_ISSUES_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["list", "--group-by-label"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUES_JSON: issuesPath },
		});

		expect(exitCode).toBe(0);
		const buckets = JSON.parse(stdout.trim());
		expect(Object.keys(buckets).sort()).toEqual(["__proto__", "constructor", "toString"]);
		expect(buckets.constructor.map((i: { number: number }) => i.number)).toEqual([1]);
	});

	test("view finds the issue number after its flags", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const issuePath = writeJson("gh-view-flags.json", ghIssue(5));
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"issue view 5"*)
    cat "$FAKE_ISSUE_JSON"
    exit 0
    ;;`),
		);

		const { stdout, exitCode } = runCli(["view", "--repo", "acme/widgets", "5"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUE_JSON: issuePath },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout.trim())).toMatchObject({ number: 5 });
	});

	test("bucket reports the issues it labeled when a later issue fails", () => {
		const repo = makeGitRepoWithOrigin("https://github.com/acme/widgets.git");
		const issue1 = writeJson("gh-bucket-partial-1.json", ghIssue(1, { labels: [{ name: "triage" }] }));
		const ghBin = fakeBin(
			"gh",
			shScript(`
  *"issue edit 1"*)
    exit 0
    ;;
  *"issue view 1"*)
    cat "$FAKE_ISSUE_1"
    exit 0
    ;;
  *"issue edit 2"*)
    echo "gh: issue locked" >&2
    exit 1
    ;;`),
		);

		const { stdout, stderr, exitCode } = runCli(["bucket", "triage", "1", "2"], {
			cwd: repo,
			env: { GH_BIN: ghBin, FAKE_ISSUE_1: issue1 },
		});

		expect(exitCode).toBe(1);
		expect(JSON.parse(stdout.trim()).map((r: { number: number }) => r.number)).toEqual([1]);
		expect(stderr).toContain("#2");
		expect(stderr).toContain("issue locked");
	});
});
