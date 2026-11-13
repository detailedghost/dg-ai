import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";

/** One process as the reaper sees it; `startId` is the token the PID-reuse check compares. */
export interface ProcRow {
	pid: number;
	ppid: number;
	uid: number;
	state: string;
	ageSec: number;
	tty: boolean;
	argv: string[];
	cwd: string | null;
	startId: string;
}

export interface ReapContext {
	uid: number;
	selfPid: number;
	roots: string[];
	worktreePrefix: string | null;
	installedDgJs: string | null;
	minAgeSec: number;
	loopMinAgeSec: number;
	sessionPid: number | null;
	tempRoots: string[];
	exists: (file: string) => boolean;
	realpath: (file: string) => string;
}

export interface Candidate extends ProcRow {
	kind: string;
}

export interface Skip {
	pid: number;
	reason: string;
	command: string;
}

export interface Zombie {
	pid: number;
	ppid: number;
	parentIsCandidate: boolean;
}

/** A wait loop whose `pgrep -f` target matches nothing but the loop itself; `members` lists children first. */
export interface StuckLoop {
	pid: number;
	ppid: number;
	ageSec: number;
	patterns: string[];
	session: "current" | "other";
	command: string;
	members: Candidate[];
}

export interface LongPipe {
	pid: number;
	ppid: number;
	ageSec: number;
	command: string;
}

