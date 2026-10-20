import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { isAlive, isWSL } from "@dg/common/node";
import { astroDir, STALE_LOCK_MS, vizConfig } from "./config";
import { die, note } from "./io";

const BUN_MISSING =
	"Bun is required to run the viz viewer but was not found on PATH — install it from https://bun.sh and run the command again";

function requireBun(): string {
	return Bun.which("bun") ?? die(BUN_MISSING);
}

export async function portInUse(): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${vizConfig().port}/`, {
			signal: AbortSignal.timeout(1000),
		});
		return true;
	} catch {
		return false;
	}
}

interface ServerMeta {
	vizDir: string;
	port: number;
	pid: number;
}

/** The identity the server on VIZ_PORT reports, or null when unreachable or malformed. */
export async function fetchServerMeta(): Promise<ServerMeta | null> {
	const { port } = vizConfig();
	try {
		const res = await fetch(`http://127.0.0.1:${port}/api/_meta`, {
			signal: AbortSignal.timeout(1500),
		});
		if (!res.ok) return null;
		const data = (await res.json()) as Partial<ServerMeta>;
		if (typeof data.vizDir !== "string") return null;
		return {
			vizDir: data.vizDir,
			port: typeof data.port === "number" ? data.port : port,
			pid: typeof data.pid === "number" ? data.pid : -1,
		};
	} catch {
		return null;
	}
}

export async function serverIdentityMatches(): Promise<boolean> {
	const meta = await fetchServerMeta();
	if (!meta) return false;
	return resolvePath(meta.vizDir) === resolvePath(vizConfig().vizDir);
}

