import { type CaptureFn, capture } from "../verdict/cli";
import type { OpenPr, PrCheck, PrStatus, RepoRef } from "./types";

const GITHUB_COM = "github.com";
const SEGMENT = /^[A-Za-z0-9._-]+$/;

export type RepoClient = {
	defaultBranch(repo: RepoRef): Promise<string>;
	openPrs(repo: RepoRef): Promise<OpenPr[]>;
	prStatus(url: string): Promise<PrStatus>;
	markReady(url: string): Promise<void>;
};

const PASSING_CONCLUSIONS = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const PENDING_STATES = ["PENDING", "EXPECTED"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function toCheck(row: unknown): PrCheck {
	if (!isRecord(row)) throw new Error("gh pr view returned a malformed check");
	const name = String(row.name ?? row.context ?? "unnamed");
	if (typeof row.status === "string") {
		return {
			name,
			done: row.status === "COMPLETED",
			ok: PASSING_CONCLUSIONS.includes(String(row.conclusion)),
		};
	}
	return {
		name,
		done: !PENDING_STATES.includes(String(row.state)),
		ok: row.state === "SUCCESS",
	};
}

function parseJson(out: string, command: string): unknown {
	try {
		return JSON.parse(out);
	} catch {
		throw new Error(`${command} returned malformed JSON`);
	}
}

export function parseRepo(value: string, githubHosts: readonly string[] = [GITHUB_COM]): RepoRef {
	const parts = value.trim().split("/");
	const [host, owner, repo] = parts;
	if (parts.length !== 3 || !host || !owner || !repo) {
		throw new Error(`expected host/owner/repo, got ${value}`);
	}
	if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) {
		throw new Error(`invalid owner or repo in ${value}`);
	}
	const lowered = host.toLowerCase();
	if (!githubHosts.includes(lowered)) {
		throw new Error(`${host} is not a GitHub host; only GitHub repos are supported`);
	}
	return { host: lowered, owner, repo };
}

export function normalizeRepoTag(
	tag: string,
	githubHosts: readonly string[] = [GITHUB_COM],
): string | undefined {
	const path = tag
		.trim()
		.replace(/^[A-Za-z][\w+.-]*:\/\//, "")
		.replace(/^[^/@]+@/, "")
		.replace(/^([^/:]+):/, "$1/")
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	try {
		return repoKey(parseRepo(path, githubHosts)).toLowerCase();
	} catch {
		return undefined;
	}
}

export function repoKey({ host, owner, repo }: RepoRef): string {
	return `${host}/${owner}/${repo}`;
}

async function gh(runner: CaptureFn, args: string[]): Promise<string> {
	const result = await capture(runner, "gh", args);
	if (result.status !== 0) {
		throw new Error(`gh ${args.slice(0, 2).join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
	}
	return result.stdout.trim();
}

export function createRepoClient(runner: CaptureFn): RepoClient {
	return {
		defaultBranch: async (repo) => {
			const hostArgs = repo.host === GITHUB_COM ? [] : ["--hostname", repo.host];
			const branch = await gh(runner, [
				"api",
				...hostArgs,
				`repos/${repo.owner}/${repo.repo}`,
				"--jq",
				".default_branch",
			]);
			if (branch === "") throw new Error(`${repoKey(repo)} has no default branch`);
			return branch;
		},
		openPrs: async (repo) => {
			const out = await gh(runner, [
				"pr",
				"list",
				"--repo",
				repoKey(repo),
				"--state",
				"open",
				"--limit",
				"100",
				"--json",
				"url,headRefName,isDraft,createdAt",
			]);
			let rows: unknown;
			try {
				rows = JSON.parse(out);
			} catch {
				throw new Error("gh pr list returned malformed JSON");
			}
			if (!Array.isArray(rows)) throw new Error("gh pr list returned malformed JSON");
			return rows as OpenPr[];
		},
		prStatus: async (url) => {
			const view = parseJson(
				await gh(runner, ["pr", "view", url, "--json", "isDraft,state,statusCheckRollup"]),
				"gh pr view",
			);
			if (!isRecord(view)) throw new Error("gh pr view returned malformed JSON");
			const { state, isDraft, statusCheckRollup } = view;
			if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
				throw new Error("gh pr view returned an unknown state");
			}
			return {
				state,
				isDraft: isDraft === true,
				checks: Array.isArray(statusCheckRollup) ? statusCheckRollup.map(toCheck) : [],
			};
		},
		markReady: async (url) => {
			await gh(runner, ["pr", "ready", url]);
		},
	};
}
