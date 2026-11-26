import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import {
	CREDENTIAL_SEALED_PREFIX,
	describeError,
	isReservedCredentialPrefix,
	noteSecret,
} from "@dg/common";
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
import { assertJobPinned } from "./pin-check";

export type LauncherDeps = {
	paths: Pick<DgPaths, "logDir" | "grantsDir" | "jobStateRoot" | "jobsDir" | "jobSourcesPath">;
	daemonUrl: () => string;
	logger: Pick<Logger, "warn">;
	maxLogBytes: number;
	readCredential: (name: string) => string | undefined;
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

export type BoundCredentials =
	| { ok: true; env: Record<string, string> }
	| { ok: false; error: string };

export function readBoundCredentials(
	decl: JobDecl,
	readCredential: LauncherDeps["readCredential"],
): BoundCredentials {
	const env: Record<string, string> = {};
	const bindings = Object.entries(decl.credentialEnv);
	const grant = decl.grant ?? "";
	if (
		bindings.length > 0 &&
		(isReservedCredentialPrefix(grant) ||
			grant.toLowerCase() === CREDENTIAL_SEALED_PREFIX)
	) {
		return {
			ok: false,
			error: `credential prefix ${grant} is reserved and cannot bind an environment variable`,
		};
	}
	for (const [variable, name] of bindings) {
		let value: string | undefined;
		try {
			value = readCredential(`${decl.grant}/${name}`);
		} catch (err) {
			return { ok: false, error: describeError(err) };
		}
		if (value === undefined) {
			return {
				ok: false,
				error: `credential ${name} is missing — run dg job setup ${decl.name}`,
			};
		}
		noteSecret(value);
		if (value.includes("\0")) {
			return {
				ok: false,
				error: `credential ${name} cannot be an environment variable`,
			};
		}
		env[variable] = value;
	}
	return { ok: true, env };
}

export function buildJobEnv(
	decl: JobDecl,
	deps: Pick<LauncherDeps, "paths" | "daemonUrl" | "logger" | "readCredential">,
): Record<string, string> {
	const bound = readBoundCredentials(decl, deps.readCredential);
	if (!bound.ok) throw new Error(bound.error);
	const env: Record<string, string> = {
		...buildBaseEnv(decl, deps),
		...bound.env,
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
	assertJobPinned(decl.name, deps.paths);
	const env = buildJobEnv(decl, deps);
	const logFile = jobLogFile(deps.paths.logDir, decl.name);
	ensurePrivateDir(deps.paths.logDir);
	rotateLogIfLarge(logFile, deps.maxLogBytes);
	const fd = openSync(logFile, "a", 0o600);
	try {
		return Bun.spawn(decl.argv, {
			cwd: decl.cwd,
			env,
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
	assertJobPinned(decl.name, deps.paths);
	const env = buildJobEnv(decl, deps);
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
			env,
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
