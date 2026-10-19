import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTempDir(prefix = "dg-provider-test-"): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** Empty repository with no origin; shared by provider detection and CLI tests. */
export function makeGitRepo(): string {
	const dir = makeTempDir();
	git(["init", "-q", "-b", "main"], dir);
	return dir;
}

export function makeGitRepoWithOrigin(url: string): string {
	const dir = makeGitRepo();
	git(["remote", "add", "origin", url], dir);
	return dir;
}

/** Run git with isolated config; return stdout, or throw naming the args and cwd. */
export function git(args: string[], cwd: string): string {
	const proc = Bun.spawnSync(
		[
			"git",
			"-c",
			"user.email=test@example.invalid",
			"-c",
			"user.name=Test",
			...args,
		],
		{
			cwd,
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_COUNT: "0",
				GIT_DIR: undefined,
				GIT_WORK_TREE: undefined,
			},
		},
	);
	if (proc.exitCode !== 0)
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${proc.stderr.toString()}`);
	return proc.stdout.toString();
}

/** Disposable repositories and roots: never reads or mutates a developer checkout. */
export function scratchFixtures() {
	const roots: string[] = [];
	const tmp = (prefix = "dg-scratch-") => {
		const dir = makeTempDir(prefix);
		roots.push(dir);
		return dir;
	};
	return {
		tmp,
		git,
		repo(ignore = ".agents/\n") {
			const main = tmp("dg-stash-main-");
			git(["init", "-q", "-b", "main"], main);
			if (ignore) writeFileSync(join(main, ".gitignore"), ignore);
			git(["add", "-A"], main);
			git(["commit", "-q", "--allow-empty", "-m", "init"], main);
			const linked = join(tmp("dg-stash-linked-"), "wt");
			git(["worktree", "add", "-q", "-b", "feat", linked], main);
			return {
				main,
				linked,
				scratch: tmp("dg-stash-scratch-"),
				state: tmp("dg-stash-state-"),
				home: tmp("dg-stash-home-"),
			};
		},
		cleanup() {
			for (const dir of roots.splice(0))
				rmSync(dir, { recursive: true, force: true });
		},
	};
}
