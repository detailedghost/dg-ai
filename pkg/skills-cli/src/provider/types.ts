import { redactTokens, ShellError, type ShellTag } from "../utils/git";

/** Supported CLI-backed provider identities. */
export type ProviderKind = "github" | "gitlab";

/** An explicit host and repository path; an empty host lets the CLI use its default authenticated instance. */
export interface RepoRef {
	host: string;
	/** May contain "/" — GitLab nested subgroups (e.g. "group/subgroup"). */
	owner: string;
	repo: string;
}

/** A repository-local request number with optional explicit repository targeting. */
export interface PrRef {
	repo?: RepoRef;
	number: number;
}

/** Recognize scp-style SSH remotes and normalize the host; return null for other URL forms. */
export function parseScpForm(url: string): { host: string; path: string } | null {
	const match = /^[^/]+@([^:/]+):(.+)$/.exec(url);
	if (!match) return null;
	return { host: match[1].toLowerCase(), path: match[2] };
}

/** Parse URL, scp remote, or owner/repo slug, preserving nested owners and stripping a trailing .git. */
export function parseRepoRef(urlOrSlug: string): RepoRef {
	const scpMatch = parseScpForm(urlOrSlug);
	let host: string;
	let path: string;
	if (scpMatch) {
		host = scpMatch.host;
		path = scpMatch.path;
	} else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlOrSlug)) {
		try {
			const parsed = new URL(urlOrSlug);
			host = parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : parsed.hostname;
			path = parsed.pathname;
		} catch {
			throw new ProviderError("INVALID_REPO_REF", `cannot parse a repo reference from "${redactTokens(urlOrSlug)}"`);
		}
	} else {
		host = "";
		path = urlOrSlug;
	}

	path = path
		.replace(/^\/+/, "")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const segments = path.split("/").filter(Boolean);
	if (segments.length < 2) {
		throw new ProviderError("INVALID_REPO_REF", `cannot parse a repo reference from "${redactTokens(urlOrSlug)}"`);
	}
	const repo = segments[segments.length - 1];
	const owner = segments.slice(0, -1).join("/");
	return { host, owner, repo };
}

/** Normalized request lifecycle shared by both providers. */
export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** gh↔glab state vocabulary: GitHub's OPEN/CLOSED/MERGED vs GitLab's opened/closed/merged/locked. */
export const GITLAB_STATE_TO_PR_STATE: Record<string, PrState> = {
	opened: "OPEN",
	closed: "CLOSED",
	merged: "MERGED",
	locked: "CLOSED",
};

/** A normalized lifecycle filter; ALL includes open, closed, and merged requests. */
export type PrStateFilter = PrState | "ALL";

const PR_STATE_FILTERS: Record<string, PrStateFilter> = { ...GITLAB_STATE_TO_PR_STATE, open: "OPEN", all: "ALL" };

/** Collapses either provider's state vocabulary to one filter value, so the same call means the same thing on both. */
export function normalizePrStateFilter(state?: string): PrStateFilter {
	if (state === undefined) return "ALL";
	const key = state.toLowerCase();
	const normalized = Object.hasOwn(PR_STATE_FILTERS, key) ? PR_STATE_FILTERS[key] : undefined;
	if (normalized === undefined) {
		throw new ProviderError(
			"INVALID_PR_STATE",
			`unknown pull request state "${redactTokens(state)}" — expected one of ${Object.keys(PR_STATE_FILTERS).join(", ")}`,
		);
	}
	return normalized;
}

/** gh↔glab field-name mapping for the normalized PullRequest DTO. */
export const FIELD_MAP = {
	headRefName: { github: "headRefName", gitlab: "source_branch" },
	baseRefName: { github: "baseRefName", gitlab: "target_branch" },
	mergedAt: { github: "mergedAt", gitlab: "merged_at" },
} as const;

/** Repository identity and default branch resolved by the selected provider CLI. */
export interface RepoInfo {
	host: string;
	owner: string;
	repo: string;
	defaultBranch: string;
}

/** Provider-neutral request metadata; GitLab merge requests use the same fields. */
export interface PullRequest {
	number: number;
	title: string;
	url: string;
	state: PrState;
	headRefName: string;
	baseRefName: string;
	body: string;
	mergedAt: string | null;
	merged: boolean;
}

/** Request title/body and source/target branches, with optional draft creation. */
export interface CreatePullRequestInput {
	title: string;
	body: string;
	base: string;
	head: string;
	draft?: boolean;
}

