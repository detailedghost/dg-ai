import type { ShellTag } from "../utils/git";
import { makeBinPreflightTag } from "./preflight";
import {
	type CiFailure,
	COPILOT_BOT_NAME,
	type CreateIssueInput,
	type CreatePullRequestInput,
	checkAuthStatus,
	deriveHostFromUrl,
	extractNumberFromUrl,
	flattenPaginated,
	getBodyViaView,
	hostnameFlags,
	type Issue,
	isAlreadyExistsError,
	isCliErrorContaining,
	type ListIssuesOptions,
	type ListPullRequestsOptions,
	type ListUnresolvedThreadsOptions,
	normalizeIssueStateFilter,
	normalizePrStateFilter,
	type PostedReview,
	type PostReviewInput,
	type Provider,
	ProviderError,
	type PrRef,
	type PrState,
	type PullRequest,
	type RepoInfo,
	type RepoRef,
	type ReviewComment,
	type ReviewCommentInput,
	type ReviewThread,
	type ReviewVerdict,
	truncateLogExcerpt,
} from "./types";

const PR_JSON_FIELDS = "number,title,url,state,headRefName,baseRefName,body,mergedAt";
const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;
const DEFAULT_HOST = "github.com";

const FAILING_CONCLUSIONS = new Set(["failure", "timed_out", "action_required", "startup_failure"]);

function resolveGhBin(): string {
	return process.env.GH_BIN ?? "gh";
}

function repoFlags(repo?: RepoRef): string[] {
	if (!repo) return [];
	const path = `${repo.owner}/${repo.repo}`;
	return repo.host && repo.host !== DEFAULT_HOST ? ["-R", `${repo.host}/${path}`] : ["-R", path];
}

function repoSlug(repo?: RepoRef): string {
	if (!repo) return "";
	const path = `${repo.owner}/${repo.repo}`;
	return repo.host && repo.host !== DEFAULT_HOST ? `${repo.host}/${path}` : path;
}

function ownerRepoPath(repo?: RepoRef): string {
	return repo ? `${repo.owner}/${repo.repo}` : "{owner}/{repo}";
}

function apiHostFlags(repo?: RepoRef): string[] {
	return hostnameFlags(repo, DEFAULT_HOST);
}

function isNoPrError(err: unknown): boolean {
	return isCliErrorContaining(err, "no pull requests found");
}

function normalizeGhPr(raw: Record<string, unknown>): PullRequest {
	const state = raw.state as PrState;
	return {
		number: raw.number as number,
		title: raw.title as string,
		url: raw.url as string,
		state,
		headRefName: raw.headRefName as string,
		baseRefName: raw.baseRefName as string,
		body: (raw.body as string) ?? "",
		mergedAt: (raw.mergedAt as string | null) ?? null,
		merged: state === "MERGED",
	};
}

/** Maps `gh api repos/{owner}/{repo}/pulls` REST payloads (snake_case, no computed state) onto the normalized DTO. */
function normalizeGhPrRest(raw: Record<string, unknown>): PullRequest {
	const rawState = raw.state as string | undefined;
	const mergedAt = (raw.merged_at as string | null) ?? null;
	const state: PrState = mergedAt !== null ? "MERGED" : rawState === "closed" ? "CLOSED" : "OPEN";
	const head = raw.head as Record<string, unknown> | undefined;
	const base = raw.base as Record<string, unknown> | undefined;
	return {
		number: raw.number as number,
		title: raw.title as string,
		url: (raw.html_url as string) ?? "",
		state,
		headRefName: (head?.ref as string) ?? "",
		baseRefName: (base?.ref as string) ?? "",
		body: (raw.body as string) ?? "",
		mergedAt,
		merged: mergedAt !== null,
	};
}

function extractPrNumber(url: string): number {
	return extractNumberFromUrl(url, /\/pull\/(\d+)/, "gh pr create");
}

async function repoInfo(tag: ShellTag, repo?: RepoRef): Promise<RepoInfo> {
	const result = await tag`repo view ${repoSlug(repo)} --json owner,name,defaultBranchRef,url`;
	const raw = JSON.parse(result.stdout.toString());
	return {
		host: deriveHostFromUrl(raw.url) ?? repo?.host ?? DEFAULT_HOST,
		owner: raw.owner?.login ?? repo?.owner ?? "",
		repo: raw.name ?? repo?.repo ?? "",
		defaultBranch: raw.defaultBranchRef?.name ?? "",
	};
}

