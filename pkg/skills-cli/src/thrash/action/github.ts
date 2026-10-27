import { THRASH_REVIEW_MARKER } from "../constants";

export interface PullRequestEvent {
	repo: string;
	number: number;
	url: string;
	baseSha: string;
	headRepo: string;
}

export interface Review {
	user: { login: string } | null;
	body: string | null;
	state: string;
}

export function readEvent(
	payload: unknown,
	repository: string,
): PullRequestEvent {
	const pr = (payload as { pull_request?: Record<string, unknown> })
		.pull_request;
	if (!pr) throw new Error("Thrashley runs on pull_request events only");
	const base = pr.base as { sha: string };
	const head = pr.head as { repo: { full_name: string } | null };
	return {
		repo: repository,
		number: pr.number as number,
		url: pr.html_url as string,
		baseSha: base.sha,
		headRepo: head.repo?.full_name ?? "",
	};
}

export function isFork(event: PullRequestEvent): boolean {
	return event.headRepo.toLowerCase() !== event.repo.toLowerCase();
}

function sameLogin(a: string, b: string): boolean {
	const norm = (login: string) =>
		login
			.trim()
			.toLowerCase()
			.replace(/\[bot\]$/, "");
	return norm(a) === norm(b);
}

/** This bot's next round: one more than its submitted reviews on the PR, dismissed ones included. */
export function nextRound(reviews: Review[], botLogin: string): number {
	const own = reviews.filter(
		(r) =>
			r.state !== "PENDING" &&
			r.user !== null &&
			sameLogin(r.user.login, botLogin) &&
			(r.body ?? "").includes(THRASH_REVIEW_MARKER),
	);
	return own.length + 1;
}

async function gh(args: string[]): Promise<string> {
	const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed: ${stderr.trim()}`);
	return stdout;
}

export async function listReviews(event: PullRequestEvent): Promise<Review[]> {
	const out = await gh([
		"api",
		`repos/${event.repo}/pulls/${event.number}/reviews`,
		"--paginate",
		"--slurp",
	]);
	return (JSON.parse(out) as Review[][]).flat();
}

/** A file at the base commit, so the PR under review cannot change its own rules; null when absent. */
export async function readBaseFile(
	event: PullRequestEvent,
	path: string,
): Promise<string | null> {
	try {
		return await gh([
			"api",
			`repos/${event.repo}/contents/${encodeURI(path)}?ref=${event.baseSha}`,
			"-H",
			"Accept: application/vnd.github.raw",
		]);
	} catch (err) {
		if (err instanceof Error && /HTTP 404|Not Found/i.test(err.message))
			return null;
		throw err;
	}
}
