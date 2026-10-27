import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT } from "../src/utils/legacy-command";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { makeGitRepo } from "./git-repo-fixtures";

const CLI = join(import.meta.dir, "../src/index.ts");
const WORKFLOW_MD = join(
	import.meta.dir,
	"../../../plugins/dg/skills/address/references/workflow.md",
);
const AGENTS_MD = join(
	import.meta.dir,
	"../../../plugins/dg/skills/address/references/agents.md",
);
const BUN_BIN = process.execPath;
const PR_URL = "https://github.com/acme/widgets/pull/9001";
const SINCE = "2026-02-01T00:00:00Z";

cliFixtures.isolateCliTests();

const RATIFIED_GATHER_UNRESOLVED_ITEM_KEYS = [
	"author",
	"body",
	"commentId",
	"diffHunk",
	"line",
	"mode",
	"path",
	"threadId",
];

let createdDirs: string[];
beforeEach(() => {
	createdDirs = [];
});

afterEach(() => {
	for (const dir of createdDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

async function runCli(
	args: string[],
	opts: {
		env?: Record<string, string>;
		cwd?: string;
		stdin?: string;
		command?: string[];
	} = {},
): Promise<RunResult> {
	const cwd = opts.cwd ?? cliFixtures.tmp(createdDirs, "address-helper-cwd-");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...opts.env,
	};
	const proc = Bun.spawn(
		[...(opts.command ?? [BUN_BIN, "run", CLI, "address"]), ...args],
		{
			stdout: "pipe",
			stderr: "pipe",
			stdin: opts.stdin !== undefined ? "pipe" : undefined,
			env,
			cwd,
		},
	);
	const completed = Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	try {
		if (opts.stdin !== undefined) {
			proc.stdin.write(opts.stdin);
			proc.stdin.end();
		}
	} catch (error) {
		proc.kill();
		await completed;
		throw error;
	}
	const [stdout, stderr, exitCode] = await completed;
	return { stdout, stderr, exitCode };
}

function fakeGh(script: string): string {
	const dir = cliFixtures.tmp(createdDirs, "address-helper-fake-gh-");
	writeFakeCli(dir, "gh", script);
	return join(dir, "gh");
}

function fakeGlab(script: string): string {
	const dir = cliFixtures.tmp(createdDirs, "address-helper-fake-glab-");
	writeFakeCli(dir, "glab", script);
	return join(dir, "glab");
}

function writeJson(name: string, data: unknown): string {
	return cliFixtures.writeJson(
		createdDirs,
		"address-helper-fixture-",
		name,
		data,
	);
}

function newCallLog(): string {
	return cliFixtures.callLogPath(createdDirs, "address-helper-log-");
}

function readCalls(path: string): string[] {
	return cliFixtures.readCalls(path);
}

function rawPr(
	n: number,
	state: "OPEN" | "CLOSED" | "MERGED",
	overrides: Record<string, unknown> = {},
) {
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

function rawMr(
	n: number,
	state: "opened" | "closed" | "merged" | "locked",
	overrides: Record<string, unknown> = {},
) {
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

function ghThread(
	id: string,
	isResolved: boolean,
	comments: Array<{
		databaseId: number;
		author: string;
		body: string;
		diffHunk?: string;
	}>,
	meta: { path?: string; line?: number } = {},
) {
	return {
		id,
		isResolved,
		path: meta.path,
		line: meta.line,
		comments: {
			nodes: comments.map((c) => ({
				databaseId: c.databaseId,
				author: { login: c.author },
				body: c.body,
				createdAt: "2026-02-01T10:00:00Z",
				diffHunk: c.diffHunk,
			})),
		},
	};
}

function ghThreadsResponse(nodes: ReturnType<typeof ghThread>[]) {
	return {
		data: {
			repository: {
				pullRequest: {
					reviewThreads: {
						nodes,
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				},
			},
		},
	};
}

function glDiscussion(
	id: string,
	notes: Array<{
		id: number;
		author: string;
		body: string;
		resolvable?: boolean;
		resolved?: boolean;
		created_at?: string;
		position?: {
			new_path?: string;
			new_line?: number;
			old_path?: string;
			old_line?: number;
		};
	}>,
) {
	return {
		id,
		notes: notes.map((n) => ({
			id: n.id,
			body: n.body,
			author: { username: n.author },
			created_at: n.created_at ?? "2026-02-01T10:00:00Z",
			resolvable: n.resolvable ?? true,
			resolved: n.resolved ?? false,
			position: n.position,
		})),
	};
}

function ghListScript(prPath: string, threadsPath: string): string {
	return `#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{"owner":{"login":"acme"},"name":"widgets","defaultBranchRef":{"name":"main"},"url":"https://github.com/acme/widgets"}'
    exit 0
    ;;
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"--json number"*)
    echo '{"number":9001}'
    exit 0
    ;;
  *graphql*)
    cat "${threadsPath}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
}

function glListScript(mrPath: string, discussionsPath: string): string {
	return `#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{"web_url":"https://gitlab.com/acme/widgets","namespace":{"full_path":"acme"},"path":"widgets","default_branch":"main"}'
    exit 0
    ;;
  *"mr view"*)
    cat "${mrPath}"
    exit 0
    ;;
  *"/discussions"*)
    cat "${discussionsPath}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
}

describe("detect-github", () => {
	test("no longer exists as a subcommand", async () => {
		const { stderr, exitCode } = await runCli(["detect-github"]);
		expect(exitCode).toBe(EXIT.USAGE);
		expect(stderr).toContain("unknown subcommand");
	});
});

describe("probe", () => {
	function alwaysOkScript(): string {
		return `#!/bin/sh
echo '{"number":1,"iid":1,"state":"OPEN"}'
exit 0
`;
	}

	function alwaysFailScript(): string {
		return `#!/bin/sh
echo 'boom' 1>&2
exit 1
`;
	}

	test("emits exactly {provider, git, branch}, with provider true, when the provider is reachable", async () => {
		const repo = makeGitRepo();
		createdDirs.push(repo);
		const ghBin = fakeGh(alwaysOkScript());

		const { stdout, exitCode } = await runCli(["probe"], {
			cwd: repo,
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Object.keys(parsed).sort()).toEqual(["branch", "git", "provider"]);
		expect(parsed.provider).toBe(true);
		expect(parsed.git).toBe(true);
		expect(typeof parsed.branch).toBe("string");
		expect(parsed.branch.length).toBeGreaterThan(0);
	});

	test("reports provider:false, without crashing, when the provider check fails", async () => {
		const repo = makeGitRepo();
		createdDirs.push(repo);
		const ghBin = fakeGh(alwaysFailScript());

		const { stdout, exitCode } = await runCli(["probe"], {
			cwd: repo,
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.provider).toBe(false);
		expect(parsed.git).toBe(true);
	});

	test("reports git:false and branch:'unknown', without crashing, when cwd is not a git repository", async () => {
		const ghBin = fakeGh(alwaysOkScript());

		const { stdout, exitCode } = await runCli(["probe"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.git).toBe(false);
		expect(parsed.branch).toBe("unknown");
	});

	test("emits exactly {provider, git, branch}, with provider true, on GitLab", async () => {
		const repo = makeGitRepo();
		createdDirs.push(repo);
		const glabBin = fakeGlab(alwaysOkScript());

		const { stdout, exitCode } = await runCli(["probe"], {
			cwd: repo,
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(Object.keys(parsed).sort()).toEqual(["branch", "git", "provider"]);
		expect(parsed.provider).toBe(true);
		expect(parsed.git).toBe(true);
		expect(typeof parsed.branch).toBe("string");
		expect(parsed.branch.length).toBeGreaterThan(0);
	});

	test("reports provider:false, without crashing, when the provider check fails, on GitLab", async () => {
		const repo = makeGitRepo();
		createdDirs.push(repo);
		const glabBin = fakeGlab(alwaysFailScript());

		const { stdout, exitCode } = await runCli(["probe"], {
			cwd: repo,
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.provider).toBe(false);
		expect(parsed.git).toBe(true);
	});
});

describe("view-pr — provider-neutral PR/MR lookup for worktree resolution", () => {
	test("takes a bare number on GitHub and returns state, merged and headRefName", async () => {
		const prPath = writeJson("view-gh-num-pr.json", rawPr(9001, "MERGED"));
		const ghBin = fakeGh(
			ghListScript(prPath, writeJson("view-gh-num-threads.json", {})),
		);

		const { stdout, exitCode } = await runCli(["view-pr", "9001"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const pr = JSON.parse(stdout);
		expect(pr.state).toBe("MERGED");
		expect(pr.merged).toBe(true);
		expect(pr.headRefName).toBe("feature-9001");
	});

	test("takes a full GitHub pull URL, so a stored pr_url needs no pre-parsing", async () => {
		const prPath = writeJson("view-gh-url-pr.json", rawPr(9001, "OPEN"));
		const ghBin = fakeGh(
			ghListScript(prPath, writeJson("view-gh-url-threads.json", {})),
		);

		const { stdout, exitCode } = await runCli(
			["view-pr", "https://github.com/acme/widgets/pull/9001"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).toBe(0);
		const pr = JSON.parse(stdout);
		expect(pr.number).toBe(9001);
		expect(pr.merged).toBe(false);
	});

	test("runs ungated on GitLab, unlike the Copilot-bot subcommands, and reports a merged MR", async () => {
		const mrPath = writeJson("view-gl-mr.json", rawMr(4242, "merged"));
		const glabBin = fakeGlab(
			glListScript(mrPath, writeJson("view-gl-discussions.json", [])),
		);

		const { stdout, exitCode } = await runCli(["view-pr", "4242"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const mr = JSON.parse(stdout);
		expect(mr.state).toBe("MERGED");
		expect(mr.merged).toBe(true);
		expect(mr.headRefName).toBe("feature-4242");
	});

	test("takes a full GitLab merge_requests URL", async () => {
		const mrPath = writeJson("view-gl-url-mr.json", rawMr(4242, "opened"));
		const glabBin = fakeGlab(
			glListScript(mrPath, writeJson("view-gl-url-discussions.json", [])),
		);

		const { stdout, exitCode } = await runCli(
			["view-pr", "https://gitlab.com/acme/widgets/-/merge_requests/4242"],
			{
				env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).number).toBe(4242);
	});

	test("exits non-zero on an argument that is neither a number nor a PR/MR URL", async () => {
		const prPath = writeJson("view-bad-arg-pr.json", rawPr(9001, "OPEN"));
		const ghBin = fakeGh(
			ghListScript(prPath, writeJson("view-bad-arg-threads.json", {})),
		);

		const { exitCode, stderr } = await runCli(
			["view-pr", "https://github.com/acme/widgets/issues/12"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("not a pull request number or URL");
	});
});

describe("gather-unresolved — filtering and derivation semantics", () => {
	test("keeps unresolved fix-mode threads, drops resolved/#ignore/already-answered-explain threads, on GitHub", async () => {
		const prPath = writeJson("gh-filter-pr.json", rawPr(9001, "OPEN"));
		const threadsPath = writeJson(
			"gh-filter-threads.json",
			ghThreadsResponse([
				ghThread("RT-FIX", false, [
					{
						databaseId: 7001,
						author: "alice",
						body: "please fix the null check",
					},
				]),
				ghThread("RT-RESOLVED", true, [
					{ databaseId: 7002, author: "bob", body: "looks good now" },
				]),
				ghThread("RT-IGNORE", false, [
					{ databaseId: 7003, author: "carol", body: "#ignore this for now" },
				]),
				ghThread("RT-EXPLAIN-ANSWERED", false, [
					{
						databaseId: 7004,
						author: "dave",
						body: "#explain why is this needed",
					},
					{ databaseId: 7005, author: "swe-bot", body: "🤖 here is why" },
				]),
				ghThread("RT-EXPLAIN-ANSWERED-LEGACY", false, [
					{
						databaseId: 7007,
						author: "frank",
						body: "#explain why is this needed",
					},
					{ databaseId: 7008, author: "swe-bot", body: "[bot] here is why" },
				]),
				ghThread("RT-EXPLAIN-OPEN", false, [
					{
						databaseId: 7006,
						author: "erin",
						body: "#explain what does this do",
					},
				]),
			]),
		);
		const ghBin = fakeGh(ghListScript(prPath, threadsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed.map((t) => t.threadId)).toEqual([
			"RT-FIX",
			"RT-EXPLAIN-OPEN",
		]);
		expect(parsed[0]).toMatchObject({
			commentId: 7001,
			body: "please fix the null check",
			author: "alice",
			mode: "fix",
		});
		expect(parsed[1]).toMatchObject({
			commentId: 7006,
			body: "#explain what does this do",
			author: "erin",
			mode: "explain",
		});
	});

	test("keeps unresolved fix-mode discussions, drops resolved/#ignore/already-answered-explain discussions, on GitLab", async () => {
		const mrPath = writeJson("gl-filter-mr.json", rawMr(1, "opened"));
		const discussionsPath = writeJson("gl-filter-discussions.json", [
			glDiscussion("disc-fix", [
				{ id: 8001, author: "alice", body: "please fix the null check" },
			]),
			glDiscussion("disc-resolved", [
				{ id: 8002, author: "bob", body: "looks good now", resolved: true },
			]),
			glDiscussion("disc-ignore", [
				{ id: 8003, author: "carol", body: "#ignore this for now" },
			]),
			glDiscussion("disc-explain-answered", [
				{ id: 8004, author: "dave", body: "#explain why is this needed" },
				{ id: 8005, author: "swe-bot", body: "🤖 here is why" },
			]),
			glDiscussion("disc-explain-open", [
				{ id: 8006, author: "erin", body: "#explain what does this do" },
			]),
		]);
		const glabBin = fakeGlab(glListScript(mrPath, discussionsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed.map((t) => t.threadId)).toEqual([
			"disc-fix",
			"disc-explain-open",
		]);
		expect(parsed[0]).toMatchObject({
			commentId: 8001,
			body: "please fix the null check",
			author: "alice",
			mode: "fix",
		});
		expect(parsed[1]).toMatchObject({
			commentId: 8006,
			body: "#explain what does this do",
			author: "erin",
			mode: "explain",
		});
	});
});

describe("gather-unresolved — per-item shape parity across providers", () => {
	test("pins the per-item shape to threadId, commentId, path, line, body, diffHunk, author, mode on GitHub", async () => {
		const prPath = writeJson("gh-shape-pr.json", rawPr(9001, "OPEN"));
		const threadsPath = writeJson(
			"gh-shape-threads.json",
			ghThreadsResponse([
				ghThread("RT-SHAPE", false, [
					{ databaseId: 7101, author: "alice", body: "please fix this" },
				]),
			]),
		);
		const ghBin = fakeGh(ghListScript(prPath, threadsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(Object.keys(parsed[0]).sort()).toEqual(
			[...RATIFIED_GATHER_UNRESOLVED_ITEM_KEYS].sort(),
		);
	});

	test("returns the same per-item key set on GitLab as on GitHub, matching the ratified shape on both sides", async () => {
		const ghPrPath = writeJson("gh-parity-pr.json", rawPr(9001, "OPEN"));
		const ghThreadsPath = writeJson(
			"gh-parity-threads.json",
			ghThreadsResponse([
				ghThread("RT-PARITY", false, [
					{ databaseId: 7102, author: "alice", body: "please fix this" },
				]),
			]),
		);
		const ghBin = fakeGh(ghListScript(ghPrPath, ghThreadsPath));
		const ghRun = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		const glMrPath = writeJson("gl-parity-mr.json", rawMr(1, "opened"));
		const glDiscussionsPath = writeJson("gl-parity-discussions.json", [
			glDiscussion("disc-parity", [
				{ id: 8102, author: "alice", body: "please fix this" },
			]),
		]);
		const glabBin = fakeGlab(glListScript(glMrPath, glDiscussionsPath));
		const glRun = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		const ghItem = (
			JSON.parse(ghRun.stdout) as Array<Record<string, unknown>>
		)[0];
		const glItem = (
			JSON.parse(glRun.stdout) as Array<Record<string, unknown>>
		)[0];
		expect(Object.keys(ghItem).sort()).toEqual(
			[...RATIFIED_GATHER_UNRESOLVED_ITEM_KEYS].sort(),
		);
		expect(Object.keys(glItem).sort()).toEqual(Object.keys(ghItem).sort());
	});
});

describe("gather-unresolved — path/line/diffHunk values", () => {
	test("carries the thread's path/line and the first comment's diffHunk verbatim, on GitHub", async () => {
		const prPath = writeJson("gh-diffhunk-pr.json", rawPr(9001, "OPEN"));
		const threadsPath = writeJson(
			"gh-diffhunk-threads.json",
			ghThreadsResponse([
				ghThread(
					"RT-DIFFHUNK",
					false,
					[
						{
							databaseId: 7301,
							author: "alice",
							body: "please fix this",
							diffHunk: "@@ -10,3 +10,4 @@\n+  added line",
						},
					],
					{ path: "src/foo.ts", line: 42 },
				),
			]),
		);
		const ghBin = fakeGh(ghListScript(prPath, threadsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed[0]).toMatchObject({
			path: "src/foo.ts",
			line: 42,
			diffHunk: "@@ -10,3 +10,4 @@\n+  added line",
		});
	});

	test("reports an empty path and a null line for a thread with no diff anchor, on GitHub", async () => {
		const prPath = writeJson("gh-unanchored-pr.json", rawPr(9001, "OPEN"));
		const threadsPath = writeJson(
			"gh-unanchored-threads.json",
			ghThreadsResponse([
				ghThread("RT-UNANCHORED", false, [
					{ databaseId: 7302, author: "bob", body: "please fix this" },
				]),
			]),
		);
		const ghBin = fakeGh(ghListScript(prPath, threadsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed[0]).toMatchObject({ path: "", line: null, diffHunk: "" });
	});

	test("carries the note's path/line from its position but always reports an empty diffHunk, on GitLab", async () => {
		const mrPath = writeJson("gl-diffhunk-mr.json", rawMr(1, "opened"));
		const discussionsPath = writeJson("gl-diffhunk-discussions.json", [
			glDiscussion("disc-diffhunk", [
				{
					id: 8301,
					author: "alice",
					body: "please fix this",
					position: { new_path: "src/bar.ts", new_line: 7 },
				},
			]),
		]);
		const glabBin = fakeGlab(glListScript(mrPath, discussionsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed[0]).toMatchObject({
			path: "src/bar.ts",
			line: 7,
			diffHunk: "",
		});
	});

	test("reports an empty path and a null line for a discussion with no diff anchor, on GitLab", async () => {
		const mrPath = writeJson("gl-unanchored-mr.json", rawMr(1, "opened"));
		const discussionsPath = writeJson("gl-unanchored-discussions.json", [
			glDiscussion("disc-unanchored", [
				{ id: 8302, author: "bob", body: "please fix this" },
			]),
		]);
		const glabBin = fakeGlab(glListScript(mrPath, discussionsPath));

		const { stdout, exitCode } = await runCli(["gather-unresolved"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed[0]).toMatchObject({ path: "", line: null, diffHunk: "" });
	});
});

describe("gather-unresolved — pr_number targets that PR, not the current branch's, on GitHub", () => {
	test("queries the thread list for the given PR number instead of resolving the current branch", async () => {
		const threads222Path = writeJson(
			"gh-target-threads-222.json",
			ghThreadsResponse([
				ghThread("RT-PR222", false, [
					{ databaseId: 9401, author: "alice", body: "fix please" },
				]),
			]),
		);
		const threads111Path = writeJson(
			"gh-target-threads-111.json",
			ghThreadsResponse([]),
		);
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"-F number=222"*)
    cat "${threads222Path}"
    exit 0
    ;;
  *"-F number=111"*)
    cat "${threads111Path}"
    exit 0
    ;;
  *"pr view --json number"*)
    echo '{"number":111}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-unresolved", "222"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].threadId).toBe("RT-PR222");
	});
});

describe("gather-unresolved — pr_number targets that MR, not the current branch's, on GitLab", () => {
	test("queries the discussion list for the given MR number instead of resolving the current branch", async () => {
		const discussions222Path = writeJson("gl-target-discussions-222.json", [
			glDiscussion("disc-pr222", [
				{ id: 9402, author: "alice", body: "fix please" },
			]),
		]);
		const discussions111Path = writeJson("gl-target-discussions-111.json", []);
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"merge_requests/222/discussions"*)
    cat "${discussions222Path}"
    exit 0
    ;;
  *"merge_requests/111/discussions"*)
    cat "${discussions111Path}"
    exit 0
    ;;
  *"mr view --output json"*)
    echo '{"iid":111}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-unresolved", "222"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].threadId).toBe("disc-pr222");
	});
});

describe("gather", () => {
	test("includes both resolved and unresolved threads together with the current PR's metadata, on GitHub", async () => {
		const prPath = writeJson("gh-gather-pr.json", rawPr(9001, "OPEN"));
		const threadsPath = writeJson(
			"gh-gather-threads.json",
			ghThreadsResponse([
				ghThread("RT-RESOLVED", true, [
					{ databaseId: 7201, author: "alice", body: "looks good now" },
				]),
				ghThread("RT-OPEN", false, [
					{ databaseId: 7202, author: "bob", body: "please fix this" },
				]),
			]),
		);
		const ghBin = fakeGh(ghListScript(prPath, threadsPath));

		const { stdout, exitCode } = await runCli(["gather"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.pr.number).toBe(9001);
		expect(parsed.pr.headRefName).toBe("feature-9001");
		expect(parsed.pr.url).toBe("https://github.com/acme/widgets/pull/9001");
		expect(parsed.threads).toHaveLength(2);
		const resolvedFlags = (parsed.threads as Array<Record<string, unknown>>)
			.map((t) => t.resolved)
			.sort();
		expect(resolvedFlags).toEqual([false, true]);
	});

	test("includes both resolved and unresolved discussions together with the current MR's metadata, on GitLab", async () => {
		const mrPath = writeJson("gl-gather-mr.json", rawMr(1, "opened"));
		const discussionsPath = writeJson("gl-gather-discussions.json", [
			glDiscussion("disc-resolved", [
				{ id: 8201, author: "alice", body: "looks good now", resolved: true },
			]),
			glDiscussion("disc-open", [
				{ id: 8202, author: "bob", body: "please fix this" },
			]),
		]);
		const glabBin = fakeGlab(glListScript(mrPath, discussionsPath));

		const { stdout, exitCode } = await runCli(["gather"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.pr.number).toBe(1);
		expect(parsed.pr.headRefName).toBe("feature-1");
		expect(parsed.threads).toHaveLength(2);
		const resolvedFlags = (parsed.threads as Array<Record<string, unknown>>)
			.map((t) => t.resolved)
			.sort();
		expect(resolvedFlags).toEqual([false, true]);
	});

	test("returns the metadata and threads for the given pr_number, not the current branch's, on GitHub", async () => {
		const pr222Path = writeJson(
			"gh-gather-target-pr222.json",
			rawPr(222, "OPEN", { headRefName: "feature-222" }),
		);
		const threads222Path = writeJson(
			"gh-gather-target-threads222.json",
			ghThreadsResponse([
				ghThread("RT-PR222", false, [
					{ databaseId: 9601, author: "alice", body: "fix please" },
				]),
			]),
		);
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pr view 222"*)
    cat "${pr222Path}"
    exit 0
    ;;
  *"-F number=222"*)
    cat "${threads222Path}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather", "222"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.pr.number).toBe(222);
		expect(parsed.pr.headRefName).toBe("feature-222");
		expect(parsed.threads).toHaveLength(1);
		expect((parsed.threads[0] as Record<string, unknown>).threadId).toBe(
			"RT-PR222",
		);
	});

	test("returns the metadata and threads for the given pr_number, not the current branch's, on GitLab", async () => {
		const mr222Path = writeJson(
			"gl-gather-target-mr222.json",
			rawMr(222, "opened", { source_branch: "feature-222" }),
		);
		const mr111Path = writeJson(
			"gl-gather-target-mr111.json",
			rawMr(111, "opened", { source_branch: "feature-111" }),
		);
		const discussions222Path = writeJson("gl-gather-target-disc222.json", [
			glDiscussion("disc-pr222", [
				{ id: 9501, author: "alice", body: "fix please" },
			]),
		]);
		const discussions111Path = writeJson("gl-gather-target-disc111.json", []);
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view 222 --output json"*)
    cat "${mr222Path}"
    exit 0
    ;;
  *"mr view --output json"*)
    cat "${mr111Path}"
    exit 0
    ;;
  *"merge_requests/222/discussions"*)
    cat "${discussions222Path}"
    exit 0
    ;;
  *"merge_requests/111/discussions"*)
    cat "${discussions111Path}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather", "222"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.pr.number).toBe(222);
		expect(parsed.pr.headRefName).toBe("feature-222");
		expect(parsed.threads).toHaveLength(1);
		expect((parsed.threads[0] as Record<string, unknown>).threadId).toBe(
			"disc-pr222",
		);
	});
});

describe("gather — error handling when there is no PR for the current branch", () => {
	test("exits non-zero with a readable message instead of an empty or malformed result, on GitHub", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pr view --json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    echo 'no pull requests found for branch "feature-x"' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode, stderr } = await runCli(["gather"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("no pull request found for the current branch");
	});

	test("exits non-zero with a readable message instead of an empty or malformed result, on GitLab", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo 'no open merge request found for branch "feature-x"' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode, stderr } = await runCli(["gather"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("no pull request found for the current branch");
	});
});

const CI_FAILURE_ITEM_KEYS = [
	"ciId",
	"conclusion",
	"jobId",
	"logExcerpt",
	"name",
	"runId",
	"source",
	"url",
	"workflowFile",
].sort();

describe("gather-ci-failures — maps Provider.listCiFailures onto the CLI's field names", () => {
	test("maps executionId/configFile onto runId/workflowFile (not CiFailure's internal names) on the GitHub Actions path", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"pr view 42 --json headRefOid"*)
    echo '{"headRefOid":"deadbeef"}'
    exit 0
    ;;
  *"commits/deadbeef/check-runs"*)
    echo '[{"check_runs":[{"id":600,"name":"build","conclusion":"failure","details_url":"https://github.com/acme/widgets/actions/runs/500/job/600"}]}]'
    exit 0
    ;;
  *"actions/jobs/600/logs"*)
    echo 'boom: build failed'
    exit 0
    ;;
  *"actions/runs/500"*)
    echo '{"path":".github/workflows/build.yml"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "42"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).not.toContain("statusCheckRollup");
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(Object.keys(parsed[0]).sort()).toEqual(CI_FAILURE_ITEM_KEYS);
		expect(parsed[0]).not.toHaveProperty("executionId");
		expect(parsed[0]).not.toHaveProperty("configFile");
		expect(parsed[0]).toEqual({
			ciId: "ci-600",
			source: "ci",
			name: "build",
			conclusion: "failure",
			runId: "500",
			jobId: "600",
			workflowFile: ".github/workflows/build.yml",
			url: "https://github.com/acme/widgets/actions/runs/500/job/600",
			logExcerpt: "boom: build failed",
		});
	});

	test("maps executionId/configFile onto runId/workflowFile (not CiFailure's internal names) on the GitLab pipeline path", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"merge_requests/42/pipelines"*)
    echo '[{"id":900,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57","ref":"refs/merge-requests/42/head"}]'
    exit 0
    ;;
  *"merge_requests/42"*)
    echo '{"iid":42,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *"pipelines/900/jobs"*)
    echo '[{"id":700,"name":"test","status":"failed","web_url":"https://gitlab.com/acme/widgets/-/jobs/700"}]'
    exit 0
    ;;
  *"jobs/700/trace"*)
    echo 'trace: gitlab job failed'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(Object.keys(parsed[0]).sort()).toEqual(CI_FAILURE_ITEM_KEYS);
		expect(parsed[0]).not.toHaveProperty("executionId");
		expect(parsed[0]).not.toHaveProperty("configFile");
		expect(parsed[0]).toEqual({
			ciId: "ci-700",
			source: "ci",
			name: "test",
			conclusion: "failed",
			runId: "900",
			jobId: "700",
			workflowFile: ".gitlab-ci.yml",
			url: "https://gitlab.com/acme/widgets/-/jobs/700",
			logExcerpt: "trace: gitlab job failed",
		});
	});

	test("honors an explicit pr_number instead of the current branch's MR on GitLab", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"mr view --output json"*)
    echo 'no open merge request found for branch "feature-x"' 1>&2
    exit 1
    ;;
  *"merge_requests/42/pipelines"*)
    echo '[{"id":900,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57","ref":"refs/merge-requests/42/head"}]'
    exit 0
    ;;
  *"merge_requests/42"*)
    echo '{"iid":42,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *"pipelines/900/jobs"*)
    echo '[{"id":700,"name":"test","status":"failed"}]'
    exit 0
    ;;
  *"jobs/700/trace"*)
    echo 'trace output'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].jobId).toBe("700");
	});
});