/** Normalized issue metadata; issues have only open and closed lifecycle states. */
export interface Issue {
	number: number;
	title: string;
	url: string;
	state: "OPEN" | "CLOSED";
	body: string;
	labels: string[];
	createdAt: string;
	commentCount: number;
}

/** Provider issue filters; omitted state follows the provider's open-issue default. */
export interface ListIssuesOptions {
	limit?: number;
	state?: string;
	/** Forwarded raw to the provider CLI, same shape as ListPullRequestsOptions.label. */
	label?: string;
}

/** Issue creation fields; labels and assignees use provider-native names. */
export interface CreateIssueInput {
	title: string;
	body?: string;
	labels?: string[];
	assignees?: string[];
}

/** Normalized issue filtering without a merged state. */
export type IssueStateFilter = "OPEN" | "CLOSED" | "ALL";

const ISSUE_STATE_FILTERS: Record<string, IssueStateFilter> = { open: "OPEN", closed: "CLOSED", all: "ALL" };

/** Issues have no MERGED state, so this is a smaller vocabulary than normalizePrStateFilter; defaults to OPEN, matching gh/glab's own default. */
export function normalizeIssueStateFilter(state?: string): IssueStateFilter {
	if (state === undefined) return "OPEN";
	const key = state.toLowerCase();
	const normalized = Object.hasOwn(ISSUE_STATE_FILTERS, key) ? ISSUE_STATE_FILTERS[key] : undefined;
	if (normalized === undefined) {
		throw new ProviderError(
			"INVALID_ISSUE_STATE",
			`unknown issue state "${redactTokens(state)}" — expected one of open, closed, all`,
		);
	}
	return normalized;
}

/** A published review comment with author, timestamp, and available diff context. */
export interface ReviewComment {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	/** Empty on GitLab, whose discussions API exposes a position but no hunk text. */
	diffHunk: string;
}

/** A provider-owned discussion token and its comments, optionally anchored to a file line. */
export interface ReviewThread {
	/** Opaque, provider-owned token used to resolve the thread. */
	threadId: string;
	resolved: boolean;
	comments: ReviewComment[];
	commentId?: string;
	/** Empty for a thread not anchored to a file (a GitLab non-diff discussion, an outdated GitHub thread). */
	path: string;
	/** Current anchor in the PR diff; null once a GitHub thread is outdated. */
	line: number | null;
	/** Anchor at comment time; not valid for matching against the current diff. */
	originalLine?: number | null;
}

/** Maximum trailing CI-log characters retained in normalized failure details. */
export const LOG_EXCERPT_MAX_CHARS = 8000;

/** Shared by both adapters: keeps the tail of a CI log, where the failure detail lives. */
export function truncateLogExcerpt(text: string): string {
	return text.length > LOG_EXCERPT_MAX_CHARS ? text.slice(-LOG_EXCERPT_MAX_CHARS) : text;
}

