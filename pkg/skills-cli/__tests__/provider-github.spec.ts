import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createGithubProvider } from "../src/provider/github";
import { LOG_EXCERPT_MAX_CHARS, ProviderError, truncateLogExcerpt } from "../src/provider/types";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";

cliFixtures.isolateCliTests();

const ENV_KEYS = [
	"GH_BIN",
	"FAKE_CALL_LOG",
	"FAKE_STDIN_CAPTURE",
	"FAKE_REPO_JSON",
	"FAKE_PR_JSON",
	"FAKE_ALL_JSON",
	"FAKE_RUN_JSON",
	"FAKE_PAGE1_JSON",
	"FAKE_PAGE2_JSON",
] as const;

let savedEnv: Record<string, string | undefined>;
let createdDirs: string[];

beforeEach(() => {
	savedEnv = {};
	for (const k of ENV_KEYS) {
		savedEnv[k] = process.env[k];
		delete process.env[k];
	}
	createdDirs = [];
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (savedEnv[k] === undefined) delete process.env[k];
		else process.env[k] = savedEnv[k];
	}
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmp(prefix: string): string {
	return cliFixtures.tmp(createdDirs, prefix);
}

/** Writes a fake `gh` and points GH_BIN at it. */
function fakeGh(script: string): string {
	const dir = tmp("fake-gh-bin-");
	writeFakeCli(dir, "gh", script);
	const path = join(dir, "gh");
	process.env.GH_BIN = path;
	return path;
}

function fakeGhThreads(): string {
	return fakeGh(
		ghScript(`
  *"--json number"*)
    echo '{"number":9001}'
    exit 0
    ;;
  *graphql*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
	);
}

function writeJson(name: string, data: unknown): string {
	return cliFixtures.writeJson(createdDirs, "fake-gh-fixture-", name, data);
}

function callLogPath(): string {
	const path = cliFixtures.callLogPath(createdDirs, "fake-gh-log-");
	process.env.FAKE_CALL_LOG = path;
	return path;
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

const ghScript = cliFixtures.shScript;

function rawPr(n: number, state: "OPEN" | "CLOSED" | "MERGED", overrides: Record<string, unknown> = {}) {
	return {
		number: n,
		title: `PR #${n}`,
		url: `https://github.com/acme/widgets/pull/${n}`,
		state,
		headRefName: `feature-${n}`,
		baseRefName: "main",
		body: `body of PR ${n}`,
		mergedAt: state === "MERGED" ? "2026-01-01T00:00:00Z" : null,
		...overrides,
	};
}

/** REST shape returned by `gh api repos/{owner}/{repo}/pulls`. */
function rawPrRest(n: number, state: "open" | "closed", overrides: Record<string, unknown> = {}) {
	return {
		number: n,
		title: `PR #${n}`,
		html_url: `https://github.com/acme/widgets/pull/${n}`,
		state,
		head: { ref: `feature-${n}` },
		base: { ref: "main" },
		body: `body of PR ${n}`,
		merged_at: null,
		...overrides,
	};
}

describe("createGithubProvider — capabilities", () => {
	test("declares aiReviewBot and nativeStacking both true, naming Copilot as the reviewer", () => {
		const provider = createGithubProvider();
		expect(provider.capabilities.aiReviewBot).toBe(true);
		expect(provider.capabilities.aiReviewBotNames).toEqual(["copilot"]);
		expect(provider.capabilities.nativeStacking).toBe(true);
	});
});

describe("repoInfo", () => {
	test("parses `gh repo view` output into the normalized RepoInfo shape", async () => {
		const log = callLogPath();
		process.env.FAKE_REPO_JSON = writeJson("repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			nameWithOwner: "acme/widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		fakeGh(
			ghScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const info = await provider.repoInfo();

		expect(info).toEqual({ host: "github.com", owner: "acme", repo: "widgets", defaultBranch: "main" });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("repo view --json");
	});

	test("an explicit RepoRef targets that repo rather than the cwd's remote", async () => {
		const log = callLogPath();
		process.env.FAKE_REPO_JSON = writeJson("repo.json", {
			owner: { login: "other-org" },
			name: "other-repo",
			defaultBranchRef: { name: "develop" },
		});
		fakeGh(
			ghScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const info = await provider.repoInfo({ host: "github.com", owner: "other-org", repo: "other-repo" });

		expect(info.owner).toBe("other-org");
		expect(info.repo).toBe("other-repo");
		expect(info.defaultBranch).toBe("develop");
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("other-org/other-repo");
	});
});

describe("currentPullRequest", () => {
	test("parses `gh pr view` output for the checked-out branch's PR", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(9001, "OPEN"));
		fakeGh(
			ghScript(`
  *"pr view"*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const pr = await provider.currentPullRequest();

		expect(pr).not.toBeNull();
		expect(pr).toMatchObject({ number: 9001, state: "OPEN", headRefName: "feature-9001", merged: false });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pr view --json");
	});

	test("returns null, not a throw, when gh reports no PR for the current branch", async () => {
		fakeGh(
			ghScript(`
  *"pr view"*)
    echo 'no pull requests found for branch "feature-x"' 1>&2
    exit 1
    ;;`),
		);

		const provider = createGithubProvider();
		const pr = await provider.currentPullRequest();

		expect(pr).toBeNull();
	});
});

describe("viewPullRequest", () => {
	test("looks up a PR by number and normalizes its fields, including the computed `merged` flag", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(42, "MERGED"));
		fakeGh(
			ghScript(`
  *"pr view"*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const pr = await provider.viewPullRequest({ number: 42 });

		expect(pr.number).toBe(42);
		expect(pr.state).toBe("MERGED");
		expect(pr.merged).toBe(true);
		expect(pr.mergedAt).toBe("2026-01-01T00:00:00Z");
		expect(readCalls(log)).toEqual([
			"pr view 42 --json number,title,url,state,headRefName,baseRefName,body,mergedAt",
		]);
	});
});

describe("createPullRequest", () => {
	test("creates a PR, piping the body via stdin, and returns the normalized PullRequest", async () => {
		const log = callLogPath();
		const stdinCapture = join(tmp("fake-gh-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		process.env.FAKE_PR_JSON = writeJson(
			"pr.json",
			rawPr(9002, "OPEN", { title: "Add feature", headRefName: "feature-branch", baseRefName: "main" }),
		);
		fakeGh(
			ghScript(`
  *"pr create"*)
    cat > "$FAKE_STDIN_CAPTURE" 2>/dev/null || true
    echo "https://github.com/acme/widgets/pull/9002"
    exit 0
    ;;
  *"pr view"*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const longBody = "a very long PR description\n\nwith multiple lines\n".repeat(50);
		const pr = await provider.createPullRequest({
			title: "Add feature",
			body: longBody,
			base: "main",
			head: "feature-branch",
		});

		expect(pr.number).toBe(9002);
		expect(pr.title).toBe("Add feature");
		expect(readFileSync(stdinCapture, "utf8")).toBe(longBody);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("Add feature");
		expect(calls).toContain("main");
		expect(calls).toContain("feature-branch");
	});

	test("raises a ProviderError with a PARSE_ERROR code when gh's output has no /pull/<n> URL to extract", async () => {
		fakeGh(
			ghScript(`
  *"pr create"*)
    echo "unexpected output with no pull request url"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const caught = await cliFixtures.catchError(() => provider.createPullRequest({ title: "x", body: "y", base: "main", head: "feature" }));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("PARSE_ERROR");
	});
});

describe("listUnresolvedThreads", () => {
	function graphqlThreadsFixture() {
		return {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [
								{
									id: "RT_kwALOAB1",
									isResolved: false,
									comments: {
										nodes: [
											{
												databaseId: 5001,
												author: { login: "alice" },
												body: "please address this",
												createdAt: "2026-02-01T10:00:00Z",
											},
										],
									},
								},
								{
									id: "RT_kwALOAB2",
									isResolved: true,
									comments: {
										nodes: [
											{
												databaseId: 5002,
												author: { login: "bob" },
												body: "looks fine now",
												createdAt: "2026-02-02T11:00:00Z",
											},
										],
									},
								},
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		};
	}

	test("defaults to only unresolved threads, mapping the GraphQL node id to threadId and the comment's databaseId to commentId", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("threads.json", graphqlThreadsFixture());
		fakeGhThreads();

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({
			threadId: "RT_kwALOAB1",
			resolved: false,
			commentId: "5001",
		});
		expect(threads[0].comments).toEqual([
			{ id: "5001", author: "alice", body: "please address this", createdAt: "2026-02-01T10:00:00Z", diffHunk: "" },
		]);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("number=9001");
	});

	test("includeResolved:true also returns resolved threads", async () => {
		process.env.FAKE_PR_JSON = writeJson("threads.json", graphqlThreadsFixture());
		fakeGhThreads();

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads({ includeResolved: true });

		expect(threads.map((t) => t.threadId).sort()).toEqual(["RT_kwALOAB1", "RT_kwALOAB2"]);
		const resolvedOne = threads.find((t) => t.threadId === "RT_kwALOAB2");
		expect(resolvedOne?.resolved).toBe(true);
	});

	test("a thread with multiple comments derives commentId from the FIRST comment's databaseId, not the last", async () => {
		const multiCommentFixture = {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [
								{
									id: "RT_multiComment",
									isResolved: false,
									comments: {
										nodes: [
											{
												databaseId: 6001,
												author: { login: "alice" },
												body: "please address this",
												createdAt: "2026-03-01T09:00:00Z",
											},
											{
												databaseId: 6002,
												author: { login: "bob" },
												body: "seconding this",
												createdAt: "2026-03-01T10:00:00Z",
											},
											{
												databaseId: 6003,
												author: { login: "carol" },
												body: "still open",
												createdAt: "2026-03-01T11:00:00Z",
											},
										],
									},
								},
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		};
		process.env.FAKE_PR_JSON = writeJson("multi-comment-thread.json", multiCommentFixture);
		fakeGhThreads();

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads).toHaveLength(1);
		expect(threads[0].commentId).toBe("6001");
		expect(threads[0].commentId).not.toBe("6002");
		expect(threads[0].commentId).not.toBe("6003");
		expect(threads[0].comments.map((c) => c.id)).toEqual(["6001", "6002", "6003"]);
		expect(threads[0].comments[0].author).toBe("alice");
	});

	function threadNode(id: string, commentId: number) {
		return {
			id,
			isResolved: false,
			comments: {
				nodes: [{ databaseId: commentId, author: { login: "alice" }, body: "x", createdAt: "2026-01-01T00:00:00Z" }],
			},
		};
	}

	test("a PR with more than 100 unresolved review threads follows pageInfo.hasNextPage/endCursor across GraphQL pages", async () => {
		const page1Nodes = Array.from({ length: 100 }, (_, i) => threadNode(`RT_page1_${i}`, i));
		const page2Nodes = Array.from({ length: 5 }, (_, i) => threadNode(`RT_page2_${i}`, 1000 + i));
		const page1Response = {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: { nodes: page1Nodes, pageInfo: { hasNextPage: true, endCursor: "cursor-page-1" } },
					},
				},
			},
		};
		const page2Response = {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: { nodes: page2Nodes, pageInfo: { hasNextPage: false, endCursor: null } },
					},
				},
			},
		};
		const page1Path = writeJson("threads-page1.json", page1Response);
		const page2Path = writeJson("threads-page2.json", page2Response);
		const log = callLogPath();

		fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"--json number"*)
    echo '{"number":9001}'
    exit 0
    ;;
  *"cursor-page-1"*)
    cat "${page2Path}"
    exit 0
    ;;
  *graphql*)
    cat "${page1Path}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads).toHaveLength(105);
		expect(threads.map((t) => t.threadId)).toContain("RT_page2_0");
		const calls = readCalls(log);
		expect(calls.filter((c) => c.includes("graphql")).length).toBeGreaterThanOrEqual(2);
	});

	test("raises NO_CURRENT_PR instead of sending an under-parameterized GraphQL query when the PR number can't be resolved", async () => {
		fakeGh(
			ghScript(`
  *"--json number"*)
    echo '{}'
    exit 0
    ;;
  *graphql*)
    echo '{"data":{}}'
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const caught = await cliFixtures.catchError(() => provider.listUnresolvedThreads());

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("NO_CURRENT_PR");
	});
});

describe("resolveThread", () => {
	test("resolves a thread via the opaque threadId alone", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *graphql*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_kwALOAB1"}}}}'
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.resolveThread("RT_kwALOAB1");

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("RT_kwALOAB1");
		expect(calls).toContain("graphql");
	});
});

describe("replyToThread", () => {
	test("posts an immediately published reply directly to the original review comment", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pulls/42/comments/5001/replies"*)
    echo '{"id":5003,"in_reply_to_id":5001,"user":{"login":"carol"},"body":"thanks, fixed","created_at":"2026-02-03T12:00:00Z"}'
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const comment = await provider.replyToThread(cliFixtures.reviewThread("RT_kwALOAB1", "5001"), "thanks, fixed", { number: 42 });

		expect(comment.id).toBe("5003");
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pulls/42/comments/5001/replies");
		expect(calls).not.toContain("addPullRequestReviewThreadReply");
	});

	test("returns the normalized published reply", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pulls/42/comments/5002/replies"*)
    echo '{"id":5004,"in_reply_to_id":5002,"user":{"login":"carol"},"body":"thanks, fixed","created_at":"2026-02-03T12:00:00Z","diff_hunk":"@@ -1 +1 @@"}'
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const comment = await provider.replyToThread(cliFixtures.reviewThread("RT_kwALOAB1", "5002"), "thanks, fixed", { number: 42 });

		expect(comment).toEqual({
			id: "5004",
			author: "carol",
			body: "thanks, fixed",
			createdAt: "2026-02-03T12:00:00Z",
			diffHunk: "@@ -1 +1 @@",
		});
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pulls/42/comments/5002/replies");
	});

	test("rejects a reply response that does not point back to the requested original comment", async () => {
		fakeGh(
			ghScript(`
  *"pulls/42/comments/5005/replies"*)
    echo '{"id":5006,"in_reply_to_id":9999,"user":{"login":"carol"},"body":"wrong parent","created_at":"2026-02-03T12:00:00Z"}'
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await expect(provider.replyToThread(cliFixtures.reviewThread("RT_kwALOAB1", "5005"), "wrong parent", { number: 42 })).rejects.toMatchObject({
			code: "PARSE_ERROR",
		});
	});
});

