import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { join } from "node:path";
import { scratchFixtures } from "./git-repo-fixtures";
import { mergeEnv } from "./module-call";

export const BG_ENTRY = join(import.meta.dir, "../src/index.ts");

export interface BgRun {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface BgJob {
	id: string;
	command: string;
	cwd: string;
	logFile: string;
	statusFile: string;
	pidFile: string;
	launcherPid: number;
	kind: "shell" | "proxy";
	proxyBackend?: string;
	state: "running" | "done" | "unknown" | "canceled";
	exitCode: number | null;
	pendingUpdate: string | null;
	drainOutput?: string | null;
}

export function isLive(pid: number): boolean {
	try {
		if (
			process.platform === "linux" &&
			/^\S+ \(.+\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"))
		)
			return false;
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export async function until<T>(
	read: () => T | Promise<T>,
	ready: (value: T) => boolean,
	timeoutMs = 10000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let value = await read();
	while (!ready(value) && Date.now() < deadline) {
		await Bun.sleep(25);
		value = await read();
	}
	if (!ready(value)) throw new Error("condition did not settle before timeout");
	return value;
}

/** Isolated HOME, scratch and state roots plus disposable directories for `dg-skills bg`. */
export function bgWorld(
	command: string[] = [process.execPath, "run", BG_ENTRY],
) {
	const fixtures = scratchFixtures();
	const home = fixtures.tmp("bg-home-");
	const scratch = fixtures.tmp("bg-scratch-");
	const state = fixtures.tmp("bg-state-");

	function env(extra: Record<string, string | undefined> = {}) {
		return mergeEnv({
			HOME: home,
			XDG_STATE_HOME: undefined,
			AI_SCRATCH_DIR: scratch,
			AI_STATE_DIR: state,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			LC_ALL: "C",
			...extra,
		});
	}

	async function bg(
		args: string[],
		cwd: string,
		extra: Record<string, string | undefined> = {},
	): Promise<BgRun> {
		const proc = Bun.spawn([...command, "bg", ...args], {
			cwd,
			env: env(extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, exitCode };
	}

	async function json<T = BgJob>(
		args: string[],
		cwd: string,
		extra: Record<string, string | undefined> = {},
	): Promise<T> {
		const result = await bg(args, cwd, extra);
		if (result.exitCode !== 0)
			throw new Error(
				`bg ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`,
			);
		return JSON.parse(result.stdout) as T;
	}

	const launched: Array<{ id: string; cwd: string }> = [];

	async function launch(
		shell: string,
		cwd: string,
		extra: string[] = [],
		envExtra: Record<string, string | undefined> = {},
	): Promise<BgJob> {
		const job = await json(["run", shell, ...extra], cwd, envExtra);
		launched.push({ id: job.id, cwd });
		return job;
	}

	async function settled(
		id: string,
		cwd: string,
		ready: (job: BgJob) => boolean = (job) =>
			job.state === "done" || job.state === "canceled",
		timeoutMs?: number,
	): Promise<BgJob> {
		return until(() => json(["status", id], cwd), ready, timeoutMs);
	}

	function dir(prefix = "bg-dir-"): string {
		return realpathSync(fixtures.tmp(prefix));
	}

	function jobs(): BgJob[] {
		const root = join(state, "bg");
		try {
			return readdirSync(root)
				.filter((name) => name.endsWith(".meta.json"))
				.map((name) => JSON.parse(readFileSync(join(root, name), "utf8")));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
	}

	return {
		fixtures,
		home,
		scratch,
		state,
		env,
		bg,
		json,
		launch,
		settled,
		dir,
		jobs,
		mkdir(path: string) {
			mkdirSync(path, { recursive: true, mode: 0o700 });
			return path;
		},
		async cleanup() {
			for (const { id, cwd } of launched.splice(0)) {
				const status = await bg(["status", id], cwd).catch(() => null);
				if (status?.exitCode === 0)
					await bg(["cancel", id], cwd).catch(() => null);
			}
			fixtures.cleanup();
			for (const root of [home, scratch, state]) {
				rmSync(root, { recursive: true, force: true });
				mkdirSync(root, { recursive: true, mode: 0o700 });
			}
		},
	};
}
