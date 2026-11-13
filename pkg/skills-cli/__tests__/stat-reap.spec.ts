import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, runCli } from "./module-call";
import { classify, sessionAncestor, waitPatterns, type ProcRow, type ReapContext, reapCandidates } from "../src/stat/reap";

const ME = 1000;
const REPO = "/home/u/code/dg-ai";
const WT = "/home/u/code/worktrees/dg-ai-live";
const GONE_WT = "/home/u/code/worktrees/dg-ai-gone";
const INSTALLED = "/home/u/.local/share/dg/lib/5.5.0/dg.js";
const SCRATCHPAD = "/tmp/claude-1000/-home-u-code-other/abc/scratchpad";
const CLAUDE = 988;
const SYSTEMD_USER = 4134;

function row(pid: number, argv: string[], extra: Partial<ProcRow> = {}): ProcRow {
	return {
		pid,
		ppid: 1,
		uid: ME,
		state: "S",
		ageSec: 11 * 60,
		tty: false,
		argv,
		cwd: REPO,
		startId: `start-${pid}`,
		...extra,
	};
}

const BASE: ProcRow[] = [
	row(1, ["/sbin/init"], { uid: 0, ppid: 0, cwd: "/" }),
	row(SYSTEMD_USER, ["/usr/lib/systemd/systemd", "--user"], { cwd: "/" }),
	row(CLAUDE, ["/opt/claude-code/bin/claude", "--resume"], { ppid: 500, tty: true }),
];

function ctx(extra: Partial<ReapContext> = {}): ReapContext {
	const existing = new Set([REPO, WT, INSTALLED]);
	return {
		uid: ME,
		selfPid: 99_999,
		roots: [REPO, WT, GONE_WT],
		worktreePrefix: "/home/u/code/worktrees/dg-ai-",
		installedDgJs: INSTALLED,
		minAgeSec: 10 * 60,
		loopMinAgeSec: 60 * 60,
		sessionPid: CLAUDE,
		tempRoots: ["/tmp"],
		exists: (path) => [...existing].some((p) => path === p || path.startsWith(`${p}/`)),
		realpath: (path) => path,
		...extra,
	};
}

function verdict(rows: ProcRow[], context: ReapContext = ctx()) {
	const result = classify([...BASE, ...rows], context);
	return {
		loops: result.stuckLoops.map((l) => ({
			pid: l.pid,
			session: l.session,
			patterns: l.patterns,
			members: l.members.map((m) => m.pid),
		})),
		pipes: result.longPipes.map((p) => p.pid),
		candidates: result.candidates.map((c) => c.pid),
		skipped: Object.fromEntries(result.skipped.map((s) => [s.pid, s.reason])),
		zombies: result.zombies,
	};
}

