/** Recoverable setup state, scoped per repository and branch; cleanup trusts only these fields. */
export interface TestLiveState {
	branch: string;
	env: string;
	workflowFile: string;
	workflowPath: string;
	patched: boolean;
	patchCommitSha: string | null;
	prePatchSha: string | null;
	runUrl: string | null;
	runId: string | null;
	createdAt: string;
}
