import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, parse as parseYaml, parseDocument, Scalar } from "yaml";
import type { Node, Pair } from "yaml";
import * as cliFixtures from "./cli-fixtures";
import { writeFakeCli } from "./fake-cli";
import { git as runGit } from "./git-repo-fixtures";
import { mappingEntryText, runSetup } from "../src/test-live/setup";
import { TestLiveError } from "../src/test-live/shared";

const CLI = join(import.meta.dir, "../src/index.ts");
const BUN_BIN = process.execPath;
const BRANCH = "feature/test-branch";
const WORKFLOW_FILE = "deploy_dev.yml";
const DEPLOY_WORKFLOW = "name: Deploy\non:\n  push:\n    branches: [main]\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n";

let createdDirs: string[];
beforeEach(() => {
	createdDirs = [];
});
afterEach(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function tmp(prefix: string): string {
	return cliFixtures.tmp(createdDirs, prefix);
}

function buildRepoWithWorkflow(workflowContent: string): { origin: string; repo: string } {
	const origin = tmp("test-live-origin-");
	runGit(["init", "-q", "--bare", "-b", "main"], origin);
	const repo = tmp("test-live-repo-");
	runGit(["init", "-q", "-b", "main"], repo);
	runGit(["remote", "add", "origin", origin], repo);
	mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
	writeFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), workflowContent);
	writeFileSync(join(repo, "README.md"), "hello\n");
	runGit(["add", "-A"], repo);
	runGit(["commit", "-q", "-m", "chore: init"], repo);
	runGit(["push", "-q", "origin", "main"], repo);
	runGit(["checkout", "-q", "-b", BRANCH], repo);
	runGit(["push", "-q", "-u", "origin", BRANCH], repo);
	return { origin, repo };
}

function buildRepo(): { origin: string; repo: string } {
	return buildRepoWithWorkflow(DEPLOY_WORKFLOW);
}

function headSha(repo: string): string {
	return runGit(["rev-parse", "HEAD"], repo).trim();
}

function log(repo: string, ref = "HEAD"): string {
	return runGit(["log", "--oneline", ref], repo).trim();
}

function findStateFile(dir: string): string {
	const match = readdirSync(dir, { recursive: true })
		.map((name) => name.toString())
		.find((name) => name.endsWith(".json"));
	if (!match) throw new Error(`no state file found under ${dir}`);
	return join(dir, match);
}

interface FakeGhOptions {
	inProgress?: string;
	poll?: string;
	baseline?: string;
	baselineExit?: number;
	dispatchExit?: number;
	watchExit?: number;
}

function fakeGhScript(opts: FakeGhOptions): string {
	return cliFixtures.shScript(`  *"--status in_progress"*)
    printf '%s\\n' '${opts.inProgress ?? "[]"}'
    exit 0
    ;;
  *"--limit 10 --json databaseId,url,event"*)
    printf '%s\\n' '${opts.poll ?? "[]"}'
    exit 0
    ;;
  *"--limit 1 --json databaseId"*)
    printf '%s\\n' '${opts.baseline ?? "[]"}'
    exit ${opts.baselineExit ?? 0}
    ;;
  *"workflow run"*)
    exit ${opts.dispatchExit ?? 0}
    ;;
  *"run watch"*)
    exit ${opts.watchExit ?? 0}
    ;;`);
}

/** Writes the fake gh binary and returns the mutated process.env.PATH to bake into a spawn env. */
function fakeGhPath(opts: FakeGhOptions = {}): string {
	const dir = tmp("test-live-fake-gh-");
	writeFakeCli(dir, "gh", fakeGhScript(opts));
	return process.env.PATH ?? "";
}

function runRow(databaseId: number, event = "workflow_dispatch"): string {
	return JSON.stringify([
		{ databaseId, event, url: `https://github.com/acme/widgets/actions/runs/${databaseId}` },
	]);
}

function baseEnv(opts: { path: string; gitlab?: boolean }): Record<string, string> {
	const env: Record<string, string> = {
		...cliFixtures.isolatedGitEnv({
			path: opts.path,
			home: tmp("test-live-home-"),
			scratch: tmp("test-live-scratch-"),
			state: tmp("test-live-state-"),
		}),
		GIT_AUTHOR_NAME: "T",
		GIT_AUTHOR_EMAIL: "t@t.t",
		GIT_COMMITTER_NAME: "T",
		GIT_COMMITTER_EMAIL: "t@t.t",
	};
	if (!opts.gitlab) env.AI_VCS_PROVIDER = "github";
	return env;
}

