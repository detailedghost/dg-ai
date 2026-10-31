import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir } from "@dg/common/node";
import { adoptListenerPid, isListenerArgs, listenerCommandArgs, listenerLogPath, listenerPidPath, type ListenerPid } from "./listener";

export const ENSURE_LOCK_ATTEMPTS = 40;
export const ENSURE_LOCK_WAIT_MS = 25;
/** A lock older than this is not a live ensure, even when its pid is still alive. */
export const ENSURE_LOCK_MAX_AGE_MS = 15_000;
export const CRON_MARKER = "dg-phone-ensure";
export const CRON_JITTER_SECONDS = 60;

export type ListenerVerdict = "ours" | "foreign" | "unknown";

export type CrontabIO = {
	list: () => Promise<{ code: number; stdout: string; stderr: string }>;
	replace: (text: string) => Promise<{ code: number; stdout: string; stderr: string }>;
};

export type EnsureDeps = {
	paths: DgPaths;
	now: () => number;
	nowMs: () => number;
	sleep: (ms: number) => Promise<void>;
	isAlive: (pid: number) => boolean;
	verdict: (pid: number) => ListenerVerdict;
	/** True when this pid is our dg-agent. False when it is some other program. Undefined when the command line cannot be read. */
	ownsProcess: (pid: number) => boolean | undefined;
	argv: string[];
	hook: ListenerPid["hook"];
	spawnListener: (argv: string[], logPath: string) => number;
};

export function ensureLockPath(paths: DgPaths): string {
	return join(paths.phoneRoot, "ensure.lock");
}

function readLockPid(path: string): number | undefined {
	try {
		const pid = Number(readFileSync(path, "utf8").trim());
		if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
		return pid;
	} catch {
		// Stryker disable next-line all
		return undefined;
	}
}

/** The pid recorded in `listener.pid`, including a dead one. Missing or unreadable files return undefined. */
export function readRecordedPid(paths: DgPaths): number | undefined {
	const path = listenerPidPath(paths);
	try {
		if (!existsSync(path)) return undefined;
		const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
		if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
		return pid as number;
	} catch {
		// Stryker disable next-line all
		return undefined;
	}
}

function lockAgeMs(path: string, nowMs: number): number {
	try {
		return nowMs - statSync(path).mtimeMs;
	} catch {
		return ENSURE_LOCK_MAX_AGE_MS;
	}
}

/** Empty, dead, reused by another program, or older than the max age. A young lock held by our own process is kept. */
export function ensureLockStale(path: string, deps: Pick<EnsureDeps, "isAlive" | "nowMs" | "ownsProcess">): boolean {
	const holder = readLockPid(path);
	if (holder === undefined || !deps.isAlive(holder)) return true;
	const owns = deps.ownsProcess(holder);
	if (owns === false) return true;
	return lockAgeMs(path, deps.nowMs()) >= ENSURE_LOCK_MAX_AGE_MS;
}

/** True when this command line is our binary, a phone listener, or `phone open`. */
export function commandOwnsEnsure(args: string[], binary: string | undefined): boolean {
	if (binary !== undefined && args.includes(binary)) return true;
	if (isListenerArgs(args)) return true;
	return args.includes("phone") && args.includes("open");
}

/** True when `pid`'s command line is this binary or a phone listener. Undefined when the command line cannot be read. */
export function ownsEnsureProcess(pid: number, binary: string | undefined): boolean | undefined {
	const args = listenerCommandArgs(pid);
	if (!args) return undefined;
	return commandOwnsEnsure(args, binary);
}

/** Start a listener when nothing live of ours is recorded. A live foreign pid is a reused pid and is replaced. */
export function shouldReplaceListener(pid: number | undefined, alive: boolean, who: ListenerVerdict): boolean {
	if (pid === undefined || !alive) return true;
	return who === "foreign";
}

async function acquireEnsureLock(deps: EnsureDeps): Promise<() => void> {
	ensurePrivateDir(deps.paths.phoneRoot);
	const path = ensureLockPath(deps.paths);
	for (let attempt = 0; attempt < ENSURE_LOCK_ATTEMPTS; attempt += 1) {
		try {
			const fd = openSync(path, "wx", 0o600);
			try {
				writeSync(fd, String(process.pid));
			} finally {
				closeSync(fd);
			}
			return () => {
				rmSync(path, { force: true });
			};
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			if (ensureLockStale(path, deps)) {
				rmSync(path, { force: true });
				continue;
			}
			await deps.sleep(ENSURE_LOCK_WAIT_MS);
		}
	}
	throw new DgCliError("phone open --ensure is already running");
}

