import { type CommandSpec, defineCommand, die, EXIT } from "../utils/legacy-command";
import { gh, git } from "../utils/git";
import { getProvider } from "../provider/index";
import type { ProviderCapabilities, PrRef, ReviewThread } from "../provider/types";
import { hasCopilotBot, isAiReviewBotAuthor, notSupportedMessage, parsePrNumberArg } from "../provider/types";

/** Default no-findings ack pattern for the swe-agent's `@copilot review` reply; overridden by REVIEW_LOOP_NO_FINDINGS_PATTERN. */
const NO_FINDINGS_PATTERN_DEFAULT =
	/\bno\s+(?:additional|more|further)?\s*(?:code\s+)?changes\s+(?:are|were|will be)?\s*(?:needed|required|necessary)\b|\bno\s+(?:actionable|new)\s+(?:issues|findings|problems|concerns)\b|\bnothing\s+(?:to\s+flag|actionable)\b|\b(?:don['’]?t|do\s+not|didn['’]?t|did\s+not)\s+(?:see|find)\s+any\s+(?:[\w-]+\s+){0,3}(?:issues|findings|problems|concerns)\b/i;

/** Marker prefixing every reply the helper posts; overridden by ADDRESS_BOT_PREFIX for hosts that mangle emoji. */
const BOT_PREFIX_DEFAULT = "🤖 ";
const BOT_PREFIX_ASCII = "[bot] ";

function botPrefixMarker(): string {
	return process.env["ADDRESS_BOT_PREFIX"] || BOT_PREFIX_DEFAULT;
}

function hasBotPrefix(body: string): boolean {
	return [botPrefixMarker(), BOT_PREFIX_DEFAULT, BOT_PREFIX_ASCII].some((p) => body.startsWith(p));
}

function botPrefix(body: string): string {
	return hasBotPrefix(body) ? body : `${botPrefixMarker()}${body}`;
}

function parsePrUrl(url: string): {
	owner: string;
	repo: string;
	number: number;
} {
	const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
	if (!m) die(`malformed pr_url: ${url}`);
	return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) };
}

async function getOwnerRepo(): Promise<{ owner: string; repo: string }> {
	const provider = await getProvider();
	const info = await provider.repoInfo();
	return { owner: info.owner, repo: info.repo };
}

async function getPrNumber(prArg?: string): Promise<number> {
	if (prArg) return parsePrNumberArg(prArg);
	const provider = await getProvider();
	const pr = await provider.currentPullRequest();
	if (!pr) die("no pull request found for the current branch");
	return pr.number;
}

function extractPrFlag(args: string[]): { prArg?: string; rest: string[] } {
	const idx = args.findIndex((a) => a.startsWith("--pr="));
	if (idx === -1) return { rest: args };
	return {
		prArg: args[idx].slice("--pr=".length),
		rest: [...args.slice(0, idx), ...args.slice(idx + 1)],
	};
}

/** Optional trailing ref for the three thread methods; omitted, they resolve the current branch's PR/MR. */
function toThreadRef(prArg?: string): PrRef | undefined {
	return prArg ? { number: parsePrNumberArg(prArg) } : undefined;
}

/**
 * Dies via EXIT.UNSUPPORTED, before any provider CLI call, when the provider has no Copilot. These
 * subcommands speak Copilot's own API, so another provider's AI reviewer does not satisfy them.
 */
async function requireCopilotBot(feature: string): Promise<void> {
	const provider = await getProvider();
	if (!hasCopilotBot(provider.capabilities)) die(notSupportedMessage(feature), EXIT.UNSUPPORTED);
}

async function cmdProbe(): Promise<void> {
	const [providerResult, gitResult] = await Promise.allSettled([
		getProvider().then((provider) => provider.checkAuth()),
		git`symbolic-ref --short HEAD`,
	]);

	const providerOk = providerResult.status === "fulfilled" && providerResult.value === true;
	const gitOk = gitResult.status === "fulfilled";
	const branch = gitResult.status === "fulfilled" ? gitResult.value.stdout.toString().trim() : "unknown";

	process.stdout.write(JSON.stringify({ provider: providerOk, git: gitOk, branch }) + "\n");
}

