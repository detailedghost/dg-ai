import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

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

/** Ordered [command, argsBuilder] openers to try for this platform. */
export function openers(): Array<[string, (url: string) => string[]]> {
	if (process.platform === "darwin") return [["open", (u) => [u]]];
	if (isWSL()) {
		return [
			["wslview", (u) => [u]],
			[
				"powershell.exe",
				// Single-quote-escape the URL so it's passed as data, never as code.
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

/** Open a URL in the OS default browser; resolves false if every opener failed. */
export function tryOpen(url: string): Promise<boolean> {
	const candidates = openers();
	return new Promise((resolve) => {
		const attempt = (i: number) => {
			if (i >= candidates.length) return resolve(false);
			const [cmd, build] = candidates[i];
			const child = spawn(cmd, build(url), { stdio: "ignore", detached: true });
			child.on("error", () => attempt(i + 1)); // opener missing — try next
			child.on("spawn", () => {
				child.unref();
				resolve(true);
			});
		};
		attempt(0);
	});
}

export function run(command: string, args: string[]): string {
	const r = spawnSync(command, args, { encoding: "utf8" });
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

export type RunCaptureOptions = { stdin?: string };

export type RunCaptureResult = {
	status: number;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
};

/**
 * Like run(), but resolves non-zero statuses instead of throwing and keeps
 * stdout/stderr separate; it still rejects if the binary itself can't be
 * spawned, since that produces no exit code to branch on at all.
 */
export function runCapture(
	command: string,
	args: string[],
	options: RunCaptureOptions = {},
): Promise<RunCaptureResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: "pipe" });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			// 128+signum (POSIX shell convention) keeps a signal kill distinct from
			// a same-numbered real exit code; callers needing the signal name have `signal`.
			const status =
				code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0);
			resolve({ status, signal, stdout, stderr });
		});
		if (options.stdin !== undefined) child.stdin.write(options.stdin);
		child.stdin.end();
	});
}
