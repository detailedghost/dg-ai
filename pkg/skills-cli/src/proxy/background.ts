import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	isPathInside,
	randSuffix,
	scratchPath,
	statePath,
	stateRoot,
} from "@dg/common/node";
import { emitJson } from "../utils/json";
import { defineCommand, die, EXIT } from "../utils/legacy-command";
import { selfCommand, shellCommand } from "../utils/self-command";

type JobKind = "shell" | "proxy";

export interface JobMeta {
	id: string;
	command: string;
	cwd: string;
	startedAt: string;
	logFile: string;
	statusFile: string;
	pidFile: string;
	launcherPid: number;
	kind: JobKind;
	proxyBackend?: string;
}

interface JobState extends JobMeta {
	state: "running" | "done" | "unknown" | "cancelled";
	exitCode: number | null;
	pendingUpdate: string | null;
}

const cmd = defineCommand({
	name: "dg-skills proxy background",
	description: "Detached background-job primitive for the /bg skill.",
	subcommands: {
		run: {
			description: "Launch a command detached and print its job record",
			args: ["command", "[--cwd <dir>]"],
			run: cmdRun,
		},
		list: {
			description: "Print all known background jobs with derived state",
			run: cmdList,
		},
		prune: {
			description:
				"Remove finished jobs whose cwd is inside <dir> (both roots); reports live ones",
			args: ["--cwd <dir>"],
			run: cmdPrune,
		},
		status: {
			description: "Print one background job with derived state",
			args: ["id"],
			run: cmdStatus,
		},
		cancel: {
			description: "Terminate a running job (whole process group)",
			args: ["id"],
			run: (args) => withJobLock(args[0], () => cmdCancel(args)),
		},
		kill: {
			description: "Alias for cancel",
			args: ["id"],
			run: (args) => withJobLock(args[0], () => cmdCancel(args)),
		},
		update: {
			description: "Feed more context to a proxy/agentic job (resume or queue)",
			args: ["id", "context"],
			run: (args) => withJobLock(args[0], () => cmdUpdate(args)),
		},
		drain: {
			description: "Internal: apply a queued update once a proxy job finishes",
			args: ["id"],
			run: (args) => withJobLock(args[0], () => cmdDrain(args)),
		},
	},
});

/** Run packaged detached-job commands; cancellation and updates use ownership-checked job locks. */
export async function main(argv: string[]): Promise<void | number> {
	await cmd.run(argv);
}

async function withJobLock(
	id: string | undefined,
	run: () => Promise<void>,
): Promise<void> {
	if (!id) return run();
	const file = scratchPath("bg", `${id}.lock`, { cwdScope: false });
	const owner: LockOwner = {
		pid: process.pid,
		started: processIdentity(process.pid)?.started,
		nonce: randomUUID(),
	};
	const staging = `${file}.${owner.nonce}.tmp`;
	let staged = false;
	const deadline = Date.now() + 5000;
	try {
		mkdirSync(staging, { mode: 0o700 });
		staged = true;
		writeFileSync(
			path.join(staging, `${owner.nonce}.json`),
			JSON.stringify(owner),
			{ mode: 0o600 },
		);
		for (;;) {
			if (existsSync(file)) {
				const prior = readLockOwner(file);
				if (prior && lockOwnerIsStale(prior)) removeLockOwner(file, prior);
			}
			try {
				// Atomic publication can replace an abandoned empty directory, never a populated owner.
				renameSync(staging, file);
				staged = false;
				break;
			} catch (error) {
				if (!existsSync(file)) throw error;
			}
			if (Date.now() >= deadline)
				throw new Error(`Background job ${id} is busy; retry the operation`);
			await Bun.sleep(20);
		}
		try {
			await run();
		} finally {
			removeLockOwner(file, owner);
		}
	} finally {
		if (staged) rmSync(staging, { recursive: true, force: true });
	}
}

interface LockOwner {
	pid: number;
	started?: string;
	nonce: string;
}

function readLockOwner(dir: string): LockOwner | null {
	try {
		const files = readdirSync(dir);
		if (files.length !== 1) return null;
		const owner = JSON.parse(
			readFileSync(path.join(dir, files[0]), "utf8"),
		) as LockOwner;
		if (
			!Number.isSafeInteger(owner.pid) ||
			owner.pid <= 1 ||
			typeof owner.nonce !== "string" ||
			!/^[a-zA-Z0-9_-]+$/.test(owner.nonce) ||
			files[0] !== `${owner.nonce}.json` ||
			(owner.started !== undefined &&
				(typeof owner.started !== "string" || !owner.started))
		)
			return null;
		return owner;
	} catch {
		return null;
	}
}

