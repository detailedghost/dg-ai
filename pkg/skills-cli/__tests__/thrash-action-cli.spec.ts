import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";

cliFixtures.isolateCliTests();
const CLI = join(import.meta.dir, "../src/index.ts");
const URL = "https://github.com/acme/widgets/pull/12";
const createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture() {
	const dir = cliFixtures.tmp(createdDirs, "thrash-action-");
	const head = join(dir, "head");
	const capture = join(dir, "posted.json");
	const event = join(dir, "event.json");
	writeFileSync(head, "abc123");
	writeFileSync(
		event,
		JSON.stringify({
			pull_request: {
				number: 12,
				html_url: URL,
				base: { sha: "base123" },
				head: { repo: { full_name: "acme/widgets" } },
			},
		}),
	);
	writeFakeCli(
		dir,
		"gh",
		cliFixtures.shScript(`
  *"--version"*) echo 'gh version 2.0.0' ;;
  *"pr view 12"*"headRefOid"*) printf '{"headRefOid":"%s"}' "$(cat "$FAKE_HEAD")" ;;
  *"pr view 12"*) echo '{"number":12,"title":"change","body":"","headRefName":"feature","baseRefName":"main"}' ;;
  *"pr diff 12"*)
    if [ "$FAKE_BIG_LOCK" = 1 ]; then
      printf 'diff --git a/go.sum b/go.sum\n--- a/go.sum\n+++ b/go.sum\n@@ -0,0 +1,3001 @@\n'
      i=0; while [ $i -lt 3001 ]; do echo "+line $i"; i=$((i+1)); done
      exit 0
    fi
    printf 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
    if [ "$FAKE_PUSH_DURING_DIFF" = 1 ]; then printf def456 > "$FAKE_HEAD"; fi
    ;;
  *"api graphql"*) echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false}}}}}}' ;;
  *"contents/"*) echo 'HTTP 404: Not Found' >&2; exit 1 ;;
  *"pulls/12/reviews"*"--method POST"*)
    cat > "$FAKE_CAPTURE"
    echo '{"html_url":"${URL}#pullrequestreview-1"}'
    ;;
  *"pulls/12/reviews"*) echo '[[]]' ;;
  *"pulls/12"*) printf '{"head":{"sha":"%s"}}' "$(cat "$FAKE_HEAD")" ;;
  *"api user"*) echo '{"login":"thrashley[bot]"}' ;;
  *) echo "unexpected gh call: $ARGS" >&2; exit 1 ;;
`),
	);
	const env = {
		...process.env,
		GH_BIN: join(dir, "gh"),
		GITHUB_REPOSITORY: "acme/widgets",
		GITHUB_EVENT_PATH: event,
		THRASHLEY_WORK: dir,
		THRASHLEY_POLICY: ".github/missing.yml",
		THRASHLEY_DRY_RUN: "false",
		DG_THRASH_DRY_RUN: "0",
		FAKE_HEAD: head,
		FAKE_CAPTURE: capture,
	};
	function run(phase: string, extra: Record<string, string> = {}) {
		const result = Bun.spawnSync(
			[process.execPath, CLI, "thrash", "action", phase],
			{
				cwd: dir,
				env: { ...env, ...extra },
			},
		);
		return {
			code: result.exitCode,
			output: result.stdout.toString() + result.stderr.toString(),
		};
	}
	function prepared() {
		const result = run("prepare");
		expect(result.code, result.output).toBe(0);
		const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
		for (const chunk of state.plan.chunks) {
			writeFileSync(chunk.findingsPath, '```json\n{"findings":[]}\n```');
		}
		return state;
	}
	return { dir, head, capture, run, prepared };
}

describe("thrash action commit binding", () => {
	test("prepare saves the head associated with its diff", () => {
		const f = fixture();
		expect(f.prepared().headSha).toBe("abc123");
	});

	test("prepare rejects a push while fetching the diff", () => {
		const f = fixture();
		const result = f.run("prepare", { FAKE_PUSH_DURING_DIFF: "1" });
		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("head changed");
		expect(existsSync(join(f.dir, "state.json"))).toBe(false);
	});

	test("publish pins the review to the prepared head", () => {
		const f = fixture();
		f.prepared();
		const result = f.run("publish");
		expect(result.code, result.output).toBe(0);
		expect(JSON.parse(readFileSync(f.capture, "utf8"))).toMatchObject({
			commit_id: "abc123",
			event: "APPROVE",
		});
	});

	test("publish refuses a newer head without posting", () => {
		const f = fixture();
		f.prepared();
		writeFileSync(f.head, "def456");
		const result = f.run("publish");
		expect(result.code, result.output).toBe(1);
		expect(result.output).toContain("head changed");
		expect(existsSync(f.capture)).toBe(false);
	});

	test("prepare skips a diff with no reviewable chunks and publish posts nothing", () => {
		const f = fixture();
		const outputFile = join(f.dir, "output.txt");
		const result = f.run("prepare", {
			FAKE_BIG_LOCK: "1",
			GITHUB_OUTPUT: outputFile,
		});
		expect(result.code, result.output).toBe(0);
		expect(readFileSync(outputFile, "utf8")).toContain("skipped=true");
		expect(
			JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8")),
		).toMatchObject({ skipped: true, reason: "no reviewable changes" });
		const published = f.run("publish");
		expect(published.code, published.output).toBe(0);
		expect(existsSync(f.capture)).toBe(false);
	});
});

