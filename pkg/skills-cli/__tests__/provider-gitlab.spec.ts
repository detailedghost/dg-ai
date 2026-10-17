import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createGitlabProvider } from "../src/provider/gitlab";
import { LOG_EXCERPT_MAX_CHARS, ProviderError, truncateLogExcerpt } from "../src/provider/types";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";

cliFixtures.isolateCliTests();

const ENV_KEYS = [
	"GLAB_BIN",
	"FAKE_CALL_LOG",
	"FAKE_STDIN_CAPTURE",
	"FAKE_ARGV_CAPTURE",
	"FAKE_REPO_JSON",
	"FAKE_MR_JSON",
	"FAKE_ALL_JSON",
	"FAKE_PAGE1_JSON",
	"FAKE_PAGE2_JSON",
	"FAKE_PIPELINES_JSON",
	"FAKE_JOBS_JSON",
	"AI_VCS_GITLAB_REVIEW_BOT",
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

/** Writes a fake `glab` onto PATH. */
function fakeGlab(script: string): string {
	const dir = tmp("fake-glab-bin-");
	writeFakeCli(dir, "glab", script);
	return join(dir, "glab");
}

/** Writes a fake `glab` and points GLAB_BIN at it. */
function fakeGlabViaBin(script: string): string {
	const dir = tmp("fake-glab-bin-");
	writeFakeCli(dir, "glab", script);
	const path = join(dir, "glab");
	process.env.GLAB_BIN = path;
	return path;
}

function fakeGlabDiscussions(): string {
	return fakeGlab(
		glabScript(`
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"api projects/:id/merge_requests/"*"/discussions"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
	);
}

const HEAD_SHA = "4798a313e8e39f8067fe3b4bd6c094f20221bb57";

function headPipeline(id: number, iid = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { id, sha: HEAD_SHA, ref: `refs/merge-requests/${iid}/head`, status: "failed", ...overrides };
}

function writeJson(name: string, data: unknown): string {
	return cliFixtures.writeJson(createdDirs, "fake-glab-fixture-", name, data);
}

function callLogPath(): string {
	const path = cliFixtures.callLogPath(createdDirs, "fake-glab-log-");
	process.env.FAKE_CALL_LOG = path;
	return path;
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

const glabScript = cliFixtures.shScript;

function rawMr(n: number, state: "opened" | "closed" | "merged" | "locked", overrides: Record<string, unknown> = {}) {
	return {
		iid: n,
		title: `MR #${n}`,
		web_url: `https://gitlab.com/acme/widgets/-/merge_requests/${n}`,
		state,
		source_branch: `feature-${n}`,
		target_branch: "main",
		description: `body of MR ${n}`,
		merged_at: state === "merged" ? "2026-01-01T00:00:00Z" : null,
		...overrides,
	};
}

describe("createGitlabProvider — capabilities", () => {
	test("declares no reviewer until a GitLab reviewer is explicitly configured", () => {
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBot).toBe(false);
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
		expect(provider.capabilities.nativeStacking).toBe(false);
	});

	test("AI_VCS_GITLAB_REVIEW_BOT names the reviewer instead of the default", () => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "my_own_bot";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBot).toBe(true);
		expect(provider.capabilities.aiReviewBotNames).toEqual(["my_own_bot"]);
	});

	test("a comma-separated AI_VCS_GITLAB_REVIEW_BOT declares every reviewer, trimmed", () => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = " review_bot , gitlab_duo ";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual(["review_bot", "gitlab_duo"]);
	});

	test("AI_VCS_GITLAB_REVIEW_BOT=none declares no reviewer, restoring the proxy route", () => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "none";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBot).toBe(false);
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("an empty AI_VCS_GITLAB_REVIEW_BOT declares no reviewer rather than an unnamed one", () => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBot).toBe(false);
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("copilot is dropped from AI_VCS_GITLAB_REVIEW_BOT, since GitLab cannot have it", () => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "Copilot";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBot).toBe(false);
		expect(provider.capabilities.aiReviewBotNames).toEqual([]);
	});

	test("copilot is dropped from a list while the other reviewers are kept", () => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "copilot,review_bot";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBotNames).toEqual(["review_bot"]);
	});

	test("capabilities never shells out to glab, so it answers with no provider binary present", () => {
		process.env.GLAB_BIN = "/nonexistent/glab-does-not-exist";
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "review_bot";
		const provider = createGitlabProvider();
		expect(provider.capabilities.aiReviewBot).toBe(true);
	});
});