async function runCli(
	args: string[],
	cwd: string,
	env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn([BUN_BIN, CLI, "test-live", ...args], {
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

describe("test-live setup — GitLab refusal", () => {
	test("rejects a GitLab origin before any git mutation or workflow discovery", async () => {
		const repo = tmp("test-live-gitlab-repo-");
		runGit(["init", "-q", "-b", BRANCH], repo);
		runGit(["remote", "add", "origin", "git@gitlab.com:acme/widgets.git"], repo);
		runGit(["commit", "-q", "--allow-empty", "-m", "chore: init"], repo);
		const before = headSha(repo);

		const env = baseEnv({ path: fakeGhPath(), gitlab: true });
		const result = await runCli(["setup", "dev"], repo, env);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("GitHub only");
		expect(headSha(repo)).toBe(before);
	});
});

describe("test-live setup — branch guard", () => {
	test("refuses to run on main", async () => {
		const { repo } = buildRepo();
		runGit(["checkout", "-q", "main"], repo);
		const env = baseEnv({ path: fakeGhPath() });
		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("run test-live from a feature branch");
	});
});

describe("test-live setup/cleanup — happy path", () => {
	test("patches, dispatches, watches, then cleanup drops exactly the patch commit", async () => {
		const { origin, repo } = buildRepo();
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(1001) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);
		expect(setupResult.stdout).toContain("Fargate is live on dev");
		expect(readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8")).toContain(
			"workflow_dispatch: {}  # TEST-LIVE: temporary",
		);
		expect(headSha(repo)).not.toBe(preSha);

		const cleanupResult = await runCli(["cleanup"], repo, env);
		expect(cleanupResult.code, cleanupResult.stderr).toBe(0);
		expect(headSha(repo)).toBe(preSha);
		expect(readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8")).not.toContain(
			"workflow_dispatch",
		);
		expect(runGit(["rev-parse", `refs/heads/${BRANCH}`], origin).trim()).toBe(preSha);

		const secondCleanup = await runCli(["cleanup"], repo, env);
		expect(secondCleanup.code).toBe(1);
		expect(secondCleanup.stderr).toContain("no state file");
	});

	test("an already-dispatchable workflow skips the patch entirely", async () => {
		const { repo } = buildRepo();
		writeFileSync(
			join(repo, ".github", "workflows", WORKFLOW_FILE),
			DEPLOY_WORKFLOW.replace("on:\n", "on:\n  workflow_dispatch: {}\n"),
		);
		runGit(["add", "-A"], repo);
		runGit(["commit", "-q", "-m", "chore: already dispatchable"], repo);
		runGit(["push", "-q"], repo);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(2002) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);
		expect(headSha(repo)).toBe(preSha);
		expect(setupResult.stdout).toContain("triggering directly");

		const cleanupResult = await runCli(["cleanup"], repo, env);
		expect(cleanupResult.code, cleanupResult.stderr).toBe(0);
		expect(cleanupResult.stdout).toContain("nothing to revert");
		expect(headSha(repo)).toBe(preSha);
	});
});

const DEPLOY_JOB = "jobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps: []\n";

describe("test-live setup — on: form variants", () => {
	test("patches a scalar on: push into a mapping with workflow_dispatch", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: push\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4001) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(headSha(repo)).not.toBe(preSha);
		const patched = readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8");
		expect(patched).toContain("workflow_dispatch: {}  # TEST-LIVE: temporary");
		expect((parseYaml(patched) as { on: unknown }).on).toEqual({ push: {}, workflow_dispatch: {} });
	});

	test("patches a flow-array on: [push, pull_request] into a mapping with workflow_dispatch", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: [push, pull_request]\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4002) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(headSha(repo)).not.toBe(preSha);
		const patched = readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8");
		expect(patched).toContain("workflow_dispatch: {}  # TEST-LIVE: temporary");
		expect((parseYaml(patched) as { on: unknown }).on).toEqual({
			push: {},
			pull_request: {},
			workflow_dispatch: {},
		});
	});

	test("patches a block-sequence on: [- push, - pull_request] into a mapping with workflow_dispatch", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non:\n  - push\n  - pull_request\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4003) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(headSha(repo)).not.toBe(preSha);
		const patched = readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8");
		expect(patched).toContain("workflow_dispatch: {}  # TEST-LIVE: temporary");
		expect((parseYaml(patched) as { on: unknown }).on).toEqual({
			push: {},
			pull_request: {},
			workflow_dispatch: {},
		});
	});

	test("a scalar on: workflow_dispatch triggers directly without patching", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: workflow_dispatch\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4004) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("triggering directly");
		expect(headSha(repo)).toBe(preSha);
	});

	test("a flow-array already containing workflow_dispatch triggers directly without patching", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: [push, workflow_dispatch]\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4005) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("triggering directly");
		expect(headSha(repo)).toBe(preSha);
	});

	test("a block-sequence already containing workflow_dispatch triggers directly without patching", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non:\n  - push\n  - workflow_dispatch\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4006) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("triggering directly");
		expect(headSha(repo)).toBe(preSha);
	});

	test("patches an empty flow-mapping on: {} into a mapping with workflow_dispatch", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: {}\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4007) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(headSha(repo)).not.toBe(preSha);
		const patched = readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8");
		expect(patched).toContain("workflow_dispatch: {}  # TEST-LIVE: temporary");
		expect((parseYaml(patched) as { on: unknown }).on).toEqual({ workflow_dispatch: {} });
	});

	test("patches a flow-mapping on: {push: null} into a mapping with workflow_dispatch", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: {push: null}\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4008) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(headSha(repo)).not.toBe(preSha);
		const patched = readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8");
		expect(patched).toContain("workflow_dispatch: {}  # TEST-LIVE: temporary");
		expect((parseYaml(patched) as { on: unknown }).on).toEqual({ push: null, workflow_dispatch: {} });
	});

	test("patches a flow-mapping on: {push} (implicit-null shorthand) into a mapping with workflow_dispatch", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: {push}\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4010) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(headSha(repo)).not.toBe(preSha);
		const patched = readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8");
		expect(patched).toContain("workflow_dispatch: {}  # TEST-LIVE: temporary");
		expect((parseYaml(patched) as { on: unknown }).on).toEqual({ push: null, workflow_dispatch: {} });
	});

	test("a flow-mapping already containing workflow_dispatch triggers directly without patching", async () => {
		const { repo } = buildRepoWithWorkflow(`name: Deploy\non: {workflow_dispatch: null}\n${DEPLOY_JOB}`);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4009) }) });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout).toContain("triggering directly");
		expect(headSha(repo)).toBe(preSha);
	});

	test("a workflow with no on: key refuses instead of writing invalid YAML", async () => {
		const workflowContent = `name: Deploy\n${DEPLOY_JOB}`;
		const { repo } = buildRepoWithWorkflow(workflowContent);
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath() });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("could not find a usable 'on:' trigger to patch");
		expect(headSha(repo)).toBe(preSha);
		expect(readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8")).toBe(workflowContent);
	});
});