export interface Classified {
	candidates: Candidate[];
	skipped: Skip[];
	zombies: Zombie[];
	stuckLoops: StuckLoop[];
	longPipes: LongPipe[];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const RUNTIMES = new Set(["node", "bun"]);
const BROWSERS = new Set([
	"chrome",
	"chromium",
	"chromium-browser",
	"google-chrome",
	"headless_shell",
	"chrome-headless-shell",
]);
const DELETED_SUFFIX = " (deleted)";
const LOOP_HELPERS = new Set(["sleep", "pgrep", "tail", "timeout"]);
const PIPE_MIN_AGE_SEC = 86_400;
const SESSION_HEADS = new Set(["claude", "codex"]);

function base(word: string | undefined): string {
	return path.basename(word ?? "").replace(/\.exe$/i, "");
}

function inside(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Printable, one-line, capped form of a command line. */
export function shortCommand(argv: string[], max = 80): string {
	const text = argv.join(" ").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
	return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

function userDataDir(argv: string[]): string | null {
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg.startsWith("--user-data-dir=")) return arg.slice("--user-data-dir=".length);
		if (arg === "--user-data-dir") return argv[i + 1] ?? null;
	}
	return null;
}

function codexKind(argv: string[]): boolean {
	const head = base(argv[0]);
	for (let i = 0; i < Math.min(argv.length - 1, 2); i++) {
		if (i === 1 && !RUNTIMES.has(head)) break;
		if (/^codex(\.js)?$/.test(base(argv[i])) && ["review", "exec"].includes(argv[i + 1] ?? ""))
			return true;
	}
	return false;
}

function devDaemon(argv: string[], ctx: ReapContext): boolean {
	const i = argv.findIndex((word) => base(word) === "dg.js");
	if (i < 1 || argv[i + 1] !== "dg-daemon" || argv[i + 2] !== "serve") return false;
	if (!ctx.installedDgJs) return false;
	return ctx.realpath(argv[i] ?? "") !== ctx.installedDgJs;
}

function kindOf(proc: ProcRow, ctx: ReapContext): string | null {
	const argv = proc.argv;
	const head = base(argv[0]);
	if (head === "gh") {
		if (argv[1] === "pr" && argv[2] === "checks" && argv.includes("--watch")) return "gh-watch";
		if (argv[1] === "run" && argv[2] === "watch") return "gh-watch";
		return null;
	}
	if (codexKind(argv)) return "codex";
	if (head === "bun" && argv[1] === "test") return "bun-test";
	if (RUNTIMES.has(head) && argv.slice(1).some((word) => /(^|[/\\])playwright([/\\]|$)/.test(word)))
		return "playwright";
	if (BROWSERS.has(head)) {
		const dir = userDataDir(argv);
		return dir && ctx.tempRoots.some((root) => inside(path.resolve(dir), root)) ? "browser" : null;
	}
	if (head === "sleep" || head === "timeout") return "poll";
	if (SHELLS.has(head) && !proc.tty && argv[1] === "-c") {
		const script = argv.slice(2).join(" ");
		return /\b(while|until)\b/.test(script) && /\bsleep\b/.test(script) ? "poll-loop" : null;
	}
	if (devDaemon(argv, ctx)) return "dev-daemon";
	return null;
}

function namedPaths(proc: ProcRow): string[] {
	const found: string[] = [];
	for (const arg of proc.argv)
		for (const match of arg.matchAll(/(?:^|[\s='"`:;(])(\/[^\s'"`;|&<>()]+)/g))
			if (match[1]) found.push(match[1]);
	return found;
}

function worktreeGone(file: string, ctx: ReapContext): boolean {
	const root = ctx.roots
		.filter((r) => inside(file, r))
		.sort((a, b) => b.length - a.length)[0];
	if (root) return !ctx.exists(root);
	const prefix = ctx.worktreePrefix;
	if (!prefix || !file.startsWith(prefix)) return false;
	const slug = file.slice(prefix.length).split("/")[0];
	return !!slug && !ctx.exists(prefix + slug);
}

function cwdPath(proc: ProcRow): { dir: string; deleted: boolean } | null {
	if (!proc.cwd) return null;
	const deleted = proc.cwd.endsWith(DELETED_SUFFIX);
	return { dir: deleted ? proc.cwd.slice(0, -DELETED_SUFFIX.length) : proc.cwd, deleted };
}

function namesDeletedPath(proc: ProcRow, ctx: ReapContext): boolean {
	const cwd = cwdPath(proc);
	const paths = namedPaths(proc);
	if (cwd) paths.push(cwd.dir);
	return paths.some((file) => worktreeGone(file, ctx));
}

function ancestors(rows: Map<number, ProcRow>, pid: number): Set<number> {
	const seen = new Set<number>();
	for (let cur: number | undefined = pid; cur && !seen.has(cur); cur = rows.get(cur)?.ppid) seen.add(cur);
	return seen;
}

function descendants(rows: ProcRow[], pid: number): ProcRow[] {
	const children = new Map<number, ProcRow[]>();
	for (const proc of rows) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc]);
	const out: ProcRow[] = [];
	const walk = (parent: number) => {
		for (const child of children.get(parent) ?? []) {
			if (out.includes(child)) continue;
			walk(child.pid);
			out.push(child);
		}
	};
	walk(pid);
	return out;
}

function initPids(rows: ProcRow[], uid: number): Set<number> {
	const pids = new Set([1]);
	for (const proc of rows) {
		if (proc.uid !== uid) continue;
		const head = base(proc.argv[0]);
		if ((head === "systemd" && proc.argv.includes("--user")) || head === "launchd") pids.add(proc.pid);
	}
	return pids;
}

function shellScript(proc: ProcRow): string | null {
	if (proc.tty || !SHELLS.has(base(proc.argv[0])) || proc.argv[1] !== "-c") return null;
	return proc.argv.slice(2).join(" ");
}

/** The `pgrep -f` patterns of a shell that waits in a while/until loop or on `tail --pid=$(pgrep ...)`. */
export function waitPatterns(script: string): string[] {
	if (!/\b(while|until)\b/.test(script) && !/\btail\s+--pid=/.test(script)) return [];
	const patterns: string[] = [];
	const pgrep = /\bpgrep((?:\s+-[A-Za-z]+)+)\s+(?:"([^"]*)"|'([^']*)'|([^\s;|&)'"]+))/g;
	for (const m of script.matchAll(pgrep)) {
		if (!/f/.test(m[1] ?? "")) continue;
		const pattern = m[2] ?? m[3] ?? m[4];
		if (pattern) patterns.push(pattern);
	}
	return patterns;
}

function matcher(pattern: string): (text: string) => boolean {
	try {
		const re = new RegExp(pattern);
		return (text) => re.test(text);
	} catch {
		return (text) => text.includes(pattern);
	}
}

function hasSessionAncestor(byPid: Map<number, ProcRow>, proc: ProcRow): boolean {
	for (const pid of ancestors(byPid, proc.ppid)) {
		const head = base(byPid.get(pid)?.argv[0]);
		if (SESSION_HEADS.has(head)) return true;
	}
	return false;
}

/** Nearest `claude` or `codex` ancestor of `pid`, the session that owns this run. */
export function sessionAncestor(rows: ProcRow[], pid: number): number | null {
	const byPid = new Map(rows.map((proc) => [proc.pid, proc]));
	for (const cur of ancestors(byPid, pid)) {
		if (cur !== pid && SESSION_HEADS.has(base(byPid.get(cur)?.argv[0]))) return cur;
	}
	return null;
}

