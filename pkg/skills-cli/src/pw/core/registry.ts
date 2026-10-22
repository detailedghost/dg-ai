import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { cwdHash, scratchRoot } from "@dg/common/node";
import { ensurePrivateDir } from "./files";
import { call } from "./socket";
import { closeWindowsBrowser } from "./windows";

export const BROWSERS = ["chrome", "chromium", "msedge", "firefox", "webkit"] as const;

export type BrowserName = (typeof BROWSERS)[number];

export type SessionRecord = {
	name: string;
	key: string;
	pid: number;
	socketPath: string;
	cwd: string;
	outputDir: string;
	mode: "local" | "cdp";
	browser: BrowserName;
	headless: boolean;
	scratch: boolean;
	codegen: boolean;
	snapshotDepth?: number;
	profileDir: string | null;
	cdpUrl?: string;
	winPid?: number;
	startedAt: string;
};

type RuntimeDir = "sessions" | "sock" | "log";

export function runtimeDir(kind: RuntimeDir): string {
	const dir = path.join(scratchRoot(), "pw", kind);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

export const sessionKey = ({ name, scratch }: { name: string; scratch: boolean }): string =>
	scratch ? `${name}@${cwdHash()}` : name;

export const recordPath = (key: string): string => path.join(runtimeDir("sessions"), `${key}.json`);
export const socketPathFor = (key: string): string => path.join(runtimeDir("sock"), `${key}.sock`);
export const logPathFor = (key: string): string => path.join(runtimeDir("log"), `${key}.err`);

export function defaultOutputDir(): string {
	const dir = path.join(scratchRoot(), "pw", cwdHash());
	ensurePrivateDir(dir);
	return dir;
}

/** The hidden `pw` verb a self-reexecuted daemon process is invoked with; never registered in help. */
export const DAEMON_VERB = "__daemon";

/**
 * Matches only a cmdline ending in `pw __daemon {...}`; anchoring on the trailing JSON argument keeps
 * an unrelated dg-skills process (another subcommand, or a string literal containing this text) from
 * matching the blind `pkill -f` sweep in kill-all. The JSON `key` check in {@link isDaemonOf} is the
 * real per-process gate; this regex is only the fast filter shared with that sweep.
 */
export const DAEMON_PATTERN = `pw ${DAEMON_VERB} \\{.*\\}$`;

const daemonPattern = new RegExp(DAEMON_PATTERN);

export type WindowsSession = SessionRecord & { mode: "cdp"; winPid: number; profileDir: string };

export const isWindowsSession = (record: SessionRecord): record is WindowsSession =>
	record.mode === "cdp" && record.winPid !== undefined && record.profileDir !== null;

export function readCmdline(pid: number): string[] | null {
	try {
		const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
		if (args.at(-1) === "") args.pop();
		return args;
	} catch {
		return null;
	}
}

export function isDaemonOf(
	record: Pick<SessionRecord, "pid" | "key">,
	cmdline: string[] | null = readCmdline(record.pid),
): boolean {
	if (!cmdline || !daemonPattern.test(cmdline.join(" "))) return false;
	try {
		return (JSON.parse(cmdline.at(-1) ?? "") as { key?: unknown }).key === record.key;
	} catch {
		return false;
	}
}

export const isLive = (record: SessionRecord): boolean => isAlive(record.pid) && isDaemonOf(record);

export function signalDaemon(record: SessionRecord, signal: NodeJS.Signals): void {
	if (isDaemonOf(record)) signalPid(record.pid, signal);
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function read(key: string): SessionRecord | null {
	const file = recordPath(key);
	if (!existsSync(file)) return null;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
	} catch {
		rmSync(file, { force: true });
		return null;
	}
}

export function write(record: SessionRecord): void {
	writeFileSync(recordPath(record.key), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function remove(key: string): void {
	rmSync(recordPath(key), { force: true });
	rmSync(socketPathFor(key), { force: true });
}

export function touch(key: string): void {
	const now = new Date();
	try {
		utimesSync(recordPath(key), now, now);
	} catch {
		return;
	}
}

export function readAll(): SessionRecord[] {
	const records: SessionRecord[] = [];
	for (const file of readdirSync(runtimeDir("sessions"))) {
		if (!file.endsWith(".json")) continue;
		const record = read(file.slice(0, -".json".length));
		if (record) records.push(record);
	}
	return records.sort((a, b) => a.key.localeCompare(b.key));
}

function dropStale(record: SessionRecord): void {
	if (!isWindowsSession(record)) remove(record.key);
}

export function list(): SessionRecord[] {
	const live: SessionRecord[] = [];
	for (const record of readAll()) {
		if (isLive(record)) live.push(record);
		else dropStale(record);
	}
	return live;
}

export async function reapStale(
	closeBrowser: (profileDir: string) => Promise<unknown> = closeWindowsBrowser,
): Promise<void> {
	const records = readAll();
	const live = records.filter(isLive);
	for (const record of records) {
		if (live.includes(record)) continue;
		if (isWindowsSession(record) && !live.some((other) => other.profileDir === record.profileDir)) {
			await closeBrowser(record.profileDir).catch(() => undefined);
		}
		remove(record.key);
	}
}

export function resolve(name: string): SessionRecord | null {
	for (const key of [sessionKey({ name, scratch: true }), name]) {
		const record = read(key);
		if (!record) continue;
		if (isLive(record)) return record;
		dropStale(record);
	}
	return null;
}

export function signalPid(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		return;
	}
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isAlive(pid)) return true;
		await Bun.sleep(50);
	}
	return !isAlive(pid);
}

export type StopOptions = {
	graceMs?: number;
	termMs?: number;
	closeBrowser?: (profileDir: string) => Promise<unknown>;
};

export async function stopSession(
	record: SessionRecord,
	{ graceMs = 15_000, termMs = 5_000, closeBrowser = closeWindowsBrowser }: StopOptions = {},
): Promise<void> {
	await call(record, { id: "stop", method: "stop" }, 5_000).catch(() => undefined);
	if (!(await waitForExit(record.pid, graceMs))) {
		signalDaemon(record, "SIGTERM");
		if (!(await waitForExit(record.pid, termMs))) signalDaemon(record, "SIGKILL");
		if (isWindowsSession(record)) await closeBrowser(record.profileDir).catch(() => undefined);
	}
	remove(record.key);
}