function flowMappingPair(content: string): Pair<Node, Node | null> {
	const doc = parseDocument(content);
	if (!isMap(doc.contents)) throw new Error("fixture root is not a map");
	const onPair = doc.contents.items.find((item) => String(item.key) === "on");
	if (!onPair || !isMap(onPair.value)) throw new Error("fixture 'on:' is not a flow mapping");
	const pair = onPair.value.items[0] as Pair<Node, Node | null> | undefined;
	if (!pair) throw new Error("fixture flow mapping has no entries");
	return pair;
}

describe("test-live setup — mappingEntryText flow-mapping entry rendering", () => {
	test("renders a null-value flow-shorthand entry as the bare key followed by a colon", () => {
		const content = "on: {push}\njobs: {}\n";
		expect(mappingEntryText(content, flowMappingPair(content))).toBe("push:");
	});

	test("throws when a present value has no source range, which only a constructed (non-parsed) node can have", () => {
		const content = "on: {push: null}\njobs: {}\n";
		const pair = flowMappingPair(content);
		expect(pair.value?.range).toBeDefined();
		pair.value = new Scalar(null);
		expect(pair.value.range).toBeUndefined();
		expect(() => mappingEntryText(content, pair)).toThrow(TestLiveError);
	});
});

describe("test-live — later commits survive cleanup", () => {
	test("a commit made after the patch is preserved, dropping only the patch commit", async () => {
		const { origin, repo } = buildRepo();
		const preSha = headSha(repo);
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(3003) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);
		const patchSha = headSha(repo);
		expect(patchSha).not.toBe(preSha);

		writeFileSync(join(repo, "README.md"), "hello again\n");
		runGit(["add", "-A"], repo);
		runGit(["commit", "-q", "-m", "feat: later work"], repo);
		const laterSha = headSha(repo);
		expect(laterSha).not.toBe(patchSha);

		const cleanupResult = await runCli(["cleanup"], repo, env);
		expect(cleanupResult.code, cleanupResult.stderr).toBe(0);

		const finalLog = log(repo);
		expect(finalLog).toContain("feat: later work");
		expect(finalLog).not.toContain("workflow_dispatch for test-live");
		expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("hello again\n");
		expect(readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8")).not.toContain(
			"workflow_dispatch",
		);
		expect(runGit(["rev-parse", `refs/heads/${BRANCH}`], origin).trim()).toBe(headSha(repo));
	});

	test("a cleanup retry after a transient push failure does not re-rebase or lose the later commit", async () => {
		const { origin, repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(3303) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);
		const patchSha = headSha(repo);

		writeFileSync(join(repo, "README.md"), "hello again\n");
		runGit(["add", "-A"], repo);
		runGit(["commit", "-q", "-m", "feat: later work"], repo);

		Bun.spawnSync(["chmod", "-R", "500", origin]);
		let firstCleanup: Awaited<ReturnType<typeof runCli>>;
		try {
			firstCleanup = await runCli(["cleanup"], repo, env);
		} finally {
			Bun.spawnSync(["chmod", "-R", "700", origin]);
		}
		expect(firstCleanup.code).toBe(1);
		expect(firstCleanup.stderr).toContain("push failed");
		const rebasedSha = headSha(repo);
		expect(rebasedSha).not.toBe(patchSha);
		expect(readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8")).not.toContain(
			"workflow_dispatch",
		);

		const secondCleanup = await runCli(["cleanup"], repo, env);
		expect(secondCleanup.code, secondCleanup.stderr).toBe(0);
		expect(secondCleanup.stdout).toContain("already dropped locally");
		expect(headSha(repo)).toBe(rebasedSha);
		expect(log(repo)).toContain("feat: later work");
		expect(runGit(["rev-parse", `refs/heads/${BRANCH}`], origin).trim()).toBe(rebasedSha);
	});
});