describe("listCiFailures — per-item best-effort degrade", () => {
	test("one expired/unavailable log degrades only that item's logExcerpt to empty string, without failing the whole call", async () => {
		process.env.FAKE_PR_JSON = writeJson("runs.json", [
			{
				total_count: 2,
				check_runs: [
					{ id: 91001, name: "CI", conclusion: "failure", head_sha: "abc123" },
					{ id: 92002, name: "Lint", conclusion: "failure", head_sha: "abc123" },
				],
			},
		]);
		fakeGh(
			ghScript(`
  *91001*)
    echo "##[error] build failed at step 3"
    exit 0
    ;;
  *92002*)
    echo "gh: Not Found (HTTP 404)" 1>&2
    exit 1
    ;;
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toHaveLength(2);
		const succeeded = failures.find((f) => f.jobId === "91001");
		const degraded = failures.find((f) => f.jobId === "92002");
		expect(succeeded).toMatchObject({ name: "CI", conclusion: "failure" });
		expect(succeeded?.logExcerpt).toContain("build failed");
		expect(degraded).toMatchObject({ name: "Lint", conclusion: "failure", logExcerpt: "" });
	});
});

describe("listCiFailures — configFile via the parent workflow run", () => {
	test("a check run's details_url resolves the parent run id, and the run's `path` becomes configFile distinct from jobId", async () => {
		process.env.FAKE_PR_JSON = writeJson("runs-with-details-url.json", [
			{
				total_count: 1,
				check_runs: [
					{
						id: 91001,
						name: "CI",
						conclusion: "failure",
						head_sha: "abc123",
						details_url: "https://github.com/acme/widgets/actions/runs/555/job/91001",
					},
				],
			},
		]);
		process.env.FAKE_RUN_JSON = writeJson("run-555.json", { path: ".github/workflows/ci.yml" });
		fakeGh(
			ghScript(`
  *"actions/runs/555"*)
    cat "$FAKE_RUN_JSON"
    exit 0
    ;;
  *91001*)
    echo "##[error] build failed at step 3"
    exit 0
    ;;
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toHaveLength(1);
		expect(failures[0].executionId).toBe("555");
		expect(failures[0].jobId).toBe("91001");
		expect(failures[0].executionId).not.toBe(failures[0].jobId);
		expect(failures[0].configFile).toBe(".github/workflows/ci.yml");
	});
});