/** Deliberately ungated: both providers can view a PR/MR, unlike the Copilot-bot subcommands below. */
async function cmdViewPr(args: string[]): Promise<void> {
	const provider = await getProvider();
	const pr = args[0]
		? await provider.viewPullRequest({ number: parsePrNumberArg(args[0]) })
		: await provider.currentPullRequest();
	if (!pr) die("view-pr: no pull request found for the current branch");

	process.stdout.write(JSON.stringify(pr) + "\n");
}

async function cmdGather(args: string[]): Promise<void> {
	const ref = toThreadRef(args[0]);
	const provider = await getProvider();
	const pr = ref ? await provider.viewPullRequest(ref) : await provider.currentPullRequest();
	if (!pr) die("gather: no pull request found for the current branch");
	const threads = await provider.listUnresolvedThreads({ includeResolved: true }, ref);

	process.stdout.write(JSON.stringify({ pr, threads }) + "\n");
}

async function cmdGatherUnresolved(args: string[]): Promise<void> {
	const ref = toThreadRef(args[0]);
	const provider = await getProvider();
	const threads = await provider.listUnresolvedThreads({}, ref);

	const result = threads
		.filter((t) => !t.comments.some((c) => c.body.toLowerCase().includes("#ignore")))
		.filter((t) => {
			const isExplain = t.comments.some((c) => c.body.toLowerCase().includes("#explain"));
			const lastFromBot = hasBotPrefix(t.comments.at(-1)?.body ?? "");
			return !(isExplain && lastFromBot);
		})
		.map((t) => {
			const first = t.comments[0];
			const isExplain = t.comments.some((c) => c.body.toLowerCase().includes("#explain"));
			return {
				threadId: t.threadId,
				commentId: first ? Number(first.id) : 0,
				path: t.path,
				line: t.line,
				body: first?.body ?? "",
				diffHunk: first?.diffHunk ?? "",
				author: first?.author ?? "",
				mode: isExplain ? "explain" : "fix",
			};
		});

	process.stdout.write(JSON.stringify(result) + "\n");
}

/** Threads carrying at least one comment from a configured AI reviewer. */
function botThreadsOf(threads: ReviewThread[], capabilities: ProviderCapabilities): ReviewThread[] {
	return threads.filter((t) => t.comments.some((c) => isAiReviewBotAuthor(capabilities, c.author)));
}

/** Chronological, not lexicographic: ISO strings with differing offsets do not sort by string order. */
function latestCommentAt(threads: ReviewThread[], capabilities: ProviderCapabilities): string {
	let latest = "";
	let latestMs = Number.NEGATIVE_INFINITY;
	for (const thread of threads) {
		for (const comment of thread.comments) {
			if (!isAiReviewBotAuthor(capabilities, comment.author)) continue;
			const ms = Date.parse(comment.createdAt);
			if (!Number.isFinite(ms) || ms <= latestMs) continue;
			latestMs = ms;
			latest = comment.createdAt;
		}
	}
	return latest;
}

/**
 * Reports whether the provider's configured AI reviewer has actually posted on this PR/MR, where
 * `capabilities` only answers whether the provider has one at all.
 */
async function cmdCheckBotReview(args: string[]): Promise<void> {
	const ref = toThreadRef(args[0]);
	const provider = await getProvider();
	const bots = [...provider.capabilities.aiReviewBotNames];
	if (bots.length === 0) {
		process.stdout.write(
			JSON.stringify({ available: false, bots, present: false, reason: notSupportedMessage("bot review") }) + "\n",
		);
		return;
	}

	const allThreads = await provider.listUnresolvedThreads({ includeResolved: true }, ref);
	const botThreads = botThreadsOf(allThreads, provider.capabilities);
	const actionable = botThreadsOf(await provider.listUnresolvedThreads({}, ref), provider.capabilities);

	process.stdout.write(
		JSON.stringify({
			available: true,
			bots,
			present: botThreads.length > 0,
			threads: botThreads.length,
			unresolved: actionable.length,
			latestAt: latestCommentAt(botThreads, provider.capabilities),
		}) + "\n",
	);
}

async function cmdGatherCiFailures(args: string[]): Promise<void> {
	const prNumber = await getPrNumber(args[0]);
	const provider = await getProvider();
	const failures = await provider.listCiFailures({ number: prNumber });

	const results = failures.map((item) => ({
		ciId: `ci-${item.jobId}`,
		source: "ci",
		name: item.name,
		conclusion: item.conclusion,
		runId: item.executionId,
		jobId: item.jobId,
		workflowFile: item.configFile,
		url: item.url,
		logExcerpt: item.logExcerpt.trim(),
	}));

	process.stdout.write(JSON.stringify(results) + "\n");
}

