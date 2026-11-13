import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isPathInside, killProcessTree, scratchDir } from "@dg/common/node";
import { resolveGhBin } from "../provider/github";
import { resolveGlabBin } from "../provider/gitlab";
import { type PrRef, parseRepoRef, type ProviderKind, type RepoRef } from "../provider/types";
import type { DiffFile } from "./core";

export const CLONE_TIMEOUT_MS = 120_000;
export const API_FETCH_MAX_FILES = 50;
export const API_FETCH_MAX_BYTES = 1_048_576;
export const API_FETCH_CONCURRENCY = 8;

export type CheckoutSource = "cwd" | "clone" | "api" | "none";

export interface CheckoutResult {
	root: string;
	headSha: string;
	source: CheckoutSource;
}

export type CheckoutTarget =
	| { mode: "remote"; url: string; provider: ProviderKind; repo: RepoRef; number: number }
	| { mode: "local"; root: string; relPath: string };

type RemoteCheckoutTarget = Extract<CheckoutTarget, { mode: "remote" }>;

export interface SharedClone {
	dir: string;
}

export interface CheckoutInput {
	target: CheckoutTarget;
	pr?: { headSha?: string } | null;
	files: DiffFile[];
	provider: { getFileAtRef(ref: PrRef, path: string, sha: string): Promise<string | null> };
}

export interface CheckoutOptions {
	cloneTimeoutMs?: number;
	apiFetchMaxFiles?: number;
	/** `null` means the shared clone failed: the clone step is skipped. */
	sharedClone?: SharedClone | null;
	cwd?: string;
	env?: Record<string, string>;
}

const ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"APPDATA",
	"LOCALAPPDATA",
	"USERPROFILE",
	"SYSTEMROOT",
	"TEMP",
	"TMP",
	"PATHEXT",
	"SSH_AUTH_SOCK",
	"GIT_SSH_COMMAND",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_HOST",
	"GH_CONFIG_DIR",
	"GITLAB_TOKEN",
	"GITLAB_HOST",
	"GLAB_CONFIG_DIR",
	"HTTPS_PROXY",
	"HTTP_PROXY",
	"NO_PROXY",
	"https_proxy",
	"http_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
];

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CONFIG_HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.symlinks=false"];
const HARDENING = [`--attr-source=${EMPTY_TREE}`, ...CONFIG_HARDENING];
const CLONE_HARDENING = ["--no-tags", "--no-recurse-submodules", ...CONFIG_HARDENING];

interface Deadline {
	at: number;
	expired: boolean;
}

interface RunResult {
	ok: boolean;
	stdout: string;
}

interface Context {
	env: NodeJS.ProcessEnv;
	deadline: Deadline;
}

function buildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ENV_ALLOWLIST) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return { ...env, ...extra, GIT_LFS_SKIP_SMUDGE: "1", GIT_TERMINAL_PROMPT: "0" };
}

function run(
	command: string,
	args: string[],
	{ env, deadline }: Context,
	cwd?: string,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const remaining = deadline.at - Date.now();
		if (deadline.expired || remaining <= 0) {
			deadline.expired = true;
			resolve({ ok: false, stdout: "" });
			return;
		}
		const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "ignore"] });
		let stdout = "";
		let settled = false;
		const finish = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ ok, stdout });
		};
		const timer = Number.isFinite(remaining)
			? setTimeout(() => {
					deadline.expired = true;
					if (child.pid !== undefined) killProcessTree(child.pid);
					child.stdout.destroy();
					finish(false);
				}, remaining)
			: undefined;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => finish(false));
		child.on("close", (code) => finish(code === 0));
	});
}

function git(ctx: Context, args: string[], cwd?: string): Promise<RunResult> {
	return run("git", args, ctx, cwd);
}

function hardenedGit(ctx: Context, args: string[], cwd?: string): Promise<RunResult> {
	return run("git", [...HARDENING, ...args], ctx, cwd);
}

