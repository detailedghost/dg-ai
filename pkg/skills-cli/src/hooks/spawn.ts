import type { CommandResult, CommandRunner } from "./types";

export const COMMAND_TIMEOUT_MS = 30_000;
export const OUTPUT_CAP_BYTES = 1024 * 1024;
export const TIMED_OUT_STATUS = 124;
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
};

async function readCapped(
	stream: ReadableStream<Uint8Array>,
	capBytes: number,
): Promise<string> {
	const kept: Uint8Array[] = [];
	let size = 0;
	let truncated = false;
	for await (const chunk of stream) {
		if (size >= capBytes) {
			truncated = true;
			continue;
		}
		const room = capBytes - size;
		const piece = chunk.length > room ? chunk.subarray(0, room) : chunk;
		if (piece.length < chunk.length) truncated = true;
		kept.push(piece);
		size += piece.length;
	}
	const text = Buffer.concat(kept).toString("utf8");
	return truncated ? `${text}${TRUNCATED_NOTE}` : text;
}

/** Runs argv and captures bounded output; a timeout kills the child and reports status 124. */
export async function spawnCapture(
	argv: string[],
	opts?: { cwd?: string },
	deps: Partial<SpawnDeps> = {},
): Promise<CommandResult> {
	const { spawn, timeoutMs, capBytes } = { ...defaultDeps, ...deps };
	try {
		const proc = spawn(argv, opts?.cwd);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			proc.kill("SIGKILL");
		}, timeoutMs);
		try {
			const [stdout, stderr, status] = await Promise.all([
				readCapped(proc.stdout, capBytes),
				readCapped(proc.stderr, capBytes),
				proc.exited,
			]);
			return timedOut
				? {
						status: TIMED_OUT_STATUS,
						stdout,
						stderr: `${stderr}${argv[0]} timed out after ${timeoutMs} ms and was killed\n`,
					}
				: { status, stdout, stderr };
		} finally {
			clearTimeout(timer);
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
