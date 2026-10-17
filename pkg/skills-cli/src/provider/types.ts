import { redactTokens, ShellError, type ShellTag } from "../utils/git";

export type ProviderKind = "github" | "gitlab";

export interface RepoRef {
	host: string;
	/** May contain "/" — GitLab nested subgroups (e.g. "group/subgroup"). */
	owner: string;
	repo: string;
}

export interface PrRef {
	repo?: RepoRef;
	number: number;
}

export function parseScpForm(url: string): { host: string; path: string } | null {
	const match = /^[^/]+@([^:/]+):(.+)$/.exec(url);
	if (!match) return null;
	return { host: match[1].toLowerCase(), path: match[2] };
}

export function parseRepoRef(urlOrSlug: string): RepoRef {
	const scpMatch = parseScpForm(urlOrSlug);
	let host: string;
	let path: string;
	if (scpMatch) {
		host = scpMatch.host;
		path = scpMatch.path;
	} else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(urlOrSlug)) {
		const parsed = new URL(urlOrSlug);
		host = parsed.hostname;
		path = parsed.pathname;
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

export type PrState = "OPEN" | "CLOSED" | "MERGED";

/** gh↔glab state vocabulary: GitHub's OPEN/CLOSED/MERGED vs GitLab's opened/closed/merged/locked. */
export const GITLAB_STATE_TO_PR_STATE: Record<string, PrState> = {
	opened: "OPEN",
	closed: "CLOSED",
	merged: "MERGED",
	locked: "CLOSED",
};

export type PrStateFilter = PrState | "ALL";

const PR_STATE_FILTERS: Record<string, PrStateFilter> = { ...GITLAB_STATE_TO_PR_STATE, open: "OPEN", all: "ALL" };

/** Collapses either provider's state vocabulary to one filter value, so the same call means the same thing on both. */
export function normalizePrStateFilter(state?: string): PrStateFilter {
	if (state === undefined) return "ALL";
	const normalized = PR_STATE_FILTERS[state.toLowerCase()];
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

export interface RepoInfo {
	host: string;
	owner: string;
	repo: string;
	defaultBranch: string;
}

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

export interface CreatePullRequestInput {
	title: string;
	body: string;
	base: string;
	head: string;
	draft?: boolean;
}

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

export interface ListIssuesOptions {
	limit?: number;
	state?: string;
	/** Forwarded raw to the provider CLI, same shape as ListPullRequestsOptions.label. */
	label?: string;
}

export interface CreateIssueInput {
	title: string;
	body?: string;
	labels?: string[];
	assignees?: string[];
}

export type IssueStateFilter = "OPEN" | "CLOSED" | "ALL";

const ISSUE_STATE_FILTERS: Record<string, IssueStateFilter> = { open: "OPEN", closed: "CLOSED", all: "ALL" };

/** Issues have no MERGED state, so this is a smaller vocabulary than normalizePrStateFilter; defaults to OPEN, matching gh/glab's own default. */
export function normalizeIssueStateFilter(state?: string): IssueStateFilter {
	if (state === undefined) return "OPEN";
	const normalized = ISSUE_STATE_FILTERS[state.toLowerCase()];
	if (normalized === undefined) {
		throw new ProviderError(
			"INVALID_ISSUE_STATE",
			`unknown issue state "${redactTokens(state)}" — expected one of open, closed, all`,
		);
	}
	return normalized;
}

export interface ReviewComment {
	id: string;
	author: string;
	body: string;
	createdAt: string;
	/** Empty on GitLab, whose discussions API exposes a position but no hunk text. */
	diffHunk: string;
}

export interface ReviewThread {
	/** Opaque, provider-owned token used to resolve the thread. */
	threadId: string;
	resolved: boolean;
	comments: ReviewComment[];
	commentId?: string;
	/** Empty for a thread not anchored to a file (a GitLab non-diff discussion, an outdated GitHub thread). */
	path: string;
	line: number | null;
}

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
	if (Number.isSafeInteger(direct) && direct > 0) return direct;
	const match = /\/(?:pull|merge_requests)\/(\d+)/.exec(arg);
	if (!match) {
		throw new ProviderError("PARSE_ERROR", `not a pull request number or URL: "${redactTokens(arg)}"`);
	}
	return Number(match[1]);
}

/** Shared by both adapters: getPullRequestBody is always "view the PR/MR, return its body". */
export async function getBodyViaView(view: () => Promise<{ body: string }>): Promise<string> {
	const pr = await view();
	return pr.body;
}

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

export interface ListUnresolvedThreadsOptions {
	includeResolved?: boolean;
}

export interface ListPullRequestsOptions {
	label?: string;
	author?: string;
	head?: string;
	state?: string;
	limit?: number;
}

export type ReviewVerdict = "approve" | "request_changes" | "comment";

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

export interface PostReviewInput {
	verdict: ReviewVerdict;
	body: string;
	comments: ReviewCommentInput[];
}

export interface PostedReview {
	url: string;
	/** The verdict the provider accepted, which is "comment" when it refused approve or request_changes. */
	verdict: ReviewVerdict;
	degraded: boolean;
	commentCount: number;
}

export interface ProviderCapabilities {
	readonly aiReviewBot: boolean;
	/** Usernames of the AI reviewers whose PR/MR comments the review loop consumes; empty means the provider has none. */
	readonly aiReviewBotNames: readonly string[];
	readonly nativeStacking: boolean;
}

export interface Provider {
	readonly capabilities: ProviderCapabilities;
	repoInfo(repo?: RepoRef): Promise<RepoInfo>;
	currentPullRequest(repo?: RepoRef): Promise<PullRequest | null>;
	createPullRequest(input: CreatePullRequestInput, repo?: RepoRef): Promise<PullRequest>;
	viewPullRequest(ref: PrRef): Promise<PullRequest>;
	listUnresolvedThreads(opts?: ListUnresolvedThreadsOptions, ref?: PrRef): Promise<ReviewThread[]>;
	resolveThread(threadId: string, ref?: PrRef): Promise<void>;
	/** Reply directly to the thread's original review comment, then return the published reply. */
	replyToThread(threadId: string, commentId: string, body: string, ref?: PrRef): Promise<ReviewComment>;
	listCiFailures(ref: PrRef): Promise<CiFailure[]>;
	/** Unified diff of the pull request as the provider serves it. */
	fetchDiff(ref: PrRef): Promise<string>;
	/** Publishes every comment and the verdict in one review; degrades to "comment" when the provider refuses the verdict. */
	postReview(ref: PrRef, input: PostReviewInput): Promise<PostedReview>;
	retargetPullRequest(ref: PrRef, newBase: string): Promise<void>;
	getPullRequestBody(ref: PrRef): Promise<string>;
	setPullRequestBody(ref: PrRef, body: string): Promise<void>;
	/** A comment, where given, is posted before the close, so it is present the moment anyone sees the closure. */
	closePullRequest(ref: PrRef, comment?: string): Promise<void>;
	listPullRequests(opts?: ListPullRequestsOptions, repo?: RepoRef): Promise<PullRequest[]>;
	listIssues(opts?: ListIssuesOptions, repo?: RepoRef): Promise<Issue[]>;
	viewIssue(number: number, repo?: RepoRef): Promise<Issue>;
	createIssue(input: CreateIssueInput, repo?: RepoRef): Promise<Issue>;
	/** Additive — labels already on the issue are kept, not replaced. */
	addLabelsToIssue(number: number, labels: string[], repo?: RepoRef): Promise<Issue>;
	/** Idempotent: creates the label if it doesn't exist, no-ops (never recolors) if it does. */
	ensureLabel(name: string, repo?: RepoRef): Promise<void>;
	checkAuth(): Promise<boolean>;
}

export class ProviderError extends Error {
	constructor(
		public readonly code: string,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ProviderError";
	}
}

export function notSupportedMessage(feature: string): string {
	return `${feature} is not supported on this provider`;
}

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
