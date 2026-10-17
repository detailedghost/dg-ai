import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

/** Detect WSL from its environment marker or Linux kernel version; unreadable kernel metadata returns false. */
export function isWSL(): boolean {
	if (process.env.WSL_DISTRO_NAME) return true;
	if (process.platform !== "linux") return false;
	try {
		return readFileSync("/proc/version", "utf8")
			.toLowerCase()
			.includes("microsoft");
	} catch {
		return false;
	}
}

function openers(): Array<[string, (url: string) => string[]]> {
	if (process.platform === "darwin") return [["open", (u) => [u]]];
	if (isWSL()) {
		return [
			["wslview", (u) => [u]],
			[
				"powershell.exe",
				(u) => [
					"-NoProfile",
					"-Command",
					`Start-Process '${u.replace(/'/g, "''")}'`,
				],
			],
			["cmd.exe", (u) => ["/c", "start", "", u]],
		];
	}
	return [["xdg-open", (u) => [u]]];
}

/** Try platform URL launchers in order; true means a launcher spawned, not that the page loaded. */
export function tryOpen(url: string): Promise<boolean> {
	const candidates = openers();
	return new Promise((resolve) => {
		const attempt = (i: number) => {
			if (i >= candidates.length) return resolve(false);
			const [cmd, build] = candidates[i];
			const child = spawn(cmd, build(url), { stdio: "ignore", detached: true });
			child.on("error", () => attempt(i + 1));
			child.on("spawn", () => {
				child.unref();
				resolve(true);
			});
		};
		attempt(0);
	});
}

/** Run argv synchronously, returning trimmed UTF-8 stdout and throwing on startup or command failure. */
export function run(
	command: string,
	args: string[],
	options: { cwd?: string } = {},
): string {
	const r = spawnSync(command, args, { encoding: "utf8", cwd: options.cwd });
	if (r.error) {
		throw new Error(
			`${command} not found or failed to start: ${r.error.message}`,
		);
	}
	if (r.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed: ${r.stderr || r.stdout}`,
		);
	}
	return r.stdout.trim();
}

type RunCaptureOptions = {
	/** Null ignores stdin; undefined retains the default closed pipe. */
	stdin?: string | null;
	cwd?: string;
	timeoutMs?: number;
};

type RunCaptureResult<Output = string> = {
	status: number;
	signal: NodeJS.Signals | null;
	stdout: Output;
	stderr: Output;
};

/** Collect untrimmed UTF-8 streams and exit/signal status; startup errors reject instead of returning a status. */
export async function runCapture(
	command: string,
	args: string[],
	options: RunCaptureOptions = {},
): Promise<RunCaptureResult> {
	const result = await runCaptureBytes(command, args, options);
	return {
		...result,
		stdout: result.stdout.toString("utf8"),
		stderr: result.stderr.toString("utf8"),
	};
}

/**
 * Capture exact bytes and signal-derived status; startup errors reject and nonzero exits resolve.
 * Null stdin ignores input, undefined closes an empty pipe, and a string supplies its exact contents.
 */
export function runCaptureBytes(
	command: string,
	args: string[],
	options: RunCaptureOptions = {},
): Promise<RunCaptureResult<Buffer>> {
	return new Promise((resolve, reject) => {
		const captureOptions = {
			cwd: options.cwd,
			timeout: options.timeoutMs,
			killSignal: "SIGKILL" as const,
		};
		const child =
			options.stdin === null
				? spawn(command, args, {
						...captureOptions,
						stdio: ["ignore", "pipe", "pipe"],
					})
				: spawn(command, args, { ...captureOptions, stdio: "pipe" });
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => {
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
		});
		child.on("error", reject);
		child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
			const status =
				code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0);
			const out = Buffer.concat(stdout);
			const err = Buffer.concat(stderr);
			resolve({
				status,
				signal,
				stdout: out,
				stderr: err,
			});
		});
		child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code !== "EPIPE") reject(error);
		});
		try {
			if (typeof options.stdin === "string") child.stdin?.write(options.stdin);
			child.stdin?.end();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error);
		}
	});
}

/** Wait for stdout to accept the text, propagating write errors. */
export function writeStdout(value: string): Promise<void> {
	return new Promise((resolve, reject) => {
		process.stdout.write(value, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

/** Reads stdin, abandoning it the moment it passes the cap; undefined means it did. */
export async function readCappedStdin(
	capBytes: number,
): Promise<string | undefined> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = Bun.stdin.stream().getReader();
	try {
		for (
			let next = await reader.read();
			!next.done;
			next = await reader.read()
		) {
			total += next.value.byteLength;
			if (total > capBytes) return undefined;
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

type KillSeams = {
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	exec?: (command: string, args: string[]) => void;
};

/** True when the pid exists; EPERM counts because the process is alive but not ours. */
export function isAlive(
	pid: number,
	signal: (pid: number, signal: 0) => void = process.kill.bind(process),
): boolean {
	try {
		signal(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Kills a process and its children; on POSIX tries the group (-pid) before the pid. */
export function killProcessTree(
	pid: number,
	{
		platform = process.platform,
		kill = process.kill.bind(process),
		exec = (command, args) => {
			spawnSync(command, args, { stdio: "ignore", windowsHide: true });
		},
	}: KillSeams = {},
): void {
	if (platform === "win32") {
		exec("taskkill", ["/T", "/F", "/PID", String(Math.trunc(pid))]);
		return;
	}
	try {
		kill(-pid, "SIGKILL");
	} catch {
		try {
			kill(pid, "SIGKILL");
		} catch {
			return;
		}
	}
}
