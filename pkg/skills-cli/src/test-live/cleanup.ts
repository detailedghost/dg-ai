import { readFileSync } from "node:fs";
import { runCapture } from "@dg/common/node";
import { currentBranch } from "../utils/git";
import { readTestLiveState, removeTestLiveState } from "./state";

const PATCH_MARKER = "workflow_dispatch: {}  # TEST-LIVE: temporary";

function die(message: string): number {
	process.stderr.write(`test-live-cleanup: ${message}\n`);
	return 1;
}

function info(message: string): void {
	process.stdout.write(`>>> ${message}\n`);
}

function git(args: string[]) {
	return runCapture("git", args, { stdin: null });
}

/** A missing or unreadable workflow file is never treated as "already clean" — that would skip real recovery. */
function workflowStillPatched(workflowPath: string): boolean {
	try {
		return readFileSync(workflowPath, "utf8").includes(PATCH_MARKER);
	} catch {
		return true;
	}
}

export async function runCleanup(): Promise<number> {
	const branch = await currentBranch();
	const state = readTestLiveState(branch);
	if (!state) {
		return die(`no state file for branch '${branch}' — nothing to clean up`);
	}

	if (!state.patched) {
		info("workflow was not patched — nothing to revert");
		removeTestLiveState(branch);
		return 0;
	}

	if (!state.prePatchSha || !state.patchCommitSha) {
		return die("state file is missing its patch commit metadata");
	}

	// Tracked-only: reset/rebase never touch untracked files, so a stray untracked file should not block cleanup.
	const dirty = await git(["diff", "--quiet", "HEAD"]);
	if (dirty.status === 1) {
		return die("uncommitted changes are present — commit or stash them before cleanup");
	}
	if (dirty.status !== 0) {
		return die(`git diff failed while checking for uncommitted changes: ${dirty.stderr.trim()}`);
	}

	const headSha = (await git(["rev-parse", "HEAD"])).stdout.trim();

	if (headSha !== state.prePatchSha) {
		if (headSha === state.patchCommitSha) {
			info(`Resetting to pre-patch SHA ${state.prePatchSha}...`);
			const reset = await git(["reset", "--hard", state.prePatchSha]);
			if (reset.status !== 0) return die(`reset failed: ${reset.stderr.trim()}`);
		} else {
			const ancestor = await git(["merge-base", "--is-ancestor", state.patchCommitSha, "HEAD"]);
			if (ancestor.status !== 0) {
				// A prior cleanup run may have rebased successfully and only failed at the push retry below;
				// the marker's absence from the workflow file at HEAD is how we tell that apart from real data loss.
				if (workflowStillPatched(state.workflowPath)) {
					return die(
						`the patch commit ${state.patchCommitSha.slice(0, 8)} is no longer in this branch's history — inspect the branch manually before retrying`,
					);
				}
				info("Patch commit already dropped locally — retrying the push...");
			} else {
				info(`Dropping the patch commit ${state.patchCommitSha.slice(0, 8)}, keeping later commits...`);
				const rebase = await git(["rebase", "--onto", `${state.patchCommitSha}^`, state.patchCommitSha]);
				if (rebase.status !== 0) {
					await git(["rebase", "--abort"]);
					return die(`rebase to drop the patch commit failed and was aborted: ${rebase.stderr.trim()}`);
				}
			}
		}
	}

	const push = await git(["push", "--force-with-lease"]);
	if (push.status !== 0) {
		return die(`push failed: ${push.stderr.trim()} — the remote may have moved; inspect 'git status' before retrying`);
	}

	info("✅  Temp commits dropped. Branch is clean.");
	removeTestLiveState(branch);
	return 0;
}