/** Splits a process table into reap candidates, stuck wait loops, long pipes, skipped allowlisted processes and zombies. */
export function classify(rows: ProcRow[], ctx: ReapContext): Classified {
	const byPid = new Map(rows.map((proc) => [proc.pid, proc]));
	const self = ancestors(byPid, ctx.selfPid);
	const init = initPids(rows, ctx.uid);
	const candidates: Candidate[] = [];
	const skipped: Skip[] = [];
	const zombies: ProcRow[] = [];
	const loops: { proc: ProcRow; patterns: string[] }[] = [];
	const longPipes: LongPipe[] = [];
	const mine = rows.filter(
		(proc) => proc.uid === ctx.uid && !self.has(proc.pid) && !init.has(proc.pid),
	);
	for (const proc of mine) {
		if (proc.state.startsWith("Z")) {
			zombies.push(proc);
			continue;
		}
		const skip = (reason: string) => skipped.push({ pid: proc.pid, reason, command: shortCommand(proc.argv) });
		const kind = kindOf(proc, ctx);
		const cwd = cwdPath(proc);
		const cwdInScope = !!cwd && ctx.roots.some((root) => inside(cwd.dir, root));
		const stale = kind ? namesDeletedPath(proc, ctx) : false;
		const orphan = init.has(proc.ppid);
		if (kind && (cwdInScope || stale) && (orphan || stale) && proc.ageSec >= ctx.minAgeSec) {
			candidates.push({ ...proc, kind });
			continue;
		}
		const script = shellScript(proc);
		const patterns = script ? waitPatterns(script) : [];
		if (patterns.length > 0) {
			loops.push({ proc, patterns });
			continue;
		}
		if (script && /[^|>]\|[^|]/.test(script) && proc.ageSec >= PIPE_MIN_AGE_SEC && hasSessionAncestor(byPid, proc)) {
			longPipes.push({ pid: proc.pid, ppid: proc.ppid, ageSec: proc.ageSec, command: shortCommand(proc.argv) });
			continue;
		}
		if (!kind) continue;
		if (!cwdInScope && !stale) skip("cwd outside repo");
		else if (!orphan && !stale) skip("parent alive");
		else skip("younger than min-age");
	}
	const loopPids = new Set(loops.map((l) => l.proc.pid));
	const ignored = new Set<number>(self);
	for (const pid of loopPids)
		for (const child of descendants(rows, pid))
			if (LOOP_HELPERS.has(base(child.argv[0])) || SHELLS.has(base(child.argv[0]))) ignored.add(child.pid);
	const others = rows.filter((proc) => !loopPids.has(proc.pid) && !ignored.has(proc.pid) && !proc.state.startsWith("Z"));
	const stuckLoops: StuckLoop[] = [];
	for (const { proc, patterns } of loops) {
		const command = shortCommand(proc.argv);
		if (proc.ageSec < ctx.loopMinAgeSec) {
			skipped.push({ pid: proc.pid, reason: "younger than loop-min-age", command });
			continue;
		}
		const alive = patterns.some((pattern) => {
			const test = matcher(pattern);
			return others.some((other) => test(other.argv.join(" ")));
		});
		if (alive) {
			skipped.push({ pid: proc.pid, reason: "wait target alive", command });
			continue;
		}
		const session =
			ctx.sessionPid !== null && ancestors(byPid, proc.ppid).has(ctx.sessionPid) ? "current" : "other";
		const members = [...descendants(rows, proc.pid), proc]
			.filter((member) => member.uid === ctx.uid)
			.map((member) => ({ ...member, kind: "wait-loop" }));
		stuckLoops.push({ pid: proc.pid, ppid: proc.ppid, ageSec: proc.ageSec, patterns, session, command, members });
	}
	const chosen = new Set(candidates.map((c) => c.pid));
	return {
		candidates,
		skipped,
		zombies: zombies.map((z) => ({ pid: z.pid, ppid: z.ppid, parentIsCandidate: chosen.has(z.ppid) })),
		stuckLoops,
		longPipes,
	};
}

export interface Reaped {
	pid: number;
	ageSec: number;
	kind: string;
	command: string;
	signal: "SIGTERM" | "SIGKILL";
}

export interface ReapResult {
	killed: Reaped[];
	skipped: Skip[];
	failed: { pid: number; error: string; command: string }[];
}

export interface SignalDeps {
	identity: (pid: number) => string | null;
	kill: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	sleep: (ms: number) => Promise<void>;
	graceMs: number;
}

const POLL_MS = 100;

