import { ShellError, type ShellTag } from "../utils/git";
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

const DEFAULT_AI_REVIEW_BOTS = "";

const CONTROL_CHAR_CEILING = 0x1f;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

function resolveGlabBin(): string {
	return process.env.GLAB_BIN ?? "glab";
}

/** Drops the control characters JSON forbids inside a string, keeping tab, LF and CR, legal between tokens. */
function stripRawControlChars(raw: string): string {
	let out = "";
	let start = 0;
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code > CONTROL_CHAR_CEILING || code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue;
		out += raw.slice(start, i);
		start = i + 1;
	}
	return start === 0 ? raw : out + raw.slice(start);
}

/** GitLab embeds raw control characters in descriptions and notes carrying code-review markdown. */
function parseGlabJson<T = Record<string, unknown>>(raw: string): T {
	return JSON.parse(stripRawControlChars(raw)) as T;
}

/**
 * Comma-separated `VCS_GITLAB_AI_REVIEW_BOT`; an empty value or `none` declares no AI reviewer.
 * `copilot` is dropped rather than honoured: GitLab cannot have it, and accepting the name would
 * let the Copilot-only subcommands past their gate and on to GitHub's API.
 */
function resolveAiReviewBotNames(): string[] {
	const raw = process.env.VCS_GITLAB_AI_REVIEW_BOT ?? DEFAULT_AI_REVIEW_BOTS;
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

/**
 * glab's `-R`/`--repo` only accepts OWNER/REPO, GROUP/NAMESPACE/REPO, or a full URL — never a bare
 * HOST/OWNER/REPO (that's gh's syntax). A self-hosted host is indistinguishable from a subgroup
 * segment in that bare form, so emit the full URL instead once the host isn't the default.
 */
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
	const state = GITLAB_STATE_TO_PR_STATE[rawState] ?? "CLOSED";
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
	const result = await tag`mr view ${String(ref.number)} ${mrRepoFlags(ref.repo)} --output json`;
	return normalizeGlMr(parseGlabJson(result.stdout.toString()));
}

async function createPullRequest(tag: ShellTag, input: CreatePullRequestInput, repo?: RepoRef): Promise<PullRequest> {
	const draftFlags = input.draft ? ["--draft"] : [];
	const result =
		await tag`mr create ${draftFlags} --title ${input.title} --source-branch ${input.head} --target-branch ${input.base} --description ${input.body} ${mrRepoFlags(repo)}`;
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
	const labelFlags = opts?.label ? ["--label", opts.label] : [];
	const result =
		await tag`issue list --per-page ${String(limit)} --page 1 --output json ${issueStateFlags(opts)} ${labelFlags} ${mrRepoFlags(repo)}`;
	const raw = parseGlabJson(result.stdout.toString());
	return (Array.isArray(raw) ? raw : []).map(normalizeGlIssue).slice(0, limit);
}

async function viewIssue(tag: ShellTag, number: number, repo?: RepoRef): Promise<Issue> {
	const result = await tag`issue view ${String(number)} --output json ${mrRepoFlags(repo)}`;
	return normalizeGlIssue(parseGlabJson(result.stdout.toString()));
}