function lockOwnerIsStale(owner: LockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
	const current = processIdentity(owner.pid);
	return !!(owner.started && current && owner.started !== current.started);
}

function removeLockOwner(dir: string, owner: LockOwner): void {
	try {
		const current = readLockOwner(dir);
		if (current?.nonce !== owner.nonce || current.pid !== owner.pid) return;
		// Nonce-specific removal and nonrecursive rmdir cannot erase a newer owner.
		unlinkSync(path.join(dir, `${owner.nonce}.json`));
		rmdirSync(dir);
	} catch (error) {
		if (
			!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
				(error as NodeJS.ErrnoException).code ?? "",
			)
		)
			throw error;
	}
}

// --- subcommands -----------------------------------------------------------

async function cmdRun(args: string[]): Promise<void> {
	const [cwdOverride, rest] = extractCwd(args);
	const command = rest.join(" ").trim();
	if (!command) die("usage: run <command> [--cwd <dir>]", EXIT.USAGE);
	emitJson(await launchJob(command, cwdOverride ?? process.cwd()));
}

async function cmdList(): Promise<void> {
	const dir = path.join(stateRoot(), "bg");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
	} catch {
		// no bg dir yet → no jobs launched
	}
	const jobs = files
		.map((f) =>
			deriveState(
				JSON.parse(readFileSync(path.join(dir, f), "utf8")) as JobMeta,
			),
		)
		.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
	emitJson({ jobs });
}

async function cmdPrune(args: string[]): Promise<void> {
	let target: string | undefined;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--cwd") {
			target = args[++i];
			continue;
		}
		die(`unknown prune flag: ${args[i]}`, EXIT.USAGE);
	}
	if (!target) die("usage: prune --cwd <dir>", EXIT.USAGE);

	const dir = path.join(stateRoot(), "bg");
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".meta.json"));
	} catch {
		// no bg dir yet → nothing to prune
	}

	const removed: string[] = [];
	const running: JobState[] = [];
	for (const f of files) {
		const meta = JSON.parse(readFileSync(path.join(dir, f), "utf8")) as JobMeta;
		if (!isPathInside(meta.cwd, target)) continue;
		const state = deriveState(meta);
		// A live job is left alone: its records are the only way to reach it, and
		// removing them would orphan the process with no handle to cancel it.
		if (state.state === "running") {
			running.push(state);
			continue;
		}
		for (const p of Object.values(jobPaths(meta.id))) {
			rmSync(p, { force: true });
		}
		removed.push(meta.id);
	}
	emitJson({ prunedCwd: target, removed, running });
}

async function cmdStatus(args: string[]): Promise<void> {
	const meta = loadMeta(args[0]);
	if (!meta) die(`unknown job: ${args[0]}`, EXIT.ERR);
	emitJson(deriveState(meta));
}

async function cmdCancel(args: string[]): Promise<void> {
	const id = args[0];
	if (!id) die("usage: cancel <id>", EXIT.USAGE);

	const meta = loadMeta(id);
	if (!meta) {
		// Unknown id is a graceful no-op, not an error.
		process.stderr.write(`bg: no such job: ${id}\n`);
		emitJson({ id, action: "cancel", result: "unknown" });
		return;
	}

	const state = deriveState(meta);
	if (state.state !== "running") {
		process.stderr.write(
			`bg: job ${id} is already ${state.state}; nothing to cancel.\n`,
		);
		emitJson({
			id,
			action: "cancel",
			result: "already-finished",
			state: state.state,
		});
		return;
	}

	const pid = readPid(meta);
	if (pid === null) {
		process.stderr.write(
			`bg: job ${id} has no recorded pid; cannot signal it.\n`,
		);
		emitJson({ id, action: "cancel", result: "no-pid" });
		return;
	}

	const signal = terminateGroup(pid);
	writeFileSync(jobPaths(id).cancelledFile, new Date().toISOString());
	emitJson({ id, action: "cancel", result: "cancelled", signal });
}

