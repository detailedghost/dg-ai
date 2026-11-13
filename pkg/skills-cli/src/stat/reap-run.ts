import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scratchRoot } from "@dg/common/node";
import { listJobs, readPid } from "../bg/jobs";
import { installRoot } from "../utils/lib";
import { git, parseWorktrees, worktreePrefix } from "../worktree/shared";
import {
	type Candidate,
	type Classified,
	type ProcRow,
	classify,
	liveIdentity,
	type ReapResult,
	readProcTable,
	reapCandidates,
	sessionAncestor,
	shortCommand,
	type Skip,
} from "./reap";

export interface ReapOptions {
	cwd: string;
	dryRun: boolean;
	minAgeMinutes: number;
	loopMinAgeMinutes: number;
	sessionPid?: number;
	otherSessions: boolean;
	pids: number[];
}

export interface ReapReport extends ReapResult {
	dryRun: boolean;
	cwd: string;
	roots: string[];
	sessionPid: number | null;
	wouldReap: { pid: number; ageSec: number; kind: string; command: string }[];
	stuckLoops: (Omit<Classified["stuckLoops"][number], "members"> & { action: "reaped" | "would-reap" | "not-reaped" | "reported" })[];
	longPipes: Classified["longPipes"];
	zombies: Classified["zombies"];
}

const GRACE_MS = 5000;

function real(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return file;
	}
}

