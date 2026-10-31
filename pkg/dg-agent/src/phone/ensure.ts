import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { DgCliError } from "@dg/common";
import { type DgPaths, ensurePrivateDir } from "@dg/common/node";
import { adoptListenerPid, listenerLogPath, listenerPidPath, type ListenerPid } from "./listener";

export const ENSURE_LOCK_ATTEMPTS = 40;
export const ENSURE_LOCK_WAIT_MS = 25;
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
	sleep: (ms: number) => Promise<void>;
	isAlive: (pid: number) => boolean;
	verdict: (pid: number) => ListenerVerdict;
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
		return undefined;
	}
}

/** The pid recorded in `listener.pid`, including a dead one. Missing or unreadable files return undefined. */
export function readRecordedPid(paths: DgPaths): number | undefined {
	const path = listenerPidPath(paths);
	if (!existsSync(path)) return undefined;
	try {
		const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
		if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
		return pid;
	} catch {
		return undefined;
	}
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
			const holder = readLockPid(path);
			if (holder !== undefined && !deps.isAlive(holder)) {
				rmSync(path, { force: true });
				continue;
			}
			await deps.sleep(ENSURE_LOCK_WAIT_MS);
		}
	}
	throw new DgCliError("phone open --ensure is already running");
}

function shouldStart(pid: number | undefined, deps: EnsureDeps): boolean {
	if (pid === undefined || !deps.isAlive(pid)) return true;
	return deps.verdict(pid) === "foreign";
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

/** Crontab line that runs `phone open --ensure`. `$RANDOM` jitters each run. The marker is how a later install finds its own line. */
export function ensureCronLine(argv: string[], dgHome?: string): string {
	const command = argv.map(shQuote).join(" ");
	const env = dgHome ? `DG_HOME=${shQuote(dgHome)} ` : "";
	return `*/5 * * * * sleep $((RANDOM % ${CRON_JITTER_SECONDS})); ${env}${command} >/dev/null 2>&1 # ${CRON_MARKER}`;
}

/** Argv for the cron line: the same binary `listenerArgv` would run, but `phone open --ensure` instead of `phone __run`. */
export function openEnsureArgv(listenerArgv: (extra: string[]) => string[]): string[] {
	const sample = listenerArgv([]);
	const at = sample.lastIndexOf("phone");
	const prefix = at === -1 ? [] : sample.slice(0, at);
	return [...prefix, "phone", "open", "--ensure"];
}

/** Drops earlier dg-phone ensure lines and appends `line`. Every other crontab row stays. */
export function mergeCrontab(current: string, line: string): string {
	const kept = current.split("\n").filter((row) => row.trim().length > 0 && !row.includes(CRON_MARKER));
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
	const next = mergeCrontab(listed.code === 0 ? listed.stdout : "", line);
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