describe("repoInfo", () => {
	test("parses `glab repo view` output into the normalized RepoInfo shape", async () => {
		const log = callLogPath();
		process.env.FAKE_REPO_JSON = writeJson("repo.json", {
			path_with_namespace: "acme/widgets",
			namespace: { full_path: "acme" },
			path: "widgets",
			name: "widgets",
			default_branch: "main",
			web_url: "https://gitlab.com/acme/widgets",
		});
		fakeGlab(
			glabScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const info = await provider.repoInfo();

		expect(info).toEqual({ host: "gitlab.com", owner: "acme", repo: "widgets", defaultBranch: "main" });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("repo view -F json");
	});

	test("an explicit RepoRef with a nested subgroup owner targets that project", async () => {
		const log = callLogPath();
		process.env.FAKE_REPO_JSON = writeJson("repo.json", {
			path_with_namespace: "team/subteam/proj",
			namespace: { full_path: "team/subteam" },
			path: "proj",
			name: "proj",
			default_branch: "develop",
		});
		fakeGlab(
			glabScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const info = await provider.repoInfo({ host: "gitlab.com", owner: "team/subteam", repo: "proj" });

		expect(info.owner).toBe("team/subteam");
		expect(info.repo).toBe("proj");
		expect(info.defaultBranch).toBe("develop");
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("team/subteam/proj");
	});

	test("a self-hosted RepoRef.host is forwarded into the `repo view` slug, not silently dropped in favor of gitlab.com", async () => {
		const log = callLogPath();
		process.env.FAKE_REPO_JSON = writeJson("selfhosted-repo.json", {
			path_with_namespace: "acme/widgets",
			namespace: { full_path: "acme" },
			path: "widgets",
			default_branch: "main",
		});
		fakeGlab(
			glabScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.repoInfo({ host: "gitlab.example.com", owner: "acme", repo: "widgets" });

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("https://gitlab.example.com/acme/widgets");
	});
});

describe("currentPullRequest", () => {
	test("parses `glab mr view` output for the checked-out branch's MR, mapping opened -> OPEN", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("mr.json", rawMr(9001, "opened"));
		fakeGlab(
			glabScript(`
  *"mr view"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const pr = await provider.currentPullRequest();

		expect(pr).not.toBeNull();
		expect(pr).toMatchObject({
			number: 9001,
			state: "OPEN",
			headRefName: "feature-9001",
			baseRefName: "main",
			merged: false,
		});
		expect(readCalls(log)).toEqual(["mr view --output json"]);
	});

	test("returns null, not a throw, when glab reports no open MR for the current branch", async () => {
		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo 'no open merge request available for "feature-x"' 1>&2
    exit 1
    ;;`),
		);

		const provider = createGitlabProvider();
		const pr = await provider.currentPullRequest();

		expect(pr).toBeNull();
	});
});

describe("viewPullRequest", () => {
	test("looks up an MR by iid and normalizes fields via GITLAB_STATE_TO_PR_STATE and FIELD_MAP", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("mr.json", rawMr(42, "merged"));
		fakeGlab(
			glabScript(`
  *"mr view"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const pr = await provider.viewPullRequest({ number: 42 });

		expect(pr.number).toBe(42);
		expect(pr.state).toBe("MERGED");
		expect(pr.merged).toBe(true);
		expect(pr.mergedAt).toBe("2026-01-01T00:00:00Z");
		expect(pr.headRefName).toBe("feature-42");
		expect(pr.baseRefName).toBe("main");
		expect(readCalls(log)).toEqual(["mr view 42 --output json"]);
	});

	test("maps GitLab's `locked` state onto the normalized CLOSED, not left unmapped", async () => {
		process.env.FAKE_MR_JSON = writeJson("mr.json", rawMr(43, "locked"));
		fakeGlab(
			glabScript(`
  *"mr view"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const pr = await provider.viewPullRequest({ number: 43 });

		expect(pr.state).toBe("CLOSED");
		expect(pr.merged).toBe(false);
	});
});

describe("createPullRequest", () => {
	test("creates an MR with the description as one argv value and returns the normalized PullRequest", async () => {
		const argvCapture = join(tmp("fake-glab-argv-"), "description.txt");
		process.env.FAKE_ARGV_CAPTURE = argvCapture;
		process.env.FAKE_MR_JSON = writeJson(
			"mr.json",
			rawMr(9002, "opened", { title: "Add feature", source_branch: "feature-branch", target_branch: "main" }),
		);
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr create"*)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --description=*) printf '%s' "\${1#--description=}" > "$FAKE_ARGV_CAPTURE" ;;
      esac
      shift
    done
    echo "https://gitlab.com/acme/widgets/-/merge_requests/9002"
    exit 0
    ;;
  *"mr view"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const longBody = "synthetic MR description\n\nwith multiple lines\n".repeat(50);
		const pr = await provider.createPullRequest({
			title: "Add feature",
			body: longBody,
			base: "main",
			head: "feature-branch",
		});

		expect(pr.number).toBe(9002);
		expect(pr.title).toBe("Add feature");
		expect(readFileSync(argvCapture, "utf8")).toBe(longBody);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("Add feature");
		expect(calls).toContain("main");
		expect(calls).toContain("feature-branch");
	});

	test("raises a ProviderError with a PARSE_ERROR code when glab's output has no /merge_requests/<n> URL to extract", async () => {
		fakeGlab(
			glabScript(`
  *"mr create"*)
    echo "unexpected output with no merge request url"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() => provider.createPullRequest({ title: "x", body: "y", base: "main", head: "feature" }));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("PARSE_ERROR");
	});
});

describe("listUnresolvedThreads — discussions mapping", () => {
	function discussionsFixture() {
		return [
			{
				id: "disc-1",
				individual_note: false,
				notes: [
					{
						id: 501,
						body: "please fix this",
						author: { username: "alice" },
						created_at: "2026-02-01T10:00:00Z",
						resolvable: true,
						resolved: false,
					},
				],
			},
			{
				id: "disc-2",
				individual_note: false,
				notes: [
					{
						id: 502,
						body: "looks fine now",
						author: { username: "bob" },
						created_at: "2026-02-02T11:00:00Z",
						resolvable: true,
						resolved: true,
					},
				],
			},
			{
				id: "disc-3",
				individual_note: true,
				notes: [
					{
						id: 503,
						body: "just a plain comment",
						author: { username: "carol" },
						created_at: "2026-02-03T12:00:00Z",
						resolvable: false,
						resolved: false,
					},
				],
			},
		];
	}

	test("defaults to resolvable && !resolved, excluding both the resolved discussion and the non-resolvable comment", async () => {
		process.env.FAKE_MR_JSON = writeJson("discussions.json", discussionsFixture());
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads).toHaveLength(1);
		expect(threads[0]).toMatchObject({ threadId: "disc-1", resolved: false });
		expect(threads[0].comments).toEqual([
			{ id: "501", author: "alice", body: "please fix this", createdAt: "2026-02-01T10:00:00Z", diffHunk: "" },
		]);
	});

	test("includeResolved:true adds resolved discussions but still excludes the non-resolvable plain comment", async () => {
		process.env.FAKE_MR_JSON = writeJson("discussions.json", discussionsFixture());
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads({ includeResolved: true });

		expect(threads.map((t) => t.threadId).sort()).toEqual(["disc-1", "disc-2"]);
	});

	test("a discussion with multiple notes derives commentId from the FIRST note's id, not the last", async () => {
		const multiNoteFixture = [
			{
				id: "disc-multi",
				individual_note: false,
				notes: [
					{
						id: 701,
						body: "please address this",
						author: { username: "alice" },
						created_at: "2026-03-01T09:00:00Z",
						resolvable: true,
						resolved: false,
					},
					{
						id: 702,
						body: "seconding this",
						author: { username: "bob" },
						created_at: "2026-03-01T10:00:00Z",
						resolvable: true,
						resolved: false,
					},
					{
						id: 703,
						body: "still open",
						author: { username: "carol" },
						created_at: "2026-03-01T11:00:00Z",
						resolvable: true,
						resolved: false,
					},
				],
			},
		];
		process.env.FAKE_MR_JSON = writeJson("multi-note-discussion.json", multiNoteFixture);
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads).toHaveLength(1);
		expect(threads[0].commentId).toBe("701");
		expect(threads[0].commentId).not.toBe("702");
		expect(threads[0].commentId).not.toBe("703");
		expect(threads[0].comments.map((c) => c.id)).toEqual(["701", "702", "703"]);
		expect(threads[0].comments[0].author).toBe("alice");
	});

	test("rejects with NO_CURRENT_MR when there is no current MR for cwd", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo 'no open merge request available for "feature-x"' 1>&2
    exit 1
    ;;
  *"api projects/:id/merge_requests/"*"/discussions"*)
    echo '[]'
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() => provider.listUnresolvedThreads());

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("NO_CURRENT_MR");
		const calls = readCalls(log).join("\n");
		expect(calls).not.toContain("merge_requests//discussions");
	});
});

describe("resolveThread — PUT .../discussions/{id} with resolved=true", () => {
	test("resolves a discussion via the opaque threadId alone", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"api projects/:id/merge_requests/"*"/discussions"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.resolveThread("disc-1");

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("disc-1");
		expect(calls).toContain("resolved=true");
	});

	test("rejects with NO_CURRENT_MR when there is no current MR for cwd", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo 'no open merge request available for "feature-x"' 1>&2
    exit 1
    ;;
  *"api projects/:id/merge_requests/"*"/discussions"*)
    echo '{}'
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() => provider.resolveThread("disc-1"));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("NO_CURRENT_MR");
		const calls = readCalls(log).join("\n");
		expect(calls).not.toContain("merge_requests//discussions");
	});
});

describe("replyToThread — POST .../discussions/{id}/notes", () => {
	test("posts a note and returns the normalized new comment", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"api projects/:id/merge_requests/"*"/discussions/"*"/notes"*)
    echo '{"id":504,"body":"thanks, fixed","author":{"username":"dan"},"created_at":"2026-02-04T13:00:00Z"}'
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const comment = await provider.replyToThread(cliFixtures.reviewThread("disc-1", "5001"), "thanks, fixed");

		expect(comment).toEqual({
			id: "504",
			author: "dan",
			body: "thanks, fixed",
			createdAt: "2026-02-04T13:00:00Z",
			diffHunk: "",
		});
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("discussions/disc-1/notes -f body=");
	});

	test("rejects a reply with NO_CURRENT_MR when there is no current MR for cwd", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo 'no open merge request available for "feature-x"' 1>&2
    exit 1
    ;;
  *"api projects/:id/merge_requests/"*"/discussions/"*"/notes"*)
    echo '{}'
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() => provider.replyToThread(cliFixtures.reviewThread("disc-1", "5001"), "thanks"));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("NO_CURRENT_MR");
		const calls = readCalls(log).join("\n");
		expect(calls).not.toContain("merge_requests//discussions");
	});
});

describe("listCiFailures — pipeline -> pipeline jobs -> job trace chain", () => {
	function mockPipelineChain(pipelinesJson: string, jobsJson: string, caseBody: string, headSha = HEAD_SHA): void {
		fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
${caseBody}
  *"/jobs"*)
    cat "${jobsJson}"
    exit 0
    ;;
  *"/pipelines"*)
    cat "${pipelinesJson}"
    exit 0
    ;;
  *"merge_requests/"*)
    printf '{"iid":1,"sha":"%s"}' "${headSha}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
	}

	test("fetches the MR's pipeline, then that pipeline's jobs, then traces only the failed jobs", async () => {
		const log = callLogPath();
		const pipelinesJson = writeJson("pipelines.json", [headPipeline(5001, 1)]);
		const jobsJson = writeJson("jobs.json", [
			{ id: 81001, name: "build", stage: "test", status: "failed" },
			{ id: 82002, name: "lint", stage: "test", status: "success" },
		]);
		mockPipelineChain(
			pipelinesJson,
			jobsJson,
			`  *81001*)
    echo "build step 3 failed"
    exit 0
    ;;`,
		);

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toHaveLength(1);
		expect(failures[0].jobId).toBe("81001");
		expect(failures[0].name).toBe("build");
		expect(failures[0].configFile).toBe(".gitlab-ci.yml");
		expect(failures[0].executionId).toBe("5001");
		expect(failures[0].logExcerpt).toContain("build step 3 failed");
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/1/pipelines");
		expect(calls).toContain("pipelines/5001/jobs");
		expect(calls).toContain("jobs/81001/trace");
	});

	test("picks the newest pipeline by id when the MR has more than one, not just pipelines[0]", async () => {
		const log = callLogPath();
		const pipelinesJson = writeJson("pipelines-unsorted.json", [
			headPipeline(5010, 1, { status: "success" }),
			headPipeline(5012, 1),
			headPipeline(5011, 1),
		]);
		const jobsJson = writeJson("jobs-newest.json", [{ id: 81010, name: "build", stage: "test", status: "failed" }]);
		mockPipelineChain(
			pipelinesJson,
			jobsJson,
			`  *81010*)
    echo "build step 9 failed"
    exit 0
    ;;`,
		);

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures).toHaveLength(1);
		expect(failures[0].executionId).toBe("5012");
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pipelines/5012/jobs");
		expect(calls).not.toContain("pipelines/5010/jobs");
		expect(calls).not.toContain("pipelines/5011/jobs");
	});

	test("running, pending, and skipped jobs are not misreported as failures", async () => {
		const pipelinesJson = writeJson("pipelines2.json", [headPipeline(5002, 2, { status: "running" })]);
		const jobsJson = writeJson("jobs2.json", [
			{ id: 83001, name: "build", stage: "test", status: "running" },
			{ id: 83002, name: "deploy", stage: "deploy", status: "pending" },
			{ id: 83003, name: "docs", stage: "test", status: "skipped" },
			{ id: 83004, name: "e2e", stage: "test", status: "manual" },
		]);
		mockPipelineChain(pipelinesJson, jobsJson, "");

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 2 });

		expect(failures).toEqual([]);
	});

	test("one expired/unavailable trace degrades only that item's logExcerpt to empty string", async () => {
		const pipelinesJson = writeJson("pipelines3.json", [headPipeline(5003, 3)]);
		const jobsJson = writeJson("jobs3.json", [
			{ id: 84001, name: "build", stage: "test", status: "failed" },
			{ id: 84002, name: "test", stage: "test", status: "failed" },
		]);
		mockPipelineChain(
			pipelinesJson,
			jobsJson,
			`  *84001*)
    echo "build step 3 failed"
    exit 0
    ;;
  *84002*)
    echo "404 Not Found" 1>&2
    exit 1
    ;;`,
		);

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 3 });

		expect(failures).toHaveLength(2);
		const succeeded = failures.find((f) => f.jobId === "84001");
		const degraded = failures.find((f) => f.jobId === "84002");
		expect(succeeded?.logExcerpt).toContain("build step 3 failed");
		expect(degraded?.logExcerpt).toBe("");
		expect(degraded?.name).toBeTruthy();
	});

	test("a trace over LOG_EXCERPT_MAX_CHARS is truncated using the shared transform", async () => {
		const fullLog = `${"a".repeat(1000)}${"FAILURE DETAIL AT THE TAIL ".repeat(400)}`;
		expect(fullLog.length).toBeGreaterThan(LOG_EXCERPT_MAX_CHARS);
		const logFile = join(tmp("fake-glab-longlog-"), "log.txt");
		writeFileSync(logFile, fullLog);
		const pipelinesJson = writeJson("pipelines4.json", [headPipeline(5004, 4)]);
		const jobsJson = writeJson("jobs4.json", [{ id: 85001, name: "build", stage: "test", status: "failed" }]);
		mockPipelineChain(
			pipelinesJson,
			jobsJson,
			`  *85001*)
    cat "${logFile}"
    exit 0
    ;;`,
		);

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 4 });

		expect(failures).toHaveLength(1);
		expect(failures[0].logExcerpt.length).toBe(LOG_EXCERPT_MAX_CHARS);
		expect(failures[0].logExcerpt).toBe(truncateLogExcerpt(fullLog));
	});

	test("returns an empty array without attempting any per-job trace fetch when nothing failed", async () => {
		const log = callLogPath();
		const pipelinesJson = writeJson("pipelines5.json", [headPipeline(5005, 5, { status: "success" })]);
		const jobsJson = writeJson("jobs5.json", [{ id: 86001, name: "build", stage: "test", status: "success" }]);
		mockPipelineChain(pipelinesJson, jobsJson, "");

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 5 });

		expect(failures).toEqual([]);
		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("/trace"))).toBe(false);
	});

	test("returns an empty array without fetching jobs when the MR has no pipelines", async () => {
		const log = callLogPath();
		const pipelinesJson = writeJson("pipelines6.json", []);
		mockPipelineChain(pipelinesJson, writeJson("jobs6.json", []), "");

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 6 });

		expect(failures).toEqual([]);
		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("/jobs"))).toBe(false);
	});
});

describe("listCiFailures — pipeline identity guard", () => {
	const OTHER_SHA = "0f74980934b1a2c3d4e5f60718293a4b5c6d7e8f";

	/** Answers the MR, pipelines, jobs and trace routes independently. */
	function mockChain(mrJson: string, pipelinesJson: string, jobsJson: string): string {
		const log = callLogPath();
		fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"/trace"*)
    echo "job log"
    exit 0
    ;;
  *"/jobs"*)
    cat "${jobsJson}"
    exit 0
    ;;
  *"/pipelines"*)
    cat "${pipelinesJson}"
    exit 0
    ;;
  *"merge_requests/"*)
    cat "${mrJson}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		return log;
	}

	function failingJobs(id: number): string {
		return writeJson(`guard-jobs-${id}.json`, [{ id, name: "build", stage: "test", status: "failed" }]);
	}

	async function captureError(run: () => Promise<unknown>): Promise<ProviderError> {
		const caught = await cliFixtures.catchError(run);
		expect(caught).toBeInstanceOf(ProviderError);
		return caught as ProviderError;
	}

	test("skips another merge request's pipeline that shares the list, choosing this MR's head instead", async () => {
		const mrJson = writeJson("guard-mr-1.json", { iid: 7, sha: HEAD_SHA });
		const pipelinesJson = writeJson("guard-pipelines-1.json", [
			{ id: 9999, sha: OTHER_SHA, ref: "refs/merge-requests/133/head", status: "success" },
			{ id: 5100, sha: HEAD_SHA, ref: "refs/merge-requests/7/head", status: "failed" },
		]);
		const log = mockChain(mrJson, pipelinesJson, failingJobs(91001));

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 7 });

		expect(failures).toHaveLength(1);
		expect(failures[0].executionId).toBe("5100");
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pipelines/5100/jobs");
		expect(calls).not.toContain("pipelines/9999/jobs");
	});

	test("throws rather than reporting a green gate when every pipeline in the list belongs elsewhere", async () => {
		const mrJson = writeJson("guard-mr-2.json", { iid: 7, sha: HEAD_SHA });
		const pipelinesJson = writeJson("guard-pipelines-2.json", [
			{ id: 9999, sha: OTHER_SHA, ref: "refs/merge-requests/133/head", status: "success" },
		]);
		const log = mockChain(mrJson, pipelinesJson, failingJobs(91002));

		const err = await captureError(() => createGitlabProvider().listCiFailures({ number: 7 }));

		expect(err.code).toBe("PIPELINE_SHA_MISMATCH");
		expect(err.message).toContain(HEAD_SHA);
		expect(err.message).toContain("refs/merge-requests/7/head");
		expect(readCalls(log).some((c) => c.includes("/jobs"))).toBe(false);
	});

	test("a pipeline carrying the head sha on a different ref is not accepted as the head pipeline", async () => {
		const mrJson = writeJson("guard-mr-3.json", { iid: 7, sha: HEAD_SHA });
		const pipelinesJson = writeJson("guard-pipelines-3.json", [
			{ id: 5200, sha: HEAD_SHA, ref: "refs/merge-requests/7/merge", status: "success" },
			{ id: 5201, sha: HEAD_SHA, ref: "master", status: "success" },
		]);
		mockChain(mrJson, pipelinesJson, failingJobs(91003));

		const err = await captureError(() => createGitlabProvider().listCiFailures({ number: 7 }));
		expect(err.code).toBe("PIPELINE_SHA_MISMATCH");
	});

	test("fails closed when the merge request reports no head sha, rather than comparing empty to empty", async () => {
		const mrJson = writeJson("guard-mr-4.json", { iid: 7, sha: "" });
		const pipelinesJson = writeJson("guard-pipelines-4.json", [
			{ id: 5300, sha: "", ref: "refs/merge-requests/7/head", status: "success" },
		]);
		const log = mockChain(mrJson, pipelinesJson, failingJobs(91004));

		const err = await captureError(() => createGitlabProvider().listCiFailures({ number: 7 }));
		expect(err.code).toBe("EMPTY_HEAD_SHA");
		expect(readCalls(log).some((c) => c.includes("/pipelines"))).toBe(false);
	});

	test("fails closed when the merge request JSON has no sha field at all", async () => {
		const mrJson = writeJson("guard-mr-5.json", { iid: 7 });
		const pipelinesJson = writeJson("guard-pipelines-5.json", []);
		mockChain(mrJson, pipelinesJson, failingJobs(91005));

		const err = await captureError(() => createGitlabProvider().listCiFailures({ number: 7 }));
		expect(err.code).toBe("EMPTY_HEAD_SHA");
	});

	test("refuses a non-positive merge request iid before building any endpoint from it", async () => {
		const log = callLogPath();
		fakeGlab(`#!/bin/sh
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_CALL_LOG"; fi
exit 0
`);

		for (const bad of [0, -1, Number.NaN, 1.5]) {
			const err = await captureError(() => createGitlabProvider().listCiFailures({ number: bad }));
			expect(err.code).toBe("INVALID_MR_IID");
		}
		expect(readCalls(log)).toEqual([]);
	});

	test("refuses a matching pipeline whose id is unusable, rather than fetching pipelines/undefined/jobs", async () => {
		const mrJson = writeJson("guard-mr-7.json", { iid: 7, sha: HEAD_SHA });
		const pipelinesJson = writeJson("guard-pipelines-7.json", [
			{ sha: HEAD_SHA, ref: "refs/merge-requests/7/head", status: "failed" },
		]);
		const log = mockChain(mrJson, pipelinesJson, failingJobs(91007));

		const err = await captureError(() => createGitlabProvider().listCiFailures({ number: 7 }));
		expect(err.code).toBe("INVALID_PIPELINE_ID");
		expect(readCalls(log).some((c) => c.includes("/jobs"))).toBe(false);
	});

	test("refuses a matching pipeline whose id is a string rather than coercing it", async () => {
		const mrJson = writeJson("guard-mr-8.json", { iid: 7, sha: HEAD_SHA });
		const pipelinesJson = writeJson("guard-pipelines-8.json", [
			{ id: "5400", sha: HEAD_SHA, ref: "refs/merge-requests/7/head", status: "failed" },
		]);
		mockChain(mrJson, pipelinesJson, failingJobs(91008));

		const err = await captureError(() => createGitlabProvider().listCiFailures({ number: 7 }));
		expect(err.code).toBe("INVALID_PIPELINE_ID");
	});

	test("an empty MR list still returns no failures rather than throwing the mismatch", async () => {
		const mrJson = writeJson("guard-mr-6.json", { iid: 7, sha: HEAD_SHA });
		const pipelinesJson = writeJson("guard-pipelines-6.json", []);
		mockChain(mrJson, pipelinesJson, failingJobs(91006));

		const failures = await createGitlabProvider().listCiFailures({ number: 7 });
		expect(failures).toEqual([]);
	});
});

describe("glab JSON parsing — raw control characters", () => {
	test("an MR description carrying raw control characters parses instead of degrading to an empty field", async () => {
		const descriptionWithControlChars = `line one${String.fromCharCode(1)}line two${String.fromCharCode(31)}end`;
		const mrPath = join(tmp("fake-glab-ctrl-"), "mr.json");
		const encoded = JSON.stringify({
			iid: 12,
			title: "review notes",
			web_url: "https://gitlab.com/acme/widgets/-/merge_requests/12",
			state: "opened",
			source_branch: "feature-x",
			target_branch: "master",
			description: "PLACEHOLDER",
			merged_at: null,
			sha: "4798a313e8e39f8067fe3b4bd6c094f20221bb57",
		}).replace("PLACEHOLDER", descriptionWithControlChars);
		expect(() => JSON.parse(encoded)).toThrow();
		writeFileSync(mrPath, encoded);

		fakeGlab(`#!/bin/sh
cat "${mrPath}"
exit 0
`);

		const pr = await createGitlabProvider().viewPullRequest({ number: 12 });
		expect(pr.number).toBe(12);
		expect(pr.title).toBe("review notes");
		expect(pr.body).toBe("line oneline twoend");
	});

	test("raw tab, LF and CR between tokens survive the sanitizer on the public parse path", async () => {
		const mrPath = join(tmp("fake-glab-rawws-"), "mr.json");
		const body = JSON.stringify({
			iid: 14,
			title: "raw whitespace",
			web_url: "https://gitlab.com/acme/widgets/-/merge_requests/14",
			state: "opened",
			source_branch: "feature-z",
			target_branch: "master",
			description: "unchanged",
			merged_at: null,
		});
		const spaced = body.replace(/,"/g, `,${String.fromCharCode(9, 10, 13)}"`);
		expect(spaced).toContain(String.fromCharCode(9));
		expect(spaced).toContain(String.fromCharCode(13));
		writeFileSync(mrPath, spaced);

		fakeGlab(`#!/bin/sh
cat "${mrPath}"
exit 0
`);

		const pr = await createGitlabProvider().viewPullRequest({ number: 14 });
		expect(pr.number).toBe(14);
		expect(pr.title).toBe("raw whitespace");
		expect(pr.body).toBe("unchanged");
	});

	test("a description made only of removable control characters becomes empty, not a parse failure", async () => {
		const mrPath = join(tmp("fake-glab-allctrl-"), "mr.json");
		const encoded = JSON.stringify({
			iid: 15,
			title: "all controls",
			web_url: "https://gitlab.com/acme/widgets/-/merge_requests/15",
			state: "opened",
			source_branch: "feature-w",
			target_branch: "master",
			description: "PLACEHOLDER",
			merged_at: null,
		}).replace("PLACEHOLDER", String.fromCharCode(0, 1, 11, 12, 31));
		writeFileSync(mrPath, encoded);

		fakeGlab(`#!/bin/sh
cat "${mrPath}"
exit 0
`);

		const pr = await createGitlabProvider().viewPullRequest({ number: 15 });
		expect(pr.body).toBe("");
	});

	test("legal JSON whitespace between tokens survives the sanitizer", async () => {
		const mrPath = join(tmp("fake-glab-ws-"), "mr.json");
		writeFileSync(
			mrPath,
			JSON.stringify(
				{
					iid: 13,
					title: "pretty printed",
					web_url: "https://gitlab.com/acme/widgets/-/merge_requests/13",
					state: "opened",
					source_branch: "feature-y",
					target_branch: "master",
					description: "body\twith\ttabs",
					merged_at: null,
				},
				null,
				2,
			),
		);

		fakeGlab(`#!/bin/sh
cat "${mrPath}"
exit 0
`);

		const pr = await createGitlabProvider().viewPullRequest({ number: 13 });
		expect(pr.title).toBe("pretty printed");
		expect(pr.body).toBe("body\twith\ttabs");
	});
});

describe("retargetPullRequest", () => {
	test("updates the MR's target branch", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr update"*)
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.retargetPullRequest({ number: 7 }, "release/2.0");

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("mr update 7 --target-branch release/2.0");
	});
});

