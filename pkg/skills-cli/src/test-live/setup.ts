import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { runCapture, runNative } from "@dg/common/node";
import { detectProvider } from "../provider/detect";
import { currentBranch } from "../utils/git";
import { findWorkflow, TestLiveError } from "./discover";
import { git, info, makeDie } from "./shared";
import { readTestLiveState, writeTestLiveState } from "./state";
import type { TestLiveState } from "./types";

export interface SetupDeps {
	pollIntervalMs: number;
	pollMaxAttempts: number;
}

const DEFAULT_SETUP_DEPS: SetupDeps = { pollIntervalMs: 4000, pollMaxAttempts: 20 };

interface GhRun {
	databaseId: number;
	url: string;
	event: string;
}

const die = makeDie("test-live");

function gh(args: string[]) {
	return runCapture("gh", args, { stdin: null });
}

function parseGhRuns(stdout: string): GhRun[] {
	try {
		const rows = JSON.parse(stdout) as unknown;
		return Array.isArray(rows) ? (rows as GhRun[]) : [];
	} catch (error) {
		process.stderr.write(
			`test-live: failed to parse gh run list output as JSON: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return [];
	}
}

const ON_KEY = /^on:[ \t]*\r?$/m;

export async function runSetup(args: string[], deps: SetupDeps = DEFAULT_SETUP_DEPS): Promise<number> {
	const env = args[0] || "dev";

	let detection: Awaited<ReturnType<typeof detectProvider>>;
	try {
		detection = await detectProvider();
	} catch (error) {
		return die(error instanceof Error ? error.message : String(error));
	}
	if (detection.kind === "gitlab") {
		return die("supports GitHub only");
	}

	const branch = await currentBranch();
	if (branch === "main" || branch === "master") {
		return die(`on ${branch} — run test-live from a feature branch`);
	}

	let existing: TestLiveState | null;
	try {
		existing = readTestLiveState(branch);
	} catch (error) {
		if (error instanceof TestLiveError) return die(error.message);
		throw error;
	}
	if (existing?.patched) {
		return die(`a test-live patch is already pending on ${branch} — run cleanup first`);
	}

	const workflowsDir = join(process.cwd(), ".github", "workflows");
	if (!existsSync(workflowsDir)) {
		return die(`no .github/workflows found in ${process.cwd()}`);
	}

	let workflowPath: string;
	try {
		workflowPath = findWorkflow(env, workflowsDir);
	} catch (error) {
		if (error instanceof TestLiveError) return die(error.message);
		throw error;
	}
	const workflowFile = basename(workflowPath);
	info(`Workflow: ${workflowPath}`);

	const inProgress = await gh([
		"run",
		"list",
		"--workflow",
		workflowFile,
		"--branch",
		branch,
		"--status",
		"in_progress",
		"--limit",
		"1",
		"--json",
		"databaseId",
	]);
	if (inProgress.status === 0 && parseGhRuns(inProgress.stdout).length > 0) {
		process.stderr.write(`WARNING: a run is already in progress for ${workflowFile} on ${branch}\n`);
	}

	const content = readFileSync(workflowPath, "utf8");
	let patched = false;
	let patchCommitSha: string | null = null;
	let prePatchSha: string | null = null;

	if (content.includes("workflow_dispatch")) {
		info("workflow_dispatch already present — triggering directly");
	} else {
		if (!ON_KEY.test(content)) {
			return die(`could not find an 'on:' key to patch in ${workflowPath}`);
		}
		prePatchSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
		writeFileSync(workflowPath, content.replace(ON_KEY, "on:\n  workflow_dispatch: {}  # TEST-LIVE: temporary"));
		await git(["add", workflowPath]);
		const commit = await git(["commit", "-m", "chore(ci): add workflow_dispatch for test-live [skip ci]"]);
		if (commit.status !== 0) {
			await git(["checkout", "HEAD", "--", workflowPath]);
			return die(`failed to commit the workflow patch: ${commit.stderr.trim()}`);
		}
		patchCommitSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
		patched = true;
	}

	const baseState: TestLiveState = {
		branch,
		env,
		workflowFile,
		workflowPath,
		patched,
		patchCommitSha,
		prePatchSha,
		runUrl: null,
		runId: null,
		createdAt: new Date().toISOString(),
	};
	// Write state right after the commit (before the push), so a push failure still leaves a recoverable state file.
	writeTestLiveState(baseState);

	if (patched) {
		const push = await git(["push"]);
		if (push.status !== 0) {
			return die(
				`push failed: ${push.stderr.trim()} — the patch commit is local; run cleanup to revert it, or push manually and rerun`,
			);
		}
		info("Patched and pushed");
	}

	const previous = await gh([
		"run",
		"list",
		"--workflow",
		workflowFile,
		"--branch",
		branch,
		"--limit",
		"1",
		"--json",
		"databaseId",
	]);
	const prevId = previous.status === 0 ? parseGhRuns(previous.stdout)[0]?.databaseId ?? 0 : 0;

	info(`Triggering ${workflowFile} on ${branch}...`);
	const dispatch = await gh(["workflow", "run", workflowFile, "--ref", branch]);
	if (dispatch.status !== 0) {
		return die(`dispatch failed: ${dispatch.stderr.trim()}`);
	}

	info("Waiting for run to appear...");
	let runId = "";
	let runUrl = "";
	for (let attempt = 0; attempt < deps.pollMaxAttempts; attempt++) {
		const list = await gh([
			"run",
			"list",
			"--workflow",
			workflowFile,
			"--branch",
			branch,
			"--limit",
			"10",
			"--json",
			"databaseId,url,event",
		]);
		if (list.status === 0) {
			const newest = parseGhRuns(list.stdout)
				.filter((run) => run.event === "workflow_dispatch" && run.databaseId > prevId)
				.sort((a, b) => a.databaseId - b.databaseId)
				.at(-1);
			if (newest) {
				runId = String(newest.databaseId);
				runUrl = newest.url;
				break;
			}
		}
		if (attempt < deps.pollMaxAttempts - 1) await Bun.sleep(deps.pollIntervalMs);
	}

	if (!runId) {
		return die(`timed out waiting for run to appear — check: gh run list --workflow ${workflowFile}`);
	}

	writeTestLiveState({ ...baseState, runUrl, runId });

	info(`Run: ${runUrl}`);
	info("Watching (this may take several minutes)...");

	const watchStatus = await runNative("gh", ["run", "watch", runId, "--exit-status"], process.cwd());
	if (watchStatus !== 0) return watchStatus;

	process.stdout.write(`\n✅  Fargate is live on ${env}\n    Run: ${runUrl}\n`);
	return 0;
}