describe("listCiFailures — logExcerpt truncation", () => {
	test("a log over LOG_EXCERPT_MAX_CHARS is truncated using the same shared transform as the DTO's rule", async () => {
		const fullLog = `${"a".repeat(1000)}${"FAILURE DETAIL AT THE TAIL ".repeat(400)}`;
		expect(fullLog.length).toBeGreaterThan(LOG_EXCERPT_MAX_CHARS);
		const logFile = join(tmp("fake-gh-longlog-"), "log.txt");
		writeFileSync(logFile, fullLog);
		process.env.FAKE_PR_JSON = writeJson("runs.json", [
			{ total_count: 1, check_runs: [{ id: 93003, name: "CI", conclusion: "failure" }] },
		]);
		fakeGh(
			ghScript(`
  *93003*)
    cat "${logFile}"
    exit 0
    ;;
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toHaveLength(1);
		expect(failures[0].logExcerpt.length).toBe(LOG_EXCERPT_MAX_CHARS);
		expect(failures[0].logExcerpt).toBe(truncateLogExcerpt(fullLog));
	});
});

describe("listCiFailures — pagination", () => {
	test("a PR with more failing check runs than one page collects all of them", async () => {
		const log = callLogPath();
		const page1 = {
			total_count: 45,
			check_runs: Array.from({ length: 30 }, (_, i) => ({ id: 90000 + i, name: `Check ${i}`, conclusion: "failure" })),
		};
		const page2 = {
			total_count: 45,
			check_runs: Array.from({ length: 15 }, (_, i) => ({
				id: 90030 + i,
				name: `Check ${30 + i}`,
				conclusion: "failure",
			})),
		};
		process.env.FAKE_ALL_JSON = writeJson("check-runs.json", [page1, page2]);
		fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"check-runs"*"--paginate"*"--slurp"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toHaveLength(45);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("--paginate");
		expect(calls).toContain("--slurp");
		expect(calls).toContain("per_page=100");
	});
});

describe("listCiFailures — no failing runs", () => {
	test("returns an empty array without attempting any per-run log fetch when nothing failed", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("runs.json", [
			{ total_count: 1, check_runs: [{ id: 94004, name: "CI", conclusion: "success" }] },
		]);
		fakeGh(
			ghScript(`
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toEqual([]);
		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("/logs"))).toBe(false);
	});
});