describe("getPullRequestBody", () => {
	test("returns the MR's description as the body text", async () => {
		process.env.FAKE_MR_JSON = writeJson("mr.json", rawMr(55, "opened", { description: "the full mr description" }));
		fakeGlab(
			glabScript(`
  *"mr view"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const body = await provider.getPullRequestBody({ number: 55 });

		expect(body).toBe("the full mr description");
	});
});

describe("setPullRequestBody", () => {
	test("pipes the new description via stdin (--description-file -), not an argv flag", async () => {
		const stdinCapture = join(tmp("fake-glab-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGlab(
			glabScript(`
  *"mr update"*)
    cat > "$FAKE_STDIN_CAPTURE" 2>/dev/null || true
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const newBody = "updated description\n".repeat(200);
		await provider.setPullRequestBody({ number: 8 }, newBody);

		expect(readFileSync(stdinCapture, "utf8")).toBe(newBody);
	});
});

describe("closePullRequest", () => {
	test("closes the MR by iid", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr close"*)
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.closePullRequest({ number: 13 });

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("mr close 13");
	});
});

describe("listPullRequests", () => {
	test("normalizes a small MR listing via GITLAB_STATE_TO_PR_STATE and FIELD_MAP", async () => {
		process.env.FAKE_MR_JSON = writeJson("mrs.json", [rawMr(1, "opened"), rawMr(2, "merged"), rawMr(3, "closed")]);
		fakeGlab(
			glabScript(`
  *"mr list"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const result = await provider.listPullRequests({});

		expect(result).toHaveLength(3);
		const merged = result.find((r) => r.number === 2);
		expect(merged?.state).toBe("MERGED");
		expect(merged?.merged).toBe(true);
		const closed = result.find((r) => r.number === 3);
		expect(closed?.state).toBe("CLOSED");
		expect(closed?.merged).toBe(false);
	});
});

describe("listUnresolvedThreads — pagination", () => {
	test("collects a --paginate response that spans more than one 20-item discussions page", async () => {
		const page1 = Array.from({ length: 20 }, (_, i) => ({
			id: `disc-${i + 1}`,
			individual_note: false,
			notes: [
				{
					id: 600 + i,
					body: `comment ${i + 1}`,
					author: { username: "alice" },
					created_at: "2026-03-01T00:00:00Z",
					resolvable: true,
					resolved: false,
				},
			],
		}));
		const page2 = Array.from({ length: 5 }, (_, i) => ({
			id: `disc-${i + 21}`,
			individual_note: false,
			notes: [
				{
					id: 700 + i,
					body: `comment ${i + 21}`,
					author: { username: "bob" },
					created_at: "2026-03-02T00:00:00Z",
					resolvable: true,
					resolved: false,
				},
			],
		}));
		const all = [...page1, ...page2];
		process.env.FAKE_ALL_JSON = writeJson("all.json", all);
		const log = callLogPath();

		fakeGlab(
			glabScript(`
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"--paginate"*)
    cat "$FAKE_ALL_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads).toHaveLength(25);
		expect(threads.map((t) => t.threadId).sort()).toEqual(all.map((d) => d.id).sort());
		expect(threads.map((t) => t.threadId)).toContain("disc-25");
		expect(readCalls(log).join("\n")).toContain("--paginate");
	});
});

describe("listPullRequests — explicit page-walking pagination", () => {
	test("collects an MR listing that spans more than one 100-item page", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => rawMr(i + 1, i === 99 ? "merged" : "opened"));
		const page2 = Array.from({ length: 30 }, (_, i) => rawMr(i + 101, "opened"));
		process.env.FAKE_PAGE1_JSON = writeJson("page1.json", page1);
		process.env.FAKE_PAGE2_JSON = writeJson("page2.json", page2);
		const log = callLogPath();

		fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"--page 1"*)
    cat "$FAKE_PAGE1_JSON"
    exit 0
    ;;
  *"--page 2"*)
    cat "$FAKE_PAGE2_JSON"
    exit 0
    ;;
  *"--page 3"*)
    echo "[]"
    exit 0
    ;;
  *)
    echo "[]"
    exit 0
    ;;