async function cmdUpdate(args: string[]): Promise<void> {
	const id = args[0];
	const context = args.slice(1).join(" ").trim();
	if (!id) die("usage: update <id> <context>", EXIT.USAGE);
	if (!context)
		die("usage: update <id> <context> — context is required", EXIT.USAGE);

	const meta = loadMeta(id);
	if (!meta) die(`unknown job: ${id}`, EXIT.ERR);

	if (effectiveKind(meta) !== "proxy") {
		process.stderr.write(
			`bg: job ${id} is a plain shell job — there's no session to update. Cancel it and relaunch with the fuller task.\n`,
		);
		emitJson({ id, action: "update", result: "unsupported-shell" });
		return;
	}

	const state = deriveState(meta);
	if (state.state === "cancelled") {
		process.stderr.write(`bg: job ${id} was cancelled; not resuming.\n`);
		emitJson({ id, action: "update", result: "cancelled-job" });
		return;
	}

	if (state.state === "running") {
		// Can't resume a session mid-run; record the context and let the job's
		// completion hook (drain) resume with it once the current run finishes.
		const pending = appendPending(id, context);
		process.stderr.write(
			`bg: job ${id} still running — queued this context; the session resumes with it when the job finishes.\n`,
		);
		emitJson({
			id,
			action: "update",
			result: "queued",
			pendingUpdate: pending,
		});
		return;
	}

	emitJson({ id, action: "update", ...(await resumeSession(meta, context)) });
}

async function cmdDrain(args: string[]): Promise<void> {
	const id = args[0];
	const meta = id ? loadMeta(id) : null;
	if (!meta) {
		emitJson({ id, action: "drain", result: "unknown" });
		return;
	}
	const paths = jobPaths(id);

	if (existsSync(paths.cancelledFile)) {
		// A cancelled job's queued context is dropped, not resumed.
		rmSync(paths.pendingFile, { force: true });
		emitJson({ id, action: "drain", result: "cancelled" });
		return;
	}

	const pending = existsSync(paths.pendingFile)
		? readFileSync(paths.pendingFile, "utf8").trim()
		: "";
	if (!pending) {
		emitJson({ id, action: "drain", result: "nothing-pending" });
		return;
	}

	emitJson({ id, action: "drain", ...(await resumeSession(meta, "")) });
}

// --- launch ----------------------------------------------------------------

async function launchJob(
	command: string,
	cwd: string,
	backend?: string,
): Promise<JobState> {
	const id = `${Date.now()}-${randSuffix()}`;
	const paths = jobPaths(id);
	const proxyBackend = backend ?? parseProxyBackend(command);
	const kind: JobKind = proxyBackend ? "proxy" : detectKind(command);
	// The gate keeps even an immediately finishing command behind durable metadata.
	const child = spawn(
		"sh",
		["-c", `read -r gate || exit 1; ${buildInner(command, paths, kind, id)}`],
		{
			cwd,
			detached: true,
			stdio: ["pipe", "ignore", "ignore"],
		},
	);
	await new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	const pid = child.pid;
	if (!pid || pid <= 1 || pid === process.pid || pid === process.ppid) {
		child.stdin?.destroy();
		throw new Error("Could not establish a detached background process");
	}
	const meta: JobMeta = {
		id,
		command,
		cwd,
		startedAt: new Date().toISOString(),
		logFile: paths.logFile,
		statusFile: paths.statusFile,
		pidFile: paths.pidFile,
		launcherPid: pid,
		kind,
		proxyBackend,
	};
	try {
		const identity = processIdentity(pid);
		if (process.platform === "linux" && (!identity || identity.group !== pid))
			throw new Error(
				"Could not establish the detached background process identity",
			);
		writeFileSync(paths.metaFile, JSON.stringify(meta, null, 2));
		writeFileSync(
			paths.identityFile,
			JSON.stringify({ pid, started: identity?.started }),
		);
		// A pid becomes usable only after its identity has been published.
		writeFileSync(paths.pidFile, String(pid));
		await new Promise<void>((resolve, reject) => {
			if (!child.stdin)
				return reject(new Error("Background launch gate is unavailable"));
			child.stdin.once("error", reject);
			child.stdin.end("ready\n", resolve);
		});
	} catch (error) {
		child.stdin?.destroy();
		child.kill();
		throw error;
	}
	child.unref();
	return { ...meta, state: "running", exitCode: null, pendingUpdate: null };
}

