import type { CommandResult, CommandRunner } from "./types";

export const COMMAND_TIMEOUT_MS = 30_000;
export const OUTPUT_CAP_BYTES = 1024 * 1024;
export const TIMED_OUT_STATUS = 124;
export const DRAIN_AFTER_KILL_MS = 1000;
const TRUNCATED_NOTE = "\n[output truncated]\n";

export interface SpawnedProcess {
	stdout: ReadableStream<Uint8Array>;
	stderr: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill: (signal?: NodeJS.Signals) => void;
}

export interface SpawnDeps {
	spawn: (argv: string[], cwd: string | undefined) => SpawnedProcess;
	timeoutMs: number;
	capBytes: number;
	drainMs: number;
}

const defaultDeps: SpawnDeps = {
	spawn: (argv, cwd) =>
		Bun.spawn(argv, {
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	timeoutMs: COMMAND_TIMEOUT_MS,
	capBytes: OUTPUT_CAP_BYTES,
	drainMs: DRAIN_AFTER_KILL_MS,
};

interface Captured {
	text: string;
	truncated: boolean;
}

function readCapped(stream: ReadableStream<Uint8Array>, capBytes: number) {
	const reader = stream.getReader();
	const kept: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	const done = (async (): Promise<Captured> => {
		for (;;) {
			const { done, value } = await reader.read().catch(() => ({
				done: true as const,
				value: undefined,
			}));
			if (done) break;
			if (size >= capBytes) {
				truncated = true;
				continue;
			}
			const room = capBytes - size;
			const piece = value.length > room ? value.subarray(0, room) : value;
			if (piece.length < value.length) truncated = true;
			kept.push(piece);
			size += piece.length;
		}
		const text = Buffer.concat(kept).toString("utf8");
		return { text: truncated ? `${text}${TRUNCATED_NOTE}` : text, truncated };
	})();
	return { done, cancel: () => reader.cancel().catch(() => {}) };
}

/** Runs argv and captures bounded output; a timeout kills the child and reports status 124. */
export async function spawnCapture(
	argv: string[],
	opts?: { cwd?: string },
	deps: Partial<SpawnDeps> = {},
): Promise<CommandResult> {
	const { spawn, timeoutMs, capBytes, drainMs } = { ...defaultDeps, ...deps };
	try {
		const proc = spawn(argv, opts?.cwd);
		const stdout = readCapped(proc.stdout, capBytes);
		const stderr = readCapped(proc.stderr, capBytes);
		let timedOut = false;
		let drain: ReturnType<typeof setTimeout> | undefined;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
			drain = setTimeout(() => {
				stdout.cancel();
				stderr.cancel();
			}, drainMs);
		}, timeoutMs);
		try {
			const [out, err, status] = await Promise.all([
				stdout.done,
				stderr.done,
				proc.exited,
			]);
			const flag = out.truncated ? { truncated: true } : {};
			return timedOut
				? {
						status: TIMED_OUT_STATUS,
						stdout: out.text,
						stderr: `${err.text}${argv[0]} timed out after ${timeoutMs} ms and was killed\n`,
						...flag,
					}
				: { status, stdout: out.text, stderr: err.text, ...flag };
		} finally {
			clearTimeout(timer);
			clearTimeout(drain);
		}
	} catch (error) {
		return {
			status: 127,
			stdout: "",
			stderr: error instanceof Error ? error.message : String(error),
		};
	}
}

export const runCommand: CommandRunner = (argv, opts) =>
	spawnCapture(argv, opts);