esac
`);

		const provider = createGitlabProvider();
		const result = await provider.listPullRequests({});

		expect(result).toHaveLength(130);
		const merged = result.find((r) => r.number === 100);
		expect(merged?.merged).toBe(true);
		expect(merged?.state).toBe("MERGED");
		const notMerged = result.find((r) => r.number === 1);
		expect(notMerged?.merged).toBe(false);
		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("--page 1"))).toBe(true);
		expect(calls.some((c) => c.includes("--page 2"))).toBe(true);
		expect(calls.some((c) => c.includes("--page 3"))).toBe(false);
	});
});

describe("listPullRequests — opts.limit and filter flags", () => {
	test("opts.limit slices the fully-collected result down after pagination, not before", async () => {
		process.env.FAKE_MR_JSON = writeJson(
			"limit-mrs.json",
			Array.from({ length: 5 }, (_, i) => rawMr(i + 1, "opened")),
		);
		fakeGlab(
			glabScript(`
  *"mr list"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const result = await provider.listPullRequests({ limit: 2 });

		expect(result).toHaveLength(2);
		expect(result.map((r) => r.number)).toEqual([1, 2]);
	});

	test("forwards opts.author and opts.label to `glab mr list` as flags", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("filter-mrs.json", []);
		fakeGlab(
			glabScript(`
  *"mr list"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.listPullRequests({ author: "renovate-bot", label: "dependencies" });

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("--author renovate-bot");
		expect(calls).toContain("--label dependencies");
	});

	test("maps opts.state to glab flags, with OPEN needing none", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("filter-mrs-state.json", []);
		fakeGlab(
			glabScript(`
  *"mr list"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.listPullRequests({ state: "OPEN" });
		await provider.listPullRequests({ state: "CLOSED" });
		await provider.listPullRequests({ state: "MERGED" });
		await provider.listPullRequests({});

		const calls = readCalls(log);
		expect(calls.some((c) => c.includes("--state"))).toBe(false);
		expect(calls.some((c) => c.includes("--closed"))).toBe(true);
		expect(calls.some((c) => c.includes("--merged"))).toBe(true);
		expect(calls.some((c) => c.includes("--all"))).toBe(true);
	});

	test("opts.head is forwarded as `--source-branch`", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("filter-mrs-head.json", []);
		fakeGlab(
			glabScript(`
  *"mr list"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.listPullRequests({ head: "feature-branch" });

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("--source-branch feature-branch");
	});
});

describe("checkAuth", () => {
	test("resolves true when `glab auth status` exits 0", async () => {
		fakeGlab(
			glabScript(`
  *"auth status"*)
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		expect(await provider.checkAuth()).toBe(true);
	});

	test("resolves false, not a throw, when `glab auth status` exits non-zero", async () => {
		fakeGlab(
			glabScript(`
  *"auth status"*)
    echo "not logged in" 1>&2
    exit 1
    ;;`),
		);

		const provider = createGitlabProvider();
		expect(await provider.checkAuth()).toBe(false);
	});
});