function buildInner(
	command: string,
	paths: JobPaths,
	kind: JobKind,
	id: string,
): string {
	const base = `( ${command} ) > ${sq(paths.logFile)} 2>&1; printf '%s' "$?" > ${sq(paths.statusFile)}`;
	if (kind !== "proxy") return base;
	const drain = shellCommand(selfCommand(["proxy", "background", "drain", id]));
	return `${base}; ${drain} > /dev/null 2>&1 || true`;
}

// --- resume ----------------------------------------------------------------

async function resumeSession(
	meta: JobMeta,
	extraContext: string,
): Promise<Record<string, unknown>> {
	const paths = jobPaths(meta.id);
	const backend = meta.proxyBackend ?? parseProxyBackend(meta.command);
	const sessionId = extractSessionId(meta.logFile);
	const queued = existsSync(paths.pendingFile)
		? readFileSync(paths.pendingFile, "utf8").trim()
		: "";
	const prompt = [queued, extraContext].filter(Boolean).join("\n");

	if (!backend)
		return {
			result: "no-backend",
			message: "could not determine the proxy backend from the job command",
		};
	if (!sessionId)
		return {
			result: "no-session",
			message: "no backend sessionId found in the job log; nothing to resume",
		};
	if (!prompt)
		return { result: "nothing-to-send", message: "no context to resume with" };

	const args = [backend, "--resume", sessionId, "--prompt", prompt];
	const resumeCmd = shellCommand(
		process.env.BG_PROXY_HELPER
			? [process.env.BG_PROXY_HELPER, ...args]
			: selfCommand(["proxy", ...args]),
	);
	const job = await launchJob(resumeCmd, meta.cwd, backend);
	rmSync(paths.pendingFile, { force: true });
	return {
		result: "resumed",
		sessionId,
		backend,
		newJobId: job.id,
		newJobLog: job.logFile,
	};
}

function extractSessionId(logFile: string): string | null {
	let text = "";
	try {
		text = readFileSync(logFile, "utf8");
	} catch {
		return null;
	}
	const lines = text.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (!line.startsWith("{")) continue;
		try {
			const obj = JSON.parse(line) as { sessionId?: unknown };
			if (typeof obj.sessionId === "string" && obj.sessionId)
				return obj.sessionId;
		} catch {
			// not a JSON line → keep scanning
		}
	}
	return null;
}

// --- state derivation ------------------------------------------------------

function deriveState(meta: JobMeta): JobState {
	const paths = jobPaths(meta.id);
	const pendingUpdate = existsSync(paths.pendingFile)
		? readFileSync(paths.pendingFile, "utf8").trim() || null
		: null;
	const base = { ...meta, pendingUpdate };

	if (existsSync(paths.cancelledFile))
		return { ...base, state: "cancelled", exitCode: null };
	if (existsSync(paths.statusFile)) {
		const raw = readFileSync(paths.statusFile, "utf8").trim();
		const code = raw === "" ? Number.NaN : Number.parseInt(raw, 10);
		return {
			...base,
			state: "done",
			exitCode: Number.isNaN(code) ? null : code,
		};
	}
	const pid = readPid(meta);
	if (pid !== null && isAlive(pid))
		return { ...base, state: "running", exitCode: null };
	return { ...base, state: "unknown", exitCode: null };
}

// Durable launcherPid is deliberately never a fallback: rebooted pids can be reused.
export function readPid(meta: JobMeta): number | null {
	try {
		const raw = readFileSync(meta.pidFile, "utf8").trim();
		if (!/^[0-9]+$/.test(raw)) return null;
		const pid = Number(raw);
		if (
			!Number.isSafeInteger(pid) ||
			pid <= 1 ||
			pid === process.pid ||
			pid === process.ppid
		)
			return null;
		const identityFile = jobPaths(meta.id).identityFile;
		const recorded = JSON.parse(readFileSync(identityFile, "utf8")) as {
			pid: number;
			started?: string;
		};
		if (recorded.pid !== pid) return null;
		if (
			recorded.started !== undefined &&
			(typeof recorded.started !== "string" ||
				!/^[0-9]+$/.test(recorded.started))
		)
			return null;
		if (!recorded.started || recorded.started !== processIdentity(pid)?.started)
			return null;
		return pid;
	} catch {
		return null;
	}
}

