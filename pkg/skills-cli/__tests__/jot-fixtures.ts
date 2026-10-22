import {
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { git, scratchFixtures } from "./git-repo-fixtures";
import { CLI_ENTRY, mergeEnv, runCli } from "./module-call";

export const CAP = 2048;
export const ID_A = "2026-10-13 1432 — sample-portal — retire demo";
export const ID_B = "2026-10-13 1500 — scripts — jot modes";

export interface JotRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface JotRepo {
	main: string;
	linked: string;
}

export function jotWorld(
	command: string[] = [process.execPath, "run", CLI_ENTRY],
) {
	const fixtures = scratchFixtures();
	const home = fixtures.tmp("jot-home-");
	const scratch = fixtures.tmp("jot-scratch-");
	const state = fixtures.tmp("jot-state-");

	function env(extra: Record<string, string | undefined> = {}) {
		return mergeEnv({
			HOME: home,
			AI_SCRATCH_DIR: scratch,
			AI_STATE_DIR: state,
			XDG_STATE_HOME: undefined,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			LC_ALL: "C",
			...extra,
		});
	}

	async function jot(
		args: string[],
		cwd: string,
		stdin?: string,
		extra: Record<string, string | undefined> = {},
	): Promise<JotRun> {
		return runCli(command, ["jot", ...args], { cwd, env: env(extra), stdin });
	}

	function repo(options: { agents?: boolean } = {}): JotRepo {
		const main = realpathSync(fixtures.tmp("jot-main-"));
		git(["init", "-q", "-b", "main"], main);
		if (options.agents) {
			mkdirSync(join(main, ".agents"));
			writeFileSync(join(main, ".agents", "keep.txt"), "tracked\n");
		}
		writeFileSync(join(main, "README.md"), "fixture\n");
		git(["add", "-A"], main);
		git(["commit", "-q", "-m", "init"], main);
		const linked = join(realpathSync(fixtures.tmp("jot-linked-")), "wt");
		git(["worktree", "add", "-q", "-b", "feat", linked], main);
		return { main, linked };
	}

	return {
		fixtures,
		home,
		scratch,
		state,
		env,
		jot,
		repo,
		tmp: fixtures.tmp,
		reset() {
			fixtures.cleanup();
			for (const dir of [home, scratch, state]) {
				rmSync(dir, { recursive: true, force: true });
				mkdirSync(dir, { mode: 0o700 });
			}
		},
		cleanup() {
			fixtures.cleanup();
			for (const dir of [home, scratch, state])
				rmSync(dir, { recursive: true, force: true });
		},
	};
}

export function section(heading: string, bytes: number): string {
	return `## ${heading}\n\n${"x".repeat(bytes)}\n\n`;
}

export function checkpointBody(id: string, summary = "state of play"): string {
	return [
		`## ${id}`,
		`summary: ${summary}`,
		"repo: /tmp/example-repo",
		"",
		"### Branches and PRs",
		"- main",
		"### Done",
		"- a",
		"### In progress",
		"- b",
		"### Next steps",
		"- c",
		"### Open questions",
		"- d",
		"### Gotchas",
		"- e",
		"",
	].join("\n");
}

export function tree(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}
