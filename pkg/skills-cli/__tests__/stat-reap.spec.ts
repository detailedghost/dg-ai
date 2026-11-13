import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_ENTRY, runCli } from "./module-call";
import { classify, launchdPidsFrom, liveIdentity, serviceCgroup, sessionAncestor, waitPatterns, type ProcRow, type ReapContext, reapCandidates } from "../src/stat/reap";

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
		installedLibDir: "/home/u/.local/share/dg/lib",
		minAgeSec: 10 * 60,
		loopMinAgeSec: 60 * 60,
		sessionPid: CLAUDE,
		protectedPids: new Set(),
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
		liveDaemons: result.liveDevDaemons.map((d) => [d.pid, d.script]),
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

	test("a deleted worktree path in argv brings an orphan into scope", () => {
		const out = verdict([row(10, ["bun", "test", `${GONE_WT}/pkg/a.spec.ts`], { cwd: SCRATCHPAD })]);
		expect(out.candidates).toEqual([10]);
	});

	test("a deleted worktree path in argv does not override a live parent", () => {
		const out = verdict([
			row(10, ["bun", "test", `${GONE_WT}/pkg/a.spec.ts`], { ppid: CLAUDE, cwd: SCRATCHPAD }),
		]);
		expect(out.skipped[10]).toBe("parent alive");
	});

	test("a live parent does not save a process whose cwd was deleted", () => {
		const out = verdict([row(10, ["bun", "test"], { ppid: CLAUDE, cwd: `${GONE_WT}/pkg (deleted)` })]);
		expect(out.candidates).toEqual([10]);
	});

	test("a deleted subdirectory of a live worktree does not override a live parent", () => {
		const out = verdict([row(10, ["bun", "test"], { ppid: CLAUDE, cwd: `${REPO}/temp (deleted)` })]);
		expect(out.skipped[10]).toBe("parent alive");
	});

	test("bg job processes and service units are never touched", () => {
		const out = verdict(
			[row(10, ["sleep", "600"]), row(11, ["gh", "run", "watch", "1"], { service: true })],
			ctx({ protectedPids: new Set([10]) }),
		);
		expect(out.candidates).toEqual([]);
		expect(Object.keys(out.skipped)).toEqual([]);
	});

	test("timeout counts only when the wrapped command is on the allowlist", () => {
		const out = verdict([
			row(10, ["timeout", "600", "gh", "run", "watch", "1"]),
			row(11, ["timeout", "900", "git", "worktree", "add", "x"]),
			row(12, ["/opt/chromium/chrome", "--user-data-dir=/tmp/profile"]),
			row(13, ["/opt/chromium/chrome", "--headless", "--user-data-dir=profile"], { cwd: "/tmp" }),
			row(14, ["/opt/chromium/chrome", "--remote-debugging-port=9222", "--user-data-dir=/tmp/p"]),
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
			row(17, ["timeout", "600", "bun", "test"]),
			row(18, ["/usr/bin/zsh", "-c", "until [ -s out ]; do sleep 15; done; tail out"]),
			row(19, ["/home/u/.local/share/dg/runtime/current/bun", `${GONE_WT}/pkg/launcher/dist/lib/dg.js`, "dg-daemon", "serve"]),
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

	test("a dev daemon from a live worktree is reported, never a candidate", () => {
		const script = `${WT}/pkg/launcher/dist/lib/dg.js`;
		const out = verdict([row(10, ["bun", script, "dg-daemon", "serve"])]);
		expect(out.candidates).toEqual([]);
		expect(out.liveDaemons).toEqual([[10, script]]);
	});

	test("a dev daemon from a deleted worktree is a candidate", () => {
		const out = verdict([row(10, ["bun", `${GONE_WT}/pkg/launcher/dist/lib/dg.js`, "dg-daemon", "serve"])]);
		expect(out.candidates).toEqual([10]);
		expect(out.liveDaemons).toEqual([]);
	});

	test("a daemon of an older installed version is protected", () => {
		const out = verdict([row(10, ["bun", "/home/u/.local/share/dg/lib/5.4.0/dg.js", "dg-daemon", "serve"])]);
		expect(out.candidates).toEqual([]);
	});

	test("no installed lib means no daemon is reaped", () => {
		const out = verdict(
			[row(10, ["bun", `${WT}/pkg/launcher/dist/lib/dg.js`, "dg-daemon", "serve"])],
			ctx({ installedLibDir: null }),
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
const TAIL = "&& pwd -P >| /tmp/claude-f170-cwd";

function loop(pid: number, body: string, extra: Partial<ProcRow> = {}): ProcRow {
	return row(pid, ["/usr/bin/zsh", "-c", `${SNAPSHOT} '${body}' < /dev/null ${TAIL}`], {
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
		expect(waitPatterns("while pgrep codex; do sleep 1; done")).toEqual([]);
		expect(waitPatterns("while pgrep -f -- worker; do sleep 10; done")).toEqual(["worker"]);
		expect(
			waitPatterns("while true; do pgrep -f worker >/dev/null; echo beat >> hb.log; sleep 10; done"),
		).toEqual([]);
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

	test("a loop member appears only in its loop, not in skipped", () => {
		const out = verdict([loop(30, until), row(31, ["sleep", "15"], { ppid: 30, ageSec: 5, cwd: SCRATCHPAD })]);
		expect(out.loops.map((l) => l.members)).toEqual([[31, 30]]);
		expect(out.skipped[31]).toBeUndefined();
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

	test("a loop whose target is its own background child is not stuck", () => {
		const out = verdict([
			loop(30, "bash ./build.sh & while pgrep -f build.sh; do sleep 5; done"),
			row(31, ["bash", "./build.sh"], { ppid: 30, cwd: SCRATCHPAD }),
		]);
		expect(out.loops).toEqual([]);
	});

	test("a sleep the loop waits on is a live target, not a helper", () => {
		const out = verdict([
			loop(30, "sleep 14400 & while pgrep -f 'sleep 14400'; do sleep 15; done"),
			row(31, ["sleep", "14400"], { ppid: 30, cwd: SCRATCHPAD }),
			row(32, ["sleep", "15"], { ppid: 30, cwd: SCRATCHPAD }),
		]);
		expect(out.loops).toEqual([]);
	});

	test("pgrep flags that change matching are left alone", () => {
		const out = verdict([loop(30, "while pgrep -fx service-name; do sleep 15; done")]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("wait pattern not supported");
	});

	test("pgrep -A excludes the loop itself, so it is left alone", () => {
		const out = verdict([loop(30, 'while pgrep -Af "codex review"; do sleep 15; done')]);
		expect(out.skipped[30]).toBe("wait pattern not supported");
	});

	test("a working loop counts as a live target for another loop", () => {
		const out = verdict([
			loop(30, 'until ! pgrep -f "touch out"; do sleep 15; done'),
			loop(31, "while pgrep -f '[b]uild'; do sleep 15; done; touch out"),
			row(32, ["build"], { ppid: 31, cwd: SCRATCHPAD }),
		]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("wait target alive");
	});

	test("a login shell loop is found", () => {
		const out = verdict([
			row(30, ["bash", "-lc", until], { ppid: CLAUDE, ageSec: 3 * 24 * HOUR, cwd: SCRATCHPAD }),
			row(31, ["zsh", "-l", "-c", until], { ppid: CLAUDE, ageSec: 3 * 24 * HOUR, cwd: SCRATCHPAD }),
		]);
		expect(out.loops.map((l) => l.pid)).toEqual([30, 31]);
	});

	test("a loop with no session ancestor is marked none", () => {
		const out = verdict([loop(30, until, { ppid: 1 })]);
		expect(out.loops.map((l) => [l.pid, l.session])).toEqual([[30, "none"]]);
	});

	test("a loop of another live session is reported as other", () => {
		const out = verdict([
			row(OTHER_CLAUDE, ["/opt/claude-code/bin/claude"], { ppid: 500, tty: true }),
			loop(30, until, { ppid: OTHER_CLAUDE }),
		]);
		expect(out.loops.map((l) => [l.pid, l.session])).toEqual([[30, "other"]]);
	});

	test("a self-excluding pattern can end, so its loop is not stuck", () => {
		const out = verdict([loop(30, "while pgrep -f '[g]h pr checks 180'; do sleep 1; done; bun test")]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("wait pattern does not match the loop itself");
	});

	test("a loop shell that runs other work is not stuck", () => {
		const out = verdict([loop(30, until), row(31, ["bun", "test"], { ppid: 30, cwd: SCRATCHPAD })]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("loop shell runs other work");
	});

	test("patterns with shell expansions or POSIX classes are left alone", () => {
		const out = verdict([
			loop(30, 'p="bun test"; while pgrep -f "$p"; do sleep 15; done'),
			loop(31, 'while pgrep -f "bun[[:space:]]test"; do sleep 15; done'),
		]);
		expect(out.loops).toEqual([]);
		expect([out.skipped[30], out.skipped[31]]).toEqual(["wait pattern not supported", "wait pattern not supported"]);
	});

	test("a young loop is left alone", () => {
		const out = verdict([loop(30, until, { ageSec: 20 * 60 })]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("younger than loop-min-age");
	});

	test("an interactive shell loop is never a wait loop", () => {
		expect(verdict([loop(30, until, { tty: true })]).loops).toEqual([]);
	});

	test("a quantified group pattern is left alone", () => {
		const out = verdict([loop(30, 'while pgrep -f "(a|aa)+x"; do sleep 15; done')]);
		expect(out.skipped[30]).toBe("wait pattern not supported");
	});

	test("a loop with another way out is not a wait loop", () => {
		expect(waitPatterns("while pgrep -f worker && [ ! -e stop ]; do sleep 15; done")).toEqual([]);
		expect(waitPatterns('until ! pgrep -f "x" || [ -e stop ]; do sleep 15; done')).toEqual([]);
		expect(waitPatterns('while pgrep -f "x"; do [ -e stop ] && break; sleep 15; done')).toEqual([]);
		expect(waitPatterns("until pgrep -f worker; do sleep 15; done")).toEqual([]);
	});

	test("a tail wait on a live PID outside the loop is not stuck", () => {
		const out = verdict([
			loop(30, 'tail --pid=$(pgrep -of "build.sh") -f /dev/null'),
			row(31, ["tail", "--pid=40", "-f", "/dev/null"], { ppid: 30, cwd: SCRATCHPAD }),
			row(40, ["node", "renamed"], { ppid: CLAUDE, cwd: SCRATCHPAD }),
		]);
		expect(out.loops).toEqual([]);
		expect(out.skipped[30]).toBe("wait target alive");
	});

	test("a tail wait on the loop shell itself is stuck", () => {
		const out = verdict([
			loop(30, 'tail --pid=$(pgrep -of "build.sh") -f /dev/null'),
			row(31, ["tail", "--pid=30", "-f", "/dev/null"], { ppid: 30, cwd: SCRATCHPAD }),
		]);
		expect(out.loops.map((l) => l.members)).toEqual([[31, 30]]);
	});

	test("a ppid cycle in the table does not hang the walk", () => {
		const out = verdict([loop(30, until, { ppid: 31 }), row(31, ["sleep", "15"], { ppid: 30, cwd: SCRATCHPAD })]);
		expect(out.loops.map((l) => l.members)).toEqual([[31, 30]]);
	});

	test("a runtime-wrapped codex and grok count as sessions", () => {
		const rows = [
			...BASE,
			row(60, ["node", "/usr/lib/node_modules/@openai/codex/bin/codex.js"], { tty: true }),
			row(61, ["/usr/bin/zsh", "-c", "x"], { ppid: 60 }),
			row(62, ["grok"], { tty: true }),
			row(63, ["/usr/bin/zsh", "-c", "x"], { ppid: 62 }),
		];
		expect(sessionAncestor(rows, 61)).toBe(60);
		expect(sessionAncestor(rows, 63)).toBe(62);
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

describe("stat reap platform readers", () => {
	test("the innermost systemd unit decides whether a cgroup is a service", () => {
		const user = "0::/user.slice/user-1000.slice/user@1000.service";
		expect(serviceCgroup(`${user}/tmux-spawn-1.scope\n`)).toBe(false);
		expect(serviceCgroup(`${user}/app.slice/dg-daemon.service\n`)).toBe(true);
		expect(serviceCgroup(`${user}/app.slice/foo.service/sub\n`)).toBe(true);
		expect(serviceCgroup("12:blkio:/\n1:name=systemd:/system.slice/cron.service\n")).toBe(true);
	});

	test("a failed launchctl list fails closed", () => {
		expect(() => launchdPidsFrom({ status: 1, stdout: "" })).toThrow("nothing is reaped");
		expect(() => launchdPidsFrom({ status: null, error: new Error("ENOENT") })).toThrow("ENOENT");
		expect([...launchdPidsFrom({ status: 0, stdout: "PID\tStatus\tLabel\n412\t0\tcom.x\n-\t0\tcom.y\n" })]).toEqual([
			412,
		]);
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
		let pid = 0;
		try {
			const spawn = Bun.spawnSync(["sh", "-c", "sleep 613 >/dev/null 2>&1 & echo $!"], { cwd: dir });
			pid = Number(spawn.stdout.toString().trim());
			await Bun.sleep(100);
			const reap = (args: string[]) =>
				runCli(["bun", CLI_ENTRY], ["stat", "reap", "--json", "--cwd", dir, "--min-age", "0", "--pid", String(pid), ...args], {
					cwd: dir,
					env: process.env as Record<string, string>,
				});
			const dry = JSON.parse((await reap(["--dry-run"])).stdout);
			if (dry.wouldReap.length === 0) {
				console.warn("stat reap integration: the sleep was not reparented to init; skipped");
				return;
			}
			expect(dry.wouldReap.map((k: { pid: number }) => k.pid)).toEqual([pid]);
			const run = await reap([]);
			expect(run.exitCode).toBe(0);
			const report = JSON.parse(run.stdout);
			expect(report.killed.map((k: { pid: number; signal: string }) => [k.pid, k.signal])).toEqual([[pid, "SIGTERM"]]);
			const deadline = Date.now() + 2000;
			while (liveIdentity(pid) !== null && Date.now() < deadline) await Bun.sleep(20);
			expect(liveIdentity(pid)).toBeNull();
		} finally {
			try {
				if (pid > 1) process.kill(pid, "SIGKILL");
			} catch {}
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