describe("gather-ci-failures — one unavailable job log degrades only that entry", () => {
	test("degrades one job's logExcerpt to empty when its GitHub Actions log is unavailable, without failing the whole call", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view 77 --json headRefOid"*)
    echo '{"headRefOid":"cafef00d"}'
    exit 0
    ;;
  *"commits/cafef00d/check-runs"*)
    echo '[{"check_runs":[{"id":601,"name":"build","conclusion":"failure","details_url":"https://github.com/acme/widgets/actions/runs/501/job/601"},{"id":602,"name":"lint","conclusion":"failure","details_url":"https://github.com/acme/widgets/actions/runs/501/job/602"}]}]'
    exit 0
    ;;
  *"actions/jobs/601/logs"*)
    echo 'log601: passed after retry, still marked failed'
    exit 0
    ;;
  *"actions/jobs/602/logs"*)
    echo 'HTTP 410: log expired' 1>&2
    exit 1
    ;;
  *"actions/runs/501"*)
    echo '{"path":".github/workflows/ci.yml"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "77"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(2);
		const ok = parsed.find((item) => item.jobId === "601");
		const degraded = parsed.find((item) => item.jobId === "602");
		expect(ok?.logExcerpt).toContain(
			"log601: passed after retry, still marked failed",
		);
		expect(degraded?.logExcerpt).toBe("");
	});

	test("degrades one job's logExcerpt to empty when its GitLab job trace is unavailable, without failing the whole call", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"merge_requests/77/pipelines"*)
    echo '[{"id":950,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57","ref":"refs/merge-requests/77/head"}]'
    exit 0
    ;;
  *"merge_requests/77"*)
    echo '{"iid":77,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *"pipelines/950/jobs"*)
    echo '[{"id":701,"name":"unit","status":"failed"},{"id":702,"name":"e2e","status":"failed"}]'
    exit 0
    ;;
  *"jobs/701/trace"*)
    echo 'trace701: unit failure detail'
    exit 0
    ;;
  *"jobs/702/trace"*)
    echo 'HTTP 404: trace expired' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "77"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(2);
		const ok = parsed.find((item) => item.jobId === "701");
		const degraded = parsed.find((item) => item.jobId === "702");
		expect(ok?.logExcerpt).toContain("trace701: unit failure detail");
		expect(degraded?.logExcerpt).toBe("");
	});
});