describe("stat reap classifier", () => {
	test("a live codex review child of a live agent in a scratchpad cwd is skipped", () => {
		const out = verdict([
			row(10, ["codex", "review", "--base", "origin/master"], { ppid: CLAUDE, cwd: SCRATCHPAD }),
		]);
		expect(out.candidates).toEqual([]);
		expect(out.skipped[10]).toBe("cwd outside repo");
	});

	test("an orphaned codex review outside the repo is still skipped", () => {
		const out = verdict([row(10, ["codex", "review"], { cwd: SCRATCHPAD })]);
		expect(out.candidates).toEqual([]);
		expect(out.skipped[10]).toBe("cwd outside repo");
	});

	test("a codex review inside the repo with a live parent is skipped", () => {
		const out = verdict([row(10, ["codex", "review"], { ppid: CLAUDE })]);
		expect(out.candidates).toEqual([]);
		expect(out.skipped[10]).toBe("parent alive");
	});

	test("an orphaned codex review inside the repo is a candidate", () => {
		expect(verdict([row(10, ["codex", "review"])]).candidates).toEqual([10]);
	});

	test("a process whose cwd is a linked worktree is in scope", () => {
		expect(verdict([row(10, ["codex", "exec", "x"], { cwd: `${WT}/pkg` })]).candidates).toEqual([10]);
	});

	test("a live parent does not save a process that names a deleted worktree path", () => {
		const out = verdict([
			row(10, ["bun", "test", `${GONE_WT}/pkg/a.spec.ts`], { ppid: CLAUDE, cwd: SCRATCHPAD }),
		]);
		expect(out.candidates).toEqual([10]);
	});

	test("a path under a pruned worktree that git no longer lists still counts as deleted", () => {
		const out = verdict(
			[row(10, ["bun", "test"], { ppid: CLAUDE, cwd: "/home/u/code/worktrees/dg-ai-pruned/pkg (deleted)" })],
			ctx({ roots: [REPO, WT] }),
		);
		expect(out.candidates).toEqual([10]);
	});

	test("a missing file under a worktree that still exists is not a deleted path", () => {
		const out = verdict([row(10, ["bun", "test", `${WT}/new.log`], { ppid: CLAUDE, cwd: SCRATCHPAD })]);
		expect(out.skipped[10]).toBe("cwd outside repo");
	});

	test("the user's systemd --user counts as init", () => {
		expect(verdict([row(10, ["gh", "run", "watch", "1"], { ppid: SYSTEMD_USER })]).candidates).toEqual([10]);
	});

	test("another user's systemd --user does not count as init", () => {
		const out = verdict([
			row(77, ["/usr/lib/systemd/systemd", "--user"], { uid: 1001 }),
			row(10, ["gh", "run", "watch", "1"], { ppid: 77 }),
		]);
		expect(out.skipped[10]).toBe("parent alive");
	});

	test("young processes are skipped", () => {
		const out = verdict([row(10, ["gh", "pr", "checks", "1", "--watch"], { ageSec: 60 })]);
		expect(out.skipped[10]).toBe("younger than min-age");
	});

	test("other users' processes are never reported", () => {
		const out = verdict([row(10, ["codex", "review"], { uid: 1001 })]);
		expect(out.candidates).toEqual([]);
		expect(out.skipped[10]).toBeUndefined();
	});

	test("this process and its ancestors are never candidates", () => {
		const out = verdict(
			[row(20, ["timeout", "60", "dg-skills"]), row(21, ["bun", "test"], { ppid: 20 })],
			ctx({ selfPid: 21 }),
		);
		expect(out.candidates).toEqual([]);
	});

	test("the allowlist matches each kind of agent tooling", () => {
		const out = verdict([
			row(10, ["gh", "pr", "checks", "180", "--watch"]),
			row(11, ["gh", "run", "watch", "42"]),
			row(12, ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js", "exec", "hi"]),
			row(13, ["bun", "test", "a.spec.ts"]),
			row(14, ["node", "/repo/node_modules/playwright/cli.js", "test"]),
			row(15, ["/opt/chromium/chrome", "--headless", "--user-data-dir=/tmp/pw-profile-x"]),
			row(16, ["sleep", "15"]),
			row(17, ["timeout", "600", "gh", "pr", "view"]),
			row(18, ["/usr/bin/zsh", "-c", "until [ -s out ]; do sleep 15; done; tail out"]),
			row(19, ["/home/u/.local/share/dg/runtime/current/bun", `${WT}/pkg/launcher/dist/lib/dg.js`, "dg-daemon", "serve"]),
		]);
		expect(out.candidates).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
	});

	test("protected and off-list processes are never candidates", () => {
		const out = verdict([
			row(10, ["/opt/claude-code/bin/claude", "daemon", "run"]),
			row(11, ["codex"]),
			row(12, ["codex", "app-server"]),
			row(13, ["grok"]),
			row(14, ["nvim", "a.ts"]),
			row(15, ["/usr/bin/zsh", "-c", "while true; do sleep 1; done"], { tty: true }),
			row(16, ["-zsh"]),
			row(17, ["/home/u/.local/share/dg/runtime/current/bun", INSTALLED, "dg-daemon", "serve"]),
			row(18, ["bun", "/x/dg.js", "dg-agent", "phone", "open"]),
			row(19, ["/opt/brave/chrome", "--user-data-dir=/home/u/.config/brave"]),
			row(20, ["gh", "pr", "view", "1"]),
			row(21, ["/usr/lib/systemd/systemd", "--user"]),
			row(22, ["bun", "run", "dev"]),
		]);
		expect(out.candidates).toEqual([]);
		expect(Object.keys(out.skipped)).toEqual([]);
	});

	test("an installed daemon reached through the lib/current link is protected", () => {
		const link = "/home/u/.local/share/dg/lib/current/dg.js";
		const out = verdict(
			[row(10, ["bun", link, "dg-daemon", "serve"])],
			ctx({ realpath: (p) => (p === link ? INSTALLED : p) }),
		);
		expect(out.candidates).toEqual([]);
	});

	test("no installed lib means no daemon is reaped", () => {
		const out = verdict(
			[row(10, ["bun", `${WT}/pkg/launcher/dist/lib/dg.js`, "dg-daemon", "serve"])],
			ctx({ installedDgJs: null }),
		);
		expect(out.candidates).toEqual([]);
	});

	test("zombies are reported with their parent, never as candidates", () => {
		const out = verdict([
			row(10, ["gh", "run", "watch", "1"]),
			row(11, ["gh"], { ppid: 10, state: "Z" }),
			row(12, ["sleep"], { ppid: CLAUDE, state: "Z" }),
		]);
		expect(out.candidates).toEqual([10]);
		expect(out.zombies).toEqual([
			{ pid: 11, ppid: 10, parentIsCandidate: true },
			{ pid: 12, ppid: CLAUDE, parentIsCandidate: false },
		]);
	});
});

const OTHER_CLAUDE = 777;
const HOUR = 3600;
const SNAPSHOT = "source /home/u/.claude/shell-snapshots/snapshot-zsh-1.sh 2>/dev/null || true && eval";
const tail = "&& pwd -P >| /tmp/claude-f170-cwd";

function loop(pid: number, body: string, extra: Partial<ProcRow> = {}): ProcRow {
	return row(pid, ["/usr/bin/zsh", "-c", `${SNAPSHOT} '${body}' < /dev/null ${tail}`], {
		ppid: CLAUDE,
		ageSec: 3 * 24 * HOUR,
		cwd: SCRATCHPAD,
		...extra,
	});
}

describe("stat reap stuck wait loops", () => {
	const until = 'until [ -s out ] && ! pgrep -f "gh pr checks 180" >/dev/null; do sleep 15; done';

	test("finds the pgrep -f patterns of each wait shape", () => {
		expect(waitPatterns(until)).toEqual(["gh pr checks 180"]);
		expect(waitPatterns("while pgrep -f run-local-filtered >/dev/null; do sleep 15; done")).toEqual([
			"run-local-filtered",
		]);
		expect(waitPatterns('tail --pid=$(pgrep -of "codex review") -f /dev/null')).toEqual(["codex review"]);
		expect(waitPatterns('pgrep -f "codex review"')).toEqual([]);
		expect(waitPatterns('while pgrep codex; do sleep 1; done')).toEqual([]);
	});

	test("a loop of this session that only matches itself is stuck, children first", () => {
		const out = verdict([
			loop(30, until),
			row(31, ["sleep", "15"], { ppid: 30, ageSec: 5 }),
			row(32, ["pgrep", "-f", "gh pr checks 180"], { ppid: 30, ageSec: 0 }),
		]);
		expect(out.loops).toEqual([
			{ pid: 30, session: "current", patterns: ["gh pr checks 180"], members: [31, 32, 30] },
		]);
		expect(out.candidates).toEqual([]);
	});

	test("a loop whose target is alive is not stuck", () => {
		const out = verdict([
			loop(30, until),
			row(40, ["gh", "pr", "checks", "180", "--watch"], { ppid: CLAUDE, ageSec: 60 }),
		]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("wait target alive");
	});

	test("loops that wait on the same pattern do not keep each other alive", () => {
		const body = "while pgrep -f run-local-filtered >/dev/null; do sleep 15; done";
		const out = verdict([loop(30, body), loop(31, body)]);
		expect(out.loops.map((l) => l.pid)).toEqual([30, 31]);
	});

	test("a loop of another live session is reported as other", () => {
		const out = verdict([
			row(OTHER_CLAUDE, ["/opt/claude-code/bin/claude"], { ppid: 500, tty: true }),
			loop(30, until, { ppid: OTHER_CLAUDE }),
		]);
		expect(out.loops.map((l) => [l.pid, l.session])).toEqual([[30, "other"]]);
	});

	test("a young loop is left alone", () => {
		const out = verdict([loop(30, until, { ageSec: 20 * 60 })]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("younger than loop-min-age");
	});

	test("an interactive shell loop is never a wait loop", () => {
		expect(verdict([loop(30, until, { tty: true })]).loops).toEqual([]);
	});

	test("the session is the nearest claude or codex ancestor", () => {
		const rows = [...BASE, row(50, ["/usr/bin/zsh", "-c", "x"], { ppid: CLAUDE }), row(51, ["bun"], { ppid: 50 })];
		expect(sessionAncestor(rows, 51)).toBe(CLAUDE);
		expect(sessionAncestor(rows, CLAUDE)).toBeNull();
	});

	test("a session shell stuck in a pipe for over a day is reported", () => {
		const out = verdict([
			loop(30, "rg foo . | head -5"),
			loop(31, "rg foo . | head -5", { ageSec: HOUR }),
			loop(32, "rg foo . || true"),
		]);
		expect(out.pipes).toEqual([30]);
	});
});

describe("stat reap signaling", () => {
	function fakeProcs(initial: Record<number, string>, dieOn: "SIGTERM" | "SIGKILL" | "never") {
		const live = new Map(Object.entries(initial).map(([pid, id]) => [Number(pid), id]));
		const sent: [number, string][] = [];
		return {
			sent,
			live,
			deps: {
				identity: (pid: number) => live.get(pid) ?? null,
				kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => {
					if (!live.has(pid)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
					sent.push([pid, signal]);
					if (dieOn === signal || signal === "SIGKILL") live.delete(pid);
				},
				sleep: async () => {},
				graceMs: 0,
			},
		};
	}

	const candidate = (pid: number, startId: string) => ({ ...row(pid, ["sleep", "600"]), startId, kind: "poll" });

	test("SIGTERM is enough for a process that exits", async () => {
		const f = fakeProcs({ 10: "a" }, "SIGTERM");
		const out = await reapCandidates([candidate(10, "a")], f.deps);
		expect(out.killed.map((k) => [k.pid, k.signal])).toEqual([[10, "SIGTERM"]]);
		expect(f.sent).toEqual([[10, "SIGTERM"]]);
	});

	test("a survivor of SIGTERM gets SIGKILL", async () => {
		const f = fakeProcs({ 10: "a" }, "never");
		const out = await reapCandidates([candidate(10, "a")], f.deps);
		expect(out.killed.map((k) => [k.pid, k.signal])).toEqual([[10, "SIGKILL"]]);
		expect(f.sent).toEqual([
			[10, "SIGTERM"],
			[10, "SIGKILL"],
		]);
	});

	test("a reused PID is skipped and never signaled", async () => {
		const f = fakeProcs({ 10: "other" }, "SIGTERM");
		const out = await reapCandidates([candidate(10, "a")], f.deps);
		expect(out.killed).toEqual([]);
		expect(out.skipped).toEqual([{ pid: 10, reason: "pid reused", command: "sleep 600" }]);
		expect(f.sent).toEqual([]);
	});

	test("a process that is already gone is skipped", async () => {
		const f = fakeProcs({}, "SIGTERM");
		const out = await reapCandidates([candidate(10, "a")], f.deps);
		expect(out.skipped.map((s) => s.reason)).toEqual(["gone"]);
	});

	test("a permission error is a failure", async () => {
		const f = fakeProcs({ 10: "a" }, "SIGTERM");
		f.deps.kill = () => {
			throw Object.assign(new Error("nope"), { code: "EPERM" });
		};
		const out = await reapCandidates([candidate(10, "a")], f.deps);
		expect(out.failed.map((x) => x.pid)).toEqual([10]);
	});
});

describe.skipIf(process.platform === "win32")("dg-skills stat reap", () => {
	test("reaps an orphaned sleep in its own temp dir and nothing else", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "dg-stat-reap-")));
		try {
			const spawn = Bun.spawnSync(["sh", "-c", "sleep 613 >/dev/null 2>&1 & echo $!"], { cwd: dir });
			const pid = Number(spawn.stdout.toString().trim());
			await Bun.sleep(100);
			const reap = (args: string[]) =>
				runCli(["bun", CLI_ENTRY], ["stat", "reap", "--json", "--cwd", dir, "--min-age", "0", "--pid", String(pid), ...args], {
					cwd: dir,
					env: process.env as Record<string, string>,
				});
			const dry = JSON.parse((await reap(["--dry-run"])).stdout);
			if (dry.wouldReap.length === 0) {
				process.kill(pid, "SIGKILL");
				console.warn("stat reap integration: the sleep was not reparented to init; skipped");
				return;
			}
			expect(dry.wouldReap.map((k: { pid: number }) => k.pid)).toEqual([pid]);
			const run = await reap([]);
			expect(run.exitCode).toBe(0);
			const report = JSON.parse(run.stdout);
			expect(report.killed.map((k: { pid: number; signal: string }) => [k.pid, k.signal])).toEqual([[pid, "SIGTERM"]]);
			expect(() => process.kill(pid, 0)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