function replyTarget(threadId: string, commentId: string): ReviewThread {
	return { threadId, commentId, resolved: false, comments: [], path: "", line: null };
}

async function cmdReply(rawArgs: string[]): Promise<void> {
	const { prArg, rest: args } = extractPrFlag(rawArgs);
	if (args.length < 3) die("reply requires <comment_id> <thread_id> <body> [--pr=<number>]");
	const commentId = args[0];
	const threadId = args[1];
	const body = botPrefix(args.slice(2).join(" "));
	const provider = await getProvider();
	const ref = { number: await getPrNumber(prArg) };
	await provider.replyToThread(replyTarget(threadId, commentId), body, ref);
}

async function cmdResolve(rawArgs: string[]): Promise<void> {
	const { prArg, rest: args } = extractPrFlag(rawArgs);
	if (args.length < 1) die("resolve requires <thread_id> [--pr=<number>]");
	const provider = await getProvider();
	await provider.resolveThread(args[0], toThreadRef(prArg));
}

async function cmdResolveSilent(rawArgs: string[]): Promise<void> {
	const { prArg, rest: args } = extractPrFlag(rawArgs);
	if (args.length < 1) die("resolve-silent requires <thread_id> [--pr=<number>]");
	const provider = await getProvider();
	await provider.resolveThread(args[0], toThreadRef(prArg));
	process.stdout.write(JSON.stringify({ resolved: args[0] }) + "\n");
}

async function cmdResolveWithReply(rawArgs: string[]): Promise<void> {
	const { prArg, rest: args } = extractPrFlag(rawArgs);
	if (args.length < 3) die("resolve-with-reply requires <comment_id> <thread_id> <body> [--pr=<number>]");
	const commentId = args[0];
	const threadId = args[1];
	const body = botPrefix(args.slice(2).join(" "));
	const ref = { number: await getPrNumber(prArg) };
	const provider = await getProvider();

	await provider.replyToThread(replyTarget(threadId, commentId), body, ref);
	await provider.resolveThread(threadId, ref);
	process.stdout.write(JSON.stringify({ replied: true, resolved: threadId }) + "\n");
}

const SENSITIVE_FILE = /^\.env|^\.npmrc$|^id_|credentials|secret|\.key$|\.pem$/i;

async function cmdCommitPush(args: string[]): Promise<void> {
	if (args.length < 1) die("commit-push requires <message>");
	const message = args.join(" ");

	await git`add -u`;

	const lsResult = await git`ls-files --others --exclude-standard`;
	const untracked = lsResult.stdout.toString().split("\n").filter(Boolean);
	for (const f of untracked) {
		if (SENSITIVE_FILE.test(f.split("/").at(-1) ?? f)) continue;
		await git`add -- ${f}`;
	}

	await git`commit -m ${message}`;
	await git`push`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type BatchItem = { commentId: number; threadId: string; summary: string };

function assertBatchItem(item: unknown, index: number): asserts item is BatchItem {
	if (typeof item !== "object" || item === null) {
		throw new Error(`item ${index} must be an object`);
	}
	const { commentId, threadId, summary } = item as Record<string, unknown>;
	if (!Number.isSafeInteger(commentId) || Number(commentId) <= 0) {
		throw new Error(`item ${index}: commentId must be a positive integer`);
	}
	if (typeof threadId !== "string" || threadId.length === 0) {
		throw new Error(`item ${index}: threadId must be a non-empty string`);
	}
	if (typeof summary !== "string") {
		throw new Error(`item ${index}: summary must be a string`);
	}
}

function describeBatchTarget(item: unknown, index: number): string {
	if (typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).threadId === "string") {
		return `thread ${(item as Record<string, unknown>).threadId}`;
	}
	return `item ${index}`;
}