describe("gather-ci-failures — no failing checks", () => {
	test("prints [] and exits 0 when no GitHub Actions check run is failing", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"pr view 9 --json headRefOid"*)
    echo '{"headRefOid":"c0ffee"}'
    exit 0
    ;;
  *"commits/c0ffee/check-runs"*)
    echo '[{"check_runs":[{"id":900,"name":"build","conclusion":"success","details_url":"https://github.com/acme/widgets/actions/runs/500/job/900"}]}]'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "9"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("[]");
		expect(readCalls(log).join("\n")).not.toContain("actions/jobs/900/logs");
	});

	test("prints [] and exits 0 when the GitLab pipeline has no failing job", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"merge_requests/9/pipelines"*)
    echo '[{"id":800,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57","ref":"refs/merge-requests/9/head"}]'
    exit 0
    ;;
  *"merge_requests/9"*)
    echo '{"iid":9,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *"pipelines/800/jobs"*)
    echo '[{"id":501,"name":"unit","status":"success"}]'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "9"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("[]");
	});

	test("prints [] and exits 0 when the GitLab MR has no pipeline at all", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"merge_requests/9/pipelines"*)
    echo '[]'
    exit 0
    ;;
  *"merge_requests/9"*)
    echo '{"iid":9,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "9"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		expect(stdout.trim()).toBe("[]");
		expect(readCalls(log).join("\n")).not.toContain("/jobs");
	});
});

describe("gather-ci-failures — url is populated from the provider's link, empty rather than undefined otherwise", () => {
	test("falls back to a GitHub check run's html_url when details_url is absent", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view 51 --json headRefOid"*)
    echo '{"headRefOid":"aabbccdd"}'
    exit 0
    ;;
  *"commits/aabbccdd/check-runs"*)
    echo '[{"check_runs":[{"id":611,"name":"build","conclusion":"failure","html_url":"https://github.com/acme/widgets/actions/runs/555/job/611"}]}]'
    exit 0
    ;;
  *"actions/jobs/611/logs"*)
    echo 'log611'
    exit 0
    ;;
  *"actions/runs/555"*)
    echo '{"path":".github/workflows/build.yml"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "51"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].url).toBe(
			"https://github.com/acme/widgets/actions/runs/555/job/611",
		);
		expect(parsed[0].runId).toBe("555");
	});

	test("emits an empty string, not undefined, when a GitHub check run carries neither details_url nor html_url", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view 55 --json headRefOid"*)
    echo '{"headRefOid":"feedface"}'
    exit 0
    ;;
  *"commits/feedface/check-runs"*)
    echo '[{"check_runs":[{"id":620,"name":"flaky","conclusion":"failure"}]}]'
    exit 0
    ;;
  *"actions/jobs/620/logs"*)
    echo 'log620: transient failure'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "55"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].url).toBe("");
		expect(parsed[0].workflowFile).toBe("");
		expect(parsed[0].jobId).toBe("620");
	});

	test("emits an empty string, not undefined, when a GitLab job carries no web_url", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"merge_requests/55/pipelines"*)
    echo '[{"id":960,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57","ref":"refs/merge-requests/55/head"}]'
    exit 0
    ;;
  *"merge_requests/55"*)
    echo '{"iid":55,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *"pipelines/960/jobs"*)
    echo '[{"id":703,"name":"lint","status":"failed"}]'
    exit 0
    ;;
  *"jobs/703/trace"*)
    echo 'trace output'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "55"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].url).toBe("");
	});
});

describe("gather-ci-failures — no residual raw gh call", () => {
	test("never falls back to the pre-migration pr-view/statusCheckRollup/run-view/log-failed calls on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"pr view 88 --json headRefOid"*)
    echo '{"headRefOid":"decade00"}'
    exit 0
    ;;
  *"commits/decade00/check-runs"*)
    echo '[{"check_runs":[{"id":800,"name":"build","conclusion":"failure","details_url":"https://github.com/acme/widgets/actions/runs/700/job/800"}]}]'
    exit 0
    ;;
  *"actions/jobs/800/logs"*)
    echo 'log800'
    exit 0
    ;;
  *"actions/runs/700"*)
    echo '{"path":".github/workflows/build.yml"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(["gather-ci-failures", "88"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).not.toContain("statusCheckRollup");
		expect(calls).not.toContain("run view");
		expect(calls).not.toContain("--log-failed");
		expect(calls).toContain("check-runs");
	});
});

describe("gather-ci-failures — error handling when there is no PR for the current branch", () => {
	test("exits non-zero with a readable message instead of printing [], on GitHub", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view --json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    echo 'no pull requests found for branch "feature-x"' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode, stderr } = await runCli(["gather-ci-failures"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("no pull request found for the current branch");
		expect(stdout).toBe("");
	});

	test("exits non-zero with a readable message instead of printing [], on GitLab", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"mr view --output json"*)
    echo 'no open merge request found for branch "feature-x"' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode, stderr } = await runCli(["gather-ci-failures"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("no pull request found for the current branch");
		expect(stdout).toBe("");
	});
});

describe("gather-ci-failures — a failed CI listing call is a genuine failure, not zero results", () => {
	test("exits non-zero, printing nothing, when the GitHub check-runs listing call itself fails", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view 66 --json headRefOid"*)
    echo '{"headRefOid":"badc0de"}'
    exit 0
    ;;
  *"commits/badc0de/check-runs"*)
    echo 'boom: rate limited' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode, stderr } = await runCli(
			["gather-ci-failures", "66"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("gather-ci-failures");
	});

	test("exits non-zero, printing nothing, when the GitLab pipelines listing call itself fails", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"merge_requests/66/pipelines"*)
    echo 'boom: rate limited' 1>&2
    exit 1
    ;;
  *"merge_requests/66"*)
    echo '{"iid":66,"sha":"4798a313e8e39f8067fe3b4bd6c094f20221bb57"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode, stderr } = await runCli(
			["gather-ci-failures", "66"],
			{
				env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
			},
		);

		expect(exitCode).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("gather-ci-failures");
	});
});

describe("gather-ci-failures — logExcerpt is trimmed of surrounding whitespace", () => {
	test("strips leading and trailing blank lines from a GitHub Actions job log", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"pr view 71 --json headRefOid"*)
    echo '{"headRefOid":"f00dbead"}'
    exit 0
    ;;
  *"commits/f00dbead/check-runs"*)
    echo '[{"check_runs":[{"id":650,"name":"build","conclusion":"failure","details_url":"https://github.com/acme/widgets/actions/runs/560/job/650"}]}]'
    exit 0
    ;;
  *"actions/jobs/650/logs"*)
    printf '\\n\\n  boom: build failed  \\n\\n\\n'
    exit 0
    ;;
  *"actions/runs/560"*)
    echo '{"path":".github/workflows/build.yml"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["gather-ci-failures", "71"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
		expect(parsed).toHaveLength(1);
		expect(parsed[0].logExcerpt).toBe("boom: build failed");
	});
});

describe("references/workflow.md — gather-ci-failures output shape documentation", () => {
	test("documents the ratified nine-key shape, with no remaining checkName, detailsUrl, or workflowName reference", () => {
		const workflowMd = readFileSync(WORKFLOW_MD, "utf8");
		expect(workflowMd).not.toContain("checkName");
		expect(workflowMd).not.toContain("detailsUrl");
		expect(workflowMd).not.toContain("workflowName");

		const ciLine = workflowMd
			.split("\n")
			.find((line) => line.includes("gather-ci-failures"));
		expect(ciLine).toBeDefined();
		const line = ciLine ?? "";
		for (const key of [
			"ciId",
			"source",
			"name",
			"conclusion",
			"runId",
			"jobId",
			"workflowFile",
			"url",
			"logExcerpt",
		]) {
			expect(line).toMatch(new RegExp(`(?<![A-Za-z])${key}(?![A-Za-z])`));
		}
	});
});