async function currentPullRequest(tag: ShellTag, repo?: RepoRef): Promise<PullRequest | null> {
	try {
		const result = await tag`pr view ${repoFlags(repo)} --json ${PR_JSON_FIELDS}`;
		return normalizeGhPr(JSON.parse(result.stdout.toString()));
	} catch (err) {
		if (isNoPrError(err)) return null;
		throw err;
	}
}

async function viewPullRequest(tag: ShellTag, ref: PrRef): Promise<PullRequest> {
	const result = await tag`pr view ${String(ref.number)} ${repoFlags(ref.repo)} --json ${PR_JSON_FIELDS}`;
	return normalizeGhPr(JSON.parse(result.stdout.toString()));
}

async function createPullRequest(tag: ShellTag, input: CreatePullRequestInput, repo?: RepoRef): Promise<PullRequest> {
	const draftFlags = input.draft ? ["--draft"] : [];
	const result = await tag.withInput(
		input.body,
	)`pr create ${draftFlags} --title ${input.title} --base ${input.base} --head ${input.head} --body-file - ${repoFlags(repo)}`;
	const number = extractPrNumber(result.stdout.toString().trim());
	return viewPullRequest(tag, { number, repo });
}

function normalizeGhIssue(raw: Record<string, unknown>): Issue {
	const labels = Array.isArray(raw.labels)
		? raw.labels.map((label) =>
				typeof label === "string" ? label : String((label as Record<string, unknown>).name ?? ""),
			)
		: [];
	return {
		number: raw.number as number,
		title: raw.title as string,
		url: (raw.url as string) ?? "",
		state: raw.state === "CLOSED" ? "CLOSED" : "OPEN",
		body: (raw.body as string) ?? "",
		labels: labels.filter(Boolean),
		createdAt: (raw.createdAt as string) ?? "",
		commentCount: Array.isArray(raw.comments) ? raw.comments.length : Number(raw.comments ?? 0),
	};
}

const ISSUE_JSON_FIELDS = "number,title,url,state,body,labels,createdAt,comments";

function issueStateFlags(opts?: ListIssuesOptions): string[] {
	const state = normalizeIssueStateFilter(opts?.state);
	return ["--state", state === "ALL" ? "all" : state === "CLOSED" ? "closed" : "open"];
}

async function listIssues(tag: ShellTag, opts?: ListIssuesOptions, repo?: RepoRef): Promise<Issue[]> {
	const limit = opts?.limit ?? 100;
	const labelFlags = opts?.label ? ["--label", opts.label] : [];
	const result =
		await tag`issue list ${issueStateFlags(opts)} --limit ${String(limit)} --json ${ISSUE_JSON_FIELDS} ${labelFlags} ${repoFlags(repo)}`;
	const raw = JSON.parse(result.stdout.toString());
	return (Array.isArray(raw) ? raw : []).map(normalizeGhIssue).slice(0, limit);
}

async function viewIssue(tag: ShellTag, number: number, repo?: RepoRef): Promise<Issue> {
	const result = await tag`issue view ${String(number)} --json ${ISSUE_JSON_FIELDS} ${repoFlags(repo)}`;
	return normalizeGhIssue(JSON.parse(result.stdout.toString()));
}

