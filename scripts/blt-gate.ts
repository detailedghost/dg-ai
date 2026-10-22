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

type CheckRun = { id: number; status: string; conclusion: string | null };

async function latestRun(
	repo: string,
	sha: string,
	name: string,
	token: string,
): Promise<CheckRun | undefined> {
	const res = await fetch(
		`https://api.github.com/repos/${repo}/commits/${sha}/check-runs?check_name=${name}`,
		{
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
			},
		},
	);
	if (!res.ok) throw new Error(`check-runs for ${name}: HTTP ${res.status}`);
	const { check_runs: runs } = (await res.json()) as { check_runs: CheckRun[] };
	return runs.sort((a, b) => b.id - a.id)[0];
}

async function main(): Promise<void> {
	const { BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, GITHUB_TOKEN } = process.env;
	if (!BASE_SHA || !HEAD_SHA || !GITHUB_REPOSITORY || !GITHUB_TOKEN) {
		throw new Error(
			"BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY, and GITHUB_TOKEN are required",
		);
	}
	const changed = Bun.spawnSync([
		"git",
		"diff",
		"--name-only",
		`${BASE_SHA}...${HEAD_SHA}`,
	])
		.stdout.toString()
		.split("\n")
		.filter(Boolean);
	const pending = new Set(requiredChecks(process.cwd(), changed));
	console.log(
		pending.size === 0
			? "No BLT check applies to this PR."
			: `Waiting for: ${[...pending].join(", ")}`,
	);
	const deadline = Date.now() + TIMEOUT_MS;
	while (pending.size > 0) {
		for (const name of pending) {
			const run = await latestRun(
				GITHUB_REPOSITORY,
				HEAD_SHA,
				name,
				GITHUB_TOKEN,
			);
			if (run?.status !== "completed") continue;
			if (run.conclusion !== "success")
				throw new Error(`${name} finished with ${run.conclusion}`);
			console.log(`${name} passed`);
			pending.delete(name);
		}
		if (pending.size === 0) break;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for: ${[...pending].join(", ")}`);
		await Bun.sleep(POLL_MS);
	}
}

if (import.meta.main) await main();