describe("retargetPullRequest", () => {
	test("edits the PR's base branch", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pr edit"*)
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.retargetPullRequest({ number: 7 }, "release/2.0");

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pr edit 7 --base release/2.0");
	});
});

describe("getPullRequestBody", () => {
	test("returns the PR's body text", async () => {
		process.env.FAKE_PR_JSON = writeJson("pr.json", rawPr(55, "OPEN", { body: "the full pr description" }));
		fakeGh(
			ghScript(`
  *"pr view"*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const body = await provider.getPullRequestBody({ number: 55 });

		expect(body).toBe("the full pr description");
	});
});

describe("setPullRequestBody", () => {
	test("pipes the new body via stdin rather than an argv flag (ARG_MAX safety)", async () => {
		const stdinCapture = join(tmp("fake-gh-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGh(
			ghScript(`
  *"pr edit"*)
    cat > "$FAKE_STDIN_CAPTURE" 2>/dev/null || true
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const newBody = "updated body\n".repeat(200);
		await provider.setPullRequestBody({ number: 8 }, newBody);

		expect(readFileSync(stdinCapture, "utf8")).toBe(newBody);
	});
});

describe("closePullRequest", () => {
	test("closes the PR by number", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pr close"*)
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.closePullRequest({ number: 13 });

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pr close 13");
	});
});