/** SIGTERM each candidate whose start time still matches, then SIGKILL survivors after the grace period. */
export async function reapCandidates(candidates: Candidate[], deps: SignalDeps): Promise<ReapResult> {
	const result: ReapResult = { killed: [], skipped: [], failed: [] };
	const same = (c: Candidate) => deps.identity(c.pid) === c.startId;
	const send = (c: Candidate, signal: "SIGTERM" | "SIGKILL"): boolean => {
		const command = shortCommand(c.argv);
		try {
			deps.kill(c.pid, signal);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ESRCH") result.skipped.push({ pid: c.pid, reason: "gone", command });
			else result.failed.push({ pid: c.pid, error: code ?? (error as Error).message, command });
			return false;
		}
	};
	const pending: Candidate[] = [];
	for (const c of candidates) {
		const current = deps.identity(c.pid);
		const command = shortCommand(c.argv);
		if (current === null) result.skipped.push({ pid: c.pid, reason: "gone", command });
		else if (current !== c.startId) result.skipped.push({ pid: c.pid, reason: "pid reused", command });
		else if (send(c, "SIGTERM")) pending.push(c);
	}
	const deadline = Date.now() + deps.graceMs;
	while (pending.some(same) && Date.now() < deadline) await deps.sleep(POLL_MS);
	for (const c of pending) {
		const entry = { pid: c.pid, ageSec: c.ageSec, kind: c.kind, command: shortCommand(c.argv) };
		if (!same(c)) result.killed.push({ ...entry, signal: "SIGTERM" });
		else if (send(c, "SIGKILL")) result.killed.push({ ...entry, signal: "SIGKILL" });
	}
	return result;
}

function clockTicks(): number {
	const out = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
	const ticks = Number(out.stdout?.trim());
	return Number.isSafeInteger(ticks) && ticks > 0 ? ticks : 100;
}

function procStat(pid: number): { ppid: number; state: string; tty: boolean; start: string } | null {
	try {
		const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
		const start = fields[19] ?? "";
		if (!/^[0-9]+$/.test(start)) return null;
		return { state: fields[0] ?? "", ppid: Number(fields[1]), tty: Number(fields[4]) !== 0, start };
	} catch {
		return null;
	}
}

function linuxRows(): ProcRow[] {
	const ticks = clockTicks();
	const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
	const rows: ProcRow[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^[0-9]+$/.test(name)) continue;
		const pid = Number(name);
		try {
			const stat = procStat(pid);
			if (!stat) continue;
			const uid = statSync(`/proc/${pid}`).uid;
			const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
			if (argv.at(-1) === "") argv.pop();
			let cwd: string | null = null;
			try {
				cwd = readlinkSync(`/proc/${pid}/cwd`);
			} catch {}
			rows.push({
				pid,
				ppid: stat.ppid,
				uid,
				state: stat.state,
				ageSec: Math.max(0, Math.floor(uptime - Number(stat.start) / ticks)),
				tty: stat.tty,
				argv,
				cwd,
				startId: stat.start,
			});
		} catch {}
	}
	return rows;
}

function elapsedSeconds(etime: string): number {
	const [days, clock] = etime.includes("-") ? etime.split("-") : ["0", etime];
	const parts = (clock ?? "").split(":").map(Number).reverse();
	return Number(days) * 86_400 + (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600;
}

function psRows(): ProcRow[] {
	const out = spawnSync(
		"ps",
		["-axww", "-o", "pid=,ppid=,uid=,etime=,stat=,tty=,lstart=,command="],
		{ encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, maxBuffer: 64 * 1024 * 1024 },
	);
	if (out.status !== 0) throw new Error(`ps failed: ${out.stderr?.trim()}`);
	const rows: ProcRow[] = [];
	const line = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/;
	for (const text of out.stdout.split("\n")) {
		const m = line.exec(text);
		if (!m) continue;
		rows.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			uid: Number(m[3]),
			ageSec: elapsedSeconds(m[4] ?? ""),
			state: m[5] ?? "",
			tty: !["?", "??", "-"].includes(m[6] ?? ""),
			startId: (m[7] ?? "").replace(/\s+/g, " "),
			argv: (m[8] ?? "").split(/\s+/).filter(Boolean),
			cwd: null,
		});
	}
	return rows;
}

/** The current process table: /proc on Linux, `ps` on macOS. */
export function readProcTable(): ProcRow[] {
	return process.platform === "linux" ? linuxRows() : psRows();
}

/** Start token in the same format `readProcTable` records, or null when the process is gone or a zombie. */
export function liveIdentity(pid: number): string | null {
	if (process.platform === "linux") {
		const stat = procStat(pid);
		return stat && !stat.state.startsWith("Z") ? stat.start : null;
	}
	const out = spawnSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
	const m = /^\s*(\S+)\s+(\S.*?)\s*$/.exec(out.stdout ?? "");
	if (out.status !== 0 || !m || (m[1] ?? "").startsWith("Z")) return null;
	return (m[2] ?? "").replace(/\s+/g, " ");
}
