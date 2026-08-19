import type { Subprocess } from "bun";
import { buildAllowedEnv } from "./env-allowlist";
import { DISPATCH_KILL_GRACE_MS } from "./limits";

export type ExecResult = {
	exitOk: boolean;
	stdout: string;
	stderr: string;
	truncated: boolean;
	failureReason?: string;
};

export type ExecLimits = { timeoutMs: number; maxOutputBytes: number };

function describeSpawnFailure(executable: string, error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (code === "ENOENT") return `executable not found (ENOENT): ${executable}`;
	return `failed to start "${executable}": ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * detached:true put the child in its OWN process group (pgid === its own
 * pid), so -pid targets only it — without that, -pid would signal the
 * daemon's own group. TERM first, KILL after a grace period: a KILL cannot
 * be trapped, which is what defeats a SIGTERM-trapping child.
 */
function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		return; // already gone — nothing to escalate
	}
	setTimeout(() => {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// died to the TERM already
		}
	}, DISPATCH_KILL_GRACE_MS);
}

/** Reads until the stream ends; once `capped` flips true it stops accumulating (but keeps draining so the kill's EOF is observed). */
async function drainCapped(
	stream: ReadableStream<Uint8Array> | null,
	sink: Buffer[],
	noteBytes: (n: number) => boolean,
): Promise<void> {
	if (!stream) return;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		if (noteBytes(value.byteLength)) continue;
		sink.push(Buffer.from(value));
	}
}

/**
 * Spawns the already-resolved argv directly — no interpreter, no host flag —
 * and enforces the daemon's own timeout and combined-output cap by draining
 * the streams itself rather than trusting Bun's built-in `timeout`/`maxBuffer`
 * (the former signals only the direct child, which a trap ignores; the
 * latter overshoots its cap by up to 500x — both verified empirically).
 */
export async function executeCommand(
	argv: string[],
	cwd: string,
	limits: ExecLimits,
): Promise<ExecResult> {
	let proc: Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv, {
			cwd,
			env: buildAllowedEnv(),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	} catch (error) {
		return {
			exitOk: false,
			stdout: "",
			stderr: "",
			truncated: false,
			failureReason: describeSpawnFailure(argv[0] ?? "<unknown>", error),
		};
	}

	const pid = proc.pid;
	let totalBytes = 0;
	let capped = false;
	let killedFor: "timeout" | "output-cap" | undefined;

	const noteBytes = (n: number): boolean => {
		if (capped) return true;
		totalBytes += n;
		if (totalBytes > limits.maxOutputBytes) {
			capped = true;
			killedFor = "output-cap";
			killProcessGroup(pid);
		}
		return capped;
	};

	const timeoutTimer = setTimeout(() => {
		killedFor = "timeout";
		killProcessGroup(pid);
	}, limits.timeoutMs);

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	await Promise.all([
		drainCapped(proc.stdout, stdoutChunks, noteBytes),
		drainCapped(proc.stderr, stderrChunks, noteBytes),
	]);
	clearTimeout(timeoutTimer);
	const exitCode = await proc.exited;

	let stdout = Buffer.concat(stdoutChunks).toString("utf8");
	const stderr = Buffer.concat(stderrChunks).toString("utf8");

	if (killedFor === "output-cap") {
		stdout += `\n[...output truncated at ${limits.maxOutputBytes} bytes (combined stdout+stderr)]`;
		return {
			exitOk: false,
			stdout,
			stderr,
			truncated: true,
			failureReason: `combined output truncated at ${limits.maxOutputBytes} bytes; command killed`,
		};
	}
	if (killedFor === "timeout") {
		return {
			exitOk: false,
			stdout,
			stderr,
			truncated: false,
			failureReason: `command timed out after ${limits.timeoutMs}ms and was killed`,
		};
	}
	if (exitCode !== 0) {
		return {
			exitOk: false,
			stdout,
			stderr,
			truncated: false,
			failureReason: `command exited with status ${exitCode}`,
		};
	}
	return { exitOk: true, stdout, stderr, truncated: false };
}