describe("references/agents.md — GitLab CI routing", () => {
	test("adds .gitlab-ci.yml as its own exact, root-only routing row mapped to devops, separate from the .github/ prefix row", () => {
		const agentsMd = readFileSync(AGENTS_MD, "utf8");
		const rows = agentsMd.split("\n").filter((line) => line.startsWith("|"));

		const gitlabRow = rows.find((line) => line.includes(".gitlab-ci.yml"));
		expect(gitlabRow).toBeDefined();
		expect(gitlabRow ?? "").toMatch(/devops/);

		const githubRow = rows.find((line) => line.includes(".github/"));
		expect(githubRow).toBeDefined();
		expect(githubRow).not.toBe(gitlabRow);
		expect(githubRow ?? "").not.toContain(".gitlab-ci.yml");
	});

	test("documents relocated or include:-split GitLab CI config as out of scope", () => {
		const agentsMd = readFileSync(AGENTS_MD, "utf8").toLowerCase();
		expect(agentsMd).toContain("include:");
		expect(agentsMd).toContain("out of scope");
	});
});

describe("reply", () => {
	test("posts directly to the original review comment through the REST reply endpoint on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5001/replies"*)
		echo '{"id":9101,"in_reply_to_id":5001,"user":{"login":"carol"},"body":"🤖 thanks, fixed","created_at":"2026-02-03T12:00:00Z"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(
			["reply", "5001", "RT_kwALOAB1", "thanks, fixed", "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
			},
		);

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("pulls/1/comments/5001/replies");
		expect(calls).toContain("🤖 ");
		expect(calls).not.toContain("addPullRequestReviewThreadReply");
	});

	test("keys the reply on the thread id via discussions/{id}/notes, on GitLab", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"/discussions/"*"/notes"*)
    echo '{"id":9102,"body":"🤖 thanks, fixed","author":{"username":"dan"},"created_at":"2026-02-04T13:00:00Z"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(
			["reply", "5002", "disc-1", "thanks, fixed", "--pr=1"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("discussions/disc-1/notes");
		expect(calls).toContain("🤖 ");
	});

	test("swaps the emoji marker for ADDRESS_BOT_PREFIX when the host mangles emoji", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5010/replies"*)
		echo '{"id":9110,"in_reply_to_id":5010,"user":{"login":"carol"},"body":"[bot] thanks, fixed","created_at":"2026-02-03T12:00:00Z"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(
			["reply", "5010", "RT_kwALOAB1", "thanks, fixed", "--pr=1"],
			{
				env: {
					AI_VCS_PROVIDER: "github",
					GH_BIN: ghBin,
					FAKE_CALL_LOG: log,
					ADDRESS_BOT_PREFIX: "[bot] ",
				},
			},
		);

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("[bot] thanks, fixed");
		expect(calls).not.toContain("🤖 ");
	});

	test("leaves a body already carrying the legacy [bot] marker unprefixed", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5011/replies"*)
		echo '{"id":9111,"in_reply_to_id":5011,"user":{"login":"carol"},"body":"[bot] thanks, fixed","created_at":"2026-02-03T12:00:00Z"}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(
			["reply", "5011", "RT_kwALOAB1", "[bot] thanks, fixed", "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
			},
		);

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("[bot] thanks, fixed");
		expect(calls).not.toContain("🤖 [bot] ");
	});
});

describe("reply — --pr targets that MR, not the current branch's, on GitLab", () => {
	test("posts the note under the MR named by --pr=<number>", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view --output json"*)
    echo '{"iid":111}'
    exit 0
    ;;
  *"merge_requests/222/discussions/disc-1/notes"*)
    echo '{"id":9601,"body":"🤖 thanks, fixed","author":{"username":"dan"},"created_at":"2026-02-07T09:00:00Z"}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-1/notes"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(
			["reply", "5003", "disc-1", "thanks, fixed", "--pr=222"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/222/discussions/disc-1/notes");
		expect(calls).not.toContain("merge_requests/111");
	});
});

describe("reply — provider failure propagates a non-zero exit", () => {
	test("exits non-zero and surfaces the failure instead of succeeding silently, when the discussion note POST fails, on GitLab", async () => {
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"/discussions/"*"/notes"*)
    echo 'note create failed: 422 Unprocessable' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode, stderr } = await runCli(
			["reply", "5004", "disc-1", "thanks, fixed", "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
			},
		);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("reply");
	});
});

describe("resolve", () => {
	test("resolves a thread via the resolveReviewThread mutation keyed on the thread id, on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_kwALOAB1"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(["resolve", "RT_kwALOAB1"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("resolveReviewThread");
		expect(calls).toContain("RT_kwALOAB1");
	});

	test("resolves a discussion via PUT .../discussions/{id} with resolved=true, on GitLab", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"-X PUT"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(["resolve", "disc-1"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("disc-1");
		expect(calls).toContain("resolved=true");
	});
});

describe("resolve — provider failure propagates a non-zero exit", () => {
	test("exits non-zero and surfaces the failure instead of succeeding silently, when resolveReviewThread fails, on GitHub", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo 'GraphQL: Could not resolve to a node with the global id' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode, stderr } = await runCli(["resolve", "RT_bogus"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("resolve");
	});
});

describe("resolve — --pr targets that MR, not the current branch's, on GitLab", () => {
	test("resolves the discussion under the MR named by --pr=<number>", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view --output json"*)
    echo '{"iid":111}'
    exit 0
    ;;
  *"merge_requests/222/discussions/disc-1 -X PUT"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-1 -X PUT"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { exitCode } = await runCli(["resolve", "disc-1", "--pr=222"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/222/discussions/disc-1");
		expect(calls).toContain("-X PUT");
		expect(calls).not.toContain("merge_requests/111");
	});
});

describe("resolve-silent", () => {
	test("prints exactly {resolved: <threadId>} and actually calls resolveReviewThread, on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_kwALOAB1"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["resolve-silent", "RT_kwALOAB1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ resolved: "RT_kwALOAB1" });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("resolveReviewThread");
		expect(calls).toContain("RT_kwALOAB1");
	});

	test("prints exactly {resolved: <threadId>} and actually calls PUT .../discussions/{id} with resolved=true, on GitLab", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"-X PUT"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["resolve-silent", "disc-1"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ resolved: "disc-1" });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("disc-1");
		expect(calls).toContain("resolved=true");
	});
});

describe("resolve-silent — --pr targets that MR, not the current branch's, on GitLab", () => {
	test("resolves the discussion under the MR named by --pr=<number>", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view --output json"*)
    echo '{"iid":111}'
    exit 0
    ;;
  *"merge_requests/222/discussions/disc-1 -X PUT"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-1 -X PUT"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["resolve-silent", "disc-1", "--pr=222"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ resolved: "disc-1" });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/222/discussions/disc-1");
		expect(calls).toContain("-X PUT");
		expect(calls).not.toContain("merge_requests/111");
	});
});

describe("resolve-with-reply", () => {
	test("prints {replied:true, resolved:<threadId>} and posts the reply before resolving, on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5201/replies"*)
		echo '{"id":9201,"in_reply_to_id":5201,"user":{"login":"carol"},"body":"🤖 fixed","created_at":"2026-02-05T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_kwALOAB1"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["resolve-with-reply", "5201", "RT_kwALOAB1", "fixed", "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			replied: true,
			resolved: "RT_kwALOAB1",
		});
		const calls = readCalls(log);
		const replyIdx = calls.findIndex((c) =>
			c.includes("pulls/1/comments/5201/replies"),
		);
		const resolveIdx = calls.findIndex((c) =>
			c.includes("resolveReviewThread"),
		);
		expect(replyIdx).toBeGreaterThanOrEqual(0);
		expect(resolveIdx).toBeGreaterThan(replyIdx);
	});

	test("prints {replied:true, resolved:<threadId>} and posts the note before resolving, on GitLab", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"/discussions/"*"/notes"*)
    echo '{"id":9202,"body":"🤖 fixed","author":{"username":"dan"},"created_at":"2026-02-05T10:00:00Z"}'
    exit 0
    ;;
  *"-X PUT"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["resolve-with-reply", "5202", "disc-1", "fixed", "--pr=1"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ replied: true, resolved: "disc-1" });
		const calls = readCalls(log);
		const replyIdx = calls.findIndex((c) => c.includes("/notes"));
		const resolveIdx = calls.findIndex((c) => c.includes("-X PUT"));
		expect(replyIdx).toBeGreaterThanOrEqual(0);
		expect(resolveIdx).toBeGreaterThan(replyIdx);
	});
});

describe("resolve-with-reply — --pr targets that MR, not the current branch's, on GitLab", () => {
	test("replies then resolves the discussion under the MR named by --pr=<number>", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view --output json"*)
    echo '{"iid":111}'
    exit 0
    ;;
  *"merge_requests/222/discussions/disc-1/notes"*)
    echo '{"id":9701,"body":"🤖 fixed","author":{"username":"dan"},"created_at":"2026-02-08T09:00:00Z"}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-1/notes"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *"merge_requests/222/discussions/disc-1 -X PUT"*)
    echo '{"id":"disc-1","resolved":true}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-1 -X PUT"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["resolve-with-reply", "5203", "disc-1", "fixed", "--pr=222"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ replied: true, resolved: "disc-1" });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/222/discussions/disc-1/notes");
		expect(calls).toContain("merge_requests/222/discussions/disc-1 -X PUT");
		expect(calls).not.toContain("merge_requests/111");
	});
});

describe("batch-close", () => {
	test("returns {total,succeeded,failed} only after directly replying to commentId and resolving threadId on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5001/replies"*)
		echo '{"id":9301,"in_reply_to_id":5001,"user":{"login":"carol"},"body":"🤖 done","created_at":"2026-02-06T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_batch1"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 5001, threadId: "RT_batch1", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ total: 1, succeeded: 1, failed: 0 });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("RT_batch1");
		expect(calls).toContain("pulls/1/comments/5001/replies");
		expect(calls).not.toContain("addPullRequestReviewThreadReply");
	});

	test("returns {total,succeeded,failed,errors} and a non-zero exit when an item's reply step fails, on GitHub", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5002/replies"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_batch2"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 5002, threadId: "RT_batch2", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, FAKE_CALL_LOG: log },
			},
		);

		expect(exitCode).not.toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
		expect(typeof parsed.errors).toBe("string");
		expect(readCalls(log).join("\n")).not.toContain("resolveReviewThread");
	});

	test("returns {total,succeeded,failed} keyed on threadId against a fake GitLab adapter's discussions", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view"*)
    echo '{"iid":1}'
    exit 0
    ;;
  *"/discussions/"*"/notes"*)
    echo '{"id":9302,"body":"🤖 done","author":{"username":"dan"},"created_at":"2026-02-06T10:00:00Z"}'
    exit 0
    ;;
  *"-X PUT"*)
    echo '{"id":"disc-batch","resolved":true}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 5003, threadId: "disc-batch", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(["batch-close", items], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin, FAKE_CALL_LOG: log },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ total: 1, succeeded: 1, failed: 0 });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("disc-batch");
	});

	test("returns {total,succeeded,failed,errors} with a 'resolve failed' message when the resolve step fails but the reply succeeds, on GitHub", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5005/replies"*)
		echo '{"id":9303,"in_reply_to_id":5005,"user":{"login":"carol"},"body":"🤖 done","created_at":"2026-02-06T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 5005, threadId: "RT_batch3", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
		expect(parsed.errors).toContain("resolve failed for thread RT_batch3");
	});

	test("tallies succeeded and failed independently per item, keyed on each item's own thread id, on GitHub", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/5006/replies"*)
		echo '{"id":9401,"in_reply_to_id":5006,"user":{"login":"carol"},"body":"🤖 done","created_at":"2026-02-06T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*"threadId=RT_good"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_good"}}}}'
    exit 0
    ;;
  *"pulls/1/comments/5007/replies"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *"resolveReviewThread"*"threadId=RT_bad"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_bad"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 5006, threadId: "RT_good", summary: "fixed this" },
			{ commentId: 5007, threadId: "RT_bad", summary: "fixed that" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed.total).toBe(2);
		expect(parsed.succeeded).toBe(1);
		expect(parsed.failed).toBe(1);
		expect(parsed.errors).toContain("reply failed for thread RT_bad");
		expect(parsed.errors).not.toContain("RT_good");
	});
});

