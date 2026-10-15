import {
	CLOCK_SLACK_MS,
	type CaptureFn,
	apiJson,
	capture,
	failureCode,
	flattenSlurp,
	isThrashSummary,
	verdictFromLabel,
} from "./cli";
import {
	type Verdict,
	VerdictError,
	type VerdictReader,
} from "./types";

type Review = {
	user: { login: string } | null;
	state: string;
	submitted_at: string | null;
	body: string | null;
};

const COUNTED_STATES = new Set(["APPROVED", "CHANGES_REQUESTED", "COMMENTED"]);
const PULL_PATH = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/;
const GITHUB_COM = "github.com";

export type GithubTarget = { host: string; owner: string; repo: string; number: number };

export function parseGithubUrl(url: string): GithubTarget {
	const parsed = URL.canParse(url) ? new URL(url) : undefined;
	const match = parsed?.pathname.match(PULL_PATH);
	if (!parsed || !match) {
		throw new VerdictError("CR-302", `not a pull request URL: ${url}`);
	}
	return { host: parsed.host, owner: match[1] as string, repo: match[2] as string, number: Number(match[3]) };
}

function verdictOf(review: Review): Verdict {
	if (review.state === "APPROVED") return "approved";
	if (review.state === "CHANGES_REQUESTED") return "changes_requested";
	return isThrashSummary(review.body ?? "") ? verdictFromLabel(review.body ?? "") : "commented";
}

export function createGithubReader(runner: CaptureFn, which: (name: string) => string | undefined | null) {
	const logins = new Map<string, string>();

	const currentLogin = async (host: string): Promise<string> => {
		const cached = logins.get(host);
		if (cached) return cached;
		const result = await capture(runner, "gh", ["api", "--hostname", host, "user", "--jq", ".login"]);
		if (result.status !== 0) {
			const code = failureCode("gh", result);
			throw code
				? new VerdictError(code, result.stderr.trim())
				: new Error(`gh api user failed (${result.status})`);
		}
		const login = result.stdout.trim().toLowerCase();
		if (!login) throw new Error("gh api user returned no login");
		logins.set(host, login);
		return login;
	};

	const probe: VerdictReader["probe"] = async ({ url }) => {
		if (!which("gh")) return { ok: false, code: "CR-303" };
		const host = url ? new URL(url).host : GITHUB_COM;
		const args = ["auth", "status", ...(url && host !== GITHUB_COM ? ["--hostname", host] : [])];
		const result = await capture(runner, "gh", args).catch(() => undefined);
		return result?.status === 0 ? { ok: true } : { ok: false, code: "CR-303" };
	};

	const read = async (url: string, since: Date): Promise<Verdict> => {
		if (!which("gh")) throw new VerdictError("CR-303", "gh is not installed");
		const { host, owner, repo, number } = parseGithubUrl(url);
		const me = await currentLogin(host);
		const reviews = flattenSlurp<Review>(
			await apiJson(runner, "gh", host, `repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100`, [
				"--paginate",
				"--slurp",
			]),
		);
		const cutoff = since.getTime() - CLOCK_SLACK_MS;
		const mine = reviews
			.filter(
				(review) =>
					COUNTED_STATES.has(review.state) &&
					review.user?.login.toLowerCase() === me &&
					review.submitted_at !== null &&
					Date.parse(review.submitted_at) >= cutoff,
			)
			.sort((a, b) => Date.parse(a.submitted_at ?? "") - Date.parse(b.submitted_at ?? ""));
		const newest = mine.at(-1);
		return newest ? verdictOf(newest) : "none";
	};

	return { probe, read };
}
