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
	FIELD_MAP,
	flattenPaginated,
	GITLAB_STATE_TO_PR_STATE,
	hostnameFlags,
	type Issue,
	isAlreadyExistsError,
	isCliErrorContaining,
	isNotFoundError,
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
	type PullRequest,
	type RepoInfo,
	type RepoRef,
	type ReviewComment,
	type ReviewCommentInput,
	type ReviewThread,
	type ReviewVerdict,
	truncateLogExcerpt,
} from "./types";

const PAGE_SIZE = 100;
const MAX_LIST_PAGES = 50;
const DEFAULT_HOST = "gitlab.com";

const FAILING_JOB_STATUSES = new Set(["failed"]);

const CONTROL_CHAR_CEILING = 0x1f;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function resolveGlabBin(): string {
	return process.env.GLAB_BIN ?? "glab";
}

const ESCAPED_WHITESPACE: Record<number, string> = { [TAB]: "\\t", [LINE_FEED]: "\\n", [CARRIAGE_RETURN]: "\\r" };

/** Escapes raw tab, LF and CR inside string literals and drops other control characters everywhere. */
function stripRawControlChars(raw: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (const char of raw) {
		const code = char.charCodeAt(0);
		if (escaped) {
			escaped = false;
			if (code > CONTROL_CHAR_CEILING) out += char;
			continue;
		}
		if (code > CONTROL_CHAR_CEILING) {
			if (inString && char === "\\") escaped = true;
			else if (char === '"') inString = !inString;
			out += char;
		} else if (inString) {
			out += ESCAPED_WHITESPACE[code] ?? "";
		} else if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) {
			out += char;
		}
	}
	return out;
}

/** GitLab embeds raw control characters in descriptions and notes carrying code-review markdown. */
function parseGlabJson<T = Record<string, unknown>>(raw: string): T {
	return JSON.parse(stripRawControlChars(raw)) as T;
}

/** Comma-separated `AI_VCS_GITLAB_REVIEW_BOT`; empty or `none` declares no reviewer, and `copilot` is dropped. */
function resolveAiReviewBotNames(): string[] {
	const raw = process.env.AI_VCS_GITLAB_REVIEW_BOT ?? "";
	if (raw.trim().toLowerCase() === "none") return [];
	return raw
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "" && name.toLowerCase() !== COPILOT_BOT_NAME);
}

/** Fails closed before the endpoint is built: an empty or junk value degrades a GitLab query to an unfiltered list. */
function requireMrIid(number: unknown, context: string): string {
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
		throw new ProviderError(
			"INVALID_MR_IID",
			`${context}: merge request iid must be a positive integer, got ${JSON.stringify(number) ?? "undefined"}`,
		);
	}
	return String(number);
}

/** The ref GitLab gives a detached merge-request pipeline; a pipeline on any other ref belongs to another run. */
function mrHeadRef(iid: string): string {
	return `refs/merge-requests/${iid}/head`;
}

/** glab `-R` takes OWNER/REPO or a full URL, so a non-default host is emitted as a URL. */
function glSlug(repo?: RepoRef): string {
	if (!repo) return "";
	const path = `${repo.owner}/${repo.repo}`;
	return repo.host && repo.host !== DEFAULT_HOST ? `https://${repo.host}/${path}` : path;
}

function mrRepoFlags(repo?: RepoRef): string[] {
	return repo ? ["-R", glSlug(repo)] : [];
}

function glProjectPath(repo?: RepoRef): string {
	return repo ? encodeURIComponent(`${repo.owner}/${repo.repo}`) : ":id";
}

/** Routes `glab api` calls at a self-hosted instance instead of glab's default authenticated host. */
function apiHostFlags(repo?: RepoRef): string[] {
	return hostnameFlags(repo, DEFAULT_HOST);
}

function isNoMrError(err: unknown): boolean {
	return isCliErrorContaining(err, "no open merge request");
}

