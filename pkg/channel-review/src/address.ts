import { readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { describeError } from "@dg/common";
import type { Log } from "./engine";
import type { CrCode } from "./errors";
import { apiJson, type CaptureFn, failureCode } from "./verdict/cli";
import { parseGithubUrl } from "./verdict/github";
import { parseGitlabUrl } from "./verdict/gitlab";
import { type PrHost, VerdictError } from "./verdict/types";

const CLONE_TIMEOUT_MS = 10 * 60_000;

export type PrHead = { name: string; branch: string; fork: boolean };

export type AddressWorkspace = {
	head(request: { url: string; host: PrHost }): Promise<PrHead>;
	clone(request: {
		url: string;
		host: PrHost;
		branch: string;
		dir: string;
	}): Promise<void>;
};

type GithubPull = {
	head: { ref: string; repo: { full_name: string } | null };
	base: { repo: { full_name: string } };
};

type GitlabMerge = {
	source_branch: string;
	source_project_id: number;
	target_project_id: number;
};

export function slug(...parts: string[]): string {
	return parts.join("-").replace(/[^A-Za-z0-9._-]+/g, "-");
}

function gitlabPath(url: string): string {
	return decodeURIComponent(parseGitlabUrl(url).project);
}

export function createAddressWorkspace(runner: CaptureFn): AddressWorkspace {
	return {
		async head({ url, host }) {
			if (host === "github") {
				const target = parseGithubUrl(url);
				const pull = (await apiJson(
					runner,
					"gh",
					target.host,
					`repos/${target.owner}/${target.repo}/pulls/${target.number}`,
				)) as GithubPull;
				return {
					name: slug(target.host, target.owner, target.repo),
					branch: pull.head.ref,
					fork:
						pull.head.repo?.full_name.toLowerCase() !==
						pull.base.repo.full_name.toLowerCase(),
				};
			}
			const target = parseGitlabUrl(url);
			const merge = (await apiJson(
				runner,
				"glab",
				target.host,
				`projects/${target.project}/merge_requests/${target.iid}`,
			)) as GitlabMerge;
			return {
				name: slug(target.host, ...gitlabPath(url).split("/")),
				branch: merge.source_branch,
				fork: merge.source_project_id !== merge.target_project_id,
			};
		},
		async clone({ url, host, branch, dir }) {
			const command = host === "github" ? "gh" : "glab";
			const source =
				host === "github"
					? (({ host: name, owner, repo }) => `${name}/${owner}/${repo}`)(
							parseGithubUrl(url),
						)
					: `https://${new URL(url).host}/${gitlabPath(url)}`;
			const args = [
				"repo",
				"clone",
				source,
				dir,
				"--",
				"--branch",
				branch,
				"--single-branch",
			];
			let result: Awaited<ReturnType<CaptureFn>>;
			try {
				result = await runner(command, args, { timeoutMs: CLONE_TIMEOUT_MS });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					throw new VerdictError("CR-303", `${command} is not installed`);
				}
				throw error;
			}
			if (result.status !== 0) {
				throw new VerdictError(
					failureCode(command, result) ?? "CR-306",
					`${command} repo clone failed (${result.status}): ${result.stderr.trim()}`,
				);
			}
		},
	};
}

export function insideRoot(root: string, dir: string): boolean {
	const base = resolve(root);
	const target = resolve(dir);
	return (
		target !== base &&
		target.startsWith(base.endsWith(sep) ? base : `${base}${sep}`)
	);
}

export function removeCloneDir(root: string, dir: string, log: Log): void {
	if (!insideRoot(root, dir)) {
		log.warn(`refused to delete ${dir}: it is not inside ${root}`);
		return;
	}
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (error) {
		log.warn(`could not delete clone ${dir}: ${describeError(error)}`);
	}
}

export function removeLeftoverClones(
	root: string,
	messageIds: string[],
	log: Log,
): void {
	if (messageIds.length === 0) return;
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	for (const name of names) {
		if (messageIds.some((id) => name.endsWith(`-${slug(id)}`))) {
			removeCloneDir(root, join(root, name), log);
		}
	}
}

export function cloneDirName(head: PrHead, messageId: string): string {
	return `${head.name}-${slug(messageId)}`;
}

export function errorCode(error: unknown, fallback: CrCode): CrCode {
	return error instanceof VerdictError ? error.code : fallback;
}
