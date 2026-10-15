import { withTimeout } from "@dg/common";
import { CLI_TIMEOUT_MS } from "../runners/probe";
import { type PrHosts, parsePrUrl } from "../trigger";
import {
	type CaptureFn,
	PAGE_SIZE,
	apiJson,
	flattenSlurp,
	pagedJson,
} from "./cli";
import { parseGithubUrl } from "./github";
import { parseGitlabUrl } from "./gitlab";
import { VerdictError, type StackReader } from "./types";

type Row = { number: number; url: string; parent: string; branch: string };

type GithubPull = {
	number: number;
	html_url: string;
	base: { ref: string; repo: { full_name: string } | null };
	head: { ref: string; repo: { full_name: string } | null };
};

type GitlabMr = {
	iid: number;
	web_url: string;
	target_branch: string;
	source_branch: string;
	source_project_id: number;
	target_project_id: number;
};

function descendantsOf(rows: Row[], targetNumber: number) {
	const target = rows.find((row) => row.number === targetNumber);
	if (!target) throw new VerdictError("CR-302", `#${targetNumber} is not open`);
	const seen = new Set([target.number]);
	const found: { number: number; url: string }[] = [];
	const walk = (parent: Row) => {
		const children = rows
			.filter((row) => row.parent === parent.branch && !seen.has(row.number))
			.sort((a, b) => a.number - b.number);
		for (const child of children) {
			if (seen.has(child.number)) continue;
			seen.add(child.number);
			found.push({ number: child.number, url: child.url });
			walk(child);
		}
	};
	walk(target);
	return found;
}

export function createStackReader({
	runCapture,
	hosts,
	log,
	timeoutMs = CLI_TIMEOUT_MS,
}: {
	runCapture: CaptureFn;
	hosts: PrHosts;
	log?: { warn(message: string): void };
	timeoutMs?: number;
}): StackReader {
	const bounded: CaptureFn = (command, args, options) =>
		withTimeout(runCapture(command, args, { ...options, timeoutMs }), timeoutMs, () => {
			throw new Error(`${command} timed out`);
		});

	const githubRows = async (url: string) => {
		const { host, owner, repo, number } = parseGithubUrl(url);
		const pulls = flattenSlurp<GithubPull>(
			await apiJson(bounded, "gh", host, `repos/${owner}/${repo}/pulls?state=open&per_page=${PAGE_SIZE}`, [
				"--paginate",
				"--slurp",
			]),
		);
		const rows = pulls
			.filter(
				(pull) =>
					pull.number === number ||
					(pull.head.repo !== null && pull.head.repo.full_name === pull.base.repo?.full_name),
			)
			.map((pull) => ({
				number: pull.number,
				url: pull.html_url,
				parent: pull.base.ref,
				branch: pull.head.ref,
			}));
		return { rows, number };
	};

	const gitlabRows = async (url: string) => {
		const { host, project, iid } = parseGitlabUrl(url);
		const mrs = await pagedJson<GitlabMr>((page) =>
			apiJson(
				bounded,
				"glab",
				host,
				`projects/${project}/merge_requests?state=opened&per_page=${PAGE_SIZE}&page=${page}`,
			),
		);
		const rows = mrs
			.filter((mr) => mr.iid === iid || mr.source_project_id === mr.target_project_id)
			.map((mr) => ({
				number: mr.iid,
				url: mr.web_url,
				parent: mr.target_branch,
				branch: mr.source_branch,
			}));
		return { rows, number: iid };
	};

	return {
		async descendants({ url, host }) {
			try {
				const { rows, number } = await (host === "github" ? githubRows(url) : gitlabRows(url));
				const rootHost = new URL(url).host;
				return descendantsOf(rows, number).flatMap((found) => {
					const target = parsePrUrl(found.url, hosts);
					if (target?.host === host && new URL(target.url).host === rootHost) {
						return [{ number: found.number, url: target.url }];
					}
					log?.warn(`dropped stack PR #${found.number}: ${found.url} is not on ${rootHost}`);
					return [];
				});
			} catch (error) {
				if (error instanceof VerdictError) {
					throw error.code === "CR-302" || error.code === "CR-303"
						? error
						: new VerdictError("CR-304", error.message);
				}
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new VerdictError("CR-303", (error as Error).message);
				}
				throw new VerdictError("CR-304", (error as Error).message);
			}
		},
	};
}