describe("test-live setup — resume while a patch is pending", () => {
	test("a second setup call refuses instead of creating a second patch commit", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(4004) }) });

		const first = await runCli(["setup", "dev"], repo, env);
		expect(first.code, first.stderr).toBe(0);
		const afterFirst = headSha(repo);

		const second = await runCli(["setup", "dev"], repo, env);
		expect(second.code).toBe(1);
		expect(second.stderr).toContain("run cleanup first");
		expect(headSha(repo)).toBe(afterFirst);
		expect(log(repo).match(/workflow_dispatch for test-live/g)?.length ?? 0).toBe(1);
	});
});

describe("test-live cleanup — refusals without data loss", () => {
	test("no prior setup on this branch reports a missing state file", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath() });
		const result = await runCli(["cleanup"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no state file");
	});

	test("cleanup run from a different branch finds no state and leaves the patch branch untouched", async () => {
		const { origin, repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(5005) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);
		const patchedSha = headSha(repo);

		runGit(["checkout", "-q", "main"], repo);
		const result = await runCli(["cleanup"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("no state file");

		runGit(["checkout", "-q", BRANCH], repo);
		expect(headSha(repo)).toBe(patchedSha);
		expect(runGit(["rev-parse", `refs/heads/${BRANCH}`], origin).trim()).toBe(patchedSha);
	});

	test("unrelated uncommitted changes block cleanup and nothing is reset or pushed", async () => {
		const { origin, repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(6006) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);
		const patchedSha = headSha(repo);

		writeFileSync(join(repo, "README.md"), "unrelated edit\n");

		const result = await runCli(["cleanup"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("uncommitted changes");
		expect(headSha(repo)).toBe(patchedSha);
		expect(runGit(["rev-parse", `refs/heads/${BRANCH}`], origin).trim()).toBe(patchedSha);
	});
});

describe("test-live setup — concurrent/duplicate runs", () => {
	test("warns on an in-progress run but still completes", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({
			path: fakeGhPath({ inProgress: runRow(1), poll: runRow(7007) }),
		});
		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stderr).toContain("already in progress");
	});
});

describe("test-live setup — dispatch/push/watch failures", () => {
	test("a dispatch failure dies without starting a watch", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ dispatchExit: 1 }) });
		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("dispatch failed");
	});

	test("a failed previous-run lookup dies instead of watching a stale run", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ baselineExit: 1, poll: runRow(9009) }) });
		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("failed to list previous runs");
	});

	test("a watch failure surfaces the run's own exit status", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(8008), watchExit: 7 }) });
		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(7);
	});

	test("a push failure leaves the patch commit local and recoverable, never silently dropped", async () => {
		const repo = tmp("test-live-no-origin-repo-");
		runGit(["init", "-q", "-b", BRANCH], repo);
		mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
		writeFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), DEPLOY_WORKFLOW);
		runGit(["add", "-A"], repo);
		runGit(["commit", "-q", "-m", "chore: init"], repo);
		const preSha = headSha(repo);

		const env = baseEnv({ path: fakeGhPath() });
		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("push failed");
		expect(headSha(repo)).not.toBe(preSha);

		const cleanup = await runCli(["cleanup"], repo, env);
		expect(cleanup.code).toBe(1);
		expect(cleanup.stderr).toContain("push failed");
	});
});