function processIdentity(
	pid: number,
): { group: number; started: string } | null {
	if (process.platform !== "linux") return null;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const group = Number(fields[2]);
		const started = fields[19];
		if (
			!Number.isSafeInteger(group) ||
			group <= 0 ||
			!/^[0-9]+$/.test(started ?? "")
		)
			return null;
		return { group, started };
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH → gone; EPERM → alive but not ours (still counts as running)
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function terminateGroup(pid: number): string {
	const identity = processIdentity(pid);
	if (
		pid <= 1 ||
		pid === process.pid ||
		pid === process.ppid ||
		!identity ||
		identity.group !== pid ||
		identity.group === processIdentity(process.pid)?.group
	) {
		throw new Error(
			"Refusing to signal a process without its own detached process group",
		);
	}
	try {
		process.kill(-pid, "SIGTERM");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ESRCH") return "none";
	}

	const termDeadline = Date.now() + 2000;
	while (Date.now() < termDeadline) {
		if (!isAlive(-pid)) return "SIGTERM";
		Bun.sleepSync(50);
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// group already gone between the poll and the escalation
	}
	return "SIGKILL";
}

// --- job kind + paths ------------------------------------------------------

function detectKind(command: string): JobKind {
	return parseProxyBackend(command) ? "proxy" : "shell";
}

function effectiveKind(meta: JobMeta): JobKind {
	return meta.kind ?? detectKind(meta.command);
}

function parseProxyBackend(command: string): string | undefined {
	// Only identify command words; quoted prompt text must not classify a shell job.
	const words = shellWords(command);
	const backends = new Set([
		"codex",
		"copilot",
		"pi",
		"opencode",
		"cortex",
		"grok",
	]);
	for (let i = 0; i < words.length - 1; i++) {
		if (
			path.basename(words[i]).match(/^proxy-helper(?:\.sh)?$/) &&
			backends.has(words[i + 1])
		)
			return words[i + 1];
		if (
			words[i] === "proxy" &&
			backends.has(words[i + 1]) &&
			i > 0 &&
			(/^(?:dg-skills(?:\.exe)?|bun(?:\.exe)?)$/.test(
				path.basename(words[0]),
			) ||
				/\.[cm]?[jt]s$/.test(words[i - 1]) ||
				words[0] === process.execPath)
		)
			return words[i + 1];
	}
	return undefined;
}

function shellWords(command: string): string[] {
	const words: string[] = [];
	let word = "";
	let quote = "";
	let active = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (char === "\\" && quote !== "'") {
			word += command[++i] ?? "";
			active = true;
		} else if (quote) {
			if (char === quote) quote = "";
			else word += char;
			active = true;
		} else if (char === "'" || char === '"') {
			quote = char;
			active = true;
		} else if (/\s/.test(char)) {
			if (active) words.push(word);
			word = "";
			active = false;
		} else if (/[;|&()<>]/.test(char)) break;
		else {
			word += char;
			active = true;
		}
	}
	if (active) words.push(word);
	return words;
}

interface JobPaths {
	logFile: string;
	statusFile: string;
	pidFile: string;
	metaFile: string;
	pendingFile: string;
	cancelledFile: string;
	identityFile: string;
}

function jobPaths(id: string): JobPaths {
	const p = (suffix: string) =>
		statePath("bg", `${id}.${suffix}`, { cwdScope: false });
	// pid stays ephemeral: a pid surviving a reboot can be recycled and read as "running".
	const ephemeral = (suffix: string) =>
		scratchPath("bg", `${id}.${suffix}`, { cwdScope: false });
	return {
		logFile: p("log"),
		statusFile: p("status"),
		pidFile: ephemeral("pid"),
		identityFile: ephemeral("identity.json"),
		metaFile: p("meta.json"),
		pendingFile: p("pending"),
		cancelledFile: p("cancelled"),
	};
}

function loadMeta(id: string | undefined): JobMeta | null {
	if (!id) return null;
	const metaFile = jobPaths(id).metaFile;
	if (!existsSync(metaFile)) return null;
	return JSON.parse(readFileSync(metaFile, "utf8")) as JobMeta;
}

function appendPending(id: string, context: string): string {
	const file = jobPaths(id).pendingFile;
	appendFileSync(file, `${context}\n`);
	return readFileSync(file, "utf8").trim();
}

// --- arg helpers -----------------------------------------------------------

function extractCwd(args: string[]): [string | undefined, string[]] {
	const idx = args.indexOf("--cwd");
	if (idx === -1) return [undefined, args];
	const dir = args[idx + 1];
	if (!dir || dir.startsWith("-"))
		die("--cwd requires a directory argument", EXIT.USAGE);
	return [dir, args.filter((_, i) => i !== idx && i !== idx + 1)];
}

function sq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
