import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { killProcessTree } from "@dg/common/node";
import type { CrCode } from "../errors";

const OUTPUT_CAP_BYTES = 5 * 1024 * 1024;
const OAUTH_TOKEN = "CLAUDE_CODE_OAUTH_TOKEN";
const TAIL_BYTES = 8 * 1024;
const DRAIN_GRACE_MS = 2000;
const STRIPPED_ENV = /^(THRASH_.*|CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT)$/;

export type ProcessRequest = {
	argv: string[];
	env?: Record<string, string>;
	cwd: string;
	timeoutMs: number;
	logPath: string;
	keepOauthToken?: boolean;
	signal: AbortSignal;
	onSpawn?: (pid: number) => void;
	platform?: NodeJS.Platform;
	kill?: (pid: number, signal: NodeJS.Signals) => void;
	exec?: (command: string, args: string[]) => void;
};

export type ProcessResult = {
	status: number | null;
	signal: string | null;
	timedOut: boolean;
	aborted: boolean;
	stderrTail: string;
	stdoutTail?: string;
	outputTail?: string;
	code?: Extract<CrCode, "CR-201">;
};

function childEnv(keepOauthToken: boolean): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(process.env).filter(
			([key]) => (keepOauthToken && key === OAUTH_TOKEN) || !STRIPPED_ENV.test(key),
		),
	);
}

function isMissingBinary(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export async function runProcess(request: ProcessRequest): Promise<ProcessResult> {
	const {
		argv,
		cwd,
		timeoutMs,
		logPath,
		keepOauthToken = false,
		signal,
		onSpawn,
		platform = process.platform,
		kill = process.kill.bind(process),
		exec = (command, args) => {
			spawnSync(command, args, { stdio: "ignore" });
		},
	} = request;

	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });

	const fd = openSync(logPath, "a", 0o600);
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv, {
			cwd,
			env: { ...childEnv(keepOauthToken), ...request.env },
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	} catch (error) {
		closeSync(fd);
		if (!isMissingBinary(error)) throw error;
		return {
			status: null,
			signal: null,
			timedOut: false,
			aborted: false,
			stderrTail: "",
			stdoutTail: "",
			outputTail: "",
			code: "CR-201",
		};
	}

	const killTree = () => killProcessTree(proc.pid, { platform, kill, exec });

	let timedOut = false;
	let aborted = false;
	const stop = (reason: "timeout" | "abort") => {
		if (timedOut || aborted) return;
		if (reason === "timeout") timedOut = true;
		else aborted = true;
		killTree();
	};
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	const onAbort = () => stop("abort");
	signal.addEventListener("abort", onAbort, { once: true });

	let written = 0;
	let logging = true;
	let stderrTail = Buffer.alloc(0);
	let stdoutTail = Buffer.alloc(0);
	let exited = false;
	try {
		const readers = [proc.stdout, proc.stderr].map((stream) => stream.getReader());
		const drains = readers.map(async (reader, index) => {
			for (let next = await reader.read(); !next.done; next = await reader.read()) {
				const chunk = Buffer.from(next.value);
				const room = OUTPUT_CAP_BYTES - written;
				if (logging && room > 0) {
					const kept = chunk.subarray(0, room);
					try {
						writeSync(fd, kept);
						written += kept.length;
					} catch {
						logging = false;
					}
				}
				if (index === 0) {
					stdoutTail = Buffer.concat([stdoutTail, chunk]).subarray(-TAIL_BYTES);
				}
				if (index === 1) {
					stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-TAIL_BYTES);
				} else {
					stdoutTail = Buffer.concat([stdoutTail, chunk]).subarray(-TAIL_BYTES);
				}
			}
		});

		onSpawn?.(proc.pid);
		if (signal.aborted) onAbort();
		await proc.exited;
		exited = true;
		clearTimeout(timer);
		killTree();
		let graceTimer: ReturnType<typeof setTimeout> | undefined;
		const grace = new Promise<void>((resolve) => {
			graceTimer = setTimeout(resolve, DRAIN_GRACE_MS);
		});
		await Promise.race([Promise.all(drains), grace]);
		clearTimeout(graceTimer);
		await Promise.all(readers.map((reader) => reader.cancel().catch(() => undefined)));
		await Promise.allSettled(drains);
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
		if (!exited) killTree();
		logging = false;
		closeSync(fd);
	}

	return {
		status: proc.exitCode,
		signal: typeof proc.signalCode === "string" ? proc.signalCode : null,
		timedOut,
		aborted,
		stderrTail: stderrTail.toString("utf8"),
		stdoutTail: stdoutTail.toString("utf8"),
		outputTail: `${stdoutTail.toString("utf8")}\n${stderrTail.toString("utf8")}`,
	};
}