function exists(file: string): boolean {
	try {
		statSync(file);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

function jobPids(rows: ProcRow[]): Set<number> {
	const roots = listJobs()
		.filter((job) => job.state === "running")
		.flatMap((job) => [job.launcherPid, readPid(job)])
		.filter((pid): pid is number => typeof pid === "number" && pid > 1);
	const children = new Map<number, number[]>();
	for (const proc of rows) children.set(proc.ppid, [...(children.get(proc.ppid) ?? []), proc.pid]);
	const out = new Set<number>();
	const walk = (pid: number) => {
		if (out.has(pid)) return;
		out.add(pid);
		for (const child of children.get(pid) ?? []) walk(child);
	};
	for (const pid of roots) walk(pid);
	return out;
}

async function scopeOf(cwd: string): Promise<{ roots: string[]; prefix: string | null }> {
	const listed = await git(cwd, ["worktree", "list", "--porcelain"]);
	const entries = listed.ok ? parseWorktrees(listed.stdout) : [];
	const origin = entries[0]?.path;
	if (!origin) return { roots: [cwd], prefix: null };
	return { roots: entries.map((entry) => entry.path), prefix: worktreePrefix(origin) };
}

function installedDgJs(): string | null {
	try {
		return realpathSync(path.join(installRoot(), "lib", "current", "dg.js"));
	} catch {
		return null;
	}
}

function brief(c: Candidate) {
	return { pid: c.pid, ageSec: c.ageSec, kind: c.kind, command: shortCommand(c.argv) };
}

/** Classifies this user's processes for `cwd` and signals the chosen ones unless `dryRun`. */
export async function runReap(options: ReapOptions): Promise<ReapReport> {
	const uid = process.getuid?.();
	if (uid === undefined) throw new Error("reap: no user id on this platform");
	if (uid === 0) throw new Error("reap: refusing to run as root");
	const cwd = real(path.resolve(options.cwd));
	const { roots, prefix } = await scopeOf(cwd);
	const rows = readProcTable(uid);
	const sessionPid = options.sessionPid ?? sessionAncestor(rows, process.pid);
	const result = classify(rows, {
		uid,
		selfPid: process.pid,
		roots,
		worktreePrefix: prefix,
		installedDgJs: installedDgJs(),
		minAgeSec: options.minAgeMinutes * 60,
		loopMinAgeSec: options.loopMinAgeMinutes * 60,
		sessionPid,
		protectedPids: jobPids(rows),
		tempRoots: [...new Set([tmpdir(), "/tmp", scratchRoot()].map(real))],
		exists,
		realpath: real,
	});
	const wanted = new Set(options.pids);
	const picked = (pid: number) => wanted.size === 0 || wanted.has(pid);
	const orphans = result.candidates.filter((c) => picked(c.pid));
	const actOnLoop = (loop: Classified["stuckLoops"][number]) =>
		wanted.size > 0
			? wanted.has(loop.pid)
			: loop.session === "current" || (loop.session === "other" && options.otherSessions);
	const loops = result.stuckLoops.filter(actOnLoop);
	const targets = [...new Map([...orphans, ...loops.flatMap((loop) => loop.members)].map((c) => [c.pid, c])).values()];
	const known = new Set([...result.candidates.map((c) => c.pid), ...result.stuckLoops.map((l) => l.pid)]);
	const notCandidates: Skip[] = [...wanted]
		.filter((pid) => !known.has(pid) && !result.skipped.some((skip) => skip.pid === pid))
		.map((pid) => ({ pid, reason: "not a reap candidate", command: "" }));
	const signaled: ReapResult = options.dryRun
		? { killed: [], skipped: [], failed: [] }
		: await reapCandidates(targets, {
				identity: liveIdentity,
				kill: (pid, signal) => {
					if (pid <= 1 || pid === process.pid) throw Object.assign(new Error("self"), { code: "EPERM" });
					process.kill(pid, signal);
				},
				sleep: (ms) => Bun.sleep(ms),
				graceMs: GRACE_MS,
			});
	const acted = new Set(loops.map((loop) => loop.pid));
	return {
		dryRun: options.dryRun,
		cwd,
		roots,
		sessionPid,
		killed: signaled.killed,
		wouldReap: options.dryRun ? targets.map(brief) : [],
		skipped: [...result.skipped, ...notCandidates, ...signaled.skipped],
		failed: signaled.failed,
		zombies: result.zombies,
		stuckLoops: result.stuckLoops.map(({ members: _members, ...loop }) => ({
			...loop,
			action: !acted.has(loop.pid)
				? "reported"
				: options.dryRun
					? "would-reap"
					: signaled.killed.some((k) => k.pid === loop.pid)
						? "reaped"
						: "not-reaped",
		})),
		longPipes: result.longPipes,
	};
}

/** Short age such as `12m`, `3h` or `2d`. */
export function formatAge(seconds: number): string {
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
	return `${Math.floor(seconds / 86_400)}d`;
}

/** Human-readable reap report ending in the one-line summary the skill relays. */
export function renderReap(report: ReapReport): string {
	const lines: string[] = [];
	const verb = report.dryRun ? "would reap" : "reaped";
	for (const k of report.dryRun ? report.wouldReap : report.killed) {
		const signal = "signal" in k ? ` ${k.signal}` : "";
		lines.push(`${verb} ${k.pid} (${formatAge(k.ageSec)}, ${k.kind}${signal}): ${k.command}`);
	}
	for (const f of report.failed) lines.push(`failed ${f.pid} (${f.error}): ${f.command}`);
	for (const loop of report.stuckLoops) {
		const how =
			loop.action === "reported"
				? `reported; stop it with: dg-skills stat reap --pid ${loop.pid}`
				: loop.action.replace("-", " ");
		lines.push(
			`stuck loop ${loop.pid} (${loop.session} session, ${formatAge(loop.ageSec)}) waits on ${loop.patterns.map((p) => JSON.stringify(p)).join(", ")}: ${how}`,
		);
	}
	for (const p of report.longPipes)
		lines.push(`long pipe ${p.pid} (${formatAge(p.ageSec)}, parent ${p.ppid}): ${p.command}`);
	for (const z of report.zombies)
		lines.push(
			`zombie ${z.pid} (parent ${z.ppid}${z.parentIsCandidate ? ", cleared when the parent is reaped" : ""})`,
		);
	for (const s of report.skipped) lines.push(`skipped ${s.pid} (${s.reason})${s.command ? `: ${s.command}` : ""}`);
	const done = report.dryRun ? report.wouldReap : report.killed;
	const kinds = new Map<string, number>();
	for (const k of done) kinds.set(k.kind, (kinds.get(k.kind) ?? 0) + 1);
	const detail = [...kinds].map(([kind, n]) => `${n} ${kind}`).join(", ");
	const reported = report.stuckLoops.filter((l) => l.action === "reported").length;
	const head = report.dryRun ? "Would reap" : "Reaped";
	lines.push(
		`${head}: ${done.length} processes${detail ? ` (${detail})` : ""}. Skipped: ${report.skipped.length}.` +
			(reported ? ` Stuck loops in other sessions: ${reported}.` : "") +
			(report.failed.length ? ` Failed: ${report.failed.length}.` : ""),
	);
	return `${lines.join("\n")}\n`;
}