describe("preflight — missing glab binary", () => {
	test("a missing glab binary raises a readable ProviderError with the GLAB_NOT_FOUND code", async () => {
		process.env.GLAB_BIN = "/nonexistent/definitely-missing-glab-binary";

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() => provider.repoInfo());

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("GLAB_NOT_FOUND");
		const message = (caught as Error).message;
		expect(message).not.toMatch(/ENOENT/i);
		expect(message).toMatch(/glab/i);
		expect(message).toMatch(/not found|missing|install/i);
	});


	test("GLAB_BIN, when set to a working fake binary, is honored in place of a bare 'glab' on PATH", async () => {
		process.env.FAKE_REPO_JSON = writeJson("repo.json", {
			path_with_namespace: "acme/widgets",
			path: "widgets",
			default_branch: "main",
		});
		fakeGlab(`#!/bin/sh
echo "wrong binary invoked: this PATH glab must never run" 1>&2
exit 1
`);
		fakeGlabViaBin(
			glabScript(`
  *"repo view"*)
    cat "$FAKE_REPO_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const info = await provider.repoInfo();

		expect(info.repo).toBe("widgets");
	});
});

describe("listPullRequests — cross-provider state vocabulary", () => {
	test("an unrecognized state is rejected with a coded ProviderError rather than forwarded to glab", async () => {
		fakeGlab(glabScript(""));

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() => provider.listPullRequests({ state: "banana" }));

		expect(caught).toBeInstanceOf(ProviderError);
		expect((caught as ProviderError).code).toBe("INVALID_PR_STATE");
	});
});

describe("listUnresolvedThreads — file anchor from the discussion position", () => {
	function positionedFixture() {
		return [
			{
				id: "disc-anchored",
				notes: [
					{
						id: 801,
						body: "off by one here",
						author: { username: "alice" },
						created_at: "2026-02-01T10:00:00Z",
						resolvable: true,
						resolved: false,
						position: {
							new_path: "src/parser.ts",
							old_path: "src/parser.ts",
							new_line: 42,
							old_line: 40,
							position_type: "text",
						},
					},
				],
			},
			{
				id: "disc-deleted-line",
				notes: [
					{
						id: 802,
						body: "this removal is wrong",
						author: { username: "bob" },
						created_at: "2026-02-01T11:00:00Z",
						resolvable: true,
						resolved: false,
						position: { new_path: null, old_path: "src/gone.ts", new_line: null, old_line: 17 },
					},
				],
			},
			{
				id: "disc-overview",
				notes: [
					{
						id: 803,
						body: "general note on the MR",
						author: { username: "carol" },
						created_at: "2026-02-01T12:00:00Z",
						resolvable: true,
						resolved: false,
					},
				],
			},
		];
	}

	test("maps position.new_path and new_line onto the thread's path and line", async () => {
		process.env.FAKE_MR_JSON = writeJson("positioned.json", positionedFixture());
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		const anchored = threads.find((t) => t.threadId === "disc-anchored");
		expect(anchored?.path).toBe("src/parser.ts");
		expect(anchored?.line).toBe(42);
	});

	test("falls back to old_path and old_line for a comment on a deleted line", async () => {
		process.env.FAKE_MR_JSON = writeJson("positioned.json", positionedFixture());
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		const deleted = threads.find((t) => t.threadId === "disc-deleted-line");
		expect(deleted?.path).toBe("src/gone.ts");
		expect(deleted?.line).toBe(17);
	});

	test("reports an overview discussion with no position as an empty path and a null line", async () => {
		process.env.FAKE_MR_JSON = writeJson("positioned.json", positionedFixture());
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		const overview = threads.find((t) => t.threadId === "disc-overview");
		expect(overview?.path).toBe("");
		expect(overview?.line).toBeNull();
	});

	test("leaves diffHunk empty on every thread, since the discussions API carries a position but no hunk text", async () => {
		process.env.FAKE_MR_JSON = writeJson("positioned.json", positionedFixture());
		fakeGlabDiscussions();

		const provider = createGitlabProvider();
		const threads = await provider.listUnresolvedThreads();

		expect(threads.flatMap((t) => t.comments).every((c) => c.diffHunk === "")).toBe(true);
	});

	test("an explicit ref targets that MR's discussions without shelling out to resolve the current branch", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("positioned.json", positionedFixture());
		fakeGlab(
			glabScript(`
  *"api projects/"*"/merge_requests/"*"/discussions"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.listUnresolvedThreads(
			{},
			{ number: 77, repo: { host: "gitlab.com", owner: "acme", repo: "widgets" } },
		);

		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/77/discussions");
		expect(calls).toContain("acme%2Fwidgets");
		expect(calls).not.toContain("mr view");
	});
});

describe("listCiFailures — link to the failing job", () => {
	function pipelineChain(pipelinesJson: string, jobsJson: string): void {
		process.env.FAKE_PIPELINES_JSON = pipelinesJson;
		process.env.FAKE_JOBS_JSON = jobsJson;
		fakeGlab(
			glabScript(`
  *"/merge_requests/"*"/pipelines"*)
    cat "$FAKE_PIPELINES_JSON"
    exit 0
    ;;
  *"/pipelines/"*"/jobs"*)
    cat "$FAKE_JOBS_JSON"
    exit 0
    ;;
  *"/jobs/"*"/trace"*)
    echo "job failed"
    exit 0
    ;;
  *"/merge_requests/"*)
    printf '{"iid":1,"sha":"%s"}' "${HEAD_SHA}"
    exit 0
    ;;`),
		);
	}

	test("carries the job's web_url through as url, matching what the GitHub adapter reports", async () => {
		pipelineChain(
			writeJson("pipelines-url.json", [headPipeline(5001)]),
			writeJson("jobs-url.json", [
				{
					id: 81001,
					name: "build",
					stage: "test",
					status: "failed",
					web_url: "https://gitlab.com/acme/widgets/-/jobs/81001",
				},
			]),
		);

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures[0].url).toBe("https://gitlab.com/acme/widgets/-/jobs/81001");
	});

	test("reports an empty url rather than undefined when the job payload carries no web_url", async () => {
		pipelineChain(
			writeJson("pipelines-nourl.json", [headPipeline(5001)]),
			writeJson("jobs-nourl.json", [{ id: 81002, name: "build", stage: "test", status: "failed" }]),
		);

		const provider = createGitlabProvider();
		const failures = await provider.listCiFailures({ number: 1 });

		expect(failures[0].url).toBe("");
	});
});