function normalizeGlMr(raw: Record<string, unknown>): PullRequest {
	const rawState = raw.state as string;
	const state = Object.hasOwn(GITLAB_STATE_TO_PR_STATE, rawState) ? GITLAB_STATE_TO_PR_STATE[rawState] : "CLOSED";
	const headRefName = (raw[FIELD_MAP.headRefName.gitlab] as string) ?? "";
	const baseRefName = (raw[FIELD_MAP.baseRefName.gitlab] as string) ?? "";
	const mergedAt = (raw[FIELD_MAP.mergedAt.gitlab] as string | null) ?? null;
	return {
		number: raw.iid as number,
		title: raw.title as string,
		url: raw.web_url as string,
		state,
		headRefName,
		baseRefName,
		body: (raw.description as string) ?? "",
		mergedAt,
		merged: state === "MERGED",
	};
}

function extractMrNumber(url: string): number {
	return extractNumberFromUrl(url, /\/merge_requests\/(\d+)/, "glab mr create");
}

async function repoInfo(tag: ShellTag, repo?: RepoRef): Promise<RepoInfo> {
	const result = await tag`repo view ${glSlug(repo)} -F json`;
	const raw = parseGlabJson<{
		web_url?: string;
		namespace?: { full_path?: string };
		path?: string;
		default_branch?: string;
	}>(result.stdout.toString());
	return {
		host: deriveHostFromUrl(raw.web_url) ?? repo?.host ?? DEFAULT_HOST,
		owner: raw.namespace?.full_path ?? repo?.owner ?? "",
		repo: raw.path ?? repo?.repo ?? "",
		defaultBranch: raw.default_branch ?? "",
	};
}

async function currentPullRequest(tag: ShellTag, repo?: RepoRef): Promise<PullRequest | null> {
	try {
		const result = await tag`mr view ${mrRepoFlags(repo)} --output json`;
		return normalizeGlMr(parseGlabJson(result.stdout.toString()));
	} catch (err) {
		if (isNoMrError(err)) return null;
		throw err;
	}
}

async function viewPullRequest(tag: ShellTag, ref: PrRef): Promise<PullRequest> {
	const result =
		await tag`mr view ${requireMrIid(ref.number, "viewPullRequest")} ${mrRepoFlags(ref.repo)} --output json`;
	return normalizeGlMr(parseGlabJson(result.stdout.toString()));
}

async function createPullRequest(tag: ShellTag, input: CreatePullRequestInput, repo?: RepoRef): Promise<PullRequest> {
	const draftFlags = input.draft ? ["--draft"] : [];
	const result =
		await tag`mr create ${draftFlags} --title ${input.title} --source-branch ${input.head} --target-branch ${input.base} --description=${input.body} ${mrRepoFlags(repo)}`;
	const number = extractMrNumber(result.stdout.toString().trim());
	return viewPullRequest(tag, { number, repo });
}

function normalizeGlIssue(raw: Record<string, unknown>): Issue {
	return {
		number: raw.iid as number,
		title: raw.title as string,
		url: (raw.web_url as string) ?? "",
		state: raw.state === "closed" ? "CLOSED" : "OPEN",
		body: (raw.description as string) ?? "",
		labels: Array.isArray(raw.labels) ? raw.labels.map(String) : [],
		createdAt: (raw.created_at as string) ?? "",
		commentCount: Number(raw.user_notes_count ?? 0),
	};
}

/** glab issue list has no --state flag — state is a pair of booleans, defaulting to open-only like gh does. */
function issueStateFlags(opts?: ListIssuesOptions): string[] {
	const state = normalizeIssueStateFilter(opts?.state);
	if (state === "ALL") return ["--all"];
	if (state === "CLOSED") return ["--closed"];
	return [];
}

