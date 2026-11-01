import { spawn } from "node:child_process";
import { chmodSync, closeSync, openSync, readFileSync } from "node:fs";
import type { LaunchSpec } from "./browser";
import { daemonCommand } from "./daemon-command";
import {
	isLive,
	logPathFor,
	read,
	reapStale,
	remove,
	type SessionRecord,
	stopSession,
} from "./registry";
import { call } from "./socket";
import type { ClientEnv } from "./spec";

const READY_TIMEOUT_MS = 20_000;
const LOG_TAIL_LINES = 12;

export const refusal = (
	record: Pick<SessionRecord, "name" | "cwd" | "pid">,
): string =>
	`session '${record.name}' is open from ${record.cwd} (pid ${record.pid}). ` +
	`Run 'pw -s=${record.name} close' there or pick another -s=${record.name}.`;

function logTail(file: string): string {
	try {
		return readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.slice(-LOG_TAIL_LINES)
			.join("\n");
	} catch {
		return "";
	}
}

export async function releaseKey(
	{ key, scratch }: Pick<SessionRecord, "key" | "scratch">,
	env: ClientEnv,
	closeBrowser?: (profileDir: string) => Promise<unknown>,
): Promise<number | null> {
	const existing = read(key);
	if (existing && isLive(existing)) {
		if (!scratch && existing.cwd !== env.cwd) {
			env.err(refusal(existing));
			return 1;
		}
		await stopSession(existing, { closeBrowser });
	} else if (existing) await reapStale(closeBrowser);
	return null;
}

function startDaemon(spec: LaunchSpec): Promise<number> {
	const logFile = logPathFor(spec.key);
	const errFd = openSync(logFile, "w", 0o600);
	chmodSync(logFile, 0o600);
	const [command, ...daemonArgs] = daemonCommand();
	const child = spawn(
		command as string,
		[...daemonArgs, JSON.stringify(spec)],
		{
			cwd: spec.cwd,
			detached: true,
			stdio: ["ignore", "pipe", errFd],
		},
	);
	closeSync(errFd);

	return new Promise<number>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(
			() =>
				fail(`Daemon did not become ready within ${READY_TIMEOUT_MS / 1000} s`),
			READY_TIMEOUT_MS,
		);
		const onError = (error: Error) => fail(error.message);
		const onExit = (code: number | null) =>
			fail(`Daemon exited with code ${code} before it was ready`);
		const onData = (chunk: string) => {
			output += chunk;
			const line = output
				.split("\n")
				.find((l) => l.startsWith("READY ") || l.startsWith("ERROR "));
			if (!line) return;
			if (line.startsWith("ERROR ")) return fail(line.slice("ERROR ".length));
			settle();
			child.stdout?.destroy();
			child.unref();
			resolve(child.pid as number);
		};
		const settle = () => {
			clearTimeout(timer);
			child.off("error", onError);
			child.off("exit", onExit);
			child.stdout?.off("data", onData);
		};
		const fail = (message: string) => {
			settle();
			child.kill("SIGKILL");
			reject(new Error(message));
		};
		child.on("error", onError);
		child.on("exit", onExit);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", onData);
	});
}

export async function launch(
	spec: LaunchSpec,
	url: string | undefined,
	env: ClientEnv,
	onFailure: () => Promise<unknown> = async () => undefined,
): Promise<number> {
	let pid: number;
	try {
		pid = await startDaemon(spec);
	} catch (error) {
		remove(spec.key);
		await onFailure().catch(() => undefined);
		const detail =
			logTail(logPathFor(spec.key)) ||
			(error instanceof Error ? error.message : String(error));
		env.err(`### Error\n${detail}`);
		return 1;
	}

	env.out(`### Browser \`${spec.name}\` opened with pid ${pid}.`);
	return runRemote(spec, url ? ["goto", url] : undefined, env);
}

export async function runRemote(
	record: Pick<SessionRecord, "socketPath">,
	argv: string[] | undefined,
	env: ClientEnv,
): Promise<number> {
	const response = await call(
		record,
		argv
			? { id: "run", method: "run", params: { argv, cwd: env.cwd, raw: false } }
			: { id: "ping", method: "ping" },
	);
	if ("error" in response) {
		env.err(response.error);
		return 1;
	}
	(response.result.exitCode === 0 ? env.out : env.err)(response.result.text);
	return response.result.exitCode;
}
