import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { withTimeout } from "@dg/common";
import { ensurePrivateDir } from "@dg/common/node";
import { removeCloneDir, slug } from "../address";
import type { Log } from "../engine";
import { type CaptureFn, capture } from "../verdict/cli";
import { repoKey } from "./repos";
import type { RepoJobOutcome, RepoRef } from "./types";

const CLONE_TIMEOUT_MS = 10 * 60_000;
const SUFFIX_LENGTH = 8;

export type RepoJobContext = { dir: string; signal: AbortSignal };

export type RepoJobRequest<T> = {
	id: string;
	repo: RepoRef;
	branch: string;
	prepare?(context: RepoJobContext): Promise<void>;
	task(context: RepoJobContext): Promise<void>;
	timeoutMs: number;
	finish(context: RepoJobContext): Promise<T>;
	signal: AbortSignal;
};

export type RepoJobRunner = <T>(request: RepoJobRequest<T>) => Promise<RepoJobOutcome<T>>;

export function createRepoJobRunner({
	capture: runner,
	cloneRoot,
	log,
	suffix = () => randomUUID().slice(0, SUFFIX_LENGTH),
}: {
	capture: CaptureFn;
	cloneRoot: string;
	log: Log;
	suffix?: () => string;
}): RepoJobRunner {
	async function clone(repo: RepoRef, branch: string, dir: string): Promise<void> {
		const result = await capture(runner, "gh", [
			"repo",
			"clone",
			repoKey(repo),
			dir,
			"--",
			"--branch",
			branch,
			"--single-branch",
		]);
		if (result.status !== 0) {
			throw new Error(`gh repo clone failed (${result.status}): ${result.stderr.trim()}`);
		}
	}

	return async (request) => {
		const dir = join(cloneRoot, `${slug(request.id)}-${suffix()}`);
		const deadline = new AbortController();
		const signal = AbortSignal.any([request.signal, deadline.signal]);
		const context = { dir, signal };
		try {
			ensurePrivateDir(cloneRoot);
			await clone(request.repo, request.branch, dir);
			await request.prepare?.(context);
			await withTimeout(request.task(context), request.timeoutMs, () => deadline.abort());
			if (request.signal.aborted) return { kind: "aborted" };
			if (deadline.signal.aborted) return { kind: "timeout" };
			return { kind: "ok", value: await request.finish(context) };
		} catch (error) {
			return { kind: "error", error };
		} finally {
			deadline.abort();
			removeCloneDir(cloneRoot, dir, log);
		}
	};
}

export function sweepCloneRoot(root: string, activeIds: string[], log: Log): void {
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return;
	}
	const active = activeIds.map((id) => `${slug(id)}-`);
	for (const name of names) {
		if (active.some((prefix) => name.startsWith(prefix))) continue;
		removeCloneDir(root, join(root, name), log);
	}
}