async function listIssues(tag: ShellTag, opts?: ListIssuesOptions, repo?: RepoRef): Promise<Issue[]> {
	const limit = opts?.limit ?? 100;
	const perPage = Math.min(limit, PAGE_SIZE);
	const labelFlags = opts?.label ? ["--label", opts.label] : [];
	const issues: Issue[] = [];
	for (let page = 1; page <= MAX_LIST_PAGES && issues.length < limit; page++) {
		const result =
			await tag`issue list --per-page ${String(perPage)} --page ${String(page)} --output json ${issueStateFlags(opts)} ${labelFlags} ${mrRepoFlags(repo)}`;
		const raw = parseGlabJson(result.stdout.toString());
		const batch: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : [];
		issues.push(...batch.map(normalizeGlIssue));
		if (batch.length < perPage) break;
	}
	return issues.slice(0, limit);
}

async function viewIssue(tag: ShellTag, number: number, repo?: RepoRef): Promise<Issue> {
	const result = await tag`issue view ${String(number)} --output json ${mrRepoFlags(repo)}`;
	return normalizeGlIssue(parseGlabJson(result.stdout.toString()));
}

function extractIssueNumber(url: string): number {
	return extractNumberFromUrl(url, /\/-\/(?:issues|work_items)\/(\d+)(?:[/?#]|$)/, "glab issue create");
}

/** The body is glued as `--description=` so an empty value cannot leave a dangling flag. */
async function createIssue(tag: ShellTag, input: CreateIssueInput, repo?: RepoRef): Promise<Issue> {
	const labelFlags = input.labels?.length ? ["--label", input.labels.join(",")] : [];
	const assigneeFlags = input.assignees?.length ? ["--assignee", input.assignees.join(",")] : [];
	const result =
		await tag`issue create --title ${input.title} --description=${input.body ?? ""} ${labelFlags} ${assigneeFlags} --yes ${mrRepoFlags(repo)}`;
	const number = extractIssueNumber(result.stdout.toString().trim());
	return viewIssue(tag, number, repo);
}

/** `glab issue update --label` adds to the existing set — it does not replace it, same as gh's --add-label. */
async function addLabelsToIssue(tag: ShellTag, number: number, labels: string[], repo?: RepoRef): Promise<Issue> {
	await tag`issue update ${String(number)} --label ${labels.join(",")} ${mrRepoFlags(repo)}`;
	return viewIssue(tag, number, repo);
}

/** glab has no update-if-exists flag for label create (unlike gh's --force) — swallow the duplicate-name error instead. */
async function ensureLabel(tag: ShellTag, name: string, repo?: RepoRef): Promise<void> {
	try {
		await tag`label create --name ${name} ${mrRepoFlags(repo)}`;
	} catch (err) {
		if (!isAlreadyExistsError(err)) throw err;
	}
}

async function tryGetCurrentMrIid(tag: ShellTag, repo?: RepoRef): Promise<number | undefined> {
	try {
		const result = await tag`mr view ${mrRepoFlags(repo)} --output json`;
		const text = result.stdout.toString().trim();
		if (!text) return undefined;
		const parsed = parseGlabJson(text);
		return typeof parsed.iid === "number" ? parsed.iid : undefined;
	} catch (err) {
		if (isNoMrError(err)) {
			throw new ProviderError("NO_CURRENT_MR", "no merge request found for the current branch");
		}
		throw err;
	}
}

interface RawDiscussionNote {
	id: number;
	body?: string;
	author?: { username?: string };
	created_at?: string;
	resolvable?: boolean;
	resolved?: boolean;
	position?: {
		new_path?: string | null;
		old_path?: string | null;
		new_line?: number | null;
		old_line?: number | null;
	};
}

interface RawDiscussion {
	id: string;
	notes?: RawDiscussionNote[];
}

function isResolvableDiscussion(d: RawDiscussion): boolean {
	return Boolean(d.notes?.[0]?.resolvable);
}

function isResolvedDiscussion(d: RawDiscussion): boolean {
	return Boolean(d.notes?.[0]?.resolved);
}

function normalizeGlThread(raw: RawDiscussion): ReviewThread {
	const comments: ReviewComment[] = (raw.notes ?? []).map((n) => ({
		id: String(n.id),
		author: n.author?.username ?? "",
		body: n.body ?? "",
		createdAt: n.created_at ?? "",
		diffHunk: "",
	}));
	const position = raw.notes?.find((n) => n.position !== undefined)?.position;
	return {
		threadId: raw.id,
		resolved: isResolvedDiscussion(raw),
		comments,
		commentId: comments[0]?.id,
		path: position?.new_path ?? position?.old_path ?? "",
		line: position?.new_line ?? position?.old_line ?? null,
	};
}

async function requireCurrentMrIid(tag: ShellTag): Promise<number> {
	const iid = await tryGetCurrentMrIid(tag);
	if (iid === undefined) {
		throw new ProviderError("NO_CURRENT_MR", "no merge request found for the current branch");
	}
	return iid;
}

/** Memoizes the current-branch MR iid per adapter instance — batch thread operations would otherwise re-shell `glab mr view` per call. */
function makeMrIidResolver(tag: ShellTag): () => Promise<number> {
	let cached: number | undefined;
	return async () => {
		if (cached === undefined) {
			cached = await requireCurrentMrIid(tag);
		}
		return cached;
	};
}

/** An explicit ref skips the current-branch lookup; a ref naming another repo must carry its own number. */
async function threadIid(resolveIid: () => Promise<number>, ref?: PrRef, context = "thread"): Promise<string> {
	if (ref?.repo && ref.number === undefined) {
		throw new ProviderError("INVALID_ARGUMENT", `${context}: a merge request number is required when a repository is given`);
	}
	return requireMrIid(ref?.number ?? (await resolveIid()), context);
}

async function listUnresolvedThreads(
	tag: ShellTag,
	resolveIid: () => Promise<number>,
	opts?: ListUnresolvedThreadsOptions,
	ref?: PrRef,
): Promise<ReviewThread[]> {
	const iid = await threadIid(resolveIid, ref);
	const result =
		await tag`api projects/${glProjectPath(ref?.repo)}/merge_requests/${iid}/discussions --paginate ${apiHostFlags(ref?.repo)}`;
	const list = flattenPaginated<RawDiscussion>(parseGlabJson(result.stdout.toString()));
	const resolvable = list.filter(isResolvableDiscussion);
	const filtered = opts?.includeResolved ? resolvable : resolvable.filter((d) => !isResolvedDiscussion(d));
	return filtered.map(normalizeGlThread);
}

async function resolveThread(
	tag: ShellTag,
	resolveIid: () => Promise<number>,
	threadId: string,
	ref?: PrRef,
): Promise<void> {
	const iid = await threadIid(resolveIid, ref);
	await tag`api projects/${glProjectPath(ref?.repo)}/merge_requests/${iid}/discussions/${threadId} -X PUT -f resolved=true ${apiHostFlags(ref?.repo)}`;
}

async function replyToThread(
	tag: ShellTag,
	resolveIid: () => Promise<number>,
	thread: ReviewThread,
	body: string,
	ref?: PrRef,
): Promise<ReviewComment> {
	const iid = await threadIid(resolveIid, ref);
	const result =
		await tag`api projects/${glProjectPath(ref?.repo)}/merge_requests/${iid}/discussions/${thread.threadId}/notes -f body=${body} ${apiHostFlags(ref?.repo)}`;
	const raw = parseGlabJson<{
		id?: string | number;
		body?: string;
		author?: { username?: string };
		created_at?: string;
	}>(result.stdout.toString());
	if (raw?.id === undefined || raw?.body === undefined) {
		throw new ProviderError("PARSE_ERROR", "glab api response is missing the expected discussion note shape");
	}
	return {
		id: String(raw.id),
		author: raw.author?.username ?? "",
		body: raw.body,
		createdAt: raw.created_at ?? "",
		diffHunk: "",
	};
}

/** Fails closed on an absent head sha, which would reduce the pipeline assertion below to `"" === ""`. */
async function mrHeadSha(tag: ShellTag, project: string, iid: string, hostFlags: string[]): Promise<string> {
	const result = await tag`api projects/${project}/merge_requests/${iid} ${hostFlags}`;
	const raw = parseGlabJson(result.stdout.toString());
	const sha = typeof raw.sha === "string" ? raw.sha.trim() : "";
	if (sha === "") {
		throw new ProviderError(
			"EMPTY_HEAD_SHA",
			`merge request !${iid} reported no head sha; refusing to resolve a pipeline without one`,
		);
	}
	return sha;
}

/** Identity is the sha and the ref together: an all-green status cannot tell this branch's pipeline from another's. */
function selectHeadPipeline(pipelines: Array<Record<string, unknown>>, iid: string, headSha: string): string {
	const expectedRef = mrHeadRef(iid);
	const matching = pipelines.filter((p) => p.sha === headSha && p.ref === expectedRef);
	if (matching.length === 0) {
		throw new ProviderError(
			"PIPELINE_SHA_MISMATCH",
			`no pipeline on merge request !${iid} carries sha ${headSha} on ${expectedRef}; refusing to report CI status from a pipeline that is not this merge request's head`,
		);
	}
	const id = [...matching].sort((a, b) => Number(b.id) - Number(a.id))[0].id;
	if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
		throw new ProviderError(
			"INVALID_PIPELINE_ID",
			`pipeline on merge request !${iid} carries no usable id; refusing to build a jobs endpoint from it`,
		);
	}
	return String(id);
}

async function listCiFailures(tag: ShellTag, ref: PrRef): Promise<CiFailure[]> {
	const project = glProjectPath(ref.repo);
	const hostFlags = apiHostFlags(ref.repo);
	const iid = requireMrIid(ref.number, "listCiFailures");
	const headSha = await mrHeadSha(tag, project, iid, hostFlags);
	const pipelinesResult = await tag`api projects/${project}/merge_requests/${iid}/pipelines --paginate ${hostFlags}`;
	const pipelines = flattenPaginated<Record<string, unknown>>(parseGlabJson(pipelinesResult.stdout.toString()));
	if (pipelines.length === 0) return [];
	const pipelineId = selectHeadPipeline(pipelines, iid, headSha);

	const jobsResult = await tag`api projects/${project}/pipelines/${pipelineId}/jobs --paginate ${hostFlags}`;
	const jobs = flattenPaginated<Record<string, unknown>>(parseGlabJson(jobsResult.stdout.toString()));
	const failing = jobs.filter((j) => FAILING_JOB_STATUSES.has(j.status as string));

	const results: CiFailure[] = [];
	for (const job of failing) {
		const jobId = String(job.id);
		let logExcerpt = "";
		try {
			const traceResult = await tag`api projects/${project}/jobs/${jobId}/trace ${hostFlags}`;
			logExcerpt = truncateLogExcerpt(traceResult.stdout.toString());
		} catch (err) {
			if (!isNotFoundError(err)) throw err;
		}
		results.push({
			executionId: pipelineId,
			jobId,
			configFile: ".gitlab-ci.yml",
			name: (job.name as string) ?? "",
			conclusion: (job.status as string) ?? "",
			logExcerpt,
			url: (job.web_url as string) ?? "",
		});
	}
	return results;
}

async function retargetPullRequest(tag: ShellTag, ref: PrRef, newBase: string): Promise<void> {
	await tag`mr update ${requireMrIid(ref.number, "retargetPullRequest")} --target-branch ${newBase} ${mrRepoFlags(ref.repo)}`;
}

async function getPullRequestBody(tag: ShellTag, ref: PrRef): Promise<string> {
	return (await viewPullRequest(tag, ref)).body;
}

async function setPullRequestBody(tag: ShellTag, ref: PrRef, body: string): Promise<void> {
	await tag.withInput(body)`mr update ${requireMrIid(ref.number, "setPullRequestBody")} --description-file - ${mrRepoFlags(ref.repo)}`;
}

/** `glab mr close` takes no comment flag, so a comment is posted as its own note first. */
async function closePullRequest(tag: ShellTag, ref: PrRef, comment?: string): Promise<void> {
	const iid = requireMrIid(ref.number, "closePullRequest");
	if (comment !== undefined) {
		await tag`api projects/${glProjectPath(ref.repo)}/merge_requests/${iid}/notes -f body=${comment} ${apiHostFlags(ref.repo)}`;
	}
	await tag`mr close ${iid} ${mrRepoFlags(ref.repo)}`;
}

/** `glab mr list` has no `--state` flag; no state means all, as on GitHub. */
function listFilterFlags(opts?: ListPullRequestsOptions): string[] {
	const flags: string[] = [];
	const state = normalizePrStateFilter(opts?.state);
	if (state === "ALL") {
		flags.push("--all");
	} else if (state === "CLOSED") {
		flags.push("--closed");
	} else if (state === "MERGED") {
		flags.push("--merged");
	}
	if (opts?.author) flags.push("--author", opts.author);
	if (opts?.label) flags.push("--label", opts.label);
	if (opts?.head) flags.push("--source-branch", opts.head);
	return flags;
}

async function listPullRequests(tag: ShellTag, opts?: ListPullRequestsOptions, repo?: RepoRef): Promise<PullRequest[]> {
	const all: PullRequest[] = [];
	let exhausted = false;
	for (let page = 1; page <= MAX_LIST_PAGES; page++) {
		const result =
			await tag`mr list --output json --page ${String(page)} --per-page ${String(PAGE_SIZE)} ${mrRepoFlags(repo)} ${listFilterFlags(opts)}`;
		const raw = parseGlabJson(result.stdout.toString());
		const batch: Array<Record<string, unknown>> = Array.isArray(raw) ? raw : [];
		all.push(...batch.map(normalizeGlMr));
		if (batch.length < PAGE_SIZE) {
			exhausted = true;
			break;
		}
	}
	if (!exhausted) {
		throw new ProviderError(
			"PAGE_LIMIT_EXCEEDED",
			`listPullRequests: exceeded ${MAX_LIST_PAGES} pages of merge requests without reaching the end`,
		);
	}
	return opts?.limit ? all.slice(0, opts.limit) : all;
}

async function fetchDiff(tag: ShellTag, ref: PrRef): Promise<string> {
	const result = await tag`mr diff ${requireMrIid(ref.number, "fetchDiff")} --raw ${mrRepoFlags(ref.repo)}`;
	return result.stdout.toString();
}

interface GlDiffRefs {
	base_sha: string;
	start_sha: string;
	head_sha: string;
}

/** GitLab has no comment-only reviewer state, so "comment" publishes with no state at all. */
const GITLAB_REVIEWER_STATES: Partial<Record<ReviewVerdict, string>> = {
	approve: "reviewed",
	request_changes: "requested_changes",
};

function toGitlabPosition(c: ReviewCommentInput, refs: GlDiffRefs): Record<string, unknown> {
	return {
		position_type: "text",
		base_sha: refs.base_sha,
		start_sha: refs.start_sha,
		head_sha: refs.head_sha,
		new_path: c.path,
		old_path: c.oldPath ?? c.path,
		...(c.newLine !== undefined ? { new_line: c.newLine } : {}),
		...(c.oldLine !== undefined ? { old_line: c.oldLine } : {}),
	};
}

const JSON_CONTENT_TYPE_HEADER = "Content-Type: application/json";

function draftNoteId(stdout: string): string | undefined {
	try {
		const id = parseGlabJson<{ id?: unknown }>(stdout).id;
		return typeof id === "number" || typeof id === "string" ? String(id) : undefined;
	} catch {
		return undefined;
	}
}

function isApprovalRefusal(err: unknown): boolean {
	return isCliErrorContaining(err, "401") || isCliErrorContaining(err, "403");
}

/** Posts every comment as a draft note, then releases them in one bulk_publish; failed runs delete their drafts. */
async function postReview(tag: ShellTag, ref: PrRef, input: PostReviewInput): Promise<PostedReview> {
	const project = glProjectPath(ref.repo);
	const hostFlags = apiHostFlags(ref.repo);
	const iid = requireMrIid(ref.number, "postReview");
	const mrResult = await tag`api projects/${project}/merge_requests/${iid} ${hostFlags}`;
	const mr = parseGlabJson(mrResult.stdout.toString());
	const refs = mr?.diff_refs as GlDiffRefs | undefined;
	if (!refs?.head_sha) {
		throw new ProviderError("PARSE_ERROR", "glab api merge request response is missing diff_refs");
	}
	const draftIds: string[] = [];
	try {
		for (const c of input.comments) {
			const payload = JSON.stringify({ note: c.body, position: toGitlabPosition(c, refs) });
			const draft = await tag.withInput(
				payload,
			)`api projects/${project}/merge_requests/${iid}/draft_notes -X POST --input - -H ${JSON_CONTENT_TYPE_HEADER} ${hostFlags}`;
			const draftId = draftNoteId(draft.stdout.toString());
			if (draftId !== undefined) draftIds.push(draftId);
		}
		const state = GITLAB_REVIEWER_STATES[input.verdict];
		const publish = JSON.stringify({
			...(input.body.trim() ? { note: input.body } : {}),
			...(state ? { reviewer_state: state } : {}),
		});
		await tag.withInput(
			publish,
		)`api projects/${project}/merge_requests/${iid}/draft_notes/bulk_publish -X POST --input - -H ${JSON_CONTENT_TYPE_HEADER} ${hostFlags}`;
	} catch (err) {
		for (const draftId of draftIds) {
			await tag`api projects/${project}/merge_requests/${iid}/draft_notes/${draftId} -X DELETE ${hostFlags}`.catch(
				() => undefined,
			);
		}
		throw err;
	}
	let verdict: ReviewVerdict = input.verdict;
	let degraded = false;
	if (input.verdict === "approve") {
		try {
			await tag`api projects/${project}/merge_requests/${iid}/approve -X POST ${hostFlags}`;
		} catch (err) {
			if (!isApprovalRefusal(err)) throw err;
			verdict = "comment";
			degraded = true;
		}
	}
	return { url: (mr.web_url as string) ?? "", verdict, degraded, commentCount: input.comments.length };
}

/** Create an inert GitLab adapter with configured reviewers and per-instance current-MR memoization. */
export function createGitlabProvider(): Provider {
	const bin = resolveGlabBin();
	const tag = makeBinPreflightTag(bin, {
		code: "GLAB_NOT_FOUND",
		label: "glab",
		installHint: "https://gitlab.com/gitlab-org/cli",
		envVar: "GLAB_BIN",
	});
	const resolveIid = makeMrIidResolver(tag);
	const aiReviewBotNames = resolveAiReviewBotNames();

	return {
		capabilities: Object.freeze({
			aiReviewBot: aiReviewBotNames.length > 0,
			aiReviewBotNames: Object.freeze(aiReviewBotNames),
			nativeStacking: false,
		}),
		repoInfo: (repo) => repoInfo(tag, repo),
		currentPullRequest: (repo) => currentPullRequest(tag, repo),
		createPullRequest: (input, repo) => createPullRequest(tag, input, repo),
		viewPullRequest: (ref) => viewPullRequest(tag, ref),
		listUnresolvedThreads: (opts, ref) => listUnresolvedThreads(tag, resolveIid, opts, ref),
		resolveThread: (threadId, ref) => resolveThread(tag, resolveIid, threadId, ref),
		replyToThread: (thread, body, ref) => replyToThread(tag, resolveIid, thread, body, ref),
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
		checkAuth: () => checkAuthStatus(tag),
	};
}
