import {
	CLOCK_SLACK_MS,
	type CaptureFn,
	apiJson,
	capture,
	PAGE_SIZE,
	isThrashSummary,
	pagedJson,
	verdictFromLabel,
} from "./cli";
import { type Verdict, VerdictError, type VerdictReader } from "./types";

type Note = {
	author: { username: string };
	created_at: string;
	body: string;
	system?: boolean;
};

type Discussion = { resolved?: boolean; notes: Note[] };

export type GitlabTarget = { host: string; project: string; iid: number };

const MR_PATH = /^\/(.+)\/-\/merge_requests\/(\d+)(?:\/|$)/;

export function parseGitlabUrl(url: string): GitlabTarget {
	const parsed = URL.canParse(url) ? new URL(url) : undefined;
	const match = parsed?.pathname.match(MR_PATH);
	if (!parsed || !match) {
		throw new VerdictError("CR-302", `not a merge request URL: ${url}`);
	}
	return { host: parsed.host, project: encodeURIComponent(match[1] as string), iid: Number(match[2]) };
}

export function createGitlabReader(runner: CaptureFn, which: (name: string) => string | undefined | null) {
	const logins = new Map<string, string>();

	const currentLogin = async (host: string): Promise<string> => {
		const cached = logins.get(host);
		if (cached) return cached;
		const user = (await apiJson(runner, "glab", host, "user")) as { username?: string };
		if (!user.username) throw new Error("glab api user returned no username");
		const login = user.username.toLowerCase();
		logins.set(host, login);
		return login;
	};

	const probe: VerdictReader["probe"] = async ({ url }) => {
		if (!which("glab")) return { ok: false, code: "CR-303" };
		const args = ["auth", "status", ...(url ? ["--hostname", new URL(url).host] : [])];
		const result = await capture(runner, "glab", args).catch(() => undefined);
		return result?.status === 0 ? { ok: true } : { ok: false, code: "CR-303" };
	};

	const read = async (url: string, since: Date): Promise<Verdict> => {
		if (!which("glab")) throw new VerdictError("CR-303", "glab is not installed");
		const { host, project, iid } = parseGitlabUrl(url);
		const me = await currentLogin(host);
		const base = `projects/${project}/merge_requests/${iid}`;
		const pages = <T>(resource: string) =>
			pagedJson<T>((page) =>
				apiJson(runner, "glab", host, `${base}/${resource}?per_page=${PAGE_SIZE}&page=${page}`),
			);
		const isMine = (note: Note) => note.author.username.toLowerCase() === me;
		const sinceMs = since.getTime();

		const notes = await pages<Note>("notes");
		const summary = notes
			.filter(
				(note) =>
					isMine(note) &&
					isThrashSummary(note.body) &&
					Date.parse(note.created_at) >= sinceMs - CLOCK_SLACK_MS,
			)
			.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
			.at(-1);
		if (summary) return verdictFromLabel(summary.body);

		const approvals = (await apiJson(runner, "glab", host, `${base}/approvals`)) as {
			approved_by?: { user: { username: string } }[];
		};
		if (approvals.approved_by?.some(({ user }) => user.username.toLowerCase() === me)) {
			return "approved";
		}

		const unresolved = (await pages<Discussion>("discussions")).some((discussion) => {
			const first = discussion.notes[0];
			return (
				discussion.resolved === false &&
				first !== undefined &&
				isMine(first) &&
				Date.parse(first.created_at) >= sinceMs
			);
		});
		if (unresolved) return "changes_requested";

		return notes.some((note) => isMine(note) && !note.system && Date.parse(note.created_at) >= sinceMs)
			? "commented"
			: "none";
	};

	return { probe, read };
}