describe("listPullRequests — pagination", () => {
	test("collects results that span more than one 100-item page", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) =>
			rawPrRest(i + 1, i === 99 ? "closed" : "open", i === 99 ? { merged_at: "2026-01-01T00:00:00Z" } : {}),
		);
		const page2 = Array.from({ length: 50 }, (_, i) => rawPrRest(i + 101, "open"));
		process.env.FAKE_PAGE1_JSON = writeJson("page1.json", page1);
		process.env.FAKE_PAGE2_JSON = writeJson("page2.json", page2);
		const log = callLogPath();

		fakeGh(
			ghScript(`
  *"-F page=1 "*)
    cat "$FAKE_PAGE1_JSON"
    exit 0
    ;;
  *"-F page=2 "*)
    cat "$FAKE_PAGE2_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const result = await provider.listPullRequests({});

		expect(result).toHaveLength(150);
		const merged = result.find((r) => r.number === 100);
		expect(merged?.merged).toBe(true);
		expect(merged?.state).toBe("MERGED");
		const notMerged = result.find((r) => r.number === 1);
		expect(notMerged?.merged).toBe(false);
		const calls = readCalls(log).join("\n");
		expect(calls).not.toContain("--paginate");
		expect(calls).toContain("per_page=100");
	});

	test("stops requesting pages once opts.limit is satisfied", async () => {
		process.env.FAKE_PAGE1_JSON = writeJson(
			"limit-page1.json",
			Array.from({ length: 100 }, (_, i) => rawPrRest(i + 1, "open")),
		);
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"-F page=1 "*)
    cat "$FAKE_PAGE1_JSON"
    exit 0
    ;;`),
		);

		const result = await createGithubProvider().listPullRequests({ limit: 3 });

		expect(result.map((r) => r.number)).toEqual([1, 2, 3]);
		expect(readCalls(log).filter((c) => c.includes("page="))).toHaveLength(1);
	});

	test("raises PAGE_LIMIT_EXCEEDED instead of fetching an unbounded history", async () => {
		process.env.FAKE_PAGE1_JSON = writeJson(
			"endless-page.json",
			Array.from({ length: 100 }, (_, i) => rawPrRest(i + 1, "open")),
		);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_PAGE1_JSON"
    exit 0
    ;;`),
		);

		const caught = await cliFixtures.catchError(() => createGithubProvider().listPullRequests({}));

		expect((caught as ProviderError).code).toBe("PAGE_LIMIT_EXCEEDED");
	}, 30000);
});

describe("listPullRequests — opts.limit and filter flags", () => {
	test("opts.limit slices the fully-collected result down after pagination, not before", async () => {
		const all = Array.from({ length: 5 }, (_, i) => rawPrRest(i + 1, "open"));
		process.env.FAKE_ALL_JSON = writeJson("limit-all.json", all);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const result = await provider.listPullRequests({ limit: 2 });

		expect(result).toHaveLength(2);
		expect(result.map((r) => r.number)).toEqual([1, 2]);
	});

	test("listPullRequests({}) with no state opt sends the explicit state=all default, returning every state (not open-only)", async () => {
		const log = callLogPath();
		const all = [
			rawPrRest(1, "open"),
			rawPrRest(2, "closed", { merged_at: "2026-01-01T00:00:00Z" }),
			rawPrRest(3, "closed"),
		];
		process.env.FAKE_ALL_JSON = writeJson("default-state-all.json", all);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const result = await provider.listPullRequests({});

		expect(result.map((r) => r.state).sort()).toEqual(["CLOSED", "MERGED", "OPEN"]);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("state=all");
	});

	test("opts.state and opts.head are forwarded to the `gh api` call as -F filter flags", async () => {
		const log = callLogPath();
		process.env.FAKE_ALL_JSON = writeJson("filter-all.json", []);
		process.env.FAKE_REPO_JSON = writeJson("filter-repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		fakeGh(
			ghScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.listPullRequests({ state: "OPEN", head: "feature-branch" });

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("state=open");
		expect(calls).toContain("head=acme:feature-branch");
		const stateOccurrences = calls.split("state=").length - 1;
		expect(stateOccurrences).toBe(1);
	});

	test("opts.head with an explicit repo skips the repoInfo lookup and uses that repo's owner", async () => {
		const log = callLogPath();
		process.env.FAKE_ALL_JSON = writeJson("filter-all-explicit.json", []);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.listPullRequests(
			{ head: "feature-branch" },
			{ host: "github.com", owner: "other-org", repo: "other-repo" },
		);

		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("repo view"))).toBe(false);
		expect(calls.join("\n")).toContain("head=other-org:feature-branch");
	});

	test("opts.author raises a ProviderError rather than silently returning the unfiltered list", async () => {
		process.env.FAKE_ALL_JSON = writeJson("author-all.json", []);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const caught = await cliFixtures.catchError(() => provider.listPullRequests({ author: "renovate-bot" }));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("REST_FILTER_UNIMPLEMENTED");
	});

	test("opts.label raises a ProviderError rather than silently returning the unfiltered list", async () => {
		process.env.FAKE_ALL_JSON = writeJson("label-all.json", []);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const caught = await cliFixtures.catchError(() => provider.listPullRequests({ label: "dependencies" }));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("REST_FILTER_UNIMPLEMENTED");
	});

	test("opts.state 'CLOSED' excludes merged PRs even though GitHub's REST state=closed conflates them", async () => {
		const all = [rawPrRest(1, "closed"), rawPrRest(2, "closed", { merged_at: "2026-01-01T00:00:00Z" })];
		process.env.FAKE_ALL_JSON = writeJson("closed-vs-merged.json", all);
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const result = await provider.listPullRequests({ state: "CLOSED" });

		expect(result.map((r) => r.number)).toEqual([1]);
		expect(result.every((r) => !r.merged)).toBe(true);
	});
});

describe("checkAuth", () => {
	test("resolves true when `gh auth status` exits 0", async () => {
		fakeGh(
			ghScript(`
  *"auth status"*)
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		expect(await provider.checkAuth()).toBe(true);
	});

	test("resolves false, not a throw, when `gh auth status` exits non-zero (not logged in)", async () => {
		fakeGh(
			ghScript(`
  *"auth status"*)
    echo "not logged in" 1>&2
    exit 1
    ;;`),
		);

		const provider = createGithubProvider();
		expect(await provider.checkAuth()).toBe(false);
	});
});

describe("preflight — missing gh binary", () => {
	test("a missing gh binary raises a readable ProviderError with the GH_NOT_FOUND code", async () => {
		process.env.GH_BIN = "/nonexistent/definitely-missing-gh-binary";

		const provider = createGithubProvider();
		const caught = await cliFixtures.catchError(() => provider.repoInfo());

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("GH_NOT_FOUND");
		const message = (caught as Error).message;
		expect(message).not.toMatch(/ENOENT/i);
		expect(message).toMatch(/gh/i);
		expect(message).toMatch(/not found|missing|install/i);
	});

});

describe("listPullRequests — cross-provider state vocabulary", () => {
	test("GitLab's 'opened' reaches GitHub's REST endpoint as state=open, not as a 422-triggering state=opened", async () => {
		process.env.FAKE_ALL_JSON = writeJson("state-opened.json", [rawPrRest(1, "open")]);
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"/pulls --method GET"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const result = await provider.listPullRequests({ state: "opened" });

		expect(result).toHaveLength(1);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("state=open");
		expect(calls).not.toContain("state=opened");
	});

	test("an unrecognized state is rejected with a coded ProviderError rather than forwarded to the API", async () => {
		fakeGh(ghScript(""));

		const provider = createGithubProvider();
		const caught = await cliFixtures.catchError(() => provider.listPullRequests({ state: "banana" }));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("INVALID_PR_STATE");
	});
});