describe("batch-close — rejected-as-success regression (silent-failure incident)", () => {
	test("counts an item as failed, not succeeded, when its reply step throws inside the try block, and the error names the thread", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/6001/replies"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_throws"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 6001, threadId: "RT_throws", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
		expect(parsed.errors).toContain("RT_throws");
	});

	test("counts an item as failed, not succeeded, when it throws before the inner try blocks run — the production incident: caller passed 'body' instead of 'summary'", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 6002, threadId: "RT_wrongkey", body: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toMatchObject({ total: 1, succeeded: 0, failed: 1 });
		expect(parsed.errors).toContain("RT_wrongkey");
	});

	test("tallies a mixed batch as {succeeded:1, failed:1} when one item is well-formed and the other is missing summary", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/6003/replies"*)
		echo '{"id":9601,"in_reply_to_id":6003,"user":{"login":"carol"},"body":"🤖 done","created_at":"2026-02-06T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_mixed_good"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 6003, threadId: "RT_mixed_good", summary: "fixed this" },
			{ commentId: 6004, threadId: "RT_mixed_bad" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).not.toBe(0);
		const parsed = JSON.parse(stdout);
		expect(parsed).toMatchObject({ total: 2, succeeded: 1, failed: 1 });
		expect(parsed.errors).toContain("RT_mixed_bad");
	});

	test("dies with a clean error instead of throwing when the JSON input is an object, not an array", async () => {
		const ghBin = fakeGh(`#!/bin/sh
exit 0
`);
		const items = JSON.stringify({
			threadId: "RT_notarray",
			summary: "fixed this",
		});

		const { stdout, stderr, exitCode } = await runCli(["batch-close", items], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
		});

		expect(exitCode).not.toBe(0);
		expect(stdout).toBe("");
		expect(stderr).toContain("must be an array");
	});

	test("still reports every item succeeded and exits 0 on the happy path", async () => {
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/6005/replies"*)
		echo '{"id":9701,"in_reply_to_id":6005,"user":{"login":"carol"},"body":"🤖 done","created_at":"2026-02-06T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"RT_happy"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 6005, threadId: "RT_happy", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=1"],
			{
				env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ total: 1, succeeded: 1, failed: 0 });
	});
});

describe("batch-close — reads the JSON payload from stdin instead of argv", () => {
	function successScript(threadId: string, commentId: number): string {
		return `#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"pulls/1/comments/${commentId}/replies"*)
		echo '{"id":9501,"in_reply_to_id":${commentId},"user":{"login":"carol"},"body":"🤖 done","created_at":"2026-02-06T09:00:00Z"}'
    exit 0
    ;;
  *"resolveReviewThread"*)
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"${threadId}"}}}}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	}

	test("reads the JSON array from stdin when the json arg is '-', on GitHub", async () => {
		const ghBin = fakeGh(successScript("RT_stdin1", 5010));
		const items = JSON.stringify([
			{ commentId: 5010, threadId: "RT_stdin1", summary: "fixed via stdin" },
		]);

		const { stdout, exitCode } = await runCli(["batch-close", "-", "--pr=1"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			stdin: items,
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ total: 1, succeeded: 1, failed: 0 });
	});

	test("reads the JSON array from stdin when the json arg is omitted entirely, on GitHub", async () => {
		const ghBin = fakeGh(successScript("RT_stdin2", 5011));
		const items = JSON.stringify([
			{ commentId: 5011, threadId: "RT_stdin2", summary: "fixed via stdin" },
		]);

		const { stdout, exitCode } = await runCli(["batch-close", "--pr=1"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			stdin: items,
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ total: 1, succeeded: 1, failed: 0 });
	});

	test("dies with 'batch-close requires JSON input' when stdin is empty and no json arg is given", async () => {
		const ghBin = fakeGh(`#!/bin/sh
exit 0
`);

		const { stderr, exitCode } = await runCli(["batch-close", "-"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			stdin: "",
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("batch-close requires JSON input");
	});

	test("exits non-zero instead of silently accepting garbage when the piped payload is not valid JSON", async () => {
		const ghBin = fakeGh(`#!/bin/sh
exit 0
`);

		const { stdout, exitCode } = await runCli(["batch-close", "-"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin },
			stdin: "{not valid json",
		});

		expect(exitCode).not.toBe(0);
		expect(stdout).toBe("");
	});
});

describe("batch-close — --pr targets that MR, not the current branch's, on GitLab", () => {
	test("replies+resolves items under the MR named by --pr=<number>", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view"*)
    echo '{}'
    exit 0
    ;;
  *"mr view --output json"*)
    echo '{"iid":111}'
    exit 0
    ;;
  *"merge_requests/222/discussions/disc-batch/notes"*)
    echo '{"id":9801,"body":"🤖 done","author":{"username":"dan"},"created_at":"2026-02-09T09:00:00Z"}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-batch/notes"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *"merge_requests/222/discussions/disc-batch -X PUT"*)
    echo '{"id":"disc-batch","resolved":true}'
    exit 0
    ;;
  *"merge_requests/111/discussions/disc-batch -X PUT"*)
    echo 'boom' 1>&2
    exit 1
    ;;
  *)
    exit 0
    ;;
esac
`);
		const items = JSON.stringify([
			{ commentId: 5004, threadId: "disc-batch", summary: "fixed this" },
		]);

		const { stdout, exitCode } = await runCli(
			["batch-close", items, "--pr=222"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ total: 1, succeeded: 1, failed: 0 });
		const calls = readCalls(log).join("\n");
		expect(calls).toContain("merge_requests/222/discussions/disc-batch");
		expect(calls).not.toContain("merge_requests/111");
	});
});

const NOT_SUPPORTED_ON_PROVIDER_TEXT = "is not supported on this provider";

function withFakeGhOnPath(ghBin: string): string {
	return `${dirname(ghBin)}:${process.env.PATH ?? ""}`;
}

describe("check-bot-review — the GitLab reviewer the loop used to route past", () => {
	beforeEach(() => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "review-bot";
	});
	function glabWithDiscussions(iid: number, discussionsPath: string): string {
		return fakeGlab(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"merge_requests/${iid}/discussions"*)
    cat "${discussionsPath}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
	}

	test("reports the bot's threads as present when the configured reviewer has reviewed the MR", async () => {
		const path = writeJson("gl-bot-review.json", [
			glDiscussion("disc-bot-1", [
				{
					id: 9501,
					author: "review-bot",
					body: "comment exceeds the one-line cap",
				},
			]),
			glDiscussion("disc-human", [
				{ id: 9502, author: "alice", body: "looks fine to me" },
			]),
		]);
		const glabBin = glabWithDiscussions(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			available: true,
			bots: ["review-bot"],
			present: true,
			threads: 1,
			unresolved: 1,
			latestAt: "2026-02-01T10:00:00Z",
		});
	});

	test("reports present:false when only humans have commented, so the loop can still fall through", async () => {
		const path = writeJson("gl-bot-review-none.json", [
			glDiscussion("disc-human-only", [
				{ id: 9503, author: "alice", body: "please rename this" },
			]),
		]);
		const glabBin = glabWithDiscussions(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			available: true,
			present: false,
			threads: 0,
			unresolved: 0,
		});
	});

	test("counts a resolved bot thread as present but not unresolved, so a handled review is not re-consumed", async () => {
		const path = writeJson("gl-bot-review-resolved.json", [
			glDiscussion("disc-bot-done", [
				{ id: 9504, author: "review-bot", body: "nit: naming", resolved: true },
			]),
		]);
		const glabBin = glabWithDiscussions(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			present: true,
			threads: 1,
			unresolved: 0,
		});
	});

	test("matches the bot username case-insensitively", async () => {
		const path = writeJson("gl-bot-review-case.json", [
			glDiscussion("disc-bot-case", [
				{ id: 9505, author: "Review-Bot", body: "flagged" },
			]),
		]);
		const glabBin = glabWithDiscussions(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ present: true, threads: 1 });
	});

	test("honors AI_VCS_GITLAB_REVIEW_BOT, matching the configured reviewer", async () => {
		const path = writeJson("gl-bot-review-configured.json", [
			glDiscussion("disc-duo", [
				{ id: 9506, author: "gitlab_duo", body: "suggestion" },
			]),
		]);
		const glabBin = glabWithDiscussions(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: glabBin,
				AI_VCS_GITLAB_REVIEW_BOT: "gitlab_duo",
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			available: true,
			bots: ["gitlab_duo"],
			present: true,
			threads: 1,
		});
	});

	test("reports available:false without listing any thread when no reviewer is configured", async () => {
		const log = newCallLog();
		const path = writeJson("gl-bot-review-unconfigured.json", []);
		const glabBin = glabWithDiscussions(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: glabBin,
				AI_VCS_GITLAB_REVIEW_BOT: "none",
				FAKE_CALL_LOG: log,
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			available: false,
			bots: [],
			present: false,
			reason: `bot review ${NOT_SUPPORTED_ON_PROVIDER_TEXT}`,
		});
		expect(readCalls(log).join("\n")).not.toContain("discussions");
	});

	test("finds Copilot's own threads on GitHub, so the subcommand is not GitLab-only", async () => {
		const prPath = writeJson("gh-bot-review-pr.json", rawPr(9001, "OPEN"));
		const threadsPath = writeJson(
			"gh-bot-review-threads.json",
			ghThreadsResponse([
				ghThread("RT-COPILOT", false, [
					{ databaseId: 7301, author: "copilot", body: "possible bug" },
				]),
			]),
		);
		const ghBin = fakeGh(ghListScript(prPath, threadsPath));

		const { stdout, exitCode } = await runCli(["check-bot-review"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: ghBin,
				PATH: withFakeGhOnPath(ghBin),
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			available: true,
			bots: ["copilot"],
			present: true,
			threads: 1,
		});
	});
});

