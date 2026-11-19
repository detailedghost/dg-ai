import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { describeError } from "@dg/common";
import {
	credentialGrantTokenPath,
	type DgPaths,
	ensurePrivateDir,
	jobStateDir,
	rotateLogIfLarge,
} from "@dg/common/node";
import type { Subprocess } from "bun";
import { buildAllowedEnv } from "../dispatch/env-allowlist";
import { killProcessGroup } from "../dispatch/exec";
import {
	DISPATCH_MAX_OUTPUT_BYTES,
	DISPATCH_MAX_TIMEOUT_MS,
} from "../dispatch/limits";
import type { Logger } from "../server/log";
import { loadEnvFile } from "../services/env-file";
import type { JobDecl } from "./config";

export type LauncherDeps = {
	paths: Pick<DgPaths, "logDir" | "grantsDir" | "jobStateRoot">;
	daemonUrl: () => string;
	logger: Pick<Logger, "warn">;
	maxLogBytes: number;
};

export const jobLogFile = (logDir: string, name: string): string =>
	join(logDir, `service-${name}.log`);

export function buildBaseEnv(
	decl: JobDecl,
	deps: Pick<LauncherDeps, "logger">,
): Record<string, string> {
	const passed = Object.fromEntries(
		decl.passEnv.flatMap((name) => {
			const value = process.env[name];
			if (value === undefined) {
				deps.logger.warn(
					`service ${decl.name}: passEnv name ${name} is not set in the daemon environment`,
				);
				return [];
			}
			return [[name, value]];
		}),
	);
	return {
		...buildAllowedEnv(),
		...passed,
		...(decl.envFile ? loadEnvFile(decl.envFile) : {}),
	};
}

export function buildJobEnv(
	decl: JobDecl,
	deps: Pick<LauncherDeps, "paths" | "daemonUrl" | "logger">,
): Record<string, string> {
	const env: Record<string, string> = {
		...buildBaseEnv(decl, deps),
		DG_SERVICE_API: "1",
		DG_SERVICE_LABEL: decl.name,
		DG_DAEMON_URL: deps.daemonUrl(),
		DG_SERVICE_STATE_DIR: jobStateDir(deps.paths, decl.name),
	};
	if (process.env.DG_HOME) env.DG_HOME = process.env.DG_HOME;
	if (decl.grant) {
		env.DG_CREDENTIAL_GRANT_PREFIX = decl.grant;
		env.DG_CREDENTIAL_GRANT_FILE = credentialGrantTokenPath(
			deps.paths,
			decl.grant,
		);
	} else {
		delete env.DG_CREDENTIAL_GRANT_PREFIX;
		delete env.DG_CREDENTIAL_GRANT_FILE;
	}
	return env;
}

export function launchJob(decl: JobDecl, deps: LauncherDeps): Subprocess {
	const logFile = jobLogFile(deps.paths.logDir, decl.name);
	ensurePrivateDir(deps.paths.logDir);
	rotateLogIfLarge(logFile, deps.maxLogBytes);
	const fd = openSync(logFile, "a", 0o600);
	try {
		return Bun.spawn(decl.argv, {
			cwd: decl.cwd,
			env: buildJobEnv(decl, deps),
			stdin: "ignore",
			stdout: fd,
			stderr: fd,
			detached: true,
		});
	} finally {
		closeSync(fd);
	}
}

export type JobRunResult = {
	exitCode: number;
	timedOut: boolean;
	outputCapped: boolean;
	stdout: string;
	readError?: string;
};

export type JobRun = {
	pid: number;
	done: Promise<JobRunResult>;
};

const STDOUT_DRAIN_GRACE_MS = 500;

/** A feed run keeps the 30 s and 256 KB limits of the dispatch path; a run with no feed has none unless `timeoutMs` is set. */
export function startJobRun(decl: JobDecl, deps: LauncherDeps): JobRun {
	const logFile = jobLogFile(deps.paths.logDir, decl.name);
	ensurePrivateDir(deps.paths.logDir);
	rotateLogIfLarge(logFile, deps.maxLogBytes);
	const timeoutMs =
		decl.timeoutMs ?? (decl.feed ? DISPATCH_MAX_TIMEOUT_MS : undefined);
	const maxOutputBytes = decl.feed ? DISPATCH_MAX_OUTPUT_BYTES : undefined;
	const fd = openSync(logFile, "a", 0o600);
	let proc: Subprocess;
	try {
		proc = Bun.spawn(decl.argv, {
			cwd: decl.cwd,
			env: buildJobEnv(decl, deps),
			stdin: "ignore",
			stdout: decl.feed ? "pipe" : fd,
			stderr: fd,
			detached: true,
		});
	} finally {
		closeSync(fd);
	}

	const { pid } = proc;
	let timedOut = false;
	let outputCapped = false;
	let received = 0;
	const chunks: Buffer[] = [];
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

	const drain = async (): Promise<void> => {
		const out = proc.stdout;
		if (!decl.feed || !(out instanceof ReadableStream)) return;
		reader = (out as ReadableStream<Uint8Array>).getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) return;
			if (outputCapped) continue;
			received += value.byteLength;
			if (maxOutputBytes !== undefined && received > maxOutputBytes) {
				outputCapped = true;
				void killProcessGroup(pid);
				continue;
			}
			chunks.push(Buffer.from(value));
		}
	};

	const timer =
		timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					void killProcessGroup(pid);
				}, timeoutMs);
	let readError: string | undefined;
	const drained = drain().catch((err: unknown) => {
		readError = describeError(err);
		void killProcessGroup(pid);
	});

	const done = (async (): Promise<JobRunResult> => {
		const code = await proc.exited;
		const exitCode = proc.signalCode ? 1 : code;
		if (timer) clearTimeout(timer);
		await Promise.race([drained, Bun.sleep(STDOUT_DRAIN_GRACE_MS)]);
		await reader?.cancel().catch(() => undefined);
		return {
			exitCode,
			timedOut,
			outputCapped,
			stdout: Buffer.concat(chunks).toString("utf8"),
			...(readError === undefined ? {} : { readError }),
		};
	})();
	return { pid, done };
}