function slugPart(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function targetSlug(target: RemoteCheckoutTarget): string {
	return slugPart(`${target.provider}-${target.repo.owner}-${target.repo.repo}-${target.number}`);
}

export function checkoutTreePath(target: RemoteCheckoutTarget): string {
	return path.join(scratchDir("thrash"), `tree-${targetSlug(target)}`);
}

export function sharedClonePath(target: RemoteCheckoutTarget): string {
	const { provider, repo } = target;
	return path.join(scratchDir("thrash"), `clone-${slugPart(`${provider}-${repo.host}-${repo.owner}-${repo.repo}`)}`);
}

function prHeadRef(target: RemoteCheckoutTarget): string {
	return target.provider === "github"
		? `refs/pull/${target.number}/head`
		: `refs/merge-requests/${target.number}/head`;
}

function removeDir(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function providerCloneArgs(target: RemoteCheckoutTarget, dir: string): { command: string; args: string[] } {
	const { host, owner, repo } = target.repo;
	const command = target.provider === "github" ? resolveGhBin() : resolveGlabBin();
	const source =
		target.provider === "github"
			? [host, owner, repo].filter(Boolean).join("/")
			: `${host ? `https://${host}/` : ""}${owner}/${repo}`;
	return {
		command,
		args: ["repo", "clone", source, dir, "--", "--depth", "1", "--no-checkout", ...CLONE_HARDENING],
	};
}

async function cloneRepository(ctx: Context, target: RemoteCheckoutTarget, dir: string): Promise<boolean> {
	removeDir(dir);
	const { command, args } = providerCloneArgs(target, dir);
	const result = await run(command, args, ctx);
	if (!result.ok) removeDir(dir);
	return result.ok;
}

async function originMatches(ctx: Context, cwdRoot: string, target: RemoteCheckoutTarget): Promise<string | null> {
	const origin = await git(ctx, ["config", "--get", "remote.origin.url"], cwdRoot);
	const url = origin.stdout.trim();
	if (!origin.ok || !url) return null;
	try {
		const ref = parseRepoRef(url);
		const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
		const { host, owner, repo } = target.repo;
		return same(ref.host, host) && same(ref.owner, owner) && same(ref.repo, repo) ? url : null;
	} catch {
		return null;
	}
}

async function checkoutSha(ctx: Context, tree: string, sha: string): Promise<boolean> {
	const result = await hardenedGit(ctx, ["checkout", "--detach", "--force", "--no-recurse-submodules", "-q", "--end-of-options", sha], tree);
	return result.ok;
}

async function hasCommit(ctx: Context, tree: string, sha: string): Promise<boolean> {
	return (await git(ctx, ["cat-file", "-e", `${sha}^{commit}`], tree)).ok;
}

async function cwdStep(
	ctx: Context,
	target: RemoteCheckoutTarget,
	sha: string,
	tree: string,
	cwd: string,
): Promise<boolean> {
	const top = await git(ctx, ["rev-parse", "--show-toplevel"], cwd);
	const cwdRoot = top.stdout.trim();
	if (!top.ok || !cwdRoot) return false;
	const originUrl = await originMatches(ctx, cwdRoot, target);
	if (!originUrl) return false;
	const cloned = await hardenedGit(ctx, ["clone", "--shared", "--no-checkout", ...CLONE_HARDENING, "--", cwdRoot, tree]);
	if (!cloned.ok) return false;
	if (!(await hasCommit(ctx, tree, sha))) {
		const fetched = await hardenedGit(
			ctx,
			["fetch", "--no-tags", "--no-recurse-submodules", "--", originUrl, prHeadRef(target)],
			tree,
		);
		if (!fetched.ok) return false;
	}
	return checkoutSha(ctx, tree, sha);
}

async function fetchPrHead(ctx: Context, target: RemoteCheckoutTarget, repoDir: string): Promise<boolean> {
	const fetched = await hardenedGit(
		ctx,
		["fetch", "--depth", "1", "--no-tags", "--no-recurse-submodules", "origin", prHeadRef(target)],
		repoDir,
	);
	return fetched.ok;
}

async function cloneStep(
	ctx: Context,
	target: RemoteCheckoutTarget,
	sha: string,
	tree: string,
	shared: SharedClone | undefined,
): Promise<boolean> {
	if (shared) {
		if (!(await fetchPrHead(ctx, target, shared.dir)) || !(await hasCommit(ctx, shared.dir, sha))) return false;
		await git(ctx, ["worktree", "prune"], shared.dir);
		const added = await hardenedGit(ctx, ["worktree", "add", "--detach", "--force", "--end-of-options", tree, sha], shared.dir);
		return added.ok;
	}
	if (!(await cloneRepository(ctx, target, tree))) return false;
	if (!(await fetchPrHead(ctx, target, tree))) return false;
	return checkoutSha(ctx, tree, sha);
}

function isSafePath(root: string, filePath: string): boolean {
	if (!filePath || path.isAbsolute(filePath) || filePath.includes("\0")) return false;
	const segments = filePath.split("/");
	if (segments.some((segment) => segment === "" || segment.toLowerCase() === ".git")) return false;
	const target = path.resolve(root, filePath);
	return target !== path.resolve(root) && isPathInside(target, root);
}

async function mapConcurrent<T>(items: T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) await task(items[next++] as T);
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function apiStep(
	input: CheckoutInput,
	target: RemoteCheckoutTarget,
	sha: string,
	tree: string,
	maxFiles: number,
): Promise<boolean> {
	const candidates = input.files.filter((file) => file.status !== "deleted" && file.status !== "binary");
	if (candidates.length === 0 || candidates.length > maxFiles) return false;
	const ref: PrRef = { number: target.number, repo: target.repo };
	mkdirSync(tree, { recursive: true });
	let written = 0;
	await mapConcurrent(candidates, API_FETCH_CONCURRENCY, async (file) => {
		if (!isSafePath(tree, file.path)) return;
		try {
			const content = await input.provider.getFileAtRef(ref, file.path, sha);
			if (content === null || Buffer.byteLength(content) > API_FETCH_MAX_BYTES) return;
			const destination = path.resolve(tree, file.path);
			mkdirSync(path.dirname(destination), { recursive: true });
			writeFileSync(destination, content);
			written += 1;
		} catch {
			return;
		}
	});
	if (written === 0) removeDir(tree);
	return written > 0;
}

function none(headSha: string): CheckoutResult {
	return { root: "", headSha, source: "none" };
}

async function resolveLocal(
	target: Extract<CheckoutTarget, { mode: "local" }>,
	options: CheckoutOptions,
): Promise<CheckoutResult> {
	const ctx: Context = {
		env: buildEnv(options.env),
		deadline: { at: Number.POSITIVE_INFINITY, expired: false },
	};
	const head = await git(ctx, ["rev-parse", "HEAD"], target.root);
	return { root: target.root, headSha: head.ok ? head.stdout.trim() : "", source: "cwd" };
}

async function resolveRemote(
	input: CheckoutInput,
	target: RemoteCheckoutTarget,
	sha: string,
	options: CheckoutOptions,
): Promise<CheckoutResult> {
	const ctx: Context = {
		env: buildEnv(options.env),
		deadline: { at: Date.now() + (options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS), expired: false },
	};
	const tree = checkoutTreePath(target);
	const reset = (): void => removeDir(tree);
	reset();

	if (await cwdStep(ctx, target, sha, tree, options.cwd ?? process.cwd())) {
		return { root: tree, headSha: sha, source: "cwd" };
	}
	reset();

	const cloneAllowed = options.sharedClone !== null && !ctx.deadline.expired;
	if (cloneAllowed && (await cloneStep(ctx, target, sha, tree, options.sharedClone ?? undefined))) {
		return { root: tree, headSha: sha, source: "clone" };
	}
	reset();

	if (await apiStep(input, target, sha, tree, options.apiFetchMaxFiles ?? API_FETCH_MAX_FILES)) {
		return { root: tree, headSha: sha, source: "api" };
	}
	return none(sha);
}

/** Builds a scratch tree for the PR head; never throws, and falls back to `source: "none"`. */
export async function resolveCheckout(input: CheckoutInput, options: CheckoutOptions = {}): Promise<CheckoutResult> {
	const sha = input.pr?.headSha ?? "";
	try {
		if (input.target.mode === "local") return await resolveLocal(input.target, options);
		if (!HEAD_SHA_PATTERN.test(sha)) return none(sha);
		return await resolveRemote(input, input.target, sha, options);
	} catch {
		return none(sha);
	}
}

/** Makes the one scratch clone that `stack --diff` shares between its PR worktrees; null on failure. */
export async function prepareSharedClone(
	target: RemoteCheckoutTarget,
	options: Pick<CheckoutOptions, "cloneTimeoutMs" | "env"> = {},
): Promise<SharedClone | null> {
	const ctx: Context = {
		env: buildEnv(options.env),
		deadline: { at: Date.now() + (options.cloneTimeoutMs ?? CLONE_TIMEOUT_MS), expired: false },
	};
	try {
		const dir = sharedClonePath(target);
		return (await cloneRepository(ctx, target, dir)) ? { dir } : null;
	} catch {
		return null;
	}
}

function scratchRealPath(dir: string): string | null {
	try {
		const scratch = realpathSync(scratchDir("thrash"));
		const real = realpathSync(dir);
		return real !== scratch && isPathInside(real, scratch) ? real : null;
	} catch {
		return null;
	}
}

function isLinkedWorktree(root: string): boolean {
	try {
		return lstatSync(path.join(root, ".git")).isFile();
	} catch {
		return false;
	}
}

/** Deletes a scratch tree of `resolveCheckout`; a stack worktree also drops its shared clone once it is the last one. Never throws. */
export async function removeCheckoutTree(root: string, options: Pick<CheckoutOptions, "env"> = {}): Promise<void> {
	try {
		const resolved = root ? scratchRealPath(root) : null;
		if (!resolved) return;
		const ctx: Context = {
			env: buildEnv(options.env),
			deadline: { at: Number.POSITIVE_INFINITY, expired: false },
		};
		let shared: string | null = null;
		if (isLinkedWorktree(resolved)) {
			const common = await hardenedGit(ctx, ["rev-parse", "--path-format=absolute", "--git-common-dir"], resolved);
			const candidate = path.dirname(common.stdout.trim());
			const sharedReal = scratchRealPath(candidate);
			if (common.ok && path.basename(common.stdout.trim()) === ".git" && sharedReal) {
				shared = sharedReal;
			}
		}
		if (!shared) {
			removeDir(resolved);
			return;
		}
		await hardenedGit(ctx, ["worktree", "remove", "--force", resolved], shared);
		removeDir(resolved);
		await git(ctx, ["worktree", "prune"], shared);
		const list = await git(ctx, ["worktree", "list", "--porcelain"], shared);
		const entries = list.stdout.split("\n").filter((line) => line.startsWith("worktree "));
		if (list.ok && entries.length <= 1) removeDir(shared);
	} catch {
		return;
	}
}