describe("closePullRequest — closing comment", () => {
	test("posts the comment as its own note BEFORE closing, so it is there when anyone sees the closure", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"/notes"*)
    echo '{"id":900}'
    exit 0
    ;;
  *"mr close"*)
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.closePullRequest({ number: 13 }, "Included in combined deps branch: drb/chore/deps");

		const calls = readCalls(log);
		expect(calls).toHaveLength(2);
		expect(calls[0]).toContain("merge_requests/13/notes");
		expect(calls[0]).toContain("body=Included in combined deps branch: drb/chore/deps");
		expect(calls[1]).toContain("mr close 13");
	});

	test("makes no note call at all when no comment is given", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr close"*)
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		await provider.closePullRequest({ number: 13 });

		const calls = readCalls(log);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toContain("mr close 13");
		expect(calls.join("\n")).not.toContain("/notes");
	});
});

describe("fetchDiff", () => {
	test("shells `glab mr diff <iid> --raw -R owner/repo` and returns stdout verbatim", async () => {
		const log = callLogPath();
		fakeGlab(
			glabScript(`
  *"mr diff 7 --raw"*)
    printf 'diff --git a/x b/x\\n--- a/x\\n+++ b/x\\n@@ -1 +1 @@\\n-a\\n+b\\n'
    exit 0
    ;;`),
		);

		const provider = createGitlabProvider();
		const diff = await provider.fetchDiff({ number: 7, repo: { host: "gitlab.com", owner: "acme", repo: "widgets" } });

		expect(diff).toStartWith("diff --git a/x b/x");
		expect(readCalls(log)).toEqual(["mr diff 7 --raw -R acme/widgets"]);
	});
});