async function cmdBatchClose(rawArgs: string[]): Promise<void> {
	const { prArg, rest: args } = extractPrFlag(rawArgs);
	let jsonStr: string;
	if (args.length >= 1 && args[0] !== "-") {
		jsonStr = args[0];
	} else {
		jsonStr = await Bun.stdin.text();
	}

	if (!jsonStr.trim()) die("batch-close requires JSON input");

	const parsed: unknown = JSON.parse(jsonStr);
	if (!Array.isArray(parsed)) die("batch-close: JSON input must be an array of items");
	const items = parsed;
	const ref = { number: await getPrNumber(prArg) };
	const provider = await getProvider();

	let succeeded = 0;
	let failed = 0;
	const errors: string[] = [];

	const results = await Promise.allSettled(
		items.map(async (item, index) => {
			assertBatchItem(item, index);
			const body = botPrefix(item.summary);
			const itemErrors: string[] = [];

			try {
				await provider.replyToThread(replyTarget(item.threadId, String(item.commentId)), body, ref);
			} catch (error) {
				itemErrors.push(`reply failed for thread ${item.threadId}: ${errorMessage(error)}`);
				return itemErrors;
			}

			try {
				await provider.resolveThread(item.threadId, ref);
			} catch (error) {
				itemErrors.push(`resolve failed for thread ${item.threadId}: ${errorMessage(error)}`);
			}

			return itemErrors;
		}),
	);

	for (const [index, r] of results.entries()) {
		if (r.status === "rejected") {
			failed++;
			const reason = errorMessage(r.reason);
			errors.push(`${describeBatchTarget(items[index], index)} threw: ${reason}`);
			continue;
		}
		if (r.value.length === 0) {
			succeeded++;
		} else {
			failed++;
			errors.push(...r.value);
		}
	}

	const out =
		errors.length > 0
			? { total: items.length, succeeded, failed, errors: errors.join("; ") }
			: { total: items.length, succeeded, failed };

	process.stdout.write(JSON.stringify(out) + "\n");
	if (failed > 0) die(`batch-close: ${failed} item(s) failed`);
}

async function cmdCheckCopilot(): Promise<void> {
	const provider = await getProvider();
	if (!hasCopilotBot(provider.capabilities)) {
		process.stdout.write(JSON.stringify({ available: false, reason: notSupportedMessage("Copilot review") }) + "\n");
		return;
	}

	try {
		const r = await gh`repo view --json url`;
		const data = JSON.parse(r.stdout.toString()) as { url: string };
		if (new URL(data.url).hostname === "github.com") {
			process.stdout.write(JSON.stringify({ available: true, reason: "assumed-available" }) + "\n");
			return;
		}
		process.stdout.write(JSON.stringify({ available: false, reason: notSupportedMessage("Copilot review") }) + "\n");
	} catch (error) {
		process.stdout.write(
			JSON.stringify({ available: false, reason: `could not read the repository URL: ${errorMessage(error)}` }) + "\n",
		);
	}
}