export function tryAcquireLock(): boolean {
	try {
		const fd = openSync(vizConfig().lock, "wx");
		writeSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

export function releaseLock(): void {
	try {
		unlinkSync(vizConfig().lock);
	} catch {
		return;
	}
}

function pidIsAlive(pid: number): boolean {
	return Number.isInteger(pid) && pid > 0 && isAlive(pid);
}

/** True when the lock is old and its owner pid is dead. */
export function lockIsStale(): boolean {
	const { lock } = vizConfig();
	let mtimeMs: number;
	try {
		mtimeMs = statSync(lock).mtimeMs;
	} catch {
		return true;
	}
	if (Date.now() - mtimeMs <= STALE_LOCK_MS) return false;

	let ownerPid: number | undefined;
	try {
		ownerPid = parseInt(readFileSync(lock, "utf-8").trim(), 10);
	} catch {
		ownerPid = undefined;
	}
	if (ownerPid !== undefined && pidIsAlive(ownerPid)) return false;
	return true;
}

function touchLock(): void {
	try {
		const now = new Date();
		utimesSync(vizConfig().lock, now, now);
	} catch {
		return;
	}
}

export async function waitForPort(label: string): Promise<void> {
	process.stderr.write(label);
	for (let i = 0; i < 30; i++) {
		await Bun.sleep(500);
		if (await portInUse()) {
			process.stderr.write(" ready\n");
			return;
		}
		process.stderr.write(".");
	}
	process.stderr.write("\n");
}

function writePidFileAtomic(pid: number): void {
	const { pidFile } = vizConfig();
	const tmp = `${pidFile}.${process.pid}.tmp`;
	const fd = openSync(tmp, "w");
	writeSync(fd, String(pid));
	closeSync(fd);
	renameSync(tmp, pidFile);
}

const INSTALL_MARKER = "node_modules/.dg-install-ok";
const INSTALL_WAIT_MS = 120_000;

function tryAcquireInstallLock(path: string): boolean {
	try {
		const fd = openSync(path, "wx");
		writeSync(fd, String(process.pid));
		closeSync(fd);
		return true;
	} catch {
		return false;
	}
}

function installLockIsStale(path: string): boolean {
	try {
		const ownerPid = parseInt(readFileSync(path, "utf-8").trim(), 10);
		return !pidIsAlive(ownerPid);
	} catch {
		return true;
	}
}

export function dependencyHash(dir: string): string {
	const hash = createHash("sha256");
	for (const name of ["package.json", "bun.lock"]) {
		const file = `${dir}/${name}`;
		hash.update(existsSync(file) ? readFileSync(file) : "");
		hash.update("\0");
	}
	return hash.digest("hex");
}

function installIsCurrent(marker: string, hash: string): boolean {
	try {
		return readFileSync(marker, "utf-8") === hash;
	} catch {
		return false;
	}
}

async function installDependencies(dir: string): Promise<void> {
	const marker = `${dir}/${INSTALL_MARKER}`;
	const hash = dependencyHash(dir);
	if (installIsCurrent(marker, hash)) return;
	try {
		accessSync(dir, constants.W_OK);
	} catch {
		die(
			`cannot install Astro dependencies — ${dir} is not writable; set VIZ_SKILL_DIR to a writable copy of the viz skill directory`,
		);
	}
	const bun = requireBun();
	const lockPath = `${dir}/.dg-install.lock`;
	const deadline = Date.now() + INSTALL_WAIT_MS;

	while (!installIsCurrent(marker, hash)) {
		if (!tryAcquireInstallLock(lockPath)) {
			if (installLockIsStale(lockPath)) rmSync(lockPath, { force: true });
			else if (Date.now() > deadline)
				die(`bun install did not finish — check ${dir}`);
			else await Bun.sleep(200);
			continue;
		}
		try {
			if (installIsCurrent(marker, hash)) return;
			note("installing Astro dependencies (one-time)...");
			const proc = Bun.spawn([bun, "install", "--frozen-lockfile", "--silent"], {
				cwd: dir,
				stdout: "inherit",
				stderr: "inherit",
			});
			if ((await proc.exited) !== 0) die(`bun install failed — check ${dir}`);
			writeFileSync(marker, hash);
		} finally {
			rmSync(lockPath, { force: true });
		}
	}
}

function refuseForeignServer(port: number, detail: string): never {
	return die(
		`another viz server is already running on :${port} serving a different VIZ_DIR — ${detail}\n` +
			`  fix: set a distinct VIZ_PORT for this session, or stop the other server first ` +
			`("dg-skills viz stop", with its own VIZ_PORT/VIZ_DIR set).`,
	);
}

/** Start the viewer once per VIZ_PORT, or reuse the one already serving this VIZ_DIR. */
export async function ensureServer(): Promise<void> {
	if (process.env.VIZ_NO_BROWSER === "1") return;

	const dir = astroDir();
	await installDependencies(dir);
	const { port, vizDir, log, lock } = vizConfig();

	if (await portInUse()) {
		if (await serverIdentityMatches()) return;
		refuseForeignServer(
			port,
			"refusing to reuse it (would silently serve the wrong session).",
		);
	}

	const bun = requireBun();

	for (let attempt = 0; attempt < 2; attempt++) {
		if (lockIsStale()) releaseLock();

		if (tryAcquireLock()) {
			let alreadyUp = false;
			let heartbeat: ReturnType<typeof setInterval> | undefined;
			try {
				alreadyUp = await portInUse();
				if (!alreadyUp) {
					mkdirSync(dirname(log), { recursive: true });
					const logFd = openSync(log, "a");
					const server = Bun.spawn(
						[bun, "run", "dev", "--port", String(port)],
						{
							cwd: dir,
							stdout: logFd,
							stderr: logFd,
							env: { ...process.env, VIZ_DIR: vizDir, VIZ_PORT: String(port) },
						},
					);
					writePidFileAtomic(server.pid);

					heartbeat = setInterval(
						touchLock,
						Math.floor(STALE_LOCK_MS / 3),
					);
					await waitForPort("[viz] starting server");
					if (!(await portInUse())) {
						throw new Error(
							`server on :${port} did not come up — check ${log}`,
						);
					}
				}
			} finally {
				clearInterval(heartbeat);
				releaseLock();
			}
			if (alreadyUp && !(await serverIdentityMatches()))
				refuseForeignServer(
					port,
					"refusing to reuse it (would silently serve the wrong session).",
				);
			return;
		}

		await waitForPort("[viz] waiting for server");
		if (await portInUse()) {
			if (await serverIdentityMatches()) return;
			refuseForeignServer(port, "refusing to reuse it.");
		}
		if (attempt === 0 && (lockIsStale() || !existsSync(lock))) {
			continue;
		}
		die(`server on :${port} did not come up — check ${log}`);
	}
}

/** Open the browser once per session; the page live-reloads so one tab stays current. */
export function openUrlOnce(slug: string, url: string): void {
	const marker = `${vizConfig().vizDir}/${slug}/.opened`;
	if (existsSync(marker)) return;
	try {
		closeSync(openSync(marker, "w"));
	} catch {
		openUrl(url);
		return;
	}
	openUrl(url);
}

/** The platform opener's id, or null for an unrecognized platform. */
export function detectOpener(): string | null {
	if (isWSL()) {
		return Bun.which("wslview") !== null ? "wslview" : "explorer";
	}
	if (process.platform === "darwin") return "open";
	if (process.platform === "linux") return "xdg-open";
	return null;
}

export function openUrl(url: string): void {
	if (process.env.VIZ_NO_BROWSER === "1") return;

	const opener = detectOpener();
	if (opener === "wslview") {
		Bun.spawn(["wslview", url]);
	} else if (opener === "explorer") {
		Bun.spawn(["/mnt/c/Windows/explorer.exe", url]);
	} else if (opener) {
		Bun.spawn([opener, url]);
	}
}

/** True only when the pid's cmdline confirms it is the viewer. */
export function verifyServerIdentity(pid: number): boolean {
	try {
		const raw = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
		const cmdline = raw.replace(/\0/g, " ").toLowerCase();
		return (
			cmdline.includes("astro") ||
			cmdline.includes("vite") ||
			cmdline.includes("bun")
		);
	} catch {
		return false;
	}
}

/** Stop an untracked viewer listener on VIZ_PORT. */
export async function stopOrphanListener(): Promise<boolean> {
	const { port } = vizConfig();
	const meta = await fetchServerMeta();
	if (!meta || meta.pid <= 0) return false;
	if (!verifyServerIdentity(meta.pid)) {
		note(
			`pid ${meta.pid} reported by :${port} does not look like our server (checked /proc/${meta.pid}/cmdline) — not killing`,
		);
		return false;
	}
	try {
		process.kill(meta.pid, "SIGTERM");
		note(
			`server :${port} stopped (pid ${meta.pid}, was an orphan untracked by PID file)`,
		);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ESRCH") {
			note(`could not stop pid ${meta.pid} (${code ?? err})`);
			return false;
		}
	}
	return true;
}

export function doStop(): void {
	const { pidFile, port } = vizConfig();
	if (!existsSync(pidFile)) return;
	const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
	if (Number.isNaN(pid)) {
		note("corrupt PID file — skipping stop");
		return;
	}

	if (pidIsAlive(pid) && !verifyServerIdentity(pid)) {
		note(
			`pid ${pid} in PID file does not look like our server (checked /proc/${pid}/cmdline) — ` +
				`treating as stale, not sending any signal`,
		);
		unlinkSync(pidFile);
		releaseLock();
		return;
	}

	try {
		process.kill(pid, "SIGTERM");
		note(`server :${port} stopped (pid ${pid})`);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") {
			note(`pid ${pid} already gone`);
		} else {
			note(`could not stop pid ${pid} (${code ?? err}) — leaving state as-is`);
			return;
		}
	}
	unlinkSync(pidFile);
	releaseLock();
}