describe("postReview — draft notes, bulk_publish, approve", () => {
	const ref = { number: 7, repo: { host: "gitlab.com", owner: "acme", repo: "widgets" } };
	const MR =
		'{"web_url":"https://gitlab.com/acme/widgets/-/merge_requests/7","diff_refs":{"base_sha":"b1","start_sha":"s1","head_sha":"h1"}}';
	const comments = [
		{ path: "src/a.ts", newLine: 4, oldLine: 3, body: "context line" },
		{ path: "new/name.ts", oldPath: "old/name.ts", newLine: 2, body: "renamed" },
	];

	function reviewScript(opts: { approveFails?: boolean; mrJson?: string; failDraftContaining?: string } = {}): string {
		const failDraft = opts.failDraftContaining
			? `case "$BODY" in *${opts.failDraftContaining}*) echo 'HTTP 500 Internal Server Error' 1>&2; exit 1 ;; esac`
			: "";
		return glabScript(`
  *"draft_notes -X POST"*)
    BODY=$(cat)
    ${failDraft}
    printf '%s\\n' "$BODY" >> "$FAKE_STDIN_CAPTURE"
    echo '{"id":1}'
    exit 0
    ;;
  *"bulk_publish"*)
    cat >> "$FAKE_STDIN_CAPTURE"; printf '\\n' >> "$FAKE_STDIN_CAPTURE"
    exit 0
    ;;
  *"/approve"*)
    ${opts.approveFails ? "echo '401 Unauthorized' 1>&2; exit 1" : "echo '{}'; exit 0"}
    ;;
  *"merge_requests/7")
    echo '${opts.mrJson ?? MR}'
    exit 0
    ;;`);
	}

	function stdinLines(path: string): Array<Record<string, unknown>> {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => JSON.parse(l));
	}

	test("creates one positioned draft per comment, publishes with reviewed state, then approves", async () => {
		const log = callLogPath();
		const stdinCapture = join(tmp("fake-glab-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGlab(reviewScript());

		const provider = createGitlabProvider();
		const posted = await provider.postReview(ref, { verdict: "approve", body: "summary", comments });

		expect(posted).toEqual({
			url: "https://gitlab.com/acme/widgets/-/merge_requests/7",
			verdict: "approve",
			degraded: false,
			commentCount: 2,
		});
		const [draft1, draft2, publish] = stdinLines(stdinCapture);
		expect(draft1).toEqual({
			note: "context line",
			position: {
				position_type: "text",
				base_sha: "b1",
				start_sha: "s1",
				head_sha: "h1",
				new_path: "src/a.ts",
				old_path: "src/a.ts",
				new_line: 4,
				old_line: 3,
			},
		});
		expect(draft2.position).toMatchObject({ new_path: "new/name.ts", old_path: "old/name.ts", new_line: 2 });
		expect(draft2.position).not.toHaveProperty("old_line");
		expect(publish).toEqual({ note: "summary", reviewer_state: "reviewed" });
		const calls = readCalls(log);
		expect(
			calls.filter((c) => c.includes("draft_notes -X POST --input - -H Content-Type: application/json")),
		).toHaveLength(2);
		expect(
			calls.filter((c) => c.endsWith("draft_notes/bulk_publish -X POST --input - -H Content-Type: application/json")),
		).toHaveLength(1);
		expect(calls.filter((c) => c.endsWith("merge_requests/7/approve -X POST"))).toHaveLength(1);
		expect(calls[0]).toBe("api projects/acme%2Fwidgets/merge_requests/7");
	});

	test("a failing second draft rejects without publishing the drafts already created", async () => {
		const log = callLogPath();
		const stdinCapture = join(tmp("fake-glab-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGlab(reviewScript({ failDraftContaining: "renamed" }));

		const provider = createGitlabProvider();
		const caught = await cliFixtures.catchError(() =>
			provider.postReview(ref, { verdict: "approve", body: "summary", comments }),
		);

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("500");
		expect(stdinLines(stdinCapture)).toHaveLength(1);
		const calls = readCalls(log);
		expect(calls.filter((c) => c.includes("draft_notes -X POST"))).toHaveLength(2);
		expect(calls.some((c) => c.includes("bulk_publish"))).toBe(false);
		expect(calls.some((c) => c.endsWith("/approve -X POST"))).toBe(false);
	});

	test("request_changes publishes with requested_changes and never calls approve", async () => {
		const log = callLogPath();
		const stdinCapture = join(tmp("fake-glab-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGlab(reviewScript());

		const provider = createGitlabProvider();
		const posted = await provider.postReview(ref, { verdict: "request_changes", body: "summary", comments: [] });

		expect(posted.verdict).toBe("request_changes");
		expect(stdinLines(stdinCapture)).toEqual([{ note: "summary", reviewer_state: "requested_changes" }]);
		expect(readCalls(log).some((c) => c.includes("/approve"))).toBe(false);
	});

	test("comment publishes with no reviewer_state", async () => {
		const stdinCapture = join(tmp("fake-glab-stdin-"), "stdin.txt");
		process.env.FAKE_STDIN_CAPTURE = stdinCapture;
		fakeGlab(reviewScript());

		const provider = createGitlabProvider();
		await provider.postReview(ref, { verdict: "comment", body: "summary", comments: [] });

		expect(stdinLines(stdinCapture)).toEqual([{ note: "summary" }]);
	});

	test("reports degraded when the drafts publish but approve is refused", async () => {
		process.env.FAKE_STDIN_CAPTURE = join(tmp("fake-glab-stdin-"), "stdin.txt");
		fakeGlab(reviewScript({ approveFails: true }));

		const provider = createGitlabProvider();
		const posted = await provider.postReview(ref, { verdict: "approve", body: "summary", comments });

		expect(posted).toMatchObject({ verdict: "comment", degraded: true, commentCount: 2 });
	});

	test("fails with PARSE_ERROR before posting anything when diff_refs is missing", async () => {
		const log = callLogPath();
		process.env.FAKE_STDIN_CAPTURE = join(tmp("fake-glab-stdin-"), "stdin.txt");
		fakeGlab(reviewScript({ mrJson: '{"web_url":"u"}' }));

		const provider = createGitlabProvider();
		await expect(provider.postReview(ref, { verdict: "approve", body: "s", comments })).rejects.toMatchObject({
			code: "PARSE_ERROR",
		});
		expect(readCalls(log)).toHaveLength(1);
	});
});

describe("createPullRequest — empty body", () => {
	test("glues --description= so an empty body cannot swallow the next flag", async () => {
		const log = callLogPath();
		process.env.FAKE_MR_JSON = writeJson("empty-body-mr.json", rawMr(9100, "opened"));
		fakeGlab(
			glabScript(`
  *"mr create"*)
    echo "https://gitlab.com/acme/widgets/-/merge_requests/9100"
    exit 0
    ;;
  *"mr view"*)
    cat "$FAKE_MR_JSON"
    exit 0
    ;;`),
		);

		await createGitlabProvider().createPullRequest(
			{ title: "t", body: "", base: "main", head: "feature" },
			{ host: "gitlab.com", owner: "acme", repo: "widgets" },
		);

		const create = readCalls(log).find((c) => c.startsWith("mr create")) ?? "";
		expect(create).toContain("--description= ");
		expect(create).toContain("-R acme/widgets");
	});
});

describe("listIssues — paging past one page", () => {
	test("pages through results until the requested limit is reached", async () => {
		const page = (start: number, count: number) =>
			Array.from({ length: count }, (_, i) => ({ iid: start + i, title: `i${start + i}`, state: "opened" }));
		process.env.FAKE_PAGE1_JSON = writeJson("issues-page1.json", page(1, 100));
		process.env.FAKE_PAGE2_JSON = writeJson("issues-page2.json", page(101, 100));
		const log = callLogPath();
		fakeGlab(`#!/bin/sh
ARGS="$*"
printf '%s\n' "$ARGS" >> "$FAKE_CALL_LOG"
case "$ARGS" in
  *"--page 1"*) cat "$FAKE_PAGE1_JSON" ;;
  *"--page 2"*) cat "$FAKE_PAGE2_JSON" ;;
  *) echo "[]" ;;
esac
`);

		const issues = await createGitlabProvider().listIssues({ limit: 150 });

		expect(issues).toHaveLength(150);
		expect(issues.at(-1)?.number).toBe(150);
		const calls = readCalls(log);
		expect(calls.every((c) => c.includes("--per-page 100"))).toBe(true);
		expect(calls).toHaveLength(2);
	});
});

describe("thread targeting", () => {
	test("a ref naming another repository must carry its own merge request number", async () => {
		const log = callLogPath();
		fakeGlab(glabScript(""));

		const caught = await cliFixtures.catchError(() =>
			createGitlabProvider().listUnresolvedThreads(
				{},
				{ repo: { host: "gitlab.com", owner: "other", repo: "project" } } as never,
			),
		);

		expect((caught as ProviderError).code).toBe("INVALID_ARGUMENT");
		expect(readCalls(log)).toEqual([]);
	});
});

describe("listCiFailures — trace fetch failures", () => {
	test("a server error on the trace request is raised, not hidden as an empty log", async () => {
		const headSha = HEAD_SHA;
		const mrJson = writeJson("trace-mr.json", { sha: headSha });
		const pipelinesJson = writeJson("trace-pipelines.json", [headPipeline(5001)]);
		const jobsJson = writeJson("trace-jobs.json", [{ id: 86001, name: "build", status: "failed", web_url: "u" }]);
		fakeGlab(
			glabScript(`
  *"/trace"*)
    echo "500 Internal Server Error" 1>&2
    exit 1
    ;;
  *"/jobs"*)
    cat "${jobsJson}"
    exit 0
    ;;
  *"/pipelines"*)
    cat "${pipelinesJson}"
    exit 0
    ;;
  *"merge_requests/1"*)
    cat "${mrJson}"
    exit 0
    ;;`),
		);

		const caught = await cliFixtures.catchError(() => createGitlabProvider().listCiFailures({ number: 1 }));

		expect(String((caught as Error).message)).toContain("500");
	});
});

describe("JSON parsing — raw whitespace inside string literals", () => {
	test("a raw newline and tab inside a description are escaped instead of failing the parse", async () => {
		const mrPath = join(tmp("fake-glab-rawstr-"), "mr.json");
		const encoded = JSON.stringify({
			iid: 31,
			title: "raw string whitespace",
			web_url: "https://gitlab.com/acme/widgets/-/merge_requests/31",
			state: "opened",
			source_branch: "f",
			target_branch: "main",
			description: "PLACEHOLDER",
			merged_at: null,
		}).replace("PLACEHOLDER", `first${String.fromCharCode(10)}second${String.fromCharCode(9)}third`);
		expect(() => JSON.parse(encoded)).toThrow();
		writeFileSync(mrPath, encoded);
		fakeGlab(`#!/bin/sh
cat "${mrPath}"
exit 0
`);

		const pr = await createGitlabProvider().viewPullRequest({ number: 31 });

		expect(pr.body).toBe("first\nsecond\tthird");
	});
});

describe("merge request iid validation", () => {
	test.each([
		["fetchDiff", (p: ReturnType<typeof createGitlabProvider>) => p.fetchDiff({ number: Number.NaN })],
		["retargetPullRequest", (p: ReturnType<typeof createGitlabProvider>) => p.retargetPullRequest({ number: 0 }, "main")],
		["setPullRequestBody", (p: ReturnType<typeof createGitlabProvider>) => p.setPullRequestBody({ number: -1 }, "b")],
		["closePullRequest", (p: ReturnType<typeof createGitlabProvider>) => p.closePullRequest({ number: 1.5 })],
		["viewPullRequest", (p: ReturnType<typeof createGitlabProvider>) => p.viewPullRequest({ number: 0 })],
	])("%s fails closed on a junk number before shelling out", async (_name, call) => {
		const log = callLogPath();
		fakeGlab(glabScript(""));

		const caught = await cliFixtures.catchError(() => call(createGitlabProvider()));

		expect((caught as ProviderError).code).toBe("INVALID_MR_IID");
		expect(readCalls(log)).toEqual([]);
	});
});

describe("postReview — failure handling", () => {
	const ref = { number: 7, repo: { host: "gitlab.com", owner: "acme", repo: "widgets" } };
	const comments = [
		{ path: "a.ts", newLine: 1, body: "one" },
		{ path: "b.ts", newLine: 2, body: "two" },
	];
	const MR_WITH_CONTROL_CHAR = `{"web_url":"https://gitlab.com/acme/widgets/-/merge_requests/7","description":"a${String.fromCharCode(1)}b","diff_refs":{"base_sha":"b1","start_sha":"s1","head_sha":"h1"}}`;

	function script(opts: { failPublish?: boolean; approveError?: string } = {}): string {
		return glabScript(`
  *"draft_notes -X POST"*)
    cat > /dev/null
    echo '{"id":11}'
    exit 0
    ;;
  *"-X DELETE"*)
    exit 0
    ;;
  *"bulk_publish"*)
    cat > /dev/null
    ${opts.failPublish ? "echo '500 Internal Server Error' 1>&2; exit 1" : "exit 0"}
    ;;
  *"/approve"*)
    ${opts.approveError ? `echo '${opts.approveError}' 1>&2; exit 1` : "echo '{}'; exit 0"}
    ;;
  *"merge_requests/7")
    echo '${MR_WITH_CONTROL_CHAR}'
    exit 0
    ;;`);
	}

	test("a failed bulk_publish deletes every draft it created before rethrowing", async () => {
		const log = callLogPath();
		fakeGlab(script({ failPublish: true }));

		const caught = await cliFixtures.catchError(() =>
			createGitlabProvider().postReview(ref, { verdict: "comment", body: "s", comments }),
		);

		expect(String((caught as Error).message)).toContain("500");
		const deletes = readCalls(log).filter((c) => c.includes("-X DELETE"));
		expect(deletes).toHaveLength(2);
		expect(deletes.every((c) => /draft_notes\/\d+ -X DELETE/.test(c))).toBe(true);
	});

	test("an approve failure that is not an authorization refusal is raised, not degraded", async () => {
		fakeGlab(script({ approveError: "503 Service Unavailable" }));

		const caught = await cliFixtures.catchError(() =>
			createGitlabProvider().postReview(ref, { verdict: "approve", body: "s", comments: [] }),
		);

		expect(String((caught as Error).message)).toContain("503");
	});

	test("an authorization refusal on approve still degrades to a comment", async () => {
		fakeGlab(script({ approveError: "403 Forbidden" }));

		const posted = await createGitlabProvider().postReview(ref, { verdict: "approve", body: "s", comments: [] });

		expect(posted).toMatchObject({ verdict: "comment", degraded: true });
	});

	test("an MR payload carrying a raw control character still parses", async () => {
		fakeGlab(script());

		const posted = await createGitlabProvider().postReview(ref, { verdict: "comment", body: "s", comments: [] });

		expect(posted.url).toBe("https://gitlab.com/acme/widgets/-/merge_requests/7");
	});
});

describe("viewPullRequest — inherited state names", () => {
	test("an inherited object key as the state maps to CLOSED, not a function", async () => {
		const mrPath = writeJson("inherited-state.json", rawMr(41, "opened", { state: "constructor" }));
		fakeGlab(`#!/bin/sh
cat "${mrPath}"
exit 0
`);

		const pr = await createGitlabProvider().viewPullRequest({ number: 41 });

		expect(pr.state).toBe("CLOSED");
	});
});
