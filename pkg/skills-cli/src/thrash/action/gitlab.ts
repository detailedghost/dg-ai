import { parseGlabJson } from "../../provider/gitlab";
import { flattenPaginated } from "../../provider/types";
import type { PullRequestEvent, Review } from "./github";

type Env = Record<string, string | undefined>;

const DEFAULT_HOST = "gitlab.com";

export function isGitlabCi(env: Env): boolean {
	return env.GITLAB_CI === "true";
}

/** The merge request from GitLab's predefined merge request pipeline variables. */
export function readEvent(env: Env): PullRequestEvent {
	if (env.CI_PIPELINE_SOURCE !== "merge_request_event")
		throw new Error("Thrashley runs on merge request pipelines only");
	const need = (name: string) => {
		const value = env[name];
		if (!value) throw new Error(`${name} is not set`);
		return value;
	};
	const iid = need("CI_MERGE_REQUEST_IID");
	return {
		repo: need("CI_MERGE_REQUEST_PROJECT_PATH"),
		number: Number(iid),
		url: `${need("CI_MERGE_REQUEST_PROJECT_URL")}/-/merge_requests/${iid}`,
		baseSha: env.CI_MERGE_REQUEST_TARGET_BRANCH_SHA || need("CI_MERGE_REQUEST_TARGET_BRANCH_NAME"),
		headRepo: need("CI_MERGE_REQUEST_SOURCE_PROJECT_PATH"),
	};
}

function hostFlags(event: PullRequestEvent): string[] {
	const host = new URL(event.url).host;
	return host === DEFAULT_HOST ? [] : ["--hostname", host];
}

function mrPath(event: PullRequestEvent): string {
	return `projects/${encodeURIComponent(event.repo)}/merge_requests/${event.number}`;
}

class GlabError extends Error {
	constructor(
		message: string,
		readonly stderr: string,
	) {
		super(message);
	}
}

async function glab(args: string[]): Promise<string> {
	const proc = Bun.spawn([process.env.GLAB_BIN ?? "glab", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0)
		throw new GlabError(
			`glab ${args[0]} ${args[1] ?? ""} failed: ${stderr.trim()}`,
			stderr,
		);
	return stdout;
}

export async function readHeadSha(event: PullRequestEvent): Promise<string> {
	const out = await glab(["api", mrPath(event), ...hostFlags(event)]);
	const sha = parseGlabJson<{ sha?: string }>(out).sha;
	if (!sha) throw new Error("MR head SHA is missing");
	return sha;
}

/** A file at the target branch, so the MR under review cannot change its own rules; null when absent. */
export async function readBaseFile(
	event: PullRequestEvent,
	path: string,
): Promise<string | null> {
	try {
		return await glab([
			"api",
			`projects/${encodeURIComponent(event.repo)}/repository/files/${encodeURIComponent(path)}/raw?ref=${event.baseSha}`,
			...hostFlags(event),
		]);
	} catch (err) {
		if (err instanceof GlabError && /\b404\b/.test(err.stderr)) return null;
		throw err;
	}
}

interface Note {
	author: { username: string } | null;
	body: string | null;
	system: boolean;
}

/** MR notes in the review shape; each published thrash summary is one note. */
export async function listReviews(event: PullRequestEvent): Promise<Review[]> {
	const out = await glab([
		"api",
		`${mrPath(event)}/notes?per_page=100`,
		"--paginate",
		...hostFlags(event),
	]);
	return flattenPaginated<Note>(parseGlabJson(out))
		.filter((note) => !note.system)
		.map((note) => ({
			user: note.author ? { login: note.author.username } : null,
			body: note.body,
			state: "COMMENTED",
		}));
}

/** The token's own username, which is the login its reviews post as. */
export async function readTokenLogin(event: PullRequestEvent): Promise<string> {
	const out = await glab(["api", "user", ...hostFlags(event)]);
	const login = parseGlabJson<{ username?: string }>(out).username;
	if (!login) throw new Error("glab api user returned no username");
	return login;
}