describe("listUnresolvedThreads — file anchor and diff hunk", () => {
	function anchoredThreadsFixture() {
		return {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [
								{
									id: "RT_anchored",
									isResolved: false,
									path: "src/parser.ts",
									line: 42,
									originalLine: 40,
									comments: {
										nodes: [
											{
												databaseId: 7001,
												author: { login: "alice" },
												body: "off by one here",
												createdAt: "2026-02-01T10:00:00Z",
												diffHunk: "@@ -38,6 +38,7 @@\n-  const n = i;\n+  const n = i + 1;",
											},
										],
									},
								},
								{
									id: "RT_outdated",
									isResolved: false,
									path: "src/old.ts",
									line: null,
									originalLine: 17,
									comments: { nodes: [] },
								},
								{
									id: "RT_unanchored",
									isResolved: false,
									path: null,
									line: null,
									originalLine: null,
									comments: { nodes: [] },
								},
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		};
	}

	test("carries path, line and the comment's diffHunk through to the thread, since /address composes prompts from them", async () => {
		process.env.FAKE_PR_JSON = writeJson("anchored.json", anchoredThreadsFixture());
		fakeGhThreads();

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads();

		const anchored = threads.find((t) => t.threadId === "RT_anchored");
		expect(anchored?.path).toBe("src/parser.ts");
		expect(anchored?.line).toBe(42);
		expect(anchored?.comments[0].diffHunk).toContain("const n = i + 1;");
	});

	test("falls back to originalLine for an outdated thread whose current line is null", async () => {
		process.env.FAKE_PR_JSON = writeJson("anchored.json", anchoredThreadsFixture());
		fakeGhThreads();

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads.find((t) => t.threadId === "RT_outdated")?.line).toBe(17);
	});

	test("reports an unanchored thread as an empty path and a null line rather than undefined", async () => {
		process.env.FAKE_PR_JSON = writeJson("anchored.json", anchoredThreadsFixture());
		fakeGhThreads();

		const provider = createGithubProvider();
		const threads = await provider.listUnresolvedThreads();

		const unanchored = threads.find((t) => t.threadId === "RT_unanchored");
		expect(unanchored?.path).toBe("");
		expect(unanchored?.line).toBeNull();
	});

	test("an explicit ref targets that PR's threads without ever shelling out to resolve the current branch", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("anchored.json", anchoredThreadsFixture());
		fakeGh(
			ghScript(`
  *graphql*)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.listUnresolvedThreads(
			{},
			{ number: 4242, repo: { host: "github.com", owner: "acme", repo: "widgets" } },
		);

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("number=4242");
		expect(calls).toContain("owner=acme");
		expect(calls).toContain("repo=widgets");
		expect(calls).not.toContain("--json number");
	});
});

describe("listCiFailures — link to the failing run", () => {
	test("carries the check run's details_url through as url, so a caller can open the failure", async () => {
		process.env.FAKE_PR_JSON = writeJson("runs-url.json", [
			{
				total_count: 1,
				check_runs: [
					{
						id: 91001,
						name: "CI",
						conclusion: "failure",
						head_sha: "abc123",
						details_url: "https://github.com/acme/widgets/actions/runs/555/job/91001",
					},
				],
			},
		]);
		fakeGh(
			ghScript(`
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures[0].url).toBe("https://github.com/acme/widgets/actions/runs/555/job/91001");
	});

	test("falls back to html_url when the check run carries no details_url", async () => {
		process.env.FAKE_PR_JSON = writeJson("runs-htmlurl.json", [
			{
				total_count: 1,
				check_runs: [
					{
						id: 91002,
						name: "CI",
						conclusion: "failure",
						head_sha: "abc123",
						html_url: "https://github.com/acme/widgets/runs/91002",
					},
				],
			},
		]);
		fakeGh(
			ghScript(`
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures[0].url).toBe("https://github.com/acme/widgets/runs/91002");
	});

	test("reports an empty url rather than undefined when the payload carries neither link", async () => {
		process.env.FAKE_PR_JSON = writeJson("runs-nourl.json", [
			{ total_count: 1, check_runs: [{ id: 91003, name: "CI", conclusion: "failure", head_sha: "abc123" }] },
		]);
		fakeGh(
			ghScript(`
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures[0].url).toBe("");
	});
});

describe("closePullRequest — closing comment", () => {
	test("passes a comment to gh's own --comment flag, in the same call as the close", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pr close"*)
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.closePullRequest({ number: 13 }, "Included in combined deps branch: chore/deps");

		const calls = readCalls(log);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("pr close 13");
		expect(calls[0]).toContain("--comment Included in combined deps branch: chore/deps");
	});

	test("omits the flag entirely when no comment is given", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pr close"*)
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		await provider.closePullRequest({ number: 13 });

		expect(readCalls(log).join("\n")).not.toContain("--comment");
	});
});

describe("fetchDiff", () => {
	test("shells `gh pr diff <n> -R owner/repo --color never` and returns stdout verbatim", async () => {
		const log = callLogPath();
		fakeGh(
			ghScript(`
  *"pr diff 12"*)
    printf 'diff --git a/x b/x\\n--- a/x\\n+++ b/x\\n@@ -1 +1 @@\\n-a\\n+b\\n'
    exit 0
    ;;`),
		);

		const provider = createGithubProvider();
		const diff = await provider.fetchDiff({ number: 12, repo: { host: "github.com", owner: "acme", repo: "widgets" } });

		expect(diff).toStartWith("diff --git a/x b/x");
		expect(readCalls(log)).toEqual(["pr diff 12 -R acme/widgets --color never"]);
	});
});