describe("check-bot-review — counting and ordering the reviewer's own comments", () => {
	beforeEach(() => {
		process.env.AI_VCS_GITLAB_REVIEW_BOT = "review-bot";
	});
	function glabWithThreads(iid: number, path: string): string {
		return fakeGlab(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"merge_requests/${iid}/discussions"*)
    cat "${path}"
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`);
	}

	test("a non-resolvable bot discussion is left out, so it is neither present nor unresolved work", async () => {
		const path = writeJson("gl-bot-unresolvable.json", [
			glDiscussion("disc-bot-overview", [
				{
					id: 9601,
					author: "review-bot",
					body: "review summary",
					resolvable: false,
				},
			]),
		]);
		const glabBin = glabWithThreads(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({
			present: false,
			threads: 0,
			unresolved: 0,
		});
	});

	test("latestAt is the chronologically latest bot comment, not the lexicographically largest string", async () => {
		const path = writeJson("gl-bot-offsets.json", [
			glDiscussion("disc-bot-times", [
				{
					id: 9602,
					author: "review-bot",
					body: "earlier, written as a large string",
					created_at: "2026-02-01T23:00:00+09:00",
				},
				{
					id: 9603,
					author: "review-bot",
					body: "later, written as a smaller string",
					created_at: "2026-02-01T15:00:00Z",
				},
			]),
		]);
		const glabBin = glabWithThreads(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).latestAt).toBe("2026-02-01T15:00:00Z");
	});

	test("ignores a human comment's timestamp even when it is later than the bot's", async () => {
		const path = writeJson("gl-bot-human-later.json", [
			glDiscussion("disc-mixed", [
				{
					id: 9604,
					author: "review-bot",
					body: "flagged",
					created_at: "2026-02-01T10:00:00Z",
				},
				{
					id: 9605,
					author: "alice",
					body: "acknowledged",
					created_at: "2026-02-09T10:00:00Z",
				},
			]),
		]);
		const glabBin = glabWithThreads(42, path);

		const { stdout, exitCode } = await runCli(["check-bot-review", "42"], {
			env: { AI_VCS_PROVIDER: "gitlab", GLAB_BIN: glabBin },
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).latestAt).toBe("2026-02-01T10:00:00Z");
	});
});

describe("PR/MR number arguments reject trailing garbage", () => {
	test.each(["42garbage", "0", "-3", "1e999"])("check-bot-review refuses %p", async (bad) => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_CALL_LOG"; fi
exit 0
`);

		const { exitCode, stderr } = await runCli(["check-bot-review", bad], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				GLAB_BIN: glabBin,
				FAKE_CALL_LOG: log,
			},
		});
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("not a pull request number or URL");
		expect(readCalls(log).join("\n")).not.toContain("discussions");
	});

	test("gather-ci-failures refuses the same malformed argument before any provider call", async () => {
		const log = newCallLog();
		const glabBin = fakeGlab(`#!/bin/sh
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$*" >> "$FAKE_CALL_LOG"; fi
exit 0
`);

		const { exitCode, stderr } = await runCli(
			["gather-ci-failures", "77nonsense"],
			{
				env: {
					AI_VCS_PROVIDER: "gitlab",
					GLAB_BIN: glabBin,
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("not a pull request number or URL");
		expect(readCalls(log).join("\n")).not.toContain("pipelines");
	});
});

describe("Copilot subcommands stay refused on GitLab even now that it declares a review bot", () => {
	test("request-copilot still exits UNSUPPORTED, because a GitLab reviewer does not answer Copilot's API", async () => {
		const { stdout, stderr, exitCode } = await runCli(["request-copilot"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				AI_VCS_GITLAB_REVIEW_BOT: "review-bot",
			},
		});

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
	});

	test("AI_VCS_GITLAB_REVIEW_BOT=copilot does not open the Copilot gate on a GitLab repo", async () => {
		const { stdout, stderr, exitCode } = await runCli(["request-copilot"], {
			env: { AI_VCS_PROVIDER: "gitlab", AI_VCS_GITLAB_REVIEW_BOT: "copilot" },
		});

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
	});

	test("check-copilot still answers {available:false} rather than shelling out to gh", async () => {
		const log = newCallLog();
		const { stdout, exitCode } = await runCli(["check-copilot"], {
			env: {
				AI_VCS_PROVIDER: "gitlab",
				AI_VCS_GITLAB_REVIEW_BOT: "review-bot",
				FAKE_CALL_LOG: log,
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			available: false,
			reason: `Copilot review ${NOT_SUPPORTED_ON_PROVIDER_TEXT}`,
		});
		expect(readCalls(log)).toEqual([]);
	});
});

describe("check-copilot", () => {
	test("prints {available:true, reason:'assumed-available'} for a github.com repo (regression)", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view --json url"*)
    echo '{"url":"https://github.com/acme/widgets"}'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["check-copilot"], {
			env: {
				AI_VCS_PROVIDER: "github",
				PATH: withFakeGhOnPath(ghBin),
				FAKE_CALL_LOG: log,
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			available: true,
			reason: "assumed-available",
		});
		expect(readCalls(log)).toEqual(["repo view --json url"]);
	});

	test("reports unavailable when only a lookalike host contains github.com", async () => {
		const ghBin = fakeGh(`#!/bin/sh
case "$*" in
  *"repo view --json url"*)
    echo '{"url":"https://github.com.evil.example/acme/widgets"}'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["check-copilot"], {
			env: {
				AI_VCS_PROVIDER: "github",
				PATH: withFakeGhOnPath(ghBin),
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout).available).toBe(false);
	});

	test("on GitLab, keeps its exit-0 JSON-degrade shape ({available:false, reason}) with reason converged onto notSupportedMessage(), not the old bespoke wording", async () => {
		const { stdout, stderr, exitCode } = await runCli(["check-copilot"], {
			env: { AI_VCS_PROVIDER: "gitlab" },
		});

		expect(exitCode).toBe(0);
		expect(stderr).toBe("");
		const parsed = JSON.parse(stdout) as { available: boolean; reason: string };
		expect(parsed.available).toBe(false);
		expect(parsed.reason).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(parsed.reason).not.toBe("not-a-github-repo");
		expect(parsed.reason).not.toContain("ENOENT");
		expect(parsed.reason).not.toContain("command not found");
	});
});

describe("request-copilot", () => {
	test("defaults to method=comment, posts '@copilot review', and prints {requested:true,...} (regression)", async () => {
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"pr comment 9001 --body @copilot review"*)
    echo 'https://github.com/acme/widgets/pull/9001#issuecomment-555'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["request-copilot"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: ghBin,
				PATH: withFakeGhOnPath(ghBin),
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			requested: true,
			method: "comment",
			trigger: "comment",
			commentUrl: "https://github.com/acme/widgets/pull/9001#issuecomment-555",
		});
	});

	test("method=retry-comment posts '@copilot please review the latest changes' and prints {requested:true,method:'retry-comment',trigger:'comment'}", async () => {
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"pr comment 9001 --body @copilot please review the latest changes"*)
    echo 'https://github.com/acme/widgets/pull/9001#issuecomment-556'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["request-copilot", "--method=retry-comment"],
			{
				env: {
					AI_VCS_PROVIDER: "github",
					GH_BIN: ghBin,
					PATH: withFakeGhOnPath(ghBin),
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			requested: true,
			method: "retry-comment",
			trigger: "comment",
			commentUrl: "https://github.com/acme/widgets/pull/9001#issuecomment-556",
		});
	});

	test("method=reviewer posts requested_reviewers=Copilot against owner/repo/pr and prints {requested:true,method:'reviewer',trigger:'requested_reviewers'}", async () => {
		const log = newCallLog();
		const repoPath = writeJson("repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view --json owner,name,defaultBranchRef,url"*)
    cat "${repoPath}"
    exit 0
    ;;
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"api -X POST repos/acme/widgets/pulls/9001/requested_reviewers -f reviewers[]=Copilot"*)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			["request-copilot", "--method=reviewer"],
			{
				env: {
					AI_VCS_PROVIDER: "github",
					GH_BIN: ghBin,
					PATH: withFakeGhOnPath(ghBin),
					FAKE_CALL_LOG: log,
				},
			},
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			requested: true,
			method: "reviewer",
			trigger: "requested_reviewers",
		});
		expect(readCalls(log)).toContain(
			"api -X POST repos/acme/widgets/pulls/9001/requested_reviewers -f reviewers[]=Copilot",
		);
	});

	test("on GitLab, refuses via EXIT.UNSUPPORTED before attempting any glab call", async () => {
		const { stdout, stderr, exitCode } = await runCli(["request-copilot"], {
			env: { AI_VCS_PROVIDER: "gitlab" },
		});

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("ENOENT");
		expect(stderr).not.toContain("not found");
	});

	test("on GitLab, the capability gate fires before flag validation — an invalid --method value still yields the unsupported signal, not an unknown-method error", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			["request-copilot", "--method=bogus"],
			{
				env: { AI_VCS_PROVIDER: "gitlab" },
			},
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("unknown method");
	});
});

describe("fetch-copilot-review", () => {
	test("prints the latest Copilot review's submittedAt plus its open thread comments (regression)", async () => {
		const repoPath = writeJson("repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const graphqlPath = writeJson("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						reviews: {
							nodes: [
								{
									submittedAt: "2026-02-01T10:00:00Z",
									author: { login: "copilot-pull-request-reviewer" },
								},
							],
						},
						reviewThreads: {
							nodes: [
								{
									id: "RT_1",
									isResolved: false,
									comments: {
										nodes: [
											{
												id: "c1",
												databaseId: 501,
												body: "fix this",
												path: "src/a.ts",
												line: 10,
												diffHunk: "@@ -1,2 +1,2 @@",
												author: { login: "copilot-pull-request-reviewer" },
												createdAt: "2026-02-01T10:00:00Z",
											},
										],
									},
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view --json owner,name,defaultBranchRef,url"*)
    cat "${repoPath}"
    exit 0
    ;;
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["fetch-copilot-review"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: ghBin,
				PATH: withFakeGhOnPath(ghBin),
			},
		});

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			submittedAt: "2026-02-01T10:00:00Z",
			comments: [
				{
					threadId: "RT_1",
					commentId: 501,
					path: "src/a.ts",
					line: 10,
					body: "fix this",
					diffHunk: "@@ -1,2 +1,2 @@",
				},
			],
		});
	});

	test("on GitLab, refuses via EXIT.UNSUPPORTED before attempting any glab call", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			["fetch-copilot-review"],
			{
				env: { AI_VCS_PROVIDER: "gitlab" },
			},
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
	});
});

describe("count-copilot-reviews", () => {
	test("prints the bare integer count of non-pending Copilot-authored reviews (regression)", async () => {
		const log = newCallLog();
		const repoPath = writeJson("repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const graphqlPath = writeJson("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						reviews: {
							nodes: [
								{
									author: { login: "copilot-pull-request-reviewer" },
									state: "APPROVED",
								},
								{
									author: { login: "copilot-pull-request-reviewer" },
									state: "PENDING",
								},
								{ author: { login: "alice" }, state: "APPROVED" },
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view --json owner,name,defaultBranchRef,url"*)
    cat "${repoPath}"
    exit 0
    ;;
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["count-copilot-reviews"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: ghBin,
				PATH: withFakeGhOnPath(ghBin),
				FAKE_CALL_LOG: log,
			},
		});

		expect(exitCode).toBe(0);
		expect(stdout).toBe("1\n");
		expect(readCalls(log).some((c) => c.includes("api graphql"))).toBe(true);
	});

	test("prints '0\\n', not an empty string, when no reviews are Copilot-authored (regression)", async () => {
		const repoPath = writeJson("repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const graphqlPath = writeJson("graphql.json", {
			data: { repository: { pullRequest: { reviews: { nodes: [] } } } },
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view --json owner,name,defaultBranchRef,url"*)
    cat "${repoPath}"
    exit 0
    ;;
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["count-copilot-reviews"], {
			env: {
				AI_VCS_PROVIDER: "github",
				GH_BIN: ghBin,
				PATH: withFakeGhOnPath(ghBin),
			},
		});

		expect(exitCode).toBe(0);
		expect(stdout).toBe("0\n");
	});

	test("on GitLab, prints nothing to stdout (its bare-integer contract forbids a refusal message there) and exits EXIT.UNSUPPORTED", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			["count-copilot-reviews"],
			{
				env: { AI_VCS_PROVIDER: "gitlab" },
			},
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
	});
});

describe("verify-copilot-engaged", () => {
	test("exits 0 with {engaged:true,...} once copilot-swe-agent comments after since_iso (regression)", async () => {
		const graphqlPath = writeJson("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						comments: {
							nodes: [
								{
									databaseId: 701,
									body: "Reviewing now.",
									createdAt: "2026-02-01T10:00:00Z",
									author: { login: "copilot-swe-agent" },
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"verify-copilot-engaged",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			engaged: true,
			commentId: 701,
			createdAt: "2026-02-01T10:00:00Z",
			body: "Reviewing now.",
		});
	});

	test("the capability gate fires before parsePrUrl — a GitLab MR url yields the unsupported signal, never a malformed pr_url error", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			[
				"verify-copilot-engaged",
				"https://gitlab.com/acme/widgets/-/merge_requests/42",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "gitlab" } },
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("malformed pr_url");
	});

	test("on GitLab, the capability gate fires before the argument-count check — no arguments at all still yields the unsupported signal, not a 'required' usage error", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			["verify-copilot-engaged"],
			{
				env: { AI_VCS_PROVIDER: "gitlab" },
			},
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("pr_url and since_iso required");
	});
});

describe("await-copilot-review", () => {
	test("exits 0 with {landed:true, submittedAt} once a Copilot review lands after since_iso (regression)", async () => {
		const graphqlPath = writeJson("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						reviews: {
							nodes: [
								{
									submittedAt: "2026-02-01T11:00:00Z",
									author: { login: "copilot-pull-request-reviewer" },
								},
							],
						},
						comments: { nodes: [] },
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"await-copilot-review",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			landed: true,
			submittedAt: "2026-02-01T11:00:00Z",
		});
	});

	test("exits 0 with {noFindings:true,...} for a copilot-swe-agent no-findings ack after since_iso, when no review has landed", async () => {
		const graphqlPath = writeJson("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						reviews: { nodes: [] },
						comments: {
							nodes: [
								{
									databaseId: 802,
									body: "No additional changes are needed.",
									createdAt: "2026-02-01T12:00:00Z",
									author: { login: "copilot-swe-agent" },
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"await-copilot-review",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			noFindings: true,
			commentId: 802,
			createdAt: "2026-02-01T12:00:00Z",
			bodyExcerpt: "No additional changes are needed.",
		});
	});

	test("the capability gate fires before parsePrUrl — a GitLab MR url yields the unsupported signal, never a malformed pr_url error", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			[
				"await-copilot-review",
				"https://gitlab.com/acme/widgets/-/merge_requests/42",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "gitlab" } },
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("malformed pr_url");
	});

	test("on GitLab, the capability gate fires before the argument-count check — no arguments at all still yields the unsupported signal, not a 'required' usage error", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			["await-copilot-review"],
			{
				env: { AI_VCS_PROVIDER: "gitlab" },
			},
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("pr_url and since_iso required");
	});
});

describe("check-no-findings", () => {
	test("prints {noFindings:true,...} for a copilot-swe-agent no-findings ack after since_iso (regression)", async () => {
		const graphqlPath = writeJson("graphql.json", {
			data: {
				repository: {
					pullRequest: {
						comments: {
							nodes: [
								{
									databaseId: 801,
									body: "No additional changes are needed.",
									createdAt: "2026-02-01T12:00:00Z",
									author: { login: "copilot-swe-agent" },
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"check-no-findings",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			noFindings: true,
			commentId: 801,
			createdAt: "2026-02-01T12:00:00Z",
			bodyExcerpt: "No additional changes are needed.",
		});
	});

	test("matches the 'I don't see any ... issues' phrasing the reviewer actually posts, curly apostrophe included", async () => {
		const body =
			"Reviewed the latest branch changes again; I don’t see any additional high-confidence code issues to address.";
		const graphqlPath = writeJson("graphql-dontsee.json", {
			data: {
				repository: {
					pullRequest: {
						comments: {
							nodes: [
								{
									databaseId: 803,
									body,
									createdAt: "2026-02-01T12:00:00Z",
									author: { login: "copilot-swe-agent" },
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"check-no-findings",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			noFindings: true,
			commentId: 803,
			createdAt: "2026-02-01T12:00:00Z",
			bodyExcerpt: body,
		});
	});

	test("keeps noFindings false when 'don't see any' introduces blocking findings rather than none", async () => {
		const graphqlPath = writeJson("graphql-dontsee-negative.json", {
			data: {
				repository: {
					pullRequest: {
						comments: {
							nodes: [
								{
									databaseId: 804,
									body: "I don't see any reason to merge this yet — there are 2 blocking issues below.",
									createdAt: "2026-02-01T12:00:00Z",
									author: { login: "copilot-swe-agent" },
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"check-no-findings",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ noFindings: false });
	});

	test("the capability gate fires before parsePrUrl — a GitLab MR url yields the unsupported signal, never a malformed pr_url error", async () => {
		const { stdout, stderr, exitCode } = await runCli(
			[
				"check-no-findings",
				"https://gitlab.com/acme/widgets/-/merge_requests/42",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "gitlab" } },
		);

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("malformed pr_url");
	});

	test("on GitLab, the capability gate fires before the argument-count check — no arguments at all still yields the unsupported signal, not a 'required' usage error", async () => {
		const { stdout, stderr, exitCode } = await runCli(["check-no-findings"], {
			env: { AI_VCS_PROVIDER: "gitlab" },
		});

		expect(exitCode).toBe(EXIT.UNSUPPORTED);
		expect(stdout).toBe("");
		expect(stderr).toContain(NOT_SUPPORTED_ON_PROVIDER_TEXT);
		expect(stderr).not.toContain("pr_url and since_iso required");
	});
});

describe("check-copilot — a GitHub Enterprise host", () => {
	test("reports unavailable with the shared not-supported wording, since Copilot review is a github.com capability", async () => {
		const log = newCallLog();
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
if [ -n "$FAKE_CALL_LOG" ]; then printf '%s\\n' "$ARGS" >> "$FAKE_CALL_LOG"; fi
case "$ARGS" in
  *"repo view --json url"*)
    echo '{"url":"https://ghe.example.com/acme/widgets"}'
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(["check-copilot"], {
			env: {
				AI_VCS_PROVIDER: "github",
				PATH: withFakeGhOnPath(ghBin),
				FAKE_CALL_LOG: log,
			},
		});

		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { available: boolean; reason: string };
		expect(parsed.available).toBe(false);
		expect(parsed.reason).toContain("is not supported on this provider");
		expect(parsed.reason).not.toContain("not-a-github-repo");
	});
});

describe("check-no-findings — no matching acknowledgment", () => {
	test("reports noFindings false when the bot has commented but not with a no-findings ack", async () => {
		const graphqlPath = writeJson("graphql-nomatch.json", {
			data: {
				repository: {
					pullRequest: {
						comments: {
							nodes: [
								{
									databaseId: 802,
									body: "I found a problem in src/parser.ts.",
									createdAt: "2026-02-01T12:00:00Z",
									author: { login: "copilot-swe-agent" },
								},
							],
						},
					},
				},
			},
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);

		const { stdout, exitCode } = await runCli(
			[
				"check-no-findings",
				"https://github.com/acme/widgets/pull/9001",
				"2026-02-01T00:00:00Z",
			],
			{ env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) } },
		);

		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ noFindings: false });
	});
});

describe("Copilot polling", () => {
	for (const verb of ["verify-copilot-engaged", "await-copilot-review"]) {
		test(`${verb} preserves timeout 124 with no output after one empty poll`, async () => {
			const log = newCallLog();
			const response = writeJson("poll-empty.json", {
				data: {
					repository: {
						pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } },
					},
				},
			});
			const ghBin = fakeGh(
				cliFixtures.shScript(`
  "api graphql "*) cat "${response}" ;;
  *) exit 99 ;;
`),
			);
			const result = await runCli(
				[verb, PR_URL, SINCE, "--timeout=0", "--interval=0"],
				{
					env: {
						AI_VCS_PROVIDER: "github",
						PATH: withFakeGhOnPath(ghBin),
						FAKE_CALL_LOG: log,
					},
				},
			);
			expect(result).toEqual({ exitCode: 124, stdout: "", stderr: "" });
			expect(
				readCalls(log).filter((call) => call.startsWith("api graphql ")),
			).toHaveLength(1);
		});

		test(`${verb} exits 1 after five consecutive provider errors`, async () => {
			const log = newCallLog();
			const ghBin = fakeGh(cliFixtures.shScript("  *) exit 7 ;;"));
			const result = await runCli(
				[verb, PR_URL, SINCE, "--timeout=10", "--interval=0"],
				{
					env: {
						AI_VCS_PROVIDER: "github",
						PATH: withFakeGhOnPath(ghBin),
						FAKE_CALL_LOG: log,
					},
				},
			);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe(
				`${verb}: gh api failed 5 consecutive times\n`,
			);
			expect(
				readCalls(log).filter((call) => call.startsWith("api graphql ")),
			).toHaveLength(5);
		});

		test(`${verb} polls again after an error and accepts a later acknowledgment`, async () => {
			const marker = join(
				cliFixtures.tmp(createdDirs, "address-poll-"),
				"first-poll",
			);
			const log = newCallLog();
			const body = "No actionable issues.";
			const response = writeJson("poll-recovered.json", {
				data: {
					repository: {
						pullRequest: {
							reviews: { nodes: [] },
							comments: {
								nodes: [
									{
										databaseId: 901,
										body,
										createdAt: "2026-02-01T12:00:00Z",
										author: { login: "copilot-swe-agent" },
									},
								],
							},
						},
					},
				},
			});
			const ghBin = fakeGh(
				cliFixtures.shScript(`
  "api graphql "*)
    if [ ! -f "${marker}" ]; then printf 'first' > "${marker}"; exit 7; fi
    cat "${response}"
    ;;
  *) exit 99 ;;
`),
			);
			const result = await runCli(
				[verb, PR_URL, SINCE, "--timeout=10", "--interval=0"],
				{
					env: {
						AI_VCS_PROVIDER: "github",
						PATH: withFakeGhOnPath(ghBin),
						FAKE_CALL_LOG: log,
					},
				},
			);
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stderr).toBe("");
			expect(JSON.parse(result.stdout)).toEqual(
				verb === "verify-copilot-engaged"
					? {
							engaged: true,
							commentId: 901,
							body,
							createdAt: "2026-02-01T12:00:00Z",
						}
					: {
							noFindings: true,
							commentId: 901,
							bodyExcerpt: body,
							createdAt: "2026-02-01T12:00:00Z",
						},
			);
			expect(
				readCalls(log).filter((call) => call.startsWith("api graphql ")),
			).toHaveLength(2);
		});
	}
});

describe("address nested invocation", () => {
	test("a provider subprocess can invoke the public CLI with the same isolated environment", async () => {
		const output = join(
			cliFixtures.tmp(createdDirs, "address-nested-"),
			"nested.json",
		);
		const response = writeJson("nested-comments.json", {
			data: { repository: { pullRequest: { comments: { nodes: [] } } } },
		});
		const ghBin = fakeGh(
			cliFixtures.shScript(`
  "repo view --json url")
    "$FAKE_BUN_BIN" "$FAKE_PUBLIC_CLI" address check-no-findings "${PR_URL}" "${SINCE}" > "$FAKE_NESTED_OUTPUT" || exit 91
    printf '%s\\n' '{"url":"https://github.com/acme/widgets"}'
    ;;
  "api graphql "*) cat "${response}" ;;
  *) exit 99 ;;