function extractIssueNumber(url: string): number {
	return extractNumberFromUrl(url, /\/-\/(?:issues|work_items)\/(\d+)(?:[/?#]|$)/, "glab issue create");
}

/**
 * No stdin-body path (glab's `-d -` opens an editor, unlike gh's `-F -`), so an empty body needs
 * `--description=` glued as one token: template interpolation skips a bare empty-string value,
 * which would otherwise leave a dangling `--description` that eats the next token (e.g. --label).
 */
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

/** An explicit ref supplies both halves of the endpoint, so it skips the current-branch MR lookup entirely. */
async function threadIid(resolveIid: () => Promise<number>, ref?: PrRef, context = "thread"): Promise<string> {
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
	const filtered = opts?.includeResolved
		? list
		: list.filter((d) => isResolvableDiscussion(d) && !isResolvedDiscussion(d));
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
	threadId: string,
	_commentId: string,
	body: string,
	ref?: PrRef,
): Promise<ReviewComment> {
	const iid = await threadIid(resolveIid, ref);
	const result =
		await tag`api projects/${glProjectPath(ref?.repo)}/merge_requests/${iid}/discussions/${threadId}/notes -f body=${body} ${apiHostFlags(ref?.repo)}`;
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
		} catch {}
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
	await tag`mr update ${String(ref.number)} --target-branch ${newBase} ${mrRepoFlags(ref.repo)}`;
}

async function getPullRequestBody(tag: ShellTag, ref: PrRef): Promise<string> {
	return getBodyViaView(() => viewPullRequest(tag, ref));
}

async function setPullRequestBody(tag: ShellTag, ref: PrRef, body: string): Promise<void> {
	await tag.withInput(body)`mr update ${String(ref.number)} --description-file - ${mrRepoFlags(ref.repo)}`;
}

/** `glab mr close` takes no comment flag, so a comment is posted as its own note first. */
async function closePullRequest(tag: ShellTag, ref: PrRef, comment?: string): Promise<void> {
	if (comment !== undefined) {
		await tag`api projects/${glProjectPath(ref.repo)}/merge_requests/${requireMrIid(ref.number, "closePullRequest")}/notes -f body=${comment} ${apiHostFlags(ref.repo)}`;
	}
	await tag`mr close ${String(ref.number)} ${mrRepoFlags(ref.repo)}`;
}

/** `glab mr list` has no `--state` flag — state is selected via -A/--closed/--merged, defaulting to open-only. */
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
	const result = await tag`mr diff ${String(ref.number)} --raw ${mrRepoFlags(ref.repo)}`;
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

/**
 * Draft notes are GitLab's single-review analog: every comment lands as a draft, then one
 * bulk_publish releases them with the summary note and reviewer state together.
 */
async function postReview(tag: ShellTag, ref: PrRef, input: PostReviewInput): Promise<PostedReview> {
	const project = glProjectPath(ref.repo);
	const hostFlags = apiHostFlags(ref.repo);
	const iid = String(ref.number);
	const mrResult = await tag`api projects/${project}/merge_requests/${iid} ${hostFlags}`;
	const mr = JSON.parse(mrResult.stdout.toString());
	const refs = mr?.diff_refs as GlDiffRefs | undefined;
	if (!refs?.head_sha) {
		throw new ProviderError("PARSE_ERROR", "glab api merge request response is missing diff_refs");
	}
	for (const c of input.comments) {
		const payload = JSON.stringify({ note: c.body, position: toGitlabPosition(c, refs) });
		await tag.withInput(
			payload,
		)`api projects/${project}/merge_requests/${iid}/draft_notes -X POST --input - -H ${JSON_CONTENT_TYPE_HEADER} ${hostFlags}`;
	}
	const state = GITLAB_REVIEWER_STATES[input.verdict];
	const publish = JSON.stringify({
		...(input.body.trim() ? { note: input.body } : {}),
		...(state ? { reviewer_state: state } : {}),
	});
	await tag.withInput(
		publish,
	)`api projects/${project}/merge_requests/${iid}/draft_notes/bulk_publish -X POST --input - -H ${JSON_CONTENT_TYPE_HEADER} ${hostFlags}`;
	let verdict: ReviewVerdict = input.verdict;
	let degraded = false;
	if (input.verdict === "approve") {
		try {
			await tag`api projects/${project}/merge_requests/${iid}/approve -X POST ${hostFlags}`;
		} catch (err) {
			if (!(err instanceof ShellError)) throw err;
			verdict = "comment";
			degraded = true;
		}
	}
	return { url: (mr.web_url as string) ?? "", verdict, degraded, commentCount: input.comments.length };
}

async function checkAuth(tag: ShellTag): Promise<boolean> {
	return checkAuthStatus(tag);
}

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
		replyToThread: (threadId, commentId, body, ref) => replyToThread(tag, resolveIid, threadId, commentId, body, ref),
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
