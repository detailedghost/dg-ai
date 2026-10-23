import { readFileSync } from "node:fs";
import { join } from "node:path";

export const BLT_CHECKS = [
	"skills-blt",
	"ext-blt",
	"dg-daemon-blt",
	"dg-agent-blt",
] as const;

const POLL_MS = 20_000;
const TIMEOUT_MS = 40 * 60_000;

export function watchedPaths(workflow: string): string[] {
	const block =
		/pull_request:\n {4}paths:\n((?: {6}- \S+\n)+)/.exec(workflow)?.[1] ?? "";
	return [...block.matchAll(/- (\S+)/g)].map((m) => m[1]);
}

export function touches(patterns: string[], changed: string[]): boolean {
	return changed.some((file) =>
		patterns.some((pattern) =>
			pattern.endsWith("/**")
				? file.startsWith(pattern.slice(0, -2))
				: file === pattern,
		),
	);
}

export function requiredChecks(root: string, changed: string[]): string[] {
	return BLT_CHECKS.filter((name) =>
		touches(
			watchedPaths(
				readFileSync(join(root, ".github", "workflows", `${name}.yml`), "utf8"),
			),
			changed,
		),
	);
}

type CheckRun = {
	id: number;
	status: "completed";
	conclusion: "success" | null;
};

type SpawnSyncFn = (cmd: string[]) => {
	success: boolean;
	stdout: { toString(): string };
	stderr: { toString(): string };
};

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export type GateDeps = {
	spawnSync: SpawnSyncFn;
	fetch: FetchFn;
	now: () => number;
	sleep: (ms: number) => Promise<void>;
};

const defaultDeps: GateDeps = {
	spawnSync: (cmd) => Bun.spawnSync(cmd),
	fetch,
	now: Date.now,
	sleep: Bun.sleep,
};

function changedFiles(
	spawnSync: SpawnSyncFn,
	baseSha: string,
	headSha: string,
): string[] {
	const result = spawnSync([
		"git",
		"diff",
		"--name-only",
		`${baseSha}...${headSha}`,
	]);
	if (!result.success) {
		throw new Error(
			`git diff ${baseSha}...${headSha} failed: ${result.stderr.toString().trim()}`,
		);
	}
	return result.stdout.toString().split("\n").filter(Boolean);
}

async function latestRun(
	fetchImpl: FetchFn,
	repo: string,
	sha: string,
	name: string,
	token: string,
): Promise<CheckRun | undefined> {
	let res: Response;
	try {
		res = await fetchImpl(
			`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=${name}`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github+json",
				},
			},
		);
	} catch (err) {
		console.log(
			`check-runs for ${name}: network error, retrying next poll: ${(err as Error).message}`,
		);
		return undefined;
	}
	if (!res.ok) throw new Error(`check-runs for ${name}: HTTP ${res.status}`);
	const { check_runs: runs } = (await res.json()) as { check_runs: CheckRun[] };
	return runs.sort((a, b) => b.id - a.id)[0];
}

export type GateOptions = {
	root: string;
	baseSha: string;
	headSha: string;
	repo: string;
	token: string;
};

export async function gate(
	options: GateOptions,
	deps: Partial<GateDeps> = {},
): Promise<void> {
	const { spawnSync, fetch: fetchImpl, now, sleep } = { ...defaultDeps, ...deps };
	const changed = changedFiles(spawnSync, options.baseSha, options.headSha);
	const pending = new Set(requiredChecks(options.root, changed));
	console.log(
		pending.size === 0
			? "No BLT check applies to this PR."
			: `Waiting for: ${[...pending].join(", ")}`,
	);
	const deadline = now() + TIMEOUT_MS;
	while (pending.size > 0) {
		for (const name of pending) {
			const run = await latestRun(
				fetchImpl,
				options.repo,
				options.headSha,
				name,
				options.token,
			);
			if (run?.status !== "completed") continue;
			if (run.conclusion !== "success")
				throw new Error(`${name} finished with ${run.conclusion}`);
			console.log(`${name} passed`);
			pending.delete(name);
		}
		if (pending.size === 0) break;
		if (now() > deadline)
			throw new Error(`timed out waiting for: ${[...pending].join(", ")}`);
		await sleep(POLL_MS);
	}
}

async function main(): Promise<void> {
	const { BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
	if (!BASE_SHA || !HEAD_SHA || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
		throw new Error(
			"BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, and GITHUB_TOKEN are required",
		);
	}
	await gate({
		root: process.cwd(),
		baseSha: BASE_SHA,
		headSha: HEAD_SHA,
		repo: GITHUB_REPOSITORY,
		token: GITHUB_TOKEN,
	});
}

if (import.meta.main) await main();
