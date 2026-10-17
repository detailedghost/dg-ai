import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Disposable repositories and roots: never reads or mutates a developer checkout. */
export function scratchFixtures() {
	const roots: string[] = [];
	const tmp = (prefix = "dg-scratch-") => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
		roots.push(dir);
		return dir;
	};
	const git = (args: string[], cwd: string) => {
		const proc = Bun.spawnSync(["git", "-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args], {
			cwd,
			env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0", GIT_DIR: undefined, GIT_WORK_TREE: undefined },
		});
		if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
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
			return { main, linked, scratch: tmp("dg-stash-scratch-"), state: tmp("dg-stash-state-"), home: tmp("dg-stash-home-") };
		},
		cleanup() {
			for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
		},
	};
}