describe("test-live setup — commit failure", () => {
	test("a failing pre-commit hook reverts the patched workflow file and leaves no state", async () => {
		const { repo } = buildRepo();
		const preSha = headSha(repo);
		const hookPath = join(repo, ".git", "hooks", "pre-commit");
		writeFileSync(hookPath, "#!/bin/sh\nexit 1\n");
		chmodSync(hookPath, 0o755);
		const env = baseEnv({ path: fakeGhPath() });

		const result = await runCli(["setup", "dev"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("failed to commit the workflow patch");
		expect(headSha(repo)).toBe(preSha);
		expect(readFileSync(join(repo, ".github", "workflows", WORKFLOW_FILE), "utf8")).toBe(DEPLOY_WORKFLOW);
		expect(runGit(["status", "--porcelain"], repo).trim()).toBe("");

		const cleanup = await runCli(["cleanup"], repo, env);
		expect(cleanup.code).toBe(1);
		expect(cleanup.stderr).toContain("no state file");
	});
});

describe("test-live cleanup — corrupt state file", () => {
	test("a corrupt state file dies cleanly instead of being treated as no pending patch", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(9501) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);

		const stateFile = findStateFile(env.AI_STATE_DIR);
		writeFileSync(stateFile, "{not valid json");

		const result = await runCli(["cleanup"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("no state file");
		expect(result.stderr).toContain("corrupt");
	});

	test("a git merge-base failure dies instead of being treated as 'already recovered'", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: runRow(9502) }) });

		const setupResult = await runCli(["setup", "dev"], repo, env);
		expect(setupResult.code, setupResult.stderr).toBe(0);

		const stateFile = findStateFile(env.AI_STATE_DIR);
		const state = JSON.parse(readFileSync(stateFile, "utf8")) as { patchCommitSha: string };
		state.patchCommitSha = "deadbeef".repeat(5);
		writeFileSync(stateFile, JSON.stringify(state));

		const result = await runCli(["cleanup"], repo, env);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("git merge-base failed");
	});
});

describe("test-live — scoped state path", () => {
	test("two repositories and two branches never collide on the same state file", async () => {
		const { repo: repoA } = buildRepo();
		const { repo: repoB } = buildRepo();
		const sharedEnv = baseEnv({ path: fakeGhPath({ poll: runRow(9001) }) });

		const first = await runCli(["setup", "dev"], repoA, sharedEnv);
		expect(first.code, first.stderr).toBe(0);

		// Same repo, a different branch: must not see repoA's feature/test-branch pending state.
		runGit(["checkout", "-q", "-b", "feature/other-branch", "main"], repoA);
		runGit(["push", "-q", "-u", "origin", "feature/other-branch"], repoA);
		const second = await runCli(["setup", "dev"], repoA, sharedEnv);
		expect(second.code, second.stderr).toBe(0);
		expect(second.stderr).not.toContain("run cleanup first");

		// A different repository, same branch name and the same state root: must not collide either.
		const third = await runCli(["setup", "dev"], repoB, sharedEnv);
		expect(third.code, third.stderr).toBe(0);
		expect(third.stderr).not.toContain("run cleanup first");
	});
});

describe("test-live setup — poll timeout", () => {
	test("gives up and dies when a matching run never appears", async () => {
		const { repo } = buildRepo();
		const env = baseEnv({ path: fakeGhPath({ poll: "[]" }) });
		const savedCwd = process.cwd();
		const savedEnv = { ...process.env };
		try {
			process.chdir(repo);
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, env);
			const stderr: string[] = [];
			const originalWrite = process.stderr.write.bind(process.stderr);
			process.stderr.write = ((chunk: string | Uint8Array) => {
				stderr.push(chunk.toString());
				return true;
			}) as typeof process.stderr.write;
			try {
				const code = await runSetup(["dev"], { pollIntervalMs: 1, pollMaxAttempts: 2 });
				expect(code).toBe(1);
				expect(stderr.join("")).toContain("timed out waiting for run to appear");
			} finally {
				process.stderr.write = originalWrite;
			}
		} finally {
			process.chdir(savedCwd);
			for (const key of Object.keys(process.env)) delete process.env[key];
			Object.assign(process.env, savedEnv);
		}
	});
});