/** Shared by both adapters: flattens a `--paginate` response, whose pages may already be arrays-of-arrays. */
export function flattenPaginated<T>(raw: unknown): T[] {
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

/** Shared by both adapters: parses a repo-info URL's host, swallowing an unparseable value as undefined. */
export function deriveHostFromUrl(url: unknown): string | undefined {
	if (typeof url !== "string" || url.length === 0) return undefined;
	try {
		return new URL(url).host;
	} catch {
		return undefined;
	}
}

/** Shared by both adapters: routes a CLI's `api`/`repo`/`mr`/`pr` subcommand at a self-hosted instance. */
export function hostnameFlags(repo: RepoRef | undefined, defaultHost: string): string[] {
	return repo?.host && repo.host !== defaultHost ? ["--hostname", repo.host] : [];
}

/** Shared by both adapters: `auth status` exits non-zero when logged out, on both gh and glab. */
export async function checkAuthStatus(tag: ShellTag): Promise<boolean> {
	try {
		await tag`auth status`;
		return true;
	} catch (err) {
		if (err instanceof ShellError) return false;
		throw err;
	}
}

/** Shared by both adapters: matches a CLI's "no current PR/MR for this branch" stderr/stdout text. */
export function isCliErrorContaining(err: unknown, needle: string): boolean {
	if (!(err instanceof ShellError)) return false;
	const text = `${err.stderr.toString()} ${err.stdout.toString()}`.toLowerCase();
	return text.includes(needle);
}

/** Shared by both adapters: matches a CLI's missing-resource failure, such as an expired CI log. */
export function isNotFoundError(err: unknown): boolean {
	return ["not found", "http 404", "http 410"].some((needle) => isCliErrorContaining(err, needle));
}

/** Shared by both adapters: makes ensureLabel idempotent by swallowing a duplicate-name error, on any of these wordings. */
export function isAlreadyExistsError(err: unknown): boolean {
	return (
		isCliErrorContaining(err, "already exists") ||
		isCliErrorContaining(err, "already_exists") ||
		isCliErrorContaining(err, "already been taken")
	);
}

/** Shared by both adapters: extracts the trailing numeric id from a `pr/mr create` command's printed URL. */
export function extractNumberFromUrl(url: string, pattern: RegExp, context: string): number {
	const match = pattern.exec(url);
	if (!match) {
		throw new ProviderError("PARSE_ERROR", `could not parse a number from ${context} output: "${redactTokens(url)}"`);
	}
	return Number(match[1]);
}

/** Accepts a bare number or either provider's PR/MR URL, so a caller can take a stored URL without resolving the provider first. */
export function parsePrNumberArg(arg: string): number {
	const direct = Number(arg);
	if (/^\d+$/.test(arg) && Number.isSafeInteger(direct) && direct > 0) return direct;
	const match = /\/(?:pull|merge_requests)\/(\d+)/.exec(arg);
	if (!match) {
		throw new ProviderError("PARSE_ERROR", `not a pull request number or URL: "${redactTokens(arg)}"`);
	}
	return Number(match[1]);
}

/** A failed CI execution/job with a bounded log excerpt and its provider UI link. */
export interface CiFailure {
	executionId: string;
	jobId: string;
	configFile: string;
	name: string;
	conclusion: string;
	logExcerpt: string;
	/** Link to the failing run or job in the provider's UI; empty only when the payload carried none. */
	url: string;
}

/** Opt in to resolved discussions when a caller needs the complete thread history. */
export interface ListUnresolvedThreadsOptions {
	includeResolved?: boolean;
}

/** Provider request filters; adapters reject filters they cannot implement faithfully. */
export interface ListPullRequestsOptions {
	label?: string;
	author?: string;
	head?: string;
	state?: string;
	limit?: number;
}

/** Provider-neutral review intent; adapters may degrade refused verdicts to comment. */
export type ReviewVerdict = "approve" | "request_changes" | "comment";

/** An inline review note anchored with old/new line numbers from the supplied diff. */
export interface ReviewCommentInput {
	/** Path on the new side; for a deleted file it equals oldPath. */
	path: string;
	oldPath?: string;
	/** Set for an added or context line, in new-file numbering. */
	newLine?: number;
	/** Set for a removed or context line, in old-file numbering. */
	oldLine?: number;
	body: string;
}

/** True for a comment on a whole file: it carries neither newLine nor oldLine. */
export function isFileComment(c: ReviewCommentInput): boolean {
	return c.newLine === undefined && c.oldLine === undefined;
}

/** One summary verdict and its inline comments, published together as a review. */
export interface PostReviewInput {
	/** Reviewed commit; GitHub rejects publication if the PR head has changed. */
	commitId?: string;
	verdict: ReviewVerdict;
	body: string;
	comments: ReviewCommentInput[];
}

/** The accepted verdict and publication details, including whether the provider required degradation. */
export interface PostedReview {
	url: string;
	/** The verdict the provider accepted, which is "comment" when it refused approve or request_changes. */
	verdict: ReviewVerdict;
	degraded: boolean;
	commentCount: number;
}

/** Read-only feature and reviewer declarations used to gate provider-specific workflows. */
export interface ProviderCapabilities {
	readonly aiReviewBot: boolean;
	/** Usernames of the AI reviewers whose PR/MR comments the review loop consumes; empty means the provider has none. */
	readonly aiReviewBotNames: readonly string[];
	readonly nativeStacking: boolean;
}

/** Normalized repository operations; omitted repository targeting uses the CLI's current checkout. */
export interface Provider {
	readonly capabilities: ProviderCapabilities;
	/** Resolve repository identity and default branch, using explicit targeting when supplied. */
	repoInfo(repo?: RepoRef): Promise<RepoInfo>;
	/** Find the current branch's request, returning null when no request exists. */
	currentPullRequest(repo?: RepoRef): Promise<PullRequest | null>;
	/** Create a request from the supplied source/target branches and return normalized metadata. */
	createPullRequest(input: CreatePullRequestInput, repo?: RepoRef): Promise<PullRequest>;
	/** Read one request by its repository-local number. */
	viewPullRequest(ref: PrRef): Promise<PullRequest>;
	/** Read unresolved discussions by default; explicit options may include resolved ones. */
	listUnresolvedThreads(opts?: ListUnresolvedThreadsOptions, ref?: PrRef): Promise<ReviewThread[]>;
	/** Resolve the provider-owned discussion token; ref supplies targeting where the provider needs it. */
	resolveThread(threadId: string, ref?: PrRef): Promise<void>;
	/** Reply directly to the thread's original review comment, then return the published reply. */
	replyToThread(thread: ReviewThread, body: string, ref?: PrRef): Promise<ReviewComment>;
	/** Return failing jobs associated with this request's current head, with bounded log excerpts. */
	listCiFailures(ref: PrRef): Promise<CiFailure[]>;
	/** Unified diff of the pull request as the provider serves it. */
	fetchDiff(ref: PrRef): Promise<string>;
	/** Publishes every comment and the verdict in one review; degrades to "comment" when the provider refuses the verdict. */
	postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
	/** Change the target/base branch of the specified request. */
	retargetPullRequest(ref: PrRef, newBase: string): Promise<void>;
	/** Read the request's current body without modifying it. */
	getPullRequestBody(ref: PrRef): Promise<string>;
	/** Replace the request body with the supplied text; callers must preserve unrelated content. */
	setPullRequestBody(ref: PrRef, body: string): Promise<void>;
	/** A comment, where given, is posted before the close, so it is present the moment anyone sees the closure. */
	closePullRequest(ref: PrRef, comment?: string): Promise<void>;
	/** List normalized requests using supported filters; unsupported adapter filters reject. */
	listPullRequests(opts?: ListPullRequestsOptions, repo?: RepoRef): Promise<PullRequest[]>;
	/** List normalized issues, defaulting to open issues when no state filter is given. */
	listIssues(opts?: ListIssuesOptions, repo?: RepoRef): Promise<Issue[]>;
	/** Read an issue by its repository-local number. */
	viewIssue(number: number, repo?: RepoRef): Promise<Issue>;
	/** Create an issue and return its normalized metadata. */
	createIssue(input: CreateIssueInput, repo?: RepoRef): Promise<Issue>;
	/** Additive — labels already on the issue are kept, not replaced. */
	addLabelsToIssue(number: number, labels: string[], repo?: RepoRef): Promise<Issue>;
	/** Idempotent: creates the label if it doesn't exist, no-ops (never recolors) if it does. */
	ensureLabel(name: string, repo?: RepoRef): Promise<void>;
	/** Return false for CLI authentication failure; startup/setup failures may reject. */
	checkAuth(): Promise<boolean>;
}

/** Every code a provider adapter can raise. */
export type ProviderErrorCode =
	| "EMPTY_HEAD_SHA"
	| "GH_NOT_FOUND"
	| "GLAB_NOT_FOUND"
	| "HOST_NOT_RECOGNIZED"
	| "INVALID_ARGUMENT"
	| "INVALID_ISSUE_STATE"
	| "INVALID_MR_IID"
	| "INVALID_PIPELINE_ID"
	| "INVALID_PROVIDER_ENV"
	| "INVALID_PR_STATE"
	| "INVALID_REPO_REF"
	| "NATIVE_STACK_UNSUPPORTED"
	| "NO_CURRENT_MR"
	| "NO_CURRENT_PR"
	| "NO_GIT_REPO"
	| "NO_REMOTE"
	| "PAGE_LIMIT_EXCEEDED"
	| "PARSE_ERROR"
	| "PIPELINE_SHA_MISMATCH"
	| "REST_FILTER_UNIMPLEMENTED"
	| "UNRESOLVED_BRANCH_REF";

/** A stable provider error code with a human-readable explanation and optional underlying cause. */
export class ProviderError extends Error {
	constructor(
		public readonly code: ProviderErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ProviderError";
	}
}

/** Format the shared explanation for a capability the selected provider does not implement. */
export function notSupportedMessage(feature: string): string {
	return `${feature} is not supported on this provider`;
}

/** Canonical reviewer identity used to distinguish Copilot-specific workflows. */
export const COPILOT_BOT_NAME = "copilot";

/** The Copilot-specific subcommands need Copilot itself: another provider's reviewer answers a different API. */
export function hasCopilotBot(capabilities: ProviderCapabilities): boolean {
	return capabilities.aiReviewBotNames.includes(COPILOT_BOT_NAME);
}

/** Case-insensitive membership test for a comment author against the configured reviewer usernames. */
export function isAiReviewBotAuthor(capabilities: ProviderCapabilities, author: string): boolean {
	const needle = author.trim().toLowerCase();
	if (needle === "") return false;
	return capabilities.aiReviewBotNames.some((name) => name.toLowerCase() === needle);
}