function shouldStart(pid: number | undefined, deps: EnsureDeps): boolean {
	const alive = pid !== undefined && deps.isAlive(pid);
	const who = pid === undefined ? "unknown" : deps.verdict(pid);
	return shouldReplaceListener(pid, alive, who);
}

/**
 * Starts one detached listener when the pidfile is missing, dead, or a reused
 * pid that is not this binary. A live listener, or a live pid whose command
 * line cannot be read, is left alone. The lock is held across the check and
 * the spawn so two overlapping ensures cannot both start one.
 */
export async function ensureListener(deps: EnsureDeps): Promise<{ pid: number; status: "started" | "running" }> {
	const release = await acquireEnsureLock(deps);
	try {
		await deps.sleep(0);
		const current = readRecordedPid(deps.paths);
		if (!shouldStart(current, deps)) return { pid: current as number, status: "running" };
		const pid = deps.spawnListener(deps.argv, listenerLogPath(deps.paths));
		adoptListenerPid(deps.paths, { pid, since: deps.now(), hook: deps.hook });
		return { pid, status: "started" };
	} finally {
		release();
	}
}

export function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Marker for one home. Two DG_HOME values do not share a marker, so installing one does not remove the other. */
export function ensureMarker(dgHome?: string): string {
	return `${CRON_MARKER} home=${dgHome ?? ""}`;
}

/** POSIX sleep. `/bin/sh` on Debian is dash, which has no `$RANDOM`. One `/dev/urandom` byte-pair modulo the cap. */
export function cronJitterCommand(maxSeconds = CRON_JITTER_SECONDS): string {
	return `sleep $(( $(od -An -N2 -tu2 /dev/urandom) % ${maxSeconds} ))`;
}

/** Crontab line that runs `phone open --ensure`. The marker names the home so a later install replaces only that line. */
export function ensureCronLine(argv: string[], dgHome?: string): string {
	const command = argv.map(shQuote).join(" ");
	const env = dgHome ? `DG_HOME=${shQuote(dgHome)} ` : "";
	return `*/5 * * * * ${cronJitterCommand()}; ${env}${command} >/dev/null 2>&1 # ${ensureMarker(dgHome)}`;
}

/** Argv for the cron line: the same binary `listenerArgv` would run, but `phone open --ensure` instead of `phone __run`. */
export function openEnsureArgv(listenerArgv: (extra: string[]) => string[]): string[] {
	const sample = listenerArgv([]);
	const at = sample.lastIndexOf("phone");
	const prefix = at === -1 ? [] : sample.slice(0, at);
	return [...prefix, "phone", "open", "--ensure"];
}

/** Replaces lines that carry `marker` and appends `line`. Blank lines and other homes' markers stay. */
export function mergeCrontab(current: string, line: string, marker: string): string {
	const rows = current.split("\n");
	const kept: string[] = [];
	for (let index = 0; index < rows.length; index += 1) {
		const row = rows[index] ?? "";
		if (index === rows.length - 1 && row === "") continue;
		if (marker.length > 0 && row.includes(marker)) continue;
		kept.push(row);
	}
	kept.push(line);
	return `${kept.join("\n")}\n`;
}

function firstLine(text: string): string {
	return text.split("\n")[0]?.trim() ?? "";
}

function noCrontab(result: { stdout: string; stderr: string }): boolean {
	return /no crontab/i.test(result.stderr) || /no crontab/i.test(result.stdout);
}

/** Installs `line` into the user crontab. A missing crontab is an empty one. Any other `crontab -l` failure throws. */
export async function installCrontabLine(line: string, io: CrontabIO): Promise<void> {
	const listed = await io.list();
	if (listed.code !== 0 && !noCrontab(listed)) {
		throw new DgCliError(`crontab -l failed: ${firstLine(listed.stderr || listed.stdout) || `exit ${listed.code}`}`);
	}
	const markerAt = line.indexOf(CRON_MARKER);
	const marker = markerAt === -1 ? CRON_MARKER : line.slice(markerAt).trim();
	const next = mergeCrontab(listed.code === 0 ? listed.stdout : "", line, marker);
	const replaced = await io.replace(next);
	if (replaced.code !== 0) {
		throw new DgCliError(`crontab install failed: ${firstLine(replaced.stderr || replaced.stdout) || `exit ${replaced.code}`}`);
	}
}

// Stryker disable all
export function defaultCrontab(): CrontabIO {
	return {
		list: () => runPlain(["crontab", "-l"]),
		replace: (text) => runPlain(["crontab", "-"], text),
	};
}

async function runPlain(argv: string[], stdin?: string): Promise<{ code: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(argv, {
			stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { code: code ?? 1, stdout, stderr };
	} catch (err) {
		return { code: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
	}
}
// Stryker restore all