`),
		);
		const result = await runCli(["check-copilot"], {
			env: {
				AI_VCS_PROVIDER: "github",
				PATH: withFakeGhOnPath(ghBin),
				FAKE_BUN_BIN: BUN_BIN,
				FAKE_PUBLIC_CLI: CLI,
				FAKE_NESTED_OUTPUT: output,
			},
		});
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			available: true,
			reason: "assumed-available",
		});
		expect(JSON.parse(readFileSync(output, "utf8"))).toEqual({
			noFindings: false,
		});
	});
});

describe("gather-overview", () => {
	const BOT = "copilot-pull-request-reviewer";
	const overviewBody = (header: string, summary: string) =>
		`<!-- ccr-overview-v2 -->\n${header}\n\n${summary}\n\n<details>\n<summary>Resolved</summary>\n\n- done\n</details>`;

	async function runOverview(nodes: Array<Record<string, unknown>>) {
		const repoPath = writeJson("repo.json", {
			owner: { login: "acme" },
			name: "widgets",
			defaultBranchRef: { name: "main" },
			url: "https://github.com/acme/widgets",
		});
		const prPath = writeJson("pr.json", rawPr(9001, "OPEN"));
		const graphqlPath = writeJson("graphql.json", {
			data: { repository: { pullRequest: { reviews: { nodes } } } },
		});
		const ghBin = fakeGh(`#!/bin/sh
ARGS="$*"
case "$ARGS" in
  *"repo view --json owner,name,defaultBranchRef,url"*)
    cat "${repoPath}"
    exit 0
    ;;
  *"--json number,title,url,state,headRefName,baseRefName,body,mergedAt"*)
    cat "${prPath}"
    exit 0
    ;;
  *"api graphql"*)
    cat "${graphqlPath}"
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`);
		return runCli(["gather-overview"], {
			env: { AI_VCS_PROVIDER: "github", GH_BIN: ghBin, PATH: withFakeGhOnPath(ghBin) },
		});
	}

	const review = (id: string, submittedAt: string, body: string, state = "COMMENTED") => ({
		id,
		submittedAt,
		state,
		body,
		author: { login: BOT },
	});

	test("reports needs-closer-look with its summary sentence", async () => {
		const { stdout, exitCode } = await runOverview([
			review("R_1", "2026-02-01T10:00:00Z", overviewBody("### 🔵 Needs a closer look", "Two gaps remain in retry handling.")),
		]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual([
			{
				reviewId: "R_1",
				source: "copilot-overview",
				state: "needs-closer-look",
				summary: "Two gaps remain in retry handling.",
				submittedAt: "2026-02-01T10:00:00Z",
			},
		]);
	});

	test("reports changes-recommended as one item", async () => {
		const { stdout } = await runOverview([
			review("R_2", "2026-02-01T10:00:00Z", overviewBody("### 🟡 Changes recommended", "Add a guard for empty input.")),
		]);
		const items = JSON.parse(stdout);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ reviewId: "R_2", state: "changes-recommended" });
	});

	test("fails closed with state unknown on an unrecognized header", async () => {
		const { stdout } = await runOverview([
			review("R_3", "2026-02-01T10:00:00Z", overviewBody("### 🟣 Something new", "Odd verdict.")),
		]);
		expect(JSON.parse(stdout)).toMatchObject([{ state: "unknown", summary: "Odd verdict." }]);
	});

	test("prints an empty array when the latest overview reads as approve", async () => {
		const { stdout } = await runOverview([
			review("R_4", "2026-02-01T10:00:00Z", overviewBody("### 🟢 Looks good", "No problems found.")),
		]);
		expect(JSON.parse(stdout)).toEqual([]);
	});

	test("prints an empty array when no Copilot review exists", async () => {
		const { stdout, exitCode } = await runOverview([
			{ ...review("R_5", "2026-02-01T10:00:00Z", "human review"), author: { login: "alice" } },
		]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual([]);
	});

	test("ignores an older needs-closer-look superseded by a newer approve", async () => {
		const { stdout } = await runOverview([
			review("R_old", "2026-02-01T10:00:00Z", overviewBody("### 🔵 Needs a closer look", "Old gap.")),
			review("R_new", "2026-02-02T10:00:00Z", overviewBody("### 🟢 Looks good", "All clear.")),
		]);
		expect(JSON.parse(stdout)).toEqual([]);
	});

	test("prints an empty array on GitLab", async () => {
		const { stdout, exitCode } = await runCli(["gather-overview"], { env: { AI_VCS_PROVIDER: "gitlab" } });
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual([]);
	});
});

describe("address command dispatch", () => {
	test("help inventories every migrated verb without accessing a provider", async () => {
		const result = await runCli(["--help"]);
		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		for (const verb of [
			"probe",
			"view-pr",
			"gather",
			"gather-unresolved",
			"gather-overview",
			"check-bot-review",
			"gather-ci-failures",
			"reply",
			"resolve",
			"resolve-silent",
			"resolve-with-reply",
			"commit-push",
			"batch-close",
			"check-copilot",
			"request-copilot",
			"fetch-copilot-review",
			"count-copilot-reviews",
			"verify-copilot-engaged",
			"check-no-findings",
			"await-copilot-review",
		])
			expect(result.stdout).toMatch(new RegExp(`^  ${verb}(?:\\s|$)`, "m"));
	});

	for (const args of [[], ["unknown-verb"]]) {
		test(`usage retains semantic status 2 for ${args.join(" ") || "missing verb"}`, async () => {
			const result = await runCli(args);
			expect(result.exitCode).toBe(2);
			expect(result.stdout + result.stderr).toContain("Usage:");
		});
	}

	for (const verb of [
		"reply",
		"resolve",
		"resolve-silent",
		"resolve-with-reply",
		"commit-push",
	]) {
		test(`${verb} retains error status 1 for missing arguments`, async () => {
			const result = await runCli([verb]);
			expect(result.exitCode).toBe(1);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("requires");
		});
	}
});

describe("address bot prefix idempotence", () => {
	for (const body of [
		"🤖 Already handled",
		"[bot] Already handled",
		"[agent] Already handled",
	]) {
		test(`reply preserves an existing ${body.split(" ")[0]} marker`, async () => {
			const log = newCallLog();
			const replyPath = writeJson("prefixed-reply.json", {
				id: 9101,
				in_reply_to_id: 5001,
				user: { login: "review-author" },
				body,
				created_at: "2026-02-03T12:00:00Z",
			});
			const ghBin = fakeGh(
				cliFixtures.shScript(`
  "repo view "*) printf '%s\\n' '{"owner":{"login":"acme"},"name":"widgets","url":"https://github.com/acme/widgets","defaultBranchRef":{"name":"main"}}' ;;
  *"pulls/83/comments/5001/replies"*) cat "${replyPath}" ;;
  *) exit 99 ;;
