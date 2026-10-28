import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { oneOf, parseOptionalFlag, wholeNumber } from "@dg/common";
import { scratchPath } from "@dg/common/node";
import { detectProvider } from "../provider/detect";
import { getProviderForUrl } from "../provider/index";
import {
	type ProviderKind,
	type PrRef,
	type PullRequest,
	parsePrNumberArg,
	parseRepoRef,
	type RepoRef,
	type ReviewThread,
	type ReviewVerdict,
} from "../provider/types";
import { git, resolveBaseSha } from "../utils/git";
import { CLASS_HISTORY_PRS } from "./constants";
import { parsePolicy } from "./policy";
import { defineCommand, EXIT } from "../utils/legacy-command";
import { optionalOption, requireOption } from "../utils/options";
import {
	addressFileName,
	annotateDiff,
	classPrCounts,
	type ChunkPlan,
	type CompiledReview,
	type Coverage,
	chunkSummary,
	compileReview,
	diffStats,
	lastReviewedSha,
	mergeOutputs,
	parseAgentOutput,
	parseSpice,
	parseTier,
	parseUnifiedDiff,
	planChunks,
	relativePlanPath,
	resolvePlanPath,
	renderAddressFile,
	renderPreview,
	renderTallyTable,
	type ReReview,
	reviewTrigger,
	type StackStatusRow,
	stackFor,
	type TallyRow,
	toPostReviewInput,
	unpostedBlockers,
} from "./core";

const TOOL = "thrash";
const REVIEW_DIR = path.join(".agents", "code-review");
const PR_SUFFIX_RE = /\/(?:pull|-\/merge_requests|merge_requests)\/\d+.*$/;

interface RemoteTarget {
	mode: "remote";
	url: string;
	provider: ProviderKind;
	repo: RepoRef;
	number: number;
}

interface LocalTarget {
	mode: "local";
	root: string;
	relPath: string;
}

type Target = RemoteTarget | LocalTarget;
type DiffTarget = RemoteTarget | (LocalTarget & { base: string });

interface PlanFile extends Coverage {
	contextPath: string;
	reReview?: ReReview;
	prDiffPath?: string;
	chunks: Array<Coverage["chunks"][number] & { annotatedPath: string; findingsPath: string }>;
}

interface ReviewFile {
	target: string;
	review: CompiledReview;
}

function isUrl(arg: string): boolean {
	return /^https?:\/\//.test(arg);
}

function positional(args: string[], commandName: string, valueFlags: string[] = []): string {
	const consumed = new Set<number>();
	for (const flag of valueFlags) {
		const index = args.indexOf(flag);
		if (index !== -1) {
			consumed.add(index);
			consumed.add(index + 1);
		}
	}
	const value = args.find((a, i) => !consumed.has(i) && !a.startsWith("--"));
	if (!value) throw new Error(`${commandName} requires a target: a PR/MR URL, ".", or a path`);
	return value;
}

function printJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function gitToplevel(dir: string): string {
	const result = Bun.spawnSync(["git", "-C", dir, "rev-parse", "--show-toplevel"]);
	if (result.exitCode !== 0) {
		throw new Error(`${dir} is not inside a git repository: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

async function resolveTarget(arg: string): Promise<Target> {
	if (isUrl(arg)) {
		const { kind } = await detectProvider(arg);
		return {
			mode: "remote",
			url: arg,
			provider: kind,
			repo: parseRepoRef(arg.replace(PR_SUFFIX_RE, "")),
			number: parsePrNumberArg(arg),
		};
	}
	const abs = path.resolve(arg);
	if (!existsSync(abs)) throw new Error(`path not found: ${arg}`);
	const root = gitToplevel(statSync(abs).isDirectory() ? abs : path.dirname(abs));
	process.chdir(root);
	const relPath = path.relative(root, abs) || ".";
	return { mode: "local", root, relPath };
}

function targetSlug(target: Target): string {
	if (target.mode === "remote") {
		return `${target.provider}-${target.repo.owner.replace(/\//g, "-")}-${target.repo.repo}-${target.number}`;
	}
	const label = target.relPath === "." ? "root" : target.relPath.replace(/[^A-Za-z0-9_-]+/g, "_");
	return `local-${label}`;
}

function prRef(target: RemoteTarget): PrRef {
	return { number: target.number, repo: target.repo };
}

async function fetchDiffText(target: DiffTarget): Promise<string> {
	if (target.mode === "remote") {
		const provider = await getProviderForUrl(target.url);
		return provider.fetchDiff(prRef(target));
	}
	const result = await git`-c diff.renames=true diff --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ ${target.base} -- ${target.relPath}`;
	return result.stdout.toString();
}

function warn(message: string, err: unknown): void {
	process.stderr.write(`thrash: ${message}: ${err instanceof Error ? err.message : String(err)}\n`);
}

interface ReviewDiff {
	text: string;
	since?: string;
	prText?: string;
}

/** From round 2, the diff since the bot's latest review, with the full PR diff beside it; any doubt falls back to the full diff alone. */
async function fetchReviewDiff(target: DiffTarget, reviewer?: string): Promise<ReviewDiff> {
	if (target.mode === "local") return { text: await fetchDiffText(target) };
	const provider = await getProviderForUrl(target.url);
	try {
		const reviews = await provider.listReviews(prRef(target));
		const since = lastReviewedSha(reviews, reviewer);
		if (since !== undefined && unpostedBlockers(reviews, reviewer).length > 0) {
			process.stderr.write("thrash: the last review left a blocker unposted, reviewing the full diff\n");
		} else if (since !== undefined) {
			await existingThreads(target, true);
			const text = await provider.fetchDiffSince(prRef(target), since);
			if (text !== null) return { text, since, prText: await provider.fetchDiff(prRef(target)) };
		}
	} catch (err) {
		warn("could not read the last review or the review threads, reviewing the full diff", err);
	}
	return { text: await provider.fetchDiff(prRef(target)) };
}

async function listUntracked(target: LocalTarget): Promise<string[]> {
	const result = await git`ls-files --others --exclude-standard -- ${target.relPath}`;
	return result.stdout.toString().split("\n").filter(Boolean);
}

function planPathFor(diffPath: string): string {
	return diffPath.replace(/\.diff$/, ".plan.json");
}

const BODY_LIMIT = 4000;

async function renderContext(
	target: DiffTarget,
	files: ReturnType<typeof parseUnifiedDiff>,
	plan: ChunkPlan,
	since?: string,
): Promise<string> {
	const lines: string[] = ["# Change context", ""];
	if (target.mode === "remote") {
		try {
			const provider = await getProviderForUrl(target.url);
			const pr = await provider.viewPullRequest(prRef(target));
			lines.push(
				`Title: ${pr.title}`,
				`Head: ${pr.headRefName}`,
				`Base: ${pr.baseRefName}`,
				"",
				"Description:",
				pr.body.slice(0, BODY_LIMIT) || "(none)",
				"",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			process.stderr.write(`thrash diff: could not read PR details, context has files only: ${message}\n`);
		}
	} else {
		lines.push(`Local review of ${target.relPath} against ${target.base}`, "");
	}
	lines.push(since ? `Re-review: only the diff since ${since}. Files changed since then:` : "Files in the full change:");
	for (const file of files) {
		const { added, deleted } = diffStats([file]);
		lines.push(`- ${file.path} [${file.status}] +${added} -${deleted}`);
	}
	if (plan.chunks.length > 1) {
		lines.push("", "The change is reviewed in chunks. Each reviewer sees one chunk:");
		for (const chunk of plan.chunks) {
			lines.push(`- chunk ${chunk.id}: ${chunk.label} (${chunk.files.length} files, ${chunk.changed} changed lines)`);
		}
	}
	return `${lines.join("\n")}\n`;
}

async function writeDiff(target: DiffTarget, reviewer?: string) {
	const { text, since, prText } = await fetchReviewDiff(target, reviewer);
	const files = parseUnifiedDiff(text);
	const stats = diffStats(files);
	const reReview = since === undefined ? undefined : { sha: since, files: stats.files, lines: stats.changed };
	const slug = targetSlug(target);
	const diffPath = scratchPath(TOOL, `${slug}.diff`);
	const plan = planChunks(files);
	const contextPath = scratchPath(TOOL, `${slug}.context.md`);
	const chunks = plan.chunks.map((chunk) => ({
		...chunkSummary(chunk),
		annotatedPath: scratchPath(TOOL, `${slug}.chunk${chunk.id}.annotated.diff`),
		findingsPath: scratchPath(TOOL, `${slug}.chunk${chunk.id}.findings.md`),
	}));
	for (const { findingsPath } of chunks) rmSync(findingsPath, { force: true });
	plan.chunks.forEach((chunk, i) => writeFileSync(chunks[i].annotatedPath, annotateDiff(chunk.files)));
	writeFileSync(diffPath, text);
	const prDiffPath = scratchPath(TOOL, `${slug}.pr.diff`);
	if (prText !== undefined) writeFileSync(prDiffPath, prText);
	writeFileSync(contextPath, await renderContext(target, files, plan, since));
	const planPath = planPathFor(diffPath);
	const planRoot = path.dirname(planPath);
	const planFile: PlanFile = {
		contextPath: relativePlanPath(planRoot, contextPath),
		...(reReview && { reReview }),
		...(prText !== undefined && { prDiffPath: relativePlanPath(planRoot, prDiffPath) }),
		chunks: chunks.map((chunk) => ({
			...chunk,
			annotatedPath: relativePlanPath(planRoot, chunk.annotatedPath),
			findingsPath: relativePlanPath(planRoot, chunk.findingsPath),
		})),
		skipped: plan.skipped,
	};
	writeFileSync(planPath, JSON.stringify(planFile, null, 2));
	return { diffPath, contextPath, chunks, skipped: plan.skipped, stats, ...(reReview && { reReview }) };
}

async function cmdDiff(args: string[]): Promise<number> {
	const arg = positional(args, "diff", ["--base", "--reviewer"]);
	const resolved = await resolveTarget(arg);
	const target: DiffTarget =
		resolved.mode === "local"
			? { ...resolved, base: await resolveBaseSha(optionalOption(args, "--base"), "thrash") }
			: resolved;
	const written = await writeDiff(target, optionalOption(args, "--reviewer"));
	const untracked = target.mode === "local" ? await listUntracked(target) : [];
	printJson({
		target: arg,
		mode: target.mode,
		...(target.mode === "local" ? { root: target.root, base: target.base } : { provider: target.provider }),
		...written,
		untracked,
	});
	return EXIT.OK;
}

async function existingThreads(target: Target, required: boolean): Promise<ReviewThread[]> {
	if (target.mode === "local") return [];
	try {
		const provider = await getProviderForUrl(target.url);
		return await provider.listUnresolvedThreads({ includeResolved: true }, prRef(target));
	} catch (err) {
		if (required) throw err;
		const message = err instanceof Error ? err.message : String(err);
		process.stderr.write(`thrash compile: could not list existing threads, skipping dedupe: ${message}\n`);
		return [];
	}
}

async function readClassHistory(target: Target, reviewer?: string): Promise<Record<string, number>> {
	if (target.mode === "local") return {};
	try {
		const provider = await getProviderForUrl(target.url);
		const merged = await provider.listPullRequests({ state: "MERGED", limit: CLASS_HISTORY_PRS }, target.repo);
		const reviews = await Promise.all(
			merged.map((pr) => provider.listReviews({ number: pr.number, repo: target.repo })),
		);
		return classPrCounts(reviews, reviewer);
	} catch (err) {
		warn("could not read class history, skipping the repeated-class hint", err);
		return {};
	}
}

function nextAddressFile(root: string): string {
	const dir = path.join(root, REVIEW_DIR);
	mkdirSync(dir, { recursive: true });
	const now = new Date();
	for (let sequence = 1; sequence < 1000; sequence++) {
		const candidate = path.join(dir, addressFileName(now, sequence));
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error(`no free code-review file name under ${dir}`);
}

const MAX_EVENT = oneOf(["auto", "approve", "request-changes", "comment"] as const);

function parseMaxEvent(raw: string | undefined): ReviewVerdict | undefined {
	const event = parseOptionalFlag(MAX_EVENT, raw, "--max-event");
	if (event === undefined || event === "auto") return undefined;
	return event === "request-changes" ? "request_changes" : event;
}

async function cmdCompile(args: string[], opts: { json: boolean }): Promise<number> {
	const arg = positional(args, "compile", [
		"--diff",
		"--spice",
		"--min-tier",
		"--heading",
		"--round",
		"--policy",
		"--max-comments",
		"--max-event",
		"--reviewer",
		"--head-sha",
	]);
	const target = await resolveTarget(arg);
	const diffPath = requireOption(args, "--diff");
	const files = parseUnifiedDiff(readFileSync(diffPath, "utf8"));
	const planPath = planPathFor(diffPath);
	const plan = JSON.parse(readFileSync(planPath, "utf8")) as PlanFile;
	const planRoot = path.dirname(path.resolve(planPath));
	const prFiles = plan.prDiffPath
		? parseUnifiedDiff(readFileSync(resolvePlanPath(planRoot, plan.prDiffPath), "utf8"))
		: undefined;
	const output = mergeOutputs(
		plan.chunks.map((chunk) => {
			const findingsPath = resolvePlanPath(planRoot, chunk.findingsPath);
			if (!existsSync(findingsPath)) {
				throw new Error(`chunk ${chunk.id} (${chunk.label}) has no findings file at ${findingsPath}`);
			}
			return parseAgentOutput(readFileSync(findingsPath, "utf8"));
		}),
	);
	const minTierRaw = optionalOption(args, "--min-tier");
	const policyPath = optionalOption(args, "--policy");
	const round = parseOptionalFlag(wholeNumber(1), optionalOption(args, "--round"), "--round");
	const reviewer = optionalOption(args, "--reviewer");
	const review = compileReview(files, output, {
		spice: parseSpice(optionalOption(args, "--spice")),
		minTier: minTierRaw === undefined ? undefined : parseTier(minTierRaw),
		commentOnly: args.includes("--comment"),
		existing: await existingThreads(target, policyPath !== undefined || plan.reReview !== undefined),
		trigger: reviewTrigger(process.env.THRASH_EXECUTION_CONTEXT),
		heading: optionalOption(args, "--heading"),
		round,
		policy: policyPath === undefined ? undefined : parsePolicy(readFileSync(policyPath, "utf8")),
		maxComments: parseOptionalFlag(wholeNumber(0), optionalOption(args, "--max-comments"), "--max-comments"),
		maxEvent: parseMaxEvent(optionalOption(args, "--max-event")),
		reviewer,
		headSha: optionalOption(args, "--head-sha"),
		reReview: plan.reReview,
		prFiles,
		classHistory: output.findings.some((f) => f.class) ? await readClassHistory(target, reviewer) : undefined,
		improvements: args.includes("--improvements") || undefined,
		sassSeed: args.includes("--sass") ? (target.mode === "remote" ? target.number : 0) * 1000 + (round ?? 1) : undefined,
	});
	const reviewPath = scratchPath(TOOL, `${targetSlug(target)}.review.json`);
	rmSync(scratchPath(TOOL, `${targetSlug(target)}.posted.json`), { force: true });
	writeFileSync(reviewPath, JSON.stringify({ target: arg, review } satisfies ReviewFile, null, 2));

	let addressFile: string | undefined;
	if (target.mode === "local") {
		addressFile = nextAddressFile(target.root);
		writeFileSync(addressFile, renderAddressFile(review));
	}

	if (opts.json) {
		printJson({ reviewPath, addressFile, verdict: review.verdict, reason: review.reason, tally: review.tally });
		return EXIT.OK;
	}
	process.stdout.write(renderPreview(review, arg));
	if (addressFile) process.stdout.write(`ADDRESS_FILE=${addressFile}\n`);
	process.stdout.write(`REVIEW_JSON=${reviewPath}\nVERDICT=${review.verdict}\n`);
	return EXIT.OK;
}

/** True when `post` must not publish: `--dry-run`, or DG_THRASH_DRY_RUN set to 1, true or yes. */
export function isPostDryRun(args: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
	return args.includes("--dry-run") || /^(1|true|yes)$/i.test(env.DG_THRASH_DRY_RUN?.trim() ?? "");
}

async function cmdPost(args: string[]): Promise<number> {
	const arg = positional(args, "post", ["--review", "--head-sha"]);
	if (!isUrl(arg)) {
		throw new Error("post needs a PR or MR URL; a local review only writes .agents/code-review/ for /dg:address -l");
	}
	const stored = JSON.parse(readFileSync(requireOption(args, "--review"), "utf8")) as ReviewFile;
	if (stored.target !== arg) {
		throw new Error(`review file was compiled for ${stored.target}, not ${arg}`);
	}
	const input = toPostReviewInput(stored.review);
	input.commitId = optionalOption(args, "--head-sha");
	if (isPostDryRun(args)) {
		// Report-only: no provider lookup, no gh or glab call, no .posted.json.
		printJson({ dryRun: true, url: arg, requestedVerdict: stored.review.verdict, review: input });
		return EXIT.OK;
	}
	if (input.verdict !== "comment" && !args.includes("--confirm")) {
		throw new Error(`post refuses a ${input.verdict} event without --confirm; pass --confirm once the user approves it`);
	}
	const target = await resolveTarget(arg);
	if (target.mode === "local") {
		throw new Error("post needs a PR or MR URL; a local review only writes .agents/code-review/ for /dg:address -l");
	}
	const provider = await getProviderForUrl(target.url);
	const posted = await provider.postReview(prRef(target), input);
	writeFileSync(scratchPath(TOOL, `${targetSlug(target)}.posted.json`), JSON.stringify(posted, null, 2));
	printJson({ ...posted, requestedVerdict: stored.review.verdict });
	return EXIT.OK;
}

function stackState(pr: PullRequest): "open" | "merged" | "closed" {
	if (pr.merged || pr.state === "MERGED") return "merged";
	return pr.state === "CLOSED" ? "closed" : "open";
}

function mergedContextSection(merged: PullRequest[]): string {
	if (merged.length === 0) return "";
	const lines = merged.map((pr) => `- #${pr.number} ${pr.title} (${pr.url}), ${pr.headRefName} into ${pr.baseRefName}`);
	return `\n## Merged earlier in this stack (context only, not reviewed)\n\n${lines.join("\n")}\n`;
}

/**
 * Open PRs, the target, and any merged or closed PR whose head is the base of a candidate.
 * Lists only open PRs in bulk, then asks per unowned base branch, so cost does not grow with history.
 * The default branch is never asked about.
 */
async function stackCandidates(
	provider: Awaited<ReturnType<typeof getProviderForUrl>>,
	target: RemoteTarget,
): Promise<PullRequest[]> {
	const pool = new Map<number, PullRequest>();
	for (const pr of await provider.listPullRequests({ state: "open" }, target.repo)) pool.set(pr.number, pr);
	if (!pool.has(target.number)) {
		const pr = await provider.viewPullRequest(prRef(target));
		pool.set(pr.number, pr);
	}
	// The default branch is everyone's base; a merged main-to-release PR must not become every stack's root.
	const defaultBranch = await provider
		.repoInfo(target.repo)
		.then((info) => info.defaultBranch)
		.catch(() => "");
	const asked = new Set<string>(defaultBranch ? [defaultBranch] : []);
	for (;;) {
		const heads = new Set([...pool.values()].map((pr) => pr.headRefName));
		const bases = [...new Set([...pool.values()].map((pr) => pr.baseRefName))].filter(
			(base) => !heads.has(base) && !asked.has(base),
		);
		if (bases.length === 0) return [...pool.values()];
		for (const base of bases) {
			asked.add(base);
			const found = await provider.listPullRequests({ state: "all", head: base }, target.repo);
			for (const pr of found) if (pr.headRefName === base && !pool.has(pr.number)) pool.set(pr.number, pr);
		}
	}
}

async function cmdStack(args: string[]): Promise<number> {
	const arg = positional(args, "stack");
	const target = await resolveTarget(arg);
	if (target.mode === "local") throw new Error("stack needs a PR or MR URL");
	const provider = await getProviderForUrl(target.url);
	const stack = stackFor(await stackCandidates(provider, target), target.number);
	if (!args.includes("--diff")) {
		printJson(
			stack.map((pr) => ({
				number: pr.number,
				title: pr.title,
				url: pr.url,
				headRefName: pr.headRefName,
				baseRefName: pr.baseRefName,
				state: stackState(pr),
			})),
		);
		return EXIT.OK;
	}
	const merged = stack.filter((pr) => stackState(pr) === "merged");
	const rows = await Promise.all(
		stack.map(async (pr) => {
			const state = stackState(pr);
			if (state !== "open") {
				// Merged PRs are context for the open ones; closed ones are reported. Neither is reviewed.
				const statusPath = scratchPath(TOOL, `${targetSlug({ ...target, number: pr.number })}.stack-status.json`);
				const status: StackStatusRow = { target: pr.url, stackState: state };
				writeFileSync(statusPath, JSON.stringify(status, null, 2));
				return { number: pr.number, url: pr.url, state, reviewed: false, statusPath };
			}
			const { diffPath, contextPath, chunks, skipped, stats } = await writeDiff({
				...target,
				url: pr.url,
				number: pr.number,
			});
			appendFileSync(contextPath, mergedContextSection(merged));
			return {
				number: pr.number,
				url: pr.url,
				state,
				reviewed: true,
				diffPath,
				contextPath,
				chunks,
				skipped: skipped.length,
				changed: stats.changed,
			};
		}),
	);
	printJson(rows);
	return EXIT.OK;
}

function cmdTally(args: string[]): number {
	const reviewPaths = args.filter((a) => !a.startsWith("--"));
	if (reviewPaths.length === 0) throw new Error("tally requires one or more review JSON files");
	const rows: Array<TallyRow | StackStatusRow> = reviewPaths.map((reviewPath) => {
		const parsed = JSON.parse(readFileSync(reviewPath, "utf8")) as ReviewFile | StackStatusRow;
		if ("stackState" in parsed) return { target: parsed.target, stackState: parsed.stackState };
		const stored = parsed;
		const postedPath = reviewPath.replace(/\.review\.json$/, ".posted.json");
		const posted = postedPath !== reviewPath && existsSync(postedPath);
		return {
			target: stored.target,
			review: stored.review,
			posted: posted ? JSON.parse(readFileSync(postedPath, "utf8")) : undefined,
		};
	});
	process.stdout.write(renderTallyTable(rows));
	return EXIT.OK;
}

const command = defineCommand({
	name: "thrash",
	description: "Diff, compile, and post a /thrash review against a GitHub PR, a GitLab MR, or a local path.",
	subcommands: {
		diff: {
			description:
				"Fetch the diff for a URL or path, split it into review chunks, write raw and per-chunk line-annotated copies plus a context file to scratch, print the chunk plan; --base <ref> for local",
			args: ["target"],
			run: cmdDiff,
		},
		compile: {
			description:
				"Merge every chunk's agent findings, validate them against the diff, apply spice and --min-tier, decide the verdict, write review JSON; --diff <file> [--spice N] [--min-tier t] [--comment] [--heading text] [--round N] [--policy file] [--max-comments N] [--max-event auto|approve|request-changes|comment] [--reviewer login] [--sass] [--improvements]",
			args: ["target"],
			run: (args, opts) => cmdCompile(args, opts),
		},
		post: {
			description: "Publish a compiled review to the PR or MR and save the result next to it; --review <file> [--dry-run] [--confirm]. An approve or request-changes event needs --confirm; a comment-only review does not. --dry-run or DG_THRASH_DRY_RUN=1 prints the review and makes no provider call",
			args: ["target"],
			run: cmdPost,
		},
		stack: {
			description:
				"List every PR or MR in the target's stack, root first, with its state; --diff writes diffs for open ones only, marks merged ones as context and closed ones as not reviewed",
			args: ["target"],
			run: cmdStack,
		},
		action: {
			description:
				"Run one GitHub Action phase (prepare, review or publish) from THRASHLEY_* inputs; used by the Thrashley action",
			args: ["phase"],
			run: async (args) => {
				const { runAction } = await import("./action/index");
				return runAction(args.find((a) => !a.startsWith("--")));
			},
		},
		tally: {
			description:
				"Print a markdown table of PR, link, findings per tier, inline count and verdict for review JSON files",
			args: ["review..."],
			run: (args) => Promise.resolve(cmdTally(args)),
		},
	},
});

/** Dispatch explicit review arguments with the legacy streams and exit statuses. */
export async function main(argv: string[]): Promise<void> {
	await command.run(argv);
}
