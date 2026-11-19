import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import {
	credentialGrantTokenPath,
	type DgPaths,
	ensurePrivateDir,
	jobStateDir,
	rotateLogIfLarge,
} from "@dg/common/node";
import type { Subprocess } from "bun";
import { buildAllowedEnv } from "../dispatch/env-allowlist";
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