function extractIssueNumber(url: string): number {
	return extractNumberFromUrl(url, /\/issues\/(\d+)(?:[/?#]|$)/, "gh issue create");
}

async function createIssue(tag: ShellTag, input: CreateIssueInput, repo?: RepoRef): Promise<Issue> {
	const labelFlags = (input.labels ?? []).flatMap((l) => ["--label", l]);
	const assigneeFlags = (input.assignees ?? []).flatMap((a) => ["--assignee", a]);
	const result = await tag.withInput(
		input.body ?? "",
	)`issue create --title ${input.title} --body-file - ${labelFlags} ${assigneeFlags} ${repoFlags(repo)}`;
	const number = extractIssueNumber(result.stdout.toString().trim());
	return viewIssue(tag, number, repo);
}

async function addLabelsToIssue(tag: ShellTag, number: number, labels: string[], repo?: RepoRef): Promise<Issue> {
	const labelFlags = labels.flatMap((l) => ["--add-label", l]);
	await tag`issue edit ${String(number)} ${labelFlags} ${repoFlags(repo)}`;
	return viewIssue(tag, number, repo);
}

/** No `--force`: that flag recolors an existing label on every call, a destructive side effect on shared repo state. */
async function ensureLabel(tag: ShellTag, name: string, repo?: RepoRef): Promise<void> {
	try {
		await tag`label create ${name} ${repoFlags(repo)}`;
	} catch (err) {
		if (!isAlreadyExistsError(err)) throw err;
	}
}

async function tryGetCurrentPrNumber(tag: ShellTag, repo?: RepoRef): Promise<number | undefined> {
	try {
		const result = await tag`pr view ${repoFlags(repo)} --json number`;
		const text = result.stdout.toString().trim();
		if (!text) return undefined;
		const parsed = JSON.parse(text);
		return typeof parsed.number === "number" ? parsed.number : undefined;
	} catch (err) {
		if (isNoPrError(err)) {
			throw new ProviderError("NO_CURRENT_PR", "no pull request found for the current branch");
		}
		throw err;
	}
}

function normalizeGhThread(node: {
	id: string;
	isResolved?: boolean;
	path?: string | null;
	line?: number | null;
	originalLine?: number | null;
	comments?: {
		nodes?: Array<{
			databaseId: number;
			author?: { login?: string };
			body?: string;
			createdAt?: string;
			diffHunk?: string | null;
		}>;
	};
}): ReviewThread {
	const comments: ReviewComment[] = (node.comments?.nodes ?? []).map((c) => ({
		id: String(c.databaseId),
		author: c.author?.login ?? "",
		body: c.body ?? "",
		createdAt: c.createdAt ?? "",
		diffHunk: c.diffHunk ?? "",
	}));
	return {
		threadId: node.id,
		resolved: Boolean(node.isResolved),
		comments,
		commentId: comments[0]?.id,
		path: node.path ?? "",
		line: node.line ?? node.originalLine ?? null,
	};
}

const LIST_THREADS_QUERY =
	"query($owner:String!,$repo:String!,$number:Int!,$after:String){repository(owner:$owner,name:$repo){" +
	"pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{id isResolved path line originalLine " +
	"comments(first:50){nodes{databaseId author{login} body createdAt diffHunk}}} pageInfo{hasNextPage endCursor}}}}}";

async function listUnresolvedThreads(
	tag: ShellTag,
	opts?: ListUnresolvedThreadsOptions,
	ref?: PrRef,
): Promise<ReviewThread[]> {
	const number = ref?.number ?? (await tryGetCurrentPrNumber(tag, ref?.repo));
	if (number === undefined) {
		throw new ProviderError("NO_CURRENT_PR", "no pull request found for the current branch");
	}
	const numberFlag = ["-F", `number=${number}`];
	const nodes: Array<Parameters<typeof normalizeGhThread>[0]> = [];
	let after: string | null = null;
	let page = 0;
	do {
		const afterFlag = after !== null ? ["-F", `after=${after}`] : [];
		const ownerValue = ref?.repo ? ref.repo.owner : "{owner}";
		const repoValue = ref?.repo ? ref.repo.repo : "{repo}";
		const result =
			await tag`api graphql -f query=${LIST_THREADS_QUERY} -F owner=${ownerValue} -F repo=${repoValue} ${numberFlag} ${afterFlag} ${apiHostFlags(ref?.repo)}`;
		const parsed = JSON.parse(result.stdout.toString());
		const threadsPage = parsed?.data?.repository?.pullRequest?.reviewThreads;
		nodes.push(...(threadsPage?.nodes ?? []));
		after = threadsPage?.pageInfo?.hasNextPage ? (threadsPage.pageInfo.endCursor ?? null) : null;
		page += 1;
	} while (after !== null && page < MAX_LIST_PAGES);
	if (after !== null) {
		throw new ProviderError(
			"PAGE_LIMIT_EXCEEDED",
			`listUnresolvedThreads: exceeded ${MAX_LIST_PAGES} pages of review threads without reaching the end`,
		);
	}
	const threads = nodes.map(normalizeGhThread);
	return opts?.includeResolved ? threads : threads.filter((t: ReviewThread) => !t.resolved);
}

/** GitHub review-thread node ids are globally unique, so resolving needs no repo or PR targeting. */
async function resolveThread(tag: ShellTag, threadId: string, ref?: PrRef): Promise<void> {
	const mutation = "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id}}}";
	await tag`api graphql -f query=${mutation} -F threadId=${threadId} ${apiHostFlags(ref?.repo)}`;
}

async function replyToThread(
	tag: ShellTag,
	_threadId: string,
	commentId: string,
	body: string,
	ref?: PrRef,
): Promise<ReviewComment> {
	if (ref?.number === undefined) {
		throw new ProviderError("INVALID_ARGUMENT", "replyToThread requires a pull request number on GitHub");
	}
	const result =
		await tag`api repos/${ownerRepoPath(ref.repo)}/pulls/${String(ref.number)}/comments/${commentId}/replies --method POST -f body=${body} ${apiHostFlags(ref.repo)}`;
	const c = JSON.parse(result.stdout.toString());
	if (c?.id === undefined || c?.body === undefined) {
		throw new ProviderError(
			"PARSE_ERROR",
			"gh api review-comment reply response is missing the expected comment shape",
		);
	}
	if (String(c.in_reply_to_id) !== commentId) {
		throw new ProviderError(
			"PARSE_ERROR",
			`gh api review-comment reply targeted ${String(c.in_reply_to_id)}, expected ${commentId}`,
		);
	}
	return {
		id: String(c.id),
		author: c.user?.login ?? "",
		body: c.body ?? "",
		createdAt: c.created_at ?? "",
		diffHunk: c.diff_hunk ?? "",
	};
}

/** Normalizes `gh api --paginate --slurp` check-runs output (an array of per-page `{check_runs}` objects) into a flat run array. */
function collectCheckRuns(raw: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((page) => {
		const obj = page as Record<string, unknown>;
		return Array.isArray(obj?.check_runs) ? (obj.check_runs as Array<Record<string, unknown>>) : [];
	});
}

/** Extracts the parent workflow run id from a check-run's `.../actions/runs/{runId}/job/{jobId}` details URL. */
function parseWorkflowRunId(detailsUrl: unknown): string | undefined {
	if (typeof detailsUrl !== "string") return undefined;
	const match = /\/actions\/runs\/(\d+)\/job\/\d+/.exec(detailsUrl);
	return match ? match[1] : undefined;
}

async function listCiFailures(tag: ShellTag, ref: PrRef): Promise<CiFailure[]> {
	const prResult = await tag`pr view ${String(ref.number)} ${repoFlags(ref.repo)} --json headRefOid`;
	const { headRefOid } = JSON.parse(prResult.stdout.toString());
	const listResult =
		await tag`api repos/${ownerRepoPath(ref.repo)}/commits/${headRefOid}/check-runs --method GET --paginate --slurp -F per_page=${String(PAGE_SIZE)} ${apiHostFlags(ref.repo)}`;
	const raw = JSON.parse(listResult.stdout.toString());
	const runs = collectCheckRuns(raw);
	const failing = runs.filter((r) => FAILING_CONCLUSIONS.has(r.conclusion as string));

	const results: CiFailure[] = [];
	for (const run of failing) {
		const jobId = String(run.id);
		const runId = parseWorkflowRunId(run.details_url) ?? parseWorkflowRunId(run.html_url);
		let logExcerpt = "";
		try {
			const logResult =
				await tag`api repos/${ownerRepoPath(ref.repo)}/actions/jobs/${jobId}/logs ${apiHostFlags(ref.repo)}`;
			logExcerpt = truncateLogExcerpt(logResult.stdout.toString());
		} catch {}
		let configFile = "";
		if (runId !== undefined) {
			try {
				const runResult =
					await tag`api repos/${ownerRepoPath(ref.repo)}/actions/runs/${runId} ${apiHostFlags(ref.repo)}`;
				const runRaw = JSON.parse(runResult.stdout.toString());
				configFile = (runRaw.path as string) ?? "";
			} catch {}
		}
		results.push({
			executionId: runId ?? jobId,
			jobId,
			configFile,
			name: (run.name as string) ?? "",
			conclusion: (run.conclusion as string) ?? "",
			logExcerpt,
			url: (run.details_url as string) ?? (run.html_url as string) ?? "",
		});
	}
	return results;
}

async function retargetPullRequest(tag: ShellTag, ref: PrRef, newBase: string): Promise<void> {
	await tag`pr edit ${String(ref.number)} ${repoFlags(ref.repo)} --base ${newBase}`;
}

async function getPullRequestBody(tag: ShellTag, ref: PrRef): Promise<string> {
	return getBodyViaView(() => viewPullRequest(tag, ref));
}

async function setPullRequestBody(tag: ShellTag, ref: PrRef, body: string): Promise<void> {
	await tag.withInput(body)`pr edit ${String(ref.number)} ${repoFlags(ref.repo)} --body-file -`;
}

async function closePullRequest(tag: ShellTag, ref: PrRef, comment?: string): Promise<void> {
	const commentFlags = comment === undefined ? [] : ["--comment", comment];
	await tag`pr close ${String(ref.number)} ${repoFlags(ref.repo)} ${commentFlags}`;
}

/** gh itself supports --author/--label; this adapter's REST /pulls path doesn't implement them yet — an adapter gap, not a provider one. */
function assertSupportedListFilters(opts?: ListPullRequestsOptions): void {
	if (opts?.author) {
		throw new ProviderError(
			"REST_FILTER_UNIMPLEMENTED",
			"listPullRequests({ author }) is not yet implemented by this adapter's REST /pulls listing path, though gh itself supports --author",
		);
	}
	if (opts?.label) {
		throw new ProviderError(
			"REST_FILTER_UNIMPLEMENTED",
			"listPullRequests({ label }) is not yet implemented by this adapter's REST /pulls listing path, though gh itself supports --label",
		);
	}
}

/** GitHub's REST /pulls endpoint requires `head=owner:ref` — a bare ref is silently ignored and returns the unfiltered list. */
async function resolveHeadOwner(tag: ShellTag, repo?: RepoRef): Promise<string> {
	if (repo) return repo.owner;
	const info = await repoInfo(tag, repo);
	return info.owner;
}

/** GitHub's REST /pulls `state` param only accepts open/closed/all — MERGED is requested as state=all and filtered client-side below. */
async function restFilterFlags(tag: ShellTag, opts?: ListPullRequestsOptions, repo?: RepoRef): Promise<string[]> {
	const state = normalizePrStateFilter(opts?.state);
	const stateValue = state === "OPEN" ? "open" : state === "CLOSED" ? "closed" : "all";
	const flags: string[] = ["-F", `state=${stateValue}`];
	if (opts?.head) {
		const owner = await resolveHeadOwner(tag, repo);
		flags.push("-F", `head=${owner}:${opts.head}`);
	}
	return flags;
}

async function listPullRequests(tag: ShellTag, opts?: ListPullRequestsOptions, repo?: RepoRef): Promise<PullRequest[]> {
	assertSupportedListFilters(opts);
	const filterFlags = await restFilterFlags(tag, opts, repo);
	const result =
		await tag`api repos/${ownerRepoPath(repo)}/pulls --method GET --paginate -F per_page=${String(PAGE_SIZE)} ${filterFlags} ${apiHostFlags(repo)}`;
	const raw = JSON.parse(result.stdout.toString());
	const flat = flattenPaginated<Record<string, unknown>>(raw);
	let all = flat.map(normalizeGhPrRest);
	const stateFilter = normalizePrStateFilter(opts?.state);
	if (stateFilter === "MERGED") {
		all = all.filter((pr) => pr.merged);
	} else if (stateFilter === "CLOSED") {
		all = all.filter((pr) => !pr.merged);
	}
	return opts?.limit ? all.slice(0, opts.limit) : all;
}

async function fetchDiff(tag: ShellTag, ref: PrRef): Promise<string> {
	const result = await tag`pr diff ${String(ref.number)} ${repoFlags(ref.repo)} --color never`;
	return result.stdout.toString();
}

const GITHUB_REVIEW_EVENTS: Record<ReviewVerdict, string> = {
	approve: "APPROVE",
	request_changes: "REQUEST_CHANGES",
	comment: "COMMENT",
};

/** GitHub rejects APPROVE and REQUEST_CHANGES from the PR author with this phrase; both are retried as COMMENT. */
const OWN_PR_NEEDLE = "your own pull request";

const EMPTY_REVIEW_BODY = "Reviewed via /thrash.";

function toGithubReviewComment(c: ReviewCommentInput): Record<string, unknown> {
	const onNewSide = c.newLine !== undefined;
	return {
		path: c.path,
		line: onNewSide ? c.newLine : c.oldLine,
		side: onNewSide ? "RIGHT" : "LEFT",
		body: c.body,
	};
}

async function submitReview(
	tag: ShellTag,
	ref: PrRef,
	verdict: ReviewVerdict,
	input: PostReviewInput,
	commitId: string,
): Promise<Record<string, unknown>> {
	const payload = JSON.stringify({
		commit_id: commitId,
		event: GITHUB_REVIEW_EVENTS[verdict],
		body: input.body.trim() || EMPTY_REVIEW_BODY,
		comments: input.comments.map(toGithubReviewComment),
	});
	const result = await tag.withInput(
		payload,
	)`api repos/${ownerRepoPath(ref.repo)}/pulls/${String(ref.number)}/reviews --method POST --input - ${apiHostFlags(ref.repo)}`;
	return JSON.parse(result.stdout.toString());
}

async function postReview(tag: ShellTag, ref: PrRef, input: PostReviewInput): Promise<PostedReview> {
	const prResult = await tag`pr view ${String(ref.number)} ${repoFlags(ref.repo)} --json headRefOid`;
	const { headRefOid } = JSON.parse(prResult.stdout.toString());
	try {
		const raw = await submitReview(tag, ref, input.verdict, input, headRefOid);
		return {
			url: (raw.html_url as string) ?? "",
			verdict: input.verdict,
			degraded: false,
			commentCount: input.comments.length,
		};
	} catch (err) {
		if (input.verdict === "comment" || !isCliErrorContaining(err, OWN_PR_NEEDLE)) throw err;
		const raw = await submitReview(tag, ref, "comment", input, headRefOid);
		return {
			url: (raw.html_url as string) ?? "",
			verdict: "comment",
			degraded: true,
			commentCount: input.comments.length,
		};
	}
}

async function checkAuth(tag: ShellTag): Promise<boolean> {
	return checkAuthStatus(tag);
}

/** Create an inert GitHub adapter using GH_BIN or gh; commands validate CLI availability when invoked. */
export function createGithubProvider(): Provider {
	const bin = resolveGhBin();
	const tag = makeBinPreflightTag(bin, {
		code: "GH_NOT_FOUND",
		label: "gh",
		installHint: "https://cli.github.com",
		envVar: "GH_BIN",
	});

	return {
		capabilities: Object.freeze({
			aiReviewBot: true,
			aiReviewBotNames: Object.freeze([COPILOT_BOT_NAME]),
			nativeStacking: true,
		}),
		repoInfo: (repo) => repoInfo(tag, repo),
		currentPullRequest: (repo) => currentPullRequest(tag, repo),
		createPullRequest: (input, repo) => createPullRequest(tag, input, repo),
		viewPullRequest: (ref) => viewPullRequest(tag, ref),
		listUnresolvedThreads: (opts, ref) => listUnresolvedThreads(tag, opts, ref),
		resolveThread: (threadId, ref) => resolveThread(tag, threadId, ref),
		replyToThread: (threadId, commentId, body, ref) => replyToThread(tag, threadId, commentId, body, ref),
		listCiFailures: (ref) => listCiFailures(tag, ref),
		fetchDiff: (ref) => fetchDiff(tag, ref),
		postReview: (ref, input) => postReview(tag, ref, input),
		retargetPullRequest: (ref, newBase) => retargetPullRequest(tag, ref, newBase),
		getPullRequestBody: (ref) => getPullRequestBody(tag, ref),
		setPullRequestBody: (ref, body) => setPullRequestBody(tag, ref, body),
		closePullRequest: (ref, comment) => closePullRequest(tag, ref, comment),
		listPullRequests: (opts, repo) => listPullRequests(tag, opts, repo),
		listIssues: (opts, repo) => listIssues(tag, opts, repo),
		viewIssue: (number, repo) => viewIssue(tag, number, repo),
		createIssue: (input, repo) => createIssue(tag, input, repo),
		addLabelsToIssue: (number, labels, repo) => addLabelsToIssue(tag, number, labels, repo),
		ensureLabel: (name, repo) => ensureLabel(tag, name, repo),
		checkAuth: () => checkAuth(tag),
	};
}
