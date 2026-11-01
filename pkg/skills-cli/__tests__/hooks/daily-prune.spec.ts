import {
	afterEach,
	describe,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import * as fs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { main } from "../../src/hooks/cli";
import {
	AGENTS_TTL_MS,
	linkedBranches,
	mainReposFor,
	type PruneOptions,
	pruneAgents,
	pruneRoot,
	pruneWorktrees,
	runNow,
	SCRATCH_TTL_MS,
	STATE_TTL_MS,
	scanMainRepos,
	stampFresh,
	worktreesOf,
} from "../../src/hooks/defs/daily-prune";
import type { HookSeams } from "../../src/hooks/types";
import { makeTempDir } from "../git-repo-fixtures";
import { hookWorld, SESSION } from "./hook-fixtures";

setDefaultTimeout(30_000);

const NOW = Date.now();
const DAY = 86_400_000;
const OLD = SCRATCH_TTL_MS + DAY;
let createdDirs: string[] = [];

afterEach(() => {
	for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
	createdDirs = [];
});

function tmp(prefix: string): string {
	const dir = realpathSync(makeTempDir(prefix));
	createdDirs.push(dir);
	return dir;
}

function touch(p: string, ageMs: number): void {
	const at = new Date(NOW - ageMs);
	utimesSync(p, at, at);
}

function file(p: string, ageMs: number): string {
	mkdirSync(join(p, ".."), { recursive: true });
	writeFileSync(p, "x");
	touch(p, ageMs);
	return p;
}

interface Recorded {
	argv: string[];
	cwd?: string;
}

function opts(
	dryRun = false,
	reply: (argv: string[]) => { status: number; stderr?: string } = () => ({
		status: 0,
	}),
): PruneOptions & { lines: string[]; calls: Recorded[] } {
	const lines: string[] = [];
	const calls: Recorded[] = [];
	return {
		now: NOW,
		dryRun,
		log: (l) => lines.push(l),
		run: async (argv: string[], o?: { cwd?: string }) => {
			calls.push({ argv, cwd: o?.cwd });
			const r = reply(argv);
			return { status: r.status, stdout: "", stderr: r.stderr ?? "" };
		},
		lines,
		calls,
	};
}

describe("pruneRoot", () => {
	test("removes an old bucket and keeps a fresh one", () => {
		const root = tmp("prune-root-");
		const oldBucket = join(root, "thrash", "aaaaaaaa");
		file(join(oldBucket, "f.md"), OLD);
		touch(oldBucket, OLD);
		file(join(root, "thrash", "bbbbbbbb", "f.md"), 1000);
		pruneRoot(root, SCRATCH_TTL_MS, false, opts());
		expect(existsSync(oldBucket)).toBe(false);
		expect(existsSync(join(root, "thrash", "bbbbbbbb"))).toBe(true);
	});

	test("keeps a bucket whose newest descendant is fresh", () => {
		const root = tmp("prune-root-");
		const bucket = join(root, "spec", "cccccccc");
		file(join(bucket, "old.md"), OLD);
		file(join(bucket, "deep", "new.md"), 1000);
		touch(join(bucket, "deep"), OLD);
		touch(bucket, OLD);
		pruneRoot(root, SCRATCH_TTL_MS, false, opts());
		expect(existsSync(bucket)).toBe(true);
	});

	test("keeps every skip-list entry even when old", () => {
		const root = tmp("prune-root-");
		const kept = [
			file(join(root, "hooks", "daily-prune.stamp"), OLD),
			file(join(root, "adhoc", "aaaaaaaa", "m"), OLD),
			file(join(root, "bg", "123.pid"), OLD),
			file(join(root, "pw", "states", "s.json"), OLD),
			file(join(root, "pw", "sessions", "s"), OLD),
			file(join(root, "pw", "sock", "s"), OLD),
			file(join(root, "pw", "log", "l"), OLD),
		];
		for (const p of kept)
			for (let d = join(p, ".."); d !== root; d = join(d, "..")) touch(d, OLD);
		pruneRoot(root, SCRATCH_TTL_MS, true, opts());
		for (const p of kept) expect(existsSync(p)).toBe(true);
	});

	test("prunes old hook markers but keeps the stamp", () => {
		const root = tmp("prune-root-");
		const marker = file(join(root, "hooks", "fmt-warned.S.ruff"), OLD);
		const stamp = file(join(root, "hooks", "daily-prune.stamp"), OLD);
		pruneRoot(root, SCRATCH_TTL_MS, true, opts());
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(stamp)).toBe(true);
	});

	test("removes old global files and dirs, and the emptied tool dir", () => {
		const root = tmp("prune-root-");
		const log = file(join(root, "bg", "1.log"), OLD);
		const dir = join(root, "viz", "some-slug");
		file(join(dir, "f"), OLD);
		touch(dir, OLD);
		pruneRoot(root, SCRATCH_TTL_MS, false, opts());
		expect(existsSync(log)).toBe(false);
		expect(existsSync(dir)).toBe(false);
		expect(existsSync(join(root, "bg"))).toBe(false);
	});

	test("keeps a fresh global dir", () => {
		const root = tmp("prune-root-");
		const dir = join(root, "viz", "live-slug");
		file(join(dir, "f"), 1000);
		touch(dir, OLD);
		pruneRoot(root, SCRATCH_TTL_MS, false, opts());
		expect(existsSync(dir)).toBe(true);
	});

	test("removes old flat root files only when asked", () => {
		const root = tmp("prune-root-");
		const flat = file(join(root, "stray.txt"), OLD);
		const fresh = file(join(root, "new.txt"), 1000);
		pruneRoot(root, STATE_TTL_MS, false, opts());
		expect(existsSync(flat)).toBe(true);
		pruneRoot(root, SCRATCH_TTL_MS, true, opts());
		expect(existsSync(flat)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
	});

	test("keeps a tool dir that was already empty", () => {
		const root = tmp("prune-root-");
		mkdirSync(join(root, "restack"));
		pruneRoot(root, SCRATCH_TTL_MS, false, opts());
		expect(existsSync(join(root, "restack"))).toBe(true);
	});

	test("dry run logs and removes nothing", () => {
		const root = tmp("prune-root-");
		const bucket = join(root, "thrash", "dddddddd");
		file(join(bucket, "f.md"), OLD);
		touch(bucket, OLD);
		const o = opts(true);
		pruneRoot(root, SCRATCH_TTL_MS, false, o);
		expect(existsSync(bucket)).toBe(true);
		expect(o.lines[0]).toStartWith("would remove");
	});

	test("does nothing for a root that does not exist", () => {
		const o = opts();
		pruneRoot(join(tmp("prune-root-"), "missing"), SCRATCH_TTL_MS, true, o);
		expect(o.lines).toEqual([]);
	});
});

describe("pruneRoot filesystem races", () => {
	function enoent(path: string) {
		return Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
	}

	test("keeps pruning when an entry vanishes between listing and stat", () => {
		const root = tmp("prune-root-");
		const ghost = join(root, "thrash", "aaaaaaaa");
		const stale = join(root, "thrash", "bbbbbbbb");
		file(join(ghost, "f.md"), OLD);
		file(join(stale, "f.md"), OLD);
		touch(ghost, OLD);
		touch(stale, OLD);
		const real = fs.lstatSync;
		const spy = spyOn(fs, "lstatSync").mockImplementation(((p: string) => {
			if (p === ghost) throw enoent(p);
			return real(p);
		}) as typeof fs.lstatSync);
		try {
			const o = opts();
			pruneRoot(root, SCRATCH_TTL_MS, false, o);
			expect(existsSync(stale)).toBe(false);
			expect(existsSync(ghost)).toBe(true);
		} finally {
			spy.mockRestore();
		}
	});

	test("keeps pruning when a directory vanishes before it is read", () => {
		const root = tmp("prune-root-");
		const ghost = join(root, "thrash", "aaaaaaaa");
		const stale = join(root, "thrash", "bbbbbbbb");
		file(join(ghost, "f.md"), OLD);
		file(join(stale, "f.md"), OLD);
		touch(ghost, OLD);
		touch(stale, OLD);
		const real = fs.readdirSync;
		const spy = spyOn(fs, "readdirSync").mockImplementation(((p: string) => {
			if (p === ghost) throw enoent(p);
			return real(p);
		}) as typeof fs.readdirSync);
		try {
			const o = opts();
			expect(() => pruneRoot(root, SCRATCH_TTL_MS, false, o)).not.toThrow();
			expect(existsSync(stale)).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	test("stops walking a bucket once it finds an entry newer than the cutoff", () => {
		const root = tmp("prune-root-");
		const bucket = join(root, "thrash", "cccccccc");
		file(join(bucket, "fresh.md"), 0);
		file(join(bucket, "old1.md"), OLD);
		file(join(bucket, "old2.md"), OLD);
		touch(bucket, OLD);
		const realList = fs.readdirSync;
		const realStat = fs.lstatSync;
		const seen: string[] = [];
		const list = spyOn(fs, "readdirSync").mockImplementation(((p: string) =>
			p === bucket
				? ["fresh.md", "old1.md", "old2.md"]
				: realList(p)) as typeof fs.readdirSync);
		const stat = spyOn(fs, "lstatSync").mockImplementation(((p: string) => {
			seen.push(p);
			return realStat(p);
		}) as typeof fs.lstatSync);
		try {
			pruneRoot(root, SCRATCH_TTL_MS, false, opts());
		} finally {
			list.mockRestore();
			stat.mockRestore();
		}
		expect(existsSync(bucket)).toBe(true);
		expect(seen.some((p) => p.endsWith("fresh.md"))).toBe(true);
		expect(seen.some((p) => p.endsWith("old1.md"))).toBe(false);
	});
});

describe("pruneRoot dropped personal entries", () => {
	test("prunes the entries the public SKIP list no longer protects", () => {
		const root = tmp("prune-root-");
		const stale = [
			file(join(root, "subagents-current.json"), OLD),
			file(join(root, "hook-comment-disabled.S1"), OLD),
			file(join(root, "ghattach-chromium", "profile"), OLD),
			file(join(root, "test-live", "state"), OLD),
			file(join(root, "skill-cleanup", "backups"), OLD),
		];
		for (const dir of ["ghattach-chromium", "test-live", "skill-cleanup"])
			touch(join(root, dir), OLD);
		pruneRoot(root, SCRATCH_TTL_MS, true, opts());
		for (const p of stale) expect(existsSync(p)).toBe(false);
	});
});

describe("stampFresh", () => {
	test("is false without a stamp, true within a day, false after", () => {
		const stamp = join(tmp("prune-stamp-"), "s");
		expect(stampFresh(stamp, NOW)).toBe(false);
		file(stamp, 3_600_000);
		expect(stampFresh(stamp, NOW)).toBe(true);
		touch(stamp, 25 * 3_600_000);
		expect(stampFresh(stamp, NOW)).toBe(false);
	});
});

const ID = ["-c", "user.email=t@t", "-c", "user.name=t"];

function sh(args: string[], cwd: string): void {
	const r = Bun.spawnSync(["git", ...ID, ...args], { cwd });
	if (r.exitCode !== 0)
		throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

describe("pruneWorktrees", () => {
	function fixture() {
		const base = tmp("prune-wt-");
		const origin = join(base, "origin.git");
		const main = join(base, "repo");
		const wtRoot = join(base, "worktrees");
		sh(["init", "-q", "--bare", "-b", "main", origin], base);
		sh(["clone", "-q", origin, main], base);
		sh(["commit", "-q", "--allow-empty", "-m", "init"], main);
		sh(["push", "-q", "-u", "origin", "main"], main);
		sh(["remote", "set-head", "origin", "-a"], main);
		const add = (name: string) => {
			const p = join(wtRoot, `repo-${name}`);
			sh(["worktree", "add", "-q", "-b", name, p], main);
			return p;
		};
		return { main, wtRoot, add };
	}

	test("finds main repos and linked branches", () => {
		const { main, wtRoot, add } = fixture();
		add("merged_one");
		expect(mainReposFor(wtRoot)).toEqual([main]);
		expect(linkedBranches(main)).toEqual(["merged_one"]);
	});

	test("prunes through the self command from the main repo", async () => {
		const { main, wtRoot, add } = fixture();
		add("merged_one");
		const o = opts();
		await pruneWorktrees(wtRoot, o);
		const prune = o.calls.find(
			(c) => c.argv.slice(-2).join(" ") === "worktree prune",
		);
		expect(prune).toBeDefined();
		expect(prune!.cwd).toBe(main);
	});

	test("runs a guarded remove for each linked branch from the main repo", async () => {
		const { main, wtRoot, add } = fixture();
		add("merged_one");
		add("merged_two");
		const o = opts();
		await pruneWorktrees(wtRoot, o);
		const removes = o.calls.filter(
			(c) => c.argv.at(-2) === "remove" && c.argv.at(-3) === "worktree",
		);
		expect(removes.map((c) => c.argv.at(-1)).sort()).toEqual([
			"merged_one",
			"merged_two",
		]);
		for (const r of removes) expect(r.cwd).toBe(main);
		expect(o.calls[0]?.argv.slice(-2)).toEqual(["worktree", "prune"]);
		expect(o.lines).toContain(`removed worktree ${main} merged_one`);
	});

	test("logs kept worktree with the last ANSI-stripped stderr line when remove refuses", async () => {
		const { main, wtRoot, add } = fixture();
		add("merged_one");
		const o = opts(false, (argv) =>
			argv.at(-2) === "remove"
				? { status: 1, stderr: "first\n\x1b[31mnot merged yet\x1b[0m\n" }
				: { status: 0 },
		);
		await pruneWorktrees(wtRoot, o);
		expect(o.lines).toContain(
			`kept worktree ${main} merged_one: not merged yet`,
		);
		expect(o.lines.some((l) => l.startsWith("removed worktree"))).toBe(false);
	});

	test("does nothing when the worktree root has no linked worktrees", async () => {
		const o = opts();
		await pruneWorktrees(join(tmp("prune-wt-"), "missing"), o);
		expect(o.calls).toEqual([]);
		expect(o.lines).toEqual([]);
	});

	test("dry run runs no command and keeps every worktree", async () => {
		const { wtRoot, add } = fixture();
		const merged = add("merged_one");
		const o = opts(true);
		await pruneWorktrees(wtRoot, o);
		expect(o.calls).toEqual([]);
		expect(existsSync(merged)).toBe(true);
		expect(o.lines[0]).toContain("would check");
	});

	test("skips removals and logs stderr when worktree prune fails", async () => {
		const { main, wtRoot, add } = fixture();
		add("merged_one");
		const o = opts(false, (argv) =>
			argv.at(-1) === "prune"
				? { status: 1, stderr: "fatal: locked\n" }
				: { status: 0 },
		);
		await pruneWorktrees(wtRoot, o);
		expect(o.calls.some((c) => c.argv.at(-2) === "remove")).toBe(false);
		expect(o.lines).toContain(
			`worktree prune failed in ${main}: fatal: locked`,
		);
	});

	test("removes only worktrees under the worktree root", async () => {
		const { main, wtRoot, add } = fixture();
		add("merged_one");
		const outside = join(tmp("prune-elsewhere-"), "side");
		sh(["worktree", "add", "-q", "-b", "elsewhere", outside], main);
		const o = opts();
		await pruneWorktrees(wtRoot, o);
		const removed = o.calls
			.filter((c) => c.argv.at(-2) === "remove")
			.map((c) => c.argv.at(-1));
		expect(removed).toEqual(["merged_one"]);
	});

	test("treats a worktree named with two leading dots as inside the root", async () => {
		const { main, wtRoot } = fixture();
		sh(["worktree", "add", "-q", "-b", "dots", join(wtRoot, "..dots")], main);
		const o = opts();
		await pruneWorktrees(wtRoot, o);
		const removed = o.calls
			.filter((c) => c.argv.at(-2) === "remove")
			.map((c) => c.argv.at(-1));
		expect(removed).toEqual(["dots"]);
	});
});

describe("pruneAgents", () => {
	const AGE = AGENTS_TTL_MS + DAY;

	function fixture() {
		const base = tmp("prune-agents-");
		const main = join(base, "code", "repo");
		mkdirSync(main, { recursive: true });
		sh(["init", "-q", "-b", "main"], main);
		writeFileSync(join(main, ".gitignore"), ".agents/*/\n!.agents/keep/\n");
		file(join(main, ".agents", "keep", "tracked.md"), AGE);
		sh(["add", "-A"], main);
		sh(["commit", "-q", "-m", "init"], main);
		const linked = join(base, "code", "worktrees", "repo-feat");
		sh(["worktree", "add", "-q", "-b", "feat", linked], main);
		return { main, linked, codeRoot: join(base, "code") };
	}

	function seed(wt: string) {
		const oldIgnored = file(join(wt, ".agents", "proto", "sub", "old.md"), AGE);
		const newIgnored = file(join(wt, ".agents", "proto", "new.md"), 1000);
		const tracked = join(wt, ".agents", "keep", "tracked.md");
		touch(tracked, AGE);
		const untracked = file(join(wt, ".agents", "keep", "untracked.md"), AGE);
		return {
			oldIgnored,
			newIgnored,
			tracked,
			untracked,
			gitFile: join(wt, ".git"),
		};
	}

	test("deletes old ignored files in main and linked worktrees only", () => {
		const { main, linked } = fixture();
		const m = seed(main);
		const l = seed(linked);
		pruneAgents([main], opts());
		for (const s of [m, l]) {
			expect(existsSync(s.oldIgnored)).toBe(false);
			expect(existsSync(s.newIgnored)).toBe(true);
			expect(existsSync(s.tracked)).toBe(true);
			expect(existsSync(s.untracked)).toBe(true);
			expect(existsSync(s.gitFile)).toBe(true);
		}
		expect(existsSync(join(main, ".git", "HEAD"))).toBe(true);
	});

	test("removes empty ignored dirs left behind but keeps non-empty ones", () => {
		const { main } = fixture();
		const s = seed(main);
		pruneAgents([main], opts());
		expect(existsSync(join(main, ".agents", "proto", "sub"))).toBe(false);
		expect(existsSync(join(main, ".agents", "proto"))).toBe(true);
		expect(existsSync(s.newIgnored)).toBe(true);
	});

	test("dry run logs the would-be deletions and removes nothing", () => {
		const { main } = fixture();
		const s = seed(main);
		const o = opts(true);
		pruneAgents([main], o);
		expect(existsSync(s.oldIgnored)).toBe(true);
		expect(o.lines).toEqual([
			expect.stringContaining(`would remove ${s.oldIgnored}`),
		]);
	});

	test("never reaches into .git even with ignored lookalikes", () => {
		const { main } = fixture();
		file(join(main, ".git", ".agents", "x"), AGE);
		pruneAgents([main], opts());
		expect(existsSync(join(main, ".git", ".agents", "x"))).toBe(true);
	});

	test.each([
		".agents/school/engineering.md",
		".agents/references/domain.md",
		".agents/spec/001_x/plan.md",
		".agents/decisions/d1.md",
		".agents/monolith.md",
		".agents/monolith/scan/a.json",
		".agents/jot/jot-x.md",
		".agents/paths.md",
		".agents/HANDOFF.md",
		".agents/proto/deep/HANDOFF.md",
	])("keeps ignored old %s", (rel) => {
		const { main } = fixture();
		writeFileSync(join(main, ".gitignore"), ".agents/*\n!.agents/keep/\n");
		const p = file(join(main, rel), AGE);
		pruneAgents([main], opts());
		expect(existsSync(p)).toBe(true);
	});

	test("lists worktrees and scans main repos under the code root", () => {
		const { main, linked, codeRoot } = fixture();
		expect(worktreesOf(main).sort()).toEqual([linked, main].sort());
		expect(scanMainRepos(codeRoot)).toEqual([main]);
	});
});

describe("daily-prune hook", () => {
	const stampPath = (state: string) =>
		join(state, "hooks", "daily-prune.stamp");
	const sessionStart = {
		session_id: SESSION,
		hook_event_name: "SessionStart",
		cwd: "/",
	};

	test("starts one background run and writes the stamp when there is no stamp", async () => {
		const world = hookWorld();
		try {
			const r = await world.run("daily-prune", sessionStart);
			expect(r.code).toBe(0);
			expect(world.spawned).toHaveLength(1);
			expect(existsSync(stampPath(world.state))).toBe(true);
		} finally {
			world.cleanup();
		}
	});

	test("starts nothing when the stamp is under a day old", async () => {
		const world = hookWorld();
		try {
			mkdirSync(join(world.state, "hooks"), { recursive: true });
			writeFileSync(stampPath(world.state), "");
			const r = await world.run("daily-prune", sessionStart);
			expect(r.code).toBe(0);
			expect(world.spawned).toEqual([]);
		} finally {
			world.cleanup();
		}
	});

	test("starts a run again once the stamp is older than a day", async () => {
		const world = hookWorld();
		try {
			mkdirSync(join(world.state, "hooks"), { recursive: true });
			writeFileSync(stampPath(world.state), "");
			const old = new Date(Date.now() - 2 * DAY);
			utimesSync(stampPath(world.state), old, old);
			await world.run("daily-prune", sessionStart);
			expect(world.spawned).toHaveLength(1);
			expect(statSync(stampPath(world.state)).mtimeMs).toBeGreaterThan(
				old.getTime(),
			);
		} finally {
			world.cleanup();
		}
	});
});

describe("runNow", () => {
	function world3() {
		const base = tmp("prune-now-");
		const scratch = join(base, "scratch");
		const state = join(base, "state");
		const code = join(base, "code");
		mkdirSync(code, { recursive: true });
		const env = {
			AI_SCRATCH_DIR: scratch,
			AI_STATE_DIR: state,
			DAILY_PRUNE_CODE_ROOT: code,
			DAILY_PRUNE_WORKTREE_ROOT: join(code, "worktrees"),
		};
		const oldBucket = join(scratch, "thrash", "aaaaaaaa");
		file(join(oldBucket, "f.md"), OLD);
		touch(oldBucket, OLD);
		const oldState = join(state, "tool", "bbbbbbbb");
		file(join(oldState, "f"), STATE_TTL_MS + DAY);
		touch(oldState, STATE_TTL_MS + DAY);
		return {
			env,
			oldBucket,
			oldState,
			logFile: join(scratch, "hooks", "daily-prune.log"),
		};
	}

	const noRun = async () => ({ status: 0, stdout: "", stderr: "" });

	test("prunes scratch and state and writes the log file", async () => {
		const w = world3();
		const lines: string[] = [];
		await runNow(w.env, noRun, false, (l) => lines.push(l));
		expect(existsSync(w.oldBucket)).toBe(false);
		expect(existsSync(w.oldState)).toBe(false);
		expect(lines[0]).toStartWith("daily-prune ");
		expect(readFileSync(w.logFile, "utf8")).toBe(`${lines.join("\n")}\n`);
		expect(lines.some((l) => l.startsWith("removed "))).toBe(true);
	});

	test("keeps going and writes the log when a tool dir is unreadable", async () => {
		const w = world3();
		const locked = join(w.env.AI_SCRATCH_DIR, "locked");
		mkdirSync(locked, { recursive: true });
		chmodSync(locked, 0o000);
		try {
			await runNow(w.env, noRun, false, () => {});
		} finally {
			chmodSync(locked, 0o755);
		}
		expect(existsSync(w.oldBucket)).toBe(false);
		expect(existsSync(w.logFile)).toBe(true);
	});

	test("leaves ignored .agents files in unrelated repos alone without an explicit code root", async () => {
		const w = world3();
		const other = join(w.env.DAILY_PRUNE_CODE_ROOT, "other");
		mkdirSync(other, { recursive: true });
		sh(["init", "-q", "-b", "main"], other);
		writeFileSync(join(other, ".gitignore"), ".agents/\n");
		const note = file(join(other, ".agents", "notes.md"), AGENTS_TTL_MS + DAY);
		const { DAILY_PRUNE_CODE_ROOT: _unset, ...env } = w.env;
		await runNow(env, noRun, false, () => {});
		expect(existsSync(note)).toBe(true);
		await runNow(w.env, noRun, false, () => {});
		expect(existsSync(note)).toBe(false);
	});

	test("a dry run removes nothing and writes no log file", async () => {
		const w = world3();
		const lines: string[] = [];
		await runNow(w.env, noRun, true, (l) => lines.push(l));
		expect(existsSync(w.oldBucket)).toBe(true);
		expect(existsSync(w.oldState)).toBe(true);
		expect(existsSync(w.logFile)).toBe(false);
		expect(lines[0]).toEndWith("dry-run");
		expect(lines.some((l) => l.startsWith("would remove"))).toBe(true);
	});

	test("hooks run daily-prune --now runs the job and exits 0", async () => {
		const w = world3();
		const out = { stdout: "", stderr: "" };
		const code = await main(["run", "daily-prune", "--now"], {
			stdin: Readable.from([]),
			env: w.env,
			seams: seams(out),
		});
		expect(code).toBe(0);
		expect(existsSync(w.oldBucket)).toBe(false);
		expect(existsSync(w.logFile)).toBe(true);
	});

	test("hooks run daily-prune --dry-run without --now exits 2 and spawns nothing", async () => {
		const w = world3();
		const spawned: string[][] = [];
		const out = { stdout: "", stderr: "" };
		const code = await main(["run", "daily-prune", "--dry-run"], {
			stdin: Readable.from([JSON.stringify({ session_id: SESSION })]),
			env: w.env,
			seams: {
				...seams(out),
				spawnDetached: (argv) => void spawned.push(argv),
			},
		});
		expect(code).toBe(2);
		expect(spawned).toEqual([]);
		expect(out.stderr).toContain("--now");
	});

	test("hooks run daily-prune --now --dry-run removes nothing", async () => {
		const w = world3();
		const code = await main(["run", "daily-prune", "--now", "--dry-run"], {
			stdin: Readable.from([]),
			env: w.env,
			seams: seams({ stdout: "", stderr: "" }),
		});
		expect(code).toBe(0);
		expect(existsSync(w.oldBucket)).toBe(true);
		expect(existsSync(w.logFile)).toBe(false);
	});
});

function seams(out: { stdout: string; stderr: string }): HookSeams {
	return {
		run: async () => ({ status: 0, stdout: "", stderr: "" }),
		which: () => undefined,
		spawnDetached: () => {},
		stdout: (t) => {
			out.stdout += t;
		},
		stderr: (t) => {
			out.stderr += t;
		},
	};
}

describe("daily-prune hook failure and race", () => {
	const sessionStart = {
		session_id: SESSION,
		hook_event_name: "SessionStart",
		cwd: "/",
	};

	test("two concurrent session starts spawn one run", async () => {
		const world = hookWorld();
		try {
			await Promise.all([
				world.run("daily-prune", sessionStart),
				world.run("daily-prune", sessionStart),
			]);
			expect(world.spawned).toHaveLength(1);
		} finally {
			world.cleanup();
		}
	});

	test("starts nothing while another run holds the stamp lock", async () => {
		const world = hookWorld();
		try {
			const lock = join(world.state, "hooks", "daily-prune.stamp.lock");
			mkdirSync(join(world.state, "hooks"), { recursive: true });
			writeFileSync(lock, "");
			await world.run("daily-prune", sessionStart);
			expect(world.spawned).toEqual([]);
			expect(existsSync(lock)).toBe(true);
		} finally {
			world.cleanup();
		}
	});

	test("leaves a lock that another run took over during this run", async () => {
		const world = hookWorld();
		try {
			const lock = join(world.state, "hooks", "daily-prune.stamp.lock");
			await world.run("daily-prune", sessionStart, {
				spawn: () => writeFileSync(lock, "another-owner"),
			});
			expect(readFileSync(lock, "utf8")).toBe("another-owner");
		} finally {
			world.cleanup();
		}
	});

	test("takes over a stamp lock older than ten minutes", async () => {
		const world = hookWorld();
		try {
			const lock = join(world.state, "hooks", "daily-prune.stamp.lock");
			mkdirSync(join(world.state, "hooks"), { recursive: true });
			writeFileSync(lock, "");
			const old = new Date(Date.now() - 11 * 60_000);
			utimesSync(lock, old, old);
			await world.run("daily-prune", sessionStart);
			expect(world.spawned).toHaveLength(1);
			expect(existsSync(lock)).toBe(false);
		} finally {
			world.cleanup();
		}
	});

	test("a throwing spawnDetached never blocks and is reported on stderr", async () => {
		const world = hookWorld();
		try {
			const r = await world.run("daily-prune", sessionStart, {
				spawn: () => {
					throw new Error("spawn exploded");
				},
			});
			expect(r.code).not.toBe(2);
			expect(r.stderr).toContain("spawn exploded");
			expect(existsSync(join(world.state, "hooks", "daily-prune.stamp"))).toBe(
				false,
			);
		} finally {
			world.cleanup();
		}
	});
});

describe("runNow root safety", () => {
	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"skips a group-writable scratch root and leaves its files",
		async () => {
			const base = makeTempDir("prune-unsafe-");
			const scratch = join(base, "scratch");
			const bucket = join(scratch, "thrash", "aaaaaaaa");
			fs.mkdirSync(bucket, { recursive: true });
			fs.writeFileSync(join(bucket, "f.md"), "x");
			const old = new Date(Date.now() - SCRATCH_TTL_MS - 86_400_000);
			fs.utimesSync(join(bucket, "f.md"), old, old);
			fs.utimesSync(bucket, old, old);
			fs.chmodSync(scratch, 0o777);
			const lines: string[] = [];
			await runNow(
				{ AI_SCRATCH_DIR: scratch, AI_STATE_DIR: join(base, "state") },
				async () => ({ status: 0, stdout: "", stderr: "" }),
				false,
				(l) => lines.push(l),
			);
			expect(fs.existsSync(join(bucket, "f.md"))).toBe(true);
			expect(
				lines.some((l) => l.startsWith("scratch prune failed: unsafe")),
			).toBe(true);
		},
	);
});