const MR_URL = "https://gitlab.com/acme/widgets/-/merge_requests/12";

function gitlabFixture() {
	const dir = cliFixtures.tmp(createdDirs, "thrash-action-gitlab-");
	const head = join(dir, "head");
	const capture = join(dir, "published.json");
	const calls = join(dir, "calls.log");
	writeFileSync(head, "abc123");
	writeFakeCli(
		dir,
		"glab",
		cliFixtures.shScript(`
  *"--version"*) echo 'glab version 1.50.0' ;;
  *"api user"*) echo '{"username":"thrashley-bot"}' ;;
  *"merge_requests/12/notes"*) echo '[]' ;;
  *"repository/files/"*) echo '404 Not Found' >&2; exit 1 ;;
  *"merge_requests/12/discussions"*) echo '[]' ;;
  *"draft_notes/bulk_publish"*) cat > "$FAKE_CAPTURE"; echo '{}' ;;
  *"draft_notes"*) cat >/dev/null; echo '{"id":1}' ;;
  *"merge_requests/12/approve"*) echo '{}' ;;
  *"merge_requests/12"*) printf '{"sha":"%s","web_url":"${MR_URL}","diff_refs":{"base_sha":"base123","start_sha":"base123","head_sha":"%s"}}' "$(cat "$FAKE_HEAD")" "$(cat "$FAKE_HEAD")" ;;
  *"mr view 12"*) printf '{"iid":12,"title":"change","description":"","source_branch":"feature","target_branch":"main","sha":"%s","web_url":"${MR_URL}","state":"opened"}' "$(cat "$FAKE_HEAD")" ;;
  *"mr diff 12"*) printf 'diff --git a/a.ts b/a.ts\\n--- a/a.ts\\n+++ b/a.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n' ;;
  *) echo "unexpected glab call: $ARGS" >&2; exit 1 ;;
`),
	);
	const env: Record<string, string | undefined> = {
		...process.env,
		GITHUB_ACTIONS: undefined,
		GITHUB_EVENT_PATH: undefined,
		GLAB_BIN: join(dir, "glab"),
		GITLAB_CI: "true",
		CI_PIPELINE_SOURCE: "merge_request_event",
		CI_MERGE_REQUEST_IID: "12",
		CI_MERGE_REQUEST_PROJECT_PATH: "acme/widgets",
		CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.com/acme/widgets",
		CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: "acme/widgets",
		CI_MERGE_REQUEST_DIFF_BASE_SHA: "base123",
		THRASHLEY_WORK: dir,
		THRASHLEY_POLICY: ".gitlab/missing.yml",
		DG_THRASH_DRY_RUN: "0",
		FAKE_HEAD: head,
		FAKE_CAPTURE: capture,
		FAKE_CALL_LOG: calls,
	};
	function run(phase: string, extra: Record<string, string> = {}) {
		const result = Bun.spawnSync([process.execPath, CLI, "thrash", "action", phase], {
			cwd: dir,
			env: { ...env, ...extra },
		});
		return { code: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
	}
	return { dir, capture, calls, run };
}

describe("thrash action in GitLab CI", () => {
	test("reviews the merge request and approves it as the token user", () => {
		const f = gitlabFixture();
		const prepared = f.run("prepare");
		expect(prepared.code, prepared.output).toBe(0);
		expect(prepared.output).toContain("Thrashley notice: No policy at .gitlab/missing.yml");
		expect(prepared.output).not.toContain("::notice::");
		const state = JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8"));
		expect(state).toMatchObject({ headSha: "abc123", botLogin: "thrashley-bot", round: 1 });
		expect(state.event.url).toBe(MR_URL);
		for (const chunk of state.plan.chunks) writeFileSync(chunk.findingsPath, '```json\n{"findings":[]}\n```');

		const published = f.run("publish");
		expect(published.code, published.output).toBe(0);
		expect(JSON.parse(readFileSync(f.capture, "utf8"))).toMatchObject({ reviewer_state: "reviewed" });
		expect(readFileSync(f.calls, "utf8")).toContain("merge_requests/12/approve");
	});

	test("skips a merge request from a fork", () => {
		const f = gitlabFixture();
		const result = f.run("prepare", { CI_MERGE_REQUEST_SOURCE_PROJECT_PATH: "someone/widgets" });
		expect(result.code, result.output).toBe(0);
		expect(result.output).toContain("Thrashley skips MR !12 from fork someone/widgets");
		expect(JSON.parse(readFileSync(join(f.dir, "state.json"), "utf8"))).toEqual({ skipped: true });
	});
});