async function cmdRequestCopilot(args: string[]): Promise<void> {
	await requireCopilotBot("Copilot review request");

	let method: "comment" | "reviewer" | "retry-comment" = "comment";
	for (const arg of args) {
		if (arg.startsWith("--method=")) {
			const m = arg.slice("--method=".length);
			if (m !== "comment" && m !== "reviewer" && m !== "retry-comment") {
				die(`request-copilot: unknown method ${m}`);
			}
			method = m;
		} else {
			die(`request-copilot: unknown flag ${arg}`);
		}
	}

	const prNumber = await getPrNumber();

	if (method === "comment" || method === "retry-comment") {
		const body = method === "comment" ? "@copilot review" : "@copilot please review the latest changes";
		try {
			const r = await gh`pr comment ${String(prNumber)} --body ${body}`;
			const out = r.stdout.toString();
			const commentUrl = out.split("\n").find((l) => l.startsWith("https://")) ?? "";
			const result = commentUrl
				? { requested: true, method, trigger: "comment", commentUrl }
				: { requested: true, method, trigger: "comment" };
			process.stdout.write(JSON.stringify(result) + "\n");
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stdout.write(JSON.stringify({ requested: false, method, error: msg }) + "\n");
			die(`request-copilot (${method}): ${msg}`);
		}
	} else {
		const { owner, repo } = await getOwnerRepo();
		try {
			await gh`api -X POST repos/${owner}/${repo}/pulls/${String(prNumber)}/requested_reviewers -f reviewers[]=Copilot`;
			process.stdout.write(
				JSON.stringify({
					requested: true,
					method: "reviewer",
					trigger: "requested_reviewers",
				}) + "\n",
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stdout.write(JSON.stringify({ requested: false, method: "reviewer", error: msg }) + "\n");
			die(`request-copilot (reviewer): ${msg}`);
		}
	}
}

function isAfter(iso: string, sinceIso: string): boolean {
	const ms = Date.parse(iso);
	const since = Date.parse(sinceIso);
	return Number.isFinite(ms) && Number.isFinite(since) && ms > since;
}

function byTime(a: string, b: string): number {
	return Date.parse(a) - Date.parse(b);
}

function nonNegativeInt(arg: string, prefix: string): number {
	const value = Number(arg.slice(prefix.length));
	if (!Number.isInteger(value) || value < 0) die(`${prefix}<n> must be a non-negative integer, got ${arg}`);
	return value;
}

async function cmdVerifyCopilotEngaged(args: string[]): Promise<void> {
	await requireCopilotBot("Copilot engagement verification");
	if (args.length < 2) die("verify-copilot-engaged: pr_url and since_iso required");
	const prUrl = args[0];
	const sinceIso = args[1];
	let timeout = 90;
	let interval = 8;
	for (const arg of args.slice(2)) {
		if (arg.startsWith("--timeout=")) timeout = nonNegativeInt(arg, "--timeout=");
		else if (arg.startsWith("--interval=")) interval = nonNegativeInt(arg, "--interval=");
		else die(`verify-copilot-engaged: unknown flag ${arg}`);
	}

	const { owner, repo, number: prNumber } = parsePrUrl(prUrl);
	const deadline = Date.now() + timeout * 1000;
	let consecutiveErrors = 0;
	const maxConsecutiveErrors = 5;

	const query = `
query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      comments(last:30) {
        nodes { databaseId body createdAt author { login } }
      }
    }
  }
}`;

	while (true) {
		let raw: string | null = null;
		try {
			const r = await gh`api graphql -F owner=${owner} -F repo=${repo} -F pr=${prNumber} -f query=${query}`;
			raw = r.stdout.toString();
			consecutiveErrors = 0;
		} catch {
			consecutiveErrors++;
			if (consecutiveErrors >= maxConsecutiveErrors) {
				process.stderr.write(`verify-copilot-engaged: gh api failed ${consecutiveErrors} consecutive times\n`);
				process.exit(1);
			}
		}

		if (raw) {
			const data = JSON.parse(raw) as {
				data: {
					repository: {
						pullRequest: {
							comments: {
								nodes: Array<{
									databaseId: number;
									body: string;
									createdAt: string;
									author: { login: string } | null;
								}>;
							};
						};
					};
				};
			};
			const comments = data.data.repository.pullRequest?.comments.nodes ?? [];
			const hit = comments
				.filter((c) => c.author?.login === "copilot-swe-agent" && isAfter(c.createdAt, sinceIso))
				.sort((a, b) => byTime(a.createdAt, b.createdAt))
				.at(-1);

			if (hit) {
				process.stdout.write(
					JSON.stringify({
						engaged: true,
						commentId: hit.databaseId,
						createdAt: hit.createdAt,
						body: hit.body.length > 240 ? hit.body.slice(0, 240) + "…" : hit.body,
					}) + "\n",
				);
				process.exit(0);
			}
		}

		const now = Date.now();
		if (now >= deadline) process.exit(124);
		const remaining = deadline - now;
		await Bun.sleep(Math.min(remaining, interval * 1000));
	}
}

/** Resolves the no-findings ack pattern, honoring a REVIEW_LOOP_NO_FINDINGS_PATTERN override. */
function resolveNoFindingsPattern(): RegExp {
	const patternSource = process.env["REVIEW_LOOP_NO_FINDINGS_PATTERN"];
	if (!patternSource) return NO_FINDINGS_PATTERN_DEFAULT;
	if (patternSource.length > 200) die(`REVIEW_LOOP_NO_FINDINGS_PATTERN exceeds 200 chars`);
	try {
		return new RegExp(patternSource, "i");
	} catch {
		die(`invalid REVIEW_LOOP_NO_FINDINGS_PATTERN: ${patternSource}`);
	}
}

/** One-shot, non-blocking scan for a copilot-swe-agent no-findings ack posted after since_iso. */
async function cmdCheckNoFindings(args: string[]): Promise<void> {
	await requireCopilotBot("Copilot no-findings check");
	if (args.length < 2) die("check-no-findings: pr_url and since_iso required");
	const prUrl = args[0];
	const sinceIso = args[1];
	const { owner, repo, number: prNumber } = parsePrUrl(prUrl);
	const noFindingsPattern = resolveNoFindingsPattern();

	const query = `
query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      comments(last:30) {
        nodes { databaseId body createdAt author { login } }
      }
    }
  }
}`;

	let raw: string;
	try {
		const r = await gh`api graphql -F owner=${owner} -F repo=${repo} -F pr=${prNumber} -f query=${query}`;
		raw = r.stdout.toString();
	} catch {
		die("check-no-findings: gh api failed");
	}

	const data = JSON.parse(raw) as {
		data: {
			repository: {
				pullRequest: {
					comments: {
						nodes: Array<{
							databaseId: number;
							body: string;
							createdAt: string;
							author: { login: string } | null;
						}>;
					};
				};
			};
		};
	};

	const ackHit = (data.data.repository.pullRequest?.comments.nodes ?? [])
		.filter((c) => c.author?.login === "copilot-swe-agent" && isAfter(c.createdAt, sinceIso) && noFindingsPattern.test(c.body))
		.sort((a, b) => byTime(a.createdAt, b.createdAt))
		.at(-1);

	if (ackHit) {
		process.stdout.write(
			JSON.stringify({
				noFindings: true,
				commentId: ackHit.databaseId,
				createdAt: ackHit.createdAt,
				bodyExcerpt: ackHit.body.length > 240 ? ackHit.body.slice(0, 240) + "…" : ackHit.body,
			}) + "\n",
		);
	} else {
		process.stdout.write(JSON.stringify({ noFindings: false }) + "\n");
	}
}

async function cmdAwaitCopilotReview(args: string[]): Promise<void> {
	await requireCopilotBot("Copilot review wait");
	if (args.length < 2) die("await-copilot-review: pr_url and since_iso required");
	const prUrl = args[0];
	const sinceIso = args[1];
	let timeout = 1800;
	let interval = 30;
	for (const arg of args.slice(2)) {
		if (arg.startsWith("--timeout=")) timeout = nonNegativeInt(arg, "--timeout=");
		else if (arg.startsWith("--interval=")) interval = nonNegativeInt(arg, "--interval=");
		else die(`await-copilot-review: unknown flag ${arg}`);
	}

	const { owner, repo, number: prNumber } = parsePrUrl(prUrl);

	const noFindingsPattern = resolveNoFindingsPattern();

	const deadline = Date.now() + timeout * 1000;
	let consecutiveErrors = 0;
	const maxConsecutiveErrors = 5;

	const query = `
query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviews(last:20) {
        nodes { submittedAt author { login } }
      }
      comments(last:30) {
        nodes { databaseId body createdAt author { login } }
      }
    }
  }
}`;

	while (true) {
		let raw: string | null = null;
		try {
			const r = await gh`api graphql -F owner=${owner} -F repo=${repo} -F pr=${prNumber} -f query=${query}`;
			raw = r.stdout.toString();
			consecutiveErrors = 0;
		} catch {
			consecutiveErrors++;
			if (consecutiveErrors >= maxConsecutiveErrors) {
				process.stderr.write(`await-copilot-review: gh api failed ${consecutiveErrors} consecutive times\n`);
				process.exit(1);
			}
		}

		if (raw) {
			const data = JSON.parse(raw) as {
				data: {
					repository: {
						pullRequest: {
							reviews: {
								nodes: Array<{
									submittedAt: string;
									author: { login: string } | null;
								}>;
							};
							comments: {
								nodes: Array<{
									databaseId: number;
									body: string;
									createdAt: string;
									author: { login: string } | null;
								}>;
							};
						};
					};
				};
			};
			const pr = data.data.repository.pullRequest;

			const reviewHit = (pr?.reviews.nodes ?? [])
				.filter((r) => r.author?.login === "copilot-pull-request-reviewer" && isAfter(r.submittedAt, sinceIso))
				.sort((a, b) => byTime(a.submittedAt, b.submittedAt))
				.at(-1);

			if (reviewHit) {
				process.stdout.write(JSON.stringify({ landed: true, submittedAt: reviewHit.submittedAt }) + "\n");
				process.exit(0);
			}

			const ackHit = (pr?.comments.nodes ?? [])
				.filter(
					(c) => c.author?.login === "copilot-swe-agent" && isAfter(c.createdAt, sinceIso) && noFindingsPattern.test(c.body),
				)
				.sort((a, b) => byTime(a.createdAt, b.createdAt))
				.at(-1);

			if (ackHit) {
				process.stdout.write(
					JSON.stringify({
						noFindings: true,
						commentId: ackHit.databaseId,
						createdAt: ackHit.createdAt,
						bodyExcerpt: ackHit.body.length > 240 ? ackHit.body.slice(0, 240) + "…" : ackHit.body,
					}) + "\n",
				);
				process.exit(0);
			}
		}

		const now = Date.now();
		if (now >= deadline) process.exit(124);
		const remaining = deadline - now;
		await Bun.sleep(Math.min(remaining, interval * 1000));
	}
}

async function cmdFetchCopilotReview(): Promise<void> {
	await requireCopilotBot("Copilot review fetch");
	const { owner, repo } = await getOwnerRepo();
	const prNumber = await getPrNumber();

	const query = `
query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviews(last:50) {
        nodes {
          submittedAt
          author { login }
        }
      }
      reviewThreads(first:100) {
        nodes {
          id
          isResolved
          comments(first:10) {
            nodes { id databaseId body path line diffHunk author{login} createdAt }
          }
        }
      }
    }
  }
}`;
	const r = await gh`api graphql -F owner=${owner} -F repo=${repo} -F pr=${prNumber} -f query=${query}`;
	const data = JSON.parse(r.stdout.toString()) as {
		data: {
			repository: {
				pullRequest: {
					reviews: {
						nodes: Array<{ submittedAt: string; author: { login: string } | null }>;
					};
					reviewThreads: {
						nodes: Array<{
							id: string;
							isResolved: boolean;
							comments: {
								nodes: Array<{
									id: string;
									databaseId: number;
									body: string;
									path: string;
									line: number;
									diffHunk: string;
									author: { login: string } | null;
									createdAt: string;
								}>;
							};
						}>;
					};
				};
			};
		};
	};

	const pr = data.data.repository.pullRequest;
	if (!pr) die("fetch-copilot-review: pull request not found");
	const latest = pr.reviews.nodes
		.filter((r) => r.author?.login === "copilot-pull-request-reviewer")
		.sort((a, b) => byTime(a.submittedAt, b.submittedAt))
		.at(-1);

	if (!latest) {
		process.stdout.write(JSON.stringify({ submittedAt: null, comments: [] }) + "\n");
		return;
	}

	const comments = pr.reviewThreads.nodes
		.filter((t) => !t.isResolved && t.comments.nodes[0]?.author?.login === "copilot-pull-request-reviewer")
		.map((t) => ({
			threadId: t.id,
			commentId: t.comments.nodes[0].databaseId,
			path: t.comments.nodes[0].path,
			line: t.comments.nodes[0].line,
			body: t.comments.nodes[0].body,
			diffHunk: t.comments.nodes[0].diffHunk,
		}));

	process.stdout.write(JSON.stringify({ submittedAt: latest.submittedAt, comments }) + "\n");
}

async function cmdCountCopilotReviews(): Promise<void> {
	await requireCopilotBot("Copilot review count");
	const { owner, repo } = await getOwnerRepo();
	const prNumber = await getPrNumber();

	const query = `
query($owner:String!,$repo:String!,$pr:Int!) {
  repository(owner:$owner,name:$repo) {
    pullRequest(number:$pr) {
      reviews(last:100) {
        nodes { author { login } state }
      }
    }
  }
}`;
	const r = await gh`api graphql -F owner=${owner} -F repo=${repo} -F pr=${prNumber} -f query=${query}`;
	const data = JSON.parse(r.stdout.toString()) as {
		data: {
			repository: {
				pullRequest: {
					reviews: {
						nodes: Array<{ author: { login: string } | null; state: string }>;
					};
				};
			};
		};
	};

	const pr = data.data.repository.pullRequest;
	if (!pr) die("count-copilot-reviews: pull request not found");
	const count = pr.reviews.nodes.filter(
		(r) => r.author?.login === "copilot-pull-request-reviewer" && r.state !== "PENDING",
	).length;

	process.stdout.write(`${count}\n`);
}

/** Declare all address verbs while leaving provider access deferred until dispatch. */
export const commandSpec = {
	name: "address",
	description: "VCS provider + git operations wrapper for the /address skill.",
	subcommands: {
		probe: {
			description: "verify provider/git access",
			run: async () => {
				await cmdProbe();
			},
		},
		"view-pr": {
			description: "PR/MR metadata as JSON (state, merged, headRefName); takes a number or URL",
			args: ["pr_number_or_url?"],
			run: async (args) => {
				await cmdViewPr(args);
			},
		},
		gather: {
			description: "PR metadata + review threads (JSON)",
			args: ["pr_number?"],
			run: async (args) => {
				await cmdGather(args);
			},
		},
		"gather-unresolved": {
			description: "compact array of unresolved, non-ignored threads",
			args: ["pr_number?"],
			run: async (args) => {
				await cmdGatherUnresolved(args);
			},
		},
		"check-bot-review": {
			description:
				"whether the provider's AI reviewer has posted on this PR/MR, and how many of its threads are unresolved",
			args: ["pr_number?"],
			run: async (args) => {
				await cmdCheckBotReview(args);
			},
		},
		"gather-ci-failures": {
			description: "compact array of failing CI checks on the PR",
			args: ["pr_number?"],
			run: async (args) => {
				await cmdGatherCiFailures(args);
			},
		},
		reply: {
			description: "reply directly to a review comment (auto 🤖 prefix)",
			args: ["comment_id", "thread_id", "body", "--pr=<number>?"],
			run: async (args) => {
				await cmdReply(args);
			},
		},
		resolve: {
			description: "resolve a review thread",
			args: ["thread_id", "--pr=<number>?"],
			run: async (args) => {
				await cmdResolve(args);
			},
		},
		"resolve-silent": {
			description: "alias for resolve (explicit: no reply)",
			args: ["thread_id", "--pr=<number>?"],
			run: async (args) => {
				await cmdResolveSilent(args);
			},
		},
		"resolve-with-reply": {
			description: "reply directly (auto 🤖 prefix) + resolve its thread",
			args: ["comment_id", "thread_id", "body", "--pr=<number>?"],
			run: async (args) => {
				await cmdResolveWithReply(args);
			},
		},
		"commit-push": {
			description: "stage, commit, push",
			args: ["message"],
			run: async (args) => {
				await cmdCommitPush(args);
			},
		},
		"batch-close": {
			description: "reply+resolve all threads in one call (JSON array or stdin -)",
			args: ["json", "--pr=<number>?"],
			run: async (args) => {
				await cmdBatchClose(args);
			},
		},
		"check-copilot": {
			description: "best-effort copilot reviewer availability (JSON)",
			run: async () => {
				await cmdCheckCopilot();
			},
		},
		"request-copilot": {
			description: "trigger Copilot review [--method=comment|reviewer|retry-comment]",
			run: async (args) => {
				await cmdRequestCopilot(args);
			},
		},
		"fetch-copilot-review": {
			description: "latest Copilot review + its comments (JSON)",
			run: async () => {
				await cmdFetchCopilotReview();
			},
		},
		"count-copilot-reviews": {
			description: "integer count of Copilot-authored reviews on PR",
			run: async () => {
				await cmdCountCopilotReviews();
			},
		},
		"verify-copilot-engaged": {
			description:
				"block until copilot-swe-agent posts an issue comment after since_iso [--timeout=<sec>] [--interval=<sec>]",
			args: ["pr_url", "since_iso"],
			run: async (args) => {
				await cmdVerifyCopilotEngaged(args);
			},
		},
		"check-no-findings": {
			description: "one-shot (non-blocking) scan for a copilot-swe-agent no-findings ack after since_iso",
			args: ["pr_url", "since_iso"],
			run: async (args) => {
				await cmdCheckNoFindings(args);
			},
		},
		"await-copilot-review": {
			description:
				"block until copilot review lands or no-findings ack after since_iso [--timeout=<sec>] [--interval=<sec>]",
			args: ["pr_url", "since_iso"],
			run: async (args) => {
				await cmdAwaitCopilotReview(args);
			},
		},
	},
} satisfies CommandSpec;

/** Dispatch explicit address arguments with the legacy streams and exit statuses. */
export async function main(argv: string[]): Promise<void> {
	await defineCommand(commandSpec).run(argv);
}