`),
			);
			const result = await runCli(["reply", "5001", "RT_1", body, "--pr=83"], {
				env: {
					AI_VCS_PROVIDER: "github",
					GH_BIN: ghBin,
					ADDRESS_BOT_PREFIX: "[agent] ",
					FAKE_CALL_LOG: log,
				},
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toBe("");
			const reply = readCalls(log).find((call) => call.includes("/replies"));
			expect(reply).toBeDefined();
			expect(reply).toContain(`body=${body}`);
			expect(reply).not.toContain(`[agent] ${body}`);
		});
	}
});

describe("address commit-push", () => {
	test("preserves message argv and stages ordinary untracked files before commit and push", async () => {
		const log = newCallLog();
		const bin = cliFixtures.tmp(createdDirs, "address-fake-git-");
		writeFakeCli(
			bin,
			"git",
			cliFixtures.shScript(`
  "ls-files --others --exclude-standard") printf '%s\\n' 'new file.txt' ;;
  "add -u"|"add -- new file.txt"|"commit -m Fix parsing with spaces"|"push") exit 0 ;;
  *) exit 99 ;;
`),
		);
		const result = await runCli(["commit-push", "Fix parsing with spaces"], {
			env: {
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				FAKE_CALL_LOG: log,
			},
		});
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
		expect(readCalls(log)).toEqual([
			"add -u",
			"ls-files --others --exclude-standard",
			"add -- new file.txt",
			"commit -m Fix parsing with spaces",
			"push",
		]);
	});
});

describe("address commit-push sensitive files", () => {
	test("skips nested and secret-named untracked files and stages the rest", async () => {
		const log = newCallLog();
		const bin = cliFixtures.tmp(createdDirs, "address-fake-git-");
		writeFakeCli(
			bin,
			"git",
			cliFixtures.shScript(`
  "ls-files --others --exclude-standard") printf '%s\\n' app/.env config/.env.local id_rsa .npmrc config/secrets/prod.json credentials/gcp.json certs/server.pem keys/api.key src/app.ts ;;
  "add -u"|"add -- src/app.ts"|"commit -m msg"|"push") exit 0 ;;
  *) exit 99 ;;
`),
		);
		const result = await runCli(["commit-push", "msg"], {
			env: { PATH: `${bin}:${process.env.PATH ?? ""}`, FAKE_CALL_LOG: log },
		});
		expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
		expect(readCalls(log)).toEqual([
			"add -u",
			"ls-files --others --exclude-standard",
			"add -- src/app.ts",
			"commit -m msg",
			"push",
		]);
	});
});

describe("Copilot polling input and data guards", () => {
	for (const verb of ["verify-copilot-engaged", "await-copilot-review"]) {
		test.each(["--timeout=abc", "--timeout=-1", "--interval=x"])(
			`${verb} rejects %s`,
			async (flag) => {
				const result = await runCli([verb, PR_URL, SINCE, flag], {
					env: { AI_VCS_PROVIDER: "github" },
				});
				expect(result.exitCode).not.toBe(0);
				expect(result.stderr).toContain("must be a non-negative integer");
			},
		);

		test(`${verb} survives a comment whose author is null`, async () => {
			const response = writeJson("poll-ghost.json", {
				data: {
					repository: {
						pullRequest: {
							reviews: { nodes: [{ submittedAt: SINCE, author: null }] },
							comments: {
								nodes: [
									{
										databaseId: 1,
										body: "x",
										createdAt: SINCE,
										author: null,
									},
								],
							},
						},
					},
				},
			});
			const ghBin = fakeGh(
				cliFixtures.shScript(`
  "api graphql "*) cat "${response}" ;;
  *) exit 99 ;;
`),
			);
			const result = await runCli(
				[verb, PR_URL, SINCE, "--timeout=1", "--interval=1"],
				{
					env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) },
				},
			);
			expect(result).toEqual({ exitCode: 124, stdout: "", stderr: "" });
		});

		test(`${verb} compares timestamps by instant, not by string`, async () => {
			const response = writeJson("poll-offset.json", {
				data: {
					repository: {
						pullRequest: {
							reviews: {
								nodes: [
									{
										submittedAt: "2026-02-01T00:30:00+05:00",
										author: { login: "copilot-pull-request-reviewer" },
									},
								],
							},
							comments: {
								nodes: [
									{
										databaseId: 1,
										body: "x",
										createdAt: "2026-02-01T00:30:00+05:00",
										author: { login: "copilot-swe-agent" },
									},
								],
							},
						},
					},
				},
			});
			const ghBin = fakeGh(
				cliFixtures.shScript(`
  "api graphql "*) cat "${response}" ;;
  *) exit 99 ;;
`),
			);
			const result = await runCli(
				[verb, PR_URL, "2026-02-01T00:00:00Z", "--timeout=0", "--interval=0"],
				{
					env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) },
				},
			);
			expect(result).toEqual({ exitCode: 124, stdout: "", stderr: "" });
		});
	}

	test("check-copilot reports the gh failure instead of rejecting", async () => {
		const ghBin = fakeGh(cliFixtures.shScript("  *) echo nope 1>&2; exit 1 ;;"));
		const { stdout, exitCode } = await runCli(["check-copilot"], {
			env: { AI_VCS_PROVIDER: "github", PATH: withFakeGhOnPath(ghBin) },
		});
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(stdout) as { available: boolean; reason: string };
		expect(parsed.available).toBe(false);
		expect(parsed.reason).toContain("could not read the repository URL");
	});
});

describe("compiled address", () => {
	test("runs both providers after relocation, preserving batch stdin, reply ordering, exact bodies and status streams", async () => {
		const buildDir = cliFixtures.tmp(createdDirs, "address build ");
		const original = join(buildDir, "dg skills");
		const build = Bun.spawnSync(
			[BUN_BIN, join(import.meta.dir, "../build.ts"), "--outfile", original],
			{
				env: { ...process.env },
			},
		);
		expect(build.exitCode, build.stderr.toString()).toBe(0);
		const binary = join(
			cliFixtures.tmp(createdDirs, "address relocated "),
			"dg skills",
		);
		renameSync(original, binary);
		rmSync(buildDir, { recursive: true, force: true });
		const external = cliFixtures.tmp(createdDirs, "address external ");
		const command = [binary, "address"];
		const summary =
			"Fixed 'quotes' \\ and $HOME; $(touch should-not-exist)\nsecond line <tag> `ticks`";
		const expectedBody = `🤖 ${summary}`;

		for (const kind of ["github", "gitlab"] as const) {
			const isGithub = kind === "github";
			const threadId = isGithub ? "RT_compiled" : "disc-compiled";
			const operations = newCallLog();
			const argvPath = join(
				cliFixtures.tmp(createdDirs, "address argv "),
				"reply.argv",
			);
			const prPath = writeJson(
				"compiled-pr.json",
				isGithub ? rawPr(83, "OPEN") : rawMr(83, "opened"),
			);
			const replyPath = writeJson(
				"compiled-reply.json",
				isGithub
					? {
							id: 9101,
							in_reply_to_id: 5001,
							user: { login: "review-author" },
							body: expectedBody,
							created_at: SINCE,
						}
					: {
							id: 9101,
							author: { username: "review-author" },
							body: expectedBody,
							created_at: SINCE,
						},
			);
			const graphPath = writeJson("compiled-empty-poll.json", {
				data: {
					repository: {
						pullRequest: { comments: { nodes: [] }, reviews: { nodes: [] } },
					},
				},
			});
			const script = cliFixtures.shScript(
				isGithub
					? `
  "repo view "*) printf '%s\\n' '{"owner":{"login":"acme"},"name":"widgets","url":"https://github.com/acme/widgets","defaultBranchRef":{"name":"main"}}' ;;
  "pr view 83 "*) cat "${prPath}" ;;
  *"pulls/83/comments/5001/replies"*)
    printf 'reply\\n' >> "$FAKE_OPERATIONS"
    printf '%s\\0' "$@" > "$FAKE_REPLY_ARGV"
    cat "${replyPath}"
    ;;
  "api graphql "*"resolveReviewThread"*)
    printf 'resolve\\n' >> "$FAKE_OPERATIONS"
    printf '%s\\n' '{}'
    ;;
  "api graphql "*) cat "${graphPath}" ;;
  *) exit 99 ;;
`
					: `
  "repo view "*) printf '%s\\n' '{"web_url":"https://gitlab.com/acme/widgets","namespace":{"full_path":"acme"},"path":"widgets","default_branch":"main"}' ;;
  "mr view 83 "*) cat "${prPath}" ;;
  *"merge_requests/83/discussions/${threadId}/notes"*)
    printf 'reply\\n' >> "$FAKE_OPERATIONS"
    printf '%s\\0' "$@" > "$FAKE_REPLY_ARGV"
    cat "${replyPath}"
    ;;
  *"merge_requests/83/discussions/${threadId} -X PUT"*)
    printf 'resolve\\n' >> "$FAKE_OPERATIONS"
    printf '%s\\n' '{}'
    ;;
  *) exit 99 ;;
`,
			);
			const fake = isGithub ? fakeGh(script) : fakeGlab(script);
			const env = {
				AI_VCS_PROVIDER: kind,
				[isGithub ? "GH_BIN" : "GLAB_BIN"]: fake,
				PATH: `${dirname(fake)}:${process.env.PATH ?? ""}`,
				FAKE_OPERATIONS: operations,
				FAKE_REPLY_ARGV: argvPath,
			};
			for (const name of [
				"address-helper",
				"vcs-provider-cli",
				"proxy-cli",
				"gh",
				"glab",
			]) {
				if (name === "gh" || name === "glab") {
					const found = Bun.which(name, { PATH: env.PATH });
					if (found)
						expect(createdDirs.some((dir) => found.startsWith(`${dir}/`))).toBe(
							true,
						);
				} else expect(Bun.which(name, { PATH: env.PATH })).toBeNull();
			}
			const view = await runCli(["view-pr", "83"], {
				command,
				cwd: external,
				env,
			});
			expect(view.exitCode, view.stderr).toBe(0);
			expect(view.stderr).toBe("");
			expect(JSON.parse(view.stdout)).toMatchObject({
				number: 83,
				state: "OPEN",
				merged: false,
				headRefName: "feature-83",
			});
			const batch = await runCli(["batch-close", "-", "--pr=83"], {
				command,
				cwd: external,
				env,
				stdin: JSON.stringify([{ commentId: 5001, threadId, summary }]),
			});
			expect(batch).toEqual({
				exitCode: 0,
				stdout: `${JSON.stringify({ total: 1, succeeded: 1, failed: 0 })}\n`,
				stderr: "",
			});
			expect(readCalls(operations)).toEqual(["reply", "resolve"]);
			const replyArgv = readFileSync(argvPath, "utf8").split("\0").slice(0, -1);
			expect(replyArgv.find((arg) => arg.startsWith("body="))).toBe(
				`body=${expectedBody}`,
			);
			expect(existsSync(join(external, "should-not-exist"))).toBe(false);

			if (isGithub) {
				for (const verb of ["verify-copilot-engaged", "await-copilot-review"]) {
					expect(
						await runCli([verb, PR_URL, SINCE, "--timeout=0"], {
							command,
							cwd: external,
							env,
						}),
					).toEqual({ exitCode: 124, stdout: "", stderr: "" });
				}
			} else {
				const refused = await runCli(["request-copilot", "--method=bogus"], {
					command,
					cwd: external,
					env,
				});
				expect(refused).toEqual({
					exitCode: EXIT.UNSUPPORTED,
					stdout: "",
					stderr:
						"error: Copilot review request is not supported on this provider\n",
				});
				const unavailable = await runCli(["check-copilot"], {
					command,
					cwd: external,
					env,
				});
				expect(unavailable).toEqual({
					exitCode: 0,
					stdout: `${JSON.stringify({ available: false, reason: "Copilot review is not supported on this provider" })}\n`,
					stderr: "",
				});
			}
		}
	}, 120_000);
});