describe("postReview", () => {
	const ref = { number: 12, repo: { host: "github.com", owner: "acme", repo: "widgets" } };
	const comments = [
		{ path: "src/a.ts", newLine: 4, oldLine: 3, body: "context line" },
		{ path: "src/a.ts", oldLine: 2, body: "removed line" },
	];

	function reviewScript(refuseEvent?: string): string {
		const verb = refuseEvent === "APPROVE" ? "approve" : "request changes on";
		const refusal = refuseEvent
			? `if grep -q '"event":"${refuseEvent}"' "$FAKE_STDIN_CAPTURE"; then echo 'HTTP 422: Review Can not ${verb} your own pull request' 1>&2; exit 1; fi`
			: "";
		return ghScript(`
  *"pr view 12"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *"pulls/12/reviews"*)
    cat > "$FAKE_STDIN_CAPTURE"
    ${refusal}
    echo '{"html_url":"https://github.com/acme/widgets/pull/12#pullrequestreview-1"}'
    exit 0
    ;;`);
	}

	test("posts one review pinned to the head commit with the mapped event and sides", async () => {
		const log = callLogPath();
		const stdinCapture = join(tmp("fake-gh-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGh(reviewScript());

		const provider = createGithubProvider();
		const posted = await provider.postReview(ref, { verdict: "request_changes", body: "summary", comments });

		expect(posted).toEqual({
			url: "https://github.com/acme/widgets/pull/12#pullrequestreview-1",
			verdict: "request_changes",
			degraded: false,
			commentCount: 2,
		});
		expect(JSON.parse(readFileSync(stdinCapture, "utf8"))).toEqual({
			commit_id: "abc123",
			event: "REQUEST_CHANGES",
			body: "summary",
			comments: [
				{ path: "src/a.ts", line: 4, side: "RIGHT", body: "context line" },
				{ path: "src/a.ts", line: 2, side: "LEFT", body: "removed line" },
			],
		});
		expect(readCalls(log).at(-1)).toBe("api repos/acme/widgets/pulls/12/reviews --method POST --input -");
	});

	test("retries as COMMENT and reports degraded when GitHub refuses a verdict on the author's own PR", async () => {
		const log = callLogPath();
		const stdinCapture = join(tmp("fake-gh-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGh(reviewScript("APPROVE"));

		const provider = createGithubProvider();
		const posted = await provider.postReview(ref, { verdict: "approve", body: "", comments: [] });

		expect(posted).toMatchObject({ verdict: "comment", degraded: true, commentCount: 0 });
		const payload = JSON.parse(readFileSync(stdinCapture, "utf8"));
		expect(payload.event).toBe("COMMENT");
		expect(payload.body).toBe("Review submitted.");
		expect(readCalls(log).filter((c) => c.includes("pulls/12/reviews"))).toHaveLength(2);
	});

	test("does not retry a refusal that is not about the author's own PR", async () => {
		process.env.FAKE_STDIN_CAPTURE = join(tmp("fake-gh-stdin-"), "stdin.txt");
		fakeGh(
			ghScript(`
  *"pr view 12"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *"pulls/12/reviews"*)
    cat > "$FAKE_STDIN_CAPTURE"
    echo 'HTTP 422: Unprocessable Entity (line must be part of the diff)' 1>&2
    exit 1
    ;;`),
		);

		const provider = createGithubProvider();
		await expect(provider.postReview(ref, { verdict: "approve", body: "b", comments })).rejects.toThrow(
			/part of the diff/,
		);
	});
});

describe("listUnresolvedThreads — GraphQL variable typing", () => {
	function emptyThreads(hasNextPage = false) {
		return {
			data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage, endCursor: null } } } } },
		};
	}

	test("sends owner and repo as raw strings so numeric or boolean-looking names are not coerced", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("typed.json", emptyThreads());
		fakeGhThreads();

		await createGithubProvider().listUnresolvedThreads(
			{},
			{ number: 7, repo: { host: "github.com", owner: "123", repo: "true" } },
		);

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("-f owner=123");
		expect(calls).toContain("-f repo=true");
		expect(calls).toContain("-F number=7");
	});

	test("keeps the typed placeholder flags when no repository is given", async () => {
		const log = callLogPath();
		process.env.FAKE_PR_JSON = writeJson("placeholders.json", emptyThreads());
		fakeGhThreads();

		await createGithubProvider().listUnresolvedThreads();

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("-F owner={owner}");
		expect(calls).toContain("-F repo={repo}");
	});

	test("raises PAGE_LIMIT_EXCEEDED when a thread has more comments than one page", async () => {
		process.env.FAKE_PR_JSON = writeJson("long-thread.json", {
			data: {
				repository: {
					pullRequest: {
						reviewThreads: {
							nodes: [
								{
									id: "RT_long",
									isResolved: false,
									path: "a.ts",
									line: 1,
									comments: { nodes: [], pageInfo: { hasNextPage: true } },
								},
							],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			},
		});
		fakeGhThreads();

		const caught = await cliFixtures.catchError(() => createGithubProvider().listUnresolvedThreads());

		expect((caught as ProviderError).code).toBe("PAGE_LIMIT_EXCEEDED");
	});
});

describe("listCiFailures — fetch failures", () => {
	test("an authorization failure on the log request is raised, not hidden as an empty log", async () => {
		process.env.FAKE_PR_JSON = writeJson("auth-runs.json", [
			{ total_count: 1, check_runs: [{ id: 95001, name: "CI", conclusion: "failure" }] },
		]);
		fakeGh(
			ghScript(`
  *95001*)
    echo "gh: Bad credentials (HTTP 401)" 1>&2
    exit 1
    ;;
  *"pr view"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *)
    cat "$FAKE_PR_JSON"
    exit 0
    ;;`),
		);

		const caught = await cliFixtures.catchError(() => createGithubProvider().listCiFailures({ number: 1 }));

		expect(caught).toBeInstanceOf(Error);
		expect(String((caught as Error).message)).toContain("401");
	});
});

describe("postReview — file comments", () => {
	const ref = { number: 12, repo: { host: "github.com", owner: "acme", repo: "widgets" } };
	const comments = [
		{ path: "src/a.ts", newLine: 4, body: "line note" },
		{ path: "src/b.ts", body: "file note" },
	];

	function fileScript(options: { refuseApprove?: boolean; failThread?: boolean; stalePending?: boolean } = {}): string {
		const stale = options.stalePending
			? `if [ ! -f "$FAKE_STDIN_CAPTURE.stale" ]; then : > "$FAKE_STDIN_CAPTURE.stale"; echo 'HTTP 422: User can only have one pending review per pull request' 1>&2; exit 1; fi`
			: "";
		const refuse = options.refuseApprove
			? `if grep -q '"event":"APPROVE"' "$FAKE_STDIN_CAPTURE.submit"; then echo 'HTTP 422: Can not approve your own pull request' 1>&2; exit 1; fi`
			: "";
		const thread = options.failThread ? "echo 'GraphQL: Path could not be resolved' 1>&2; exit 1" : "echo '{\"data\":{}}'; exit 0";
		return ghScript(`
  *"pr view 12"*)
    echo '{"headRefOid":"abc123"}'
    exit 0
    ;;
  *"api graphql"*)
    cat >> "$FAKE_STDIN_CAPTURE.threads"
    echo >> "$FAKE_STDIN_CAPTURE.threads"
    ${thread}
    ;;
  *"api user --jq"*)
    echo review-bot
    exit 0
    ;;
  *"--paginate"*)
    echo 55
    exit 0
    ;;
  *"--method DELETE"*)
    exit 0
    ;;
  *"reviews/77/events"*)
    cat > "$FAKE_STDIN_CAPTURE.submit"
    ${refuse}
    echo '{"html_url":"https://github.com/acme/widgets/pull/12#pullrequestreview-77"}'
    exit 0
    ;;
  *"pulls/12/reviews --method POST"*)
    cat > "$FAKE_STDIN_CAPTURE.pending"
    ${stale}
    echo '{"id":77,"node_id":"PRR_77"}'
    exit 0
    ;;`);
	}

	function capture(): string {
		const path = join(tmp("fake-gh-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = path;
		return path;
	}

	test("adds file threads to a pending review, then submits it with the verdict", async () => {
		const log = callLogPath();
		const stdin = capture();
		fakeGh(fileScript());

		const posted = await createGithubProvider().postReview(ref, { verdict: "request_changes", body: "summary", comments });

		expect(posted).toEqual({
			url: "https://github.com/acme/widgets/pull/12#pullrequestreview-77",
			verdict: "request_changes",
			degraded: false,
			commentCount: 2,
		});
		expect(JSON.parse(readFileSync(`${stdin}.pending`, "utf8"))).toEqual({
			commit_id: "abc123",
			body: "summary",
			comments: [{ path: "src/a.ts", line: 4, side: "RIGHT", body: "line note" }],
		});
		const thread = JSON.parse(readFileSync(`${stdin}.threads`, "utf8"));
		expect(thread.query).toContain("subjectType: FILE");
		expect(thread.variables).toEqual({ reviewId: "PRR_77", path: "src/b.ts", body: "file note" });
		expect(JSON.parse(readFileSync(`${stdin}.submit`, "utf8"))).toEqual({ event: "REQUEST_CHANGES", body: "summary" });
		expect(readCalls(log).filter((c) => c.startsWith("api"))).toEqual([
			"api repos/acme/widgets/pulls/12/reviews --method POST --input -",
			"api graphql --input -",
			"api repos/acme/widgets/pulls/12/reviews/77/events --method POST --input -",
		]);
	});

	test("submits the pending review as COMMENT when GitHub refuses approve on the author's own PR", async () => {
		const stdin = capture();
		fakeGh(fileScript({ refuseApprove: true }));

		const posted = await createGithubProvider().postReview(ref, { verdict: "approve", body: "summary", comments });

		expect(posted).toMatchObject({ verdict: "comment", degraded: true, commentCount: 2 });
		expect(JSON.parse(readFileSync(`${stdin}.submit`, "utf8")).event).toBe("COMMENT");
	});

	test("deletes the pending review when a file thread fails, so no half review stays behind", async () => {
		const log = callLogPath();
		capture();
		fakeGh(fileScript({ failThread: true }));

		await expect(
			createGithubProvider().postReview(ref, { verdict: "comment", body: "summary", comments }),
		).rejects.toThrow(/could not be resolved/);
		expect(readCalls(log)).toContain("api repos/acme/widgets/pulls/12/reviews/77 --method DELETE");
		expect(readCalls(log).some((c) => c.includes("/events"))).toBe(false);
	});

	test("clears a stale pending review left by a killed run, then posts again", async () => {
		const log = callLogPath();
		capture();
		fakeGh(fileScript({ stalePending: true }));

		const posted = await createGithubProvider().postReview(ref, { verdict: "comment", body: "summary", comments });

		expect(posted.url).toBe("https://github.com/acme/widgets/pull/12#pullrequestreview-77");
		const calls = readCalls(log);
		expect(calls).toContain("api repos/acme/widgets/pulls/12/reviews/55 --method DELETE");
		expect(calls.filter((c) => c === "api repos/acme/widgets/pulls/12/reviews --method POST --input -")).toHaveLength(2);
		expect(calls).toContain("api user --jq .login");
		expect(
			calls.some(
				(c) =>
					c.includes('.user.login == "review-bot"') &&
					c.includes('startswith("## Thrash review ")') &&
					c.includes("--paginate"),
			),
		).toBe(true);
	});
});

describe("replyToThread — thread without a root comment", () => {
	test("rejects with INVALID_ARGUMENT instead of posting to an undefined comment", async () => {
		fakeGh(ghScript(""));
		const thread = { ...cliFixtures.reviewThread("RT_empty", "1"), commentId: undefined };

		const caught = await cliFixtures.catchError(() =>
			createGithubProvider().replyToThread(thread, "hello", { number: 3 }),
		);

		expect((caught as ProviderError).code).toBe("INVALID_ARGUMENT");
	});
});
