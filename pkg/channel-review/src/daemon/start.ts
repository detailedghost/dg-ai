import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { describeError, wait } from "@dg/common";
import { ensurePrivateDir, type SystemSeams } from "@dg/common/node";
import { type ChannelConfig, loadConfig, resolveEnv } from "../config";
import { channelReviewPaths } from "../paths";
import type { RunnerName } from "../runners/types";
import { isOurDaemon, readPidRecord } from "./pid";
import type { PlatformSeam } from "./platform";
import { type DaemonIo, POLL_INTERVAL_MS, type ResolvedEnv } from "./shared";

export type ChildLike = {
	pid?: number;
	exitCode: number | null;
	unref(): void;
	kill(signal?: NodeJS.Signals): boolean;
	on(event: "exit" | "error", listener: (value?: unknown) => void): unknown;
};

type SpawnOptions = {
	detached: boolean;
	stdio: ["ignore", number, number];
	windowsHide: boolean;
	cwd: string;
	env: NodeJS.ProcessEnv;
};

type SpawnFn = (
	command: string,
	args: string[],
	options: SpawnOptions,
) => ChildLike;

type StartOptions = { env?: string; runner?: RunnerName; chatId?: string };

type StartSeams = {
	platform: PlatformSeam;
	io: DaemonIo;
	system?: SystemSeams;
	which?: (name: string) => string | null | undefined;
	spawn?: SpawnFn;
	execPath?: string;
	argv?: string[];
	runArgv?: string[];
	startTimeoutMs?: number;
	killEscalationMs?: number;
	pollIntervalMs?: number;
};

const START_TIMEOUT_MS = 20_000;
const KILL_ESCALATION_MS = 5_000;
const LOG_TAIL_LINES = 20;
const COMPILED_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;

function tailLines(path: string): string {
	try {
		return readFileSync(path, "utf8")
			.trimEnd()
			.split("\n")
			.slice(-LOG_TAIL_LINES)
			.join("\n");
	} catch {
		return "";
	}
}

function isCompiled(entry: string | undefined): boolean {
	return !entry || COMPILED_ENTRY.test(entry) || !existsSync(entry);
}

export async function start(
	options: StartOptions,
	seams: StartSeams,
): Promise<number> {
	const { platform, io } = seams;
	const system = seams.system ?? {};
	let config: ChannelConfig;
	let env: ResolvedEnv;
	try {
		config = loadConfig(channelReviewPaths("dev", system).configPath);
		env = resolveEnv(config, options.env);
	} catch (error) {
		io.err(describeError(error));
		return 1;
	}
	const which = seams.which ?? Bun.which;
	if (!which("aws")) {
		io.err("the aws CLI is not on PATH; install it and run aws sso login");
		return 1;
	}

	const paths = channelReviewPaths(env.name, system);
	const existing = readPidRecord(paths.pidPath);
	if (existing !== undefined && (await isOurDaemon(existing.pid, platform))) {
		io.err(`a ${env.name} daemon is already running (pid ${existing.pid})`);
		return 1;
	}
	rmSync(paths.pidPath, { force: true });

	const dir = dirname(paths.pidPath);
	ensurePrivateDir(dir);
	if (existsSync(paths.logPath))
		renameSync(paths.logPath, `${paths.logPath}.1`);

	const execPath = seams.execPath ?? process.execPath;
	const argv = seams.argv ?? process.argv;
	const base =
		seams.runArgv ??
		(isCompiled(argv[1]) ? [execPath] : [execPath, argv[1] as string]);
	const [command, ...lead] = base as [string, ...string[]];
	const args = [
		...lead,
		"channel-review",
		"run",
		"--env",
		env.name,
		...(options.runner ? ["--runner", options.runner] : []),
		...(options.chatId ? ["--chat-id", options.chatId] : []),
	];

	const logFd = openSync(paths.logPath, "a", 0o600);
	let child: ChildLike;
	try {
		child = (seams.spawn ?? spawn)(command, args, {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			windowsHide: true,
			cwd: dir,
			env: system.env ?? process.env,
		});
	} catch (error) {
		io.err(`could not start the daemon: ${describeError(error)}`);
		return 1;
	} finally {
		closeSync(logFd);
	}
	child.unref();

	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	child.on("error", () => {
		exited = true;
	});

	const report = (message: string) => {
		io.err(message);
		const tail = tailLines(paths.logPath);
		if (tail) io.err(tail);
	};

	const childPid = child.pid;
	if (childPid === undefined) {
		report("the daemon process did not start");
		return 1;
	}
	const timeoutMs = seams.startTimeoutMs ?? START_TIMEOUT_MS;
	const pollMs = seams.pollIntervalMs ?? POLL_INTERVAL_MS;
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (exited || child.exitCode !== null) {
			report("the daemon exited during startup");
			return 1;
		}
		if (readPidRecord(paths.pidPath)?.pid === childPid) {
			io.out(`started the ${env.name} daemon (pid ${childPid})`);
			return 0;
		}
		if (Date.now() >= deadline) break;
		await wait(pollMs);
	}
	if (platform.platform === "win32") await platform.killTree(childPid);
	else {
		child.kill("SIGTERM");
		const killAt = Date.now() + (seams.killEscalationMs ?? KILL_ESCALATION_MS);
		while (!exited && child.exitCode === null && Date.now() < killAt) {
			await wait(pollMs);
		}
		if (!exited && child.exitCode === null) child.kill("SIGKILL");
	}
	report(
		`the daemon wrote no pidfile within ${Math.round(timeoutMs / 1000)} s`,
	);
	return 1;
}
