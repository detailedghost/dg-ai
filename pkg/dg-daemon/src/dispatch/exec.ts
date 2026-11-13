import { describeError, wait } from "@dg/common";
import { killProcessTree } from "@dg/common/node";
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
	return `failed to start "${executable}": ${describeError(error)}`;
}

export type KillGroupSeams = {
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
	exec?: (command: string, args: string[]) => void;
};

const GROUP_PROBE_MS = 50;

const isGone = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException).code === "ESRCH";

export function killProcessGroup(
	pid: number,
	graceMs = DISPATCH_KILL_GRACE_MS,
	seams: KillGroupSeams = {},
): Promise<void> {
	const {
		platform = process.platform,
		kill = (target, signal) => {
			process.kill(target, signal);
		},
		exec,
	} = seams;
	if (platform === "win32") {
		killProcessTree(pid, { platform, exec });
		return Promise.resolve();
	}
	try {
		kill(-pid, "SIGTERM");
	} catch {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		const finish = () => {
			clearInterval(probe);
			clearTimeout(deadline);
			resolve();
		};
		const probe = setInterval(() => {
			try {
				kill(-pid, 0);
			} catch (error) {
				if (isGone(error)) finish();
			}
		}, GROUP_PROBE_MS);
		const deadline = setTimeout(() => {
			try {
				kill(-pid, "SIGKILL");
			} catch {}
			finish();
		}, graceMs);
		probe.unref();
		deadline.unref();
	});
}

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

export async function executeCommand(
	argv: string[],
	cwd: string,
	limits: ExecLimits,
	seams?: Pick<KillGroupSeams, "platform" | "exec">,
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
			void killProcessGroup(pid, undefined, seams);
		}
		return capped;
	};

	const timeoutTimer = setTimeout(() => {
		killedFor = "timeout";
		void killProcessGroup(pid, undefined, seams);
	}, limits.timeoutMs);

	const stdoutChunks: Buffer[] = [];
	const stderrChunks: Buffer[] = [];
	const drained = Promise.all([
		drainCapped(proc.stdout, stdoutChunks, noteBytes),
		drainCapped(proc.stderr, stderrChunks, noteBytes),
	]);
	const exitCode = await proc.exited;
	clearTimeout(timeoutTimer);
	await Promise.race([drained, wait(DISPATCH_KILL_GRACE_MS)]);

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
