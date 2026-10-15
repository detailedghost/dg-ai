import { DgCliError } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";
import { type EnvName, ENV_NAMES, loadConfig, type resolveEnv } from "../config";
import type { AddressWorkspace } from "../address";
import type { Log } from "../engine";
import { channelReviewPaths } from "../paths";
import type { createTeamsRelayProvider } from "../providers/teams-relay";
import type { ChatProvider } from "../providers/types";
import type { Runner, RunnerName } from "../runners/types";
import type { StackReader, VerdictReader } from "../verdict/types";

export type ResolvedEnv = ReturnType<typeof resolveEnv>;

export type DaemonIo = {
	out(line: string): void;
	err(line: string): void;
};

export type DaemonSeams = {
	fetchSecret?: (params: {
		profile: string;
		region: string;
		id: string;
		key: string;
	}) => Promise<string>;
	createProvider?: typeof createTeamsRelayProvider;
	env?: Record<string, string | undefined>;
	runners?: Record<RunnerName, Runner>;
	verdict?: VerdictReader;
	stack?: StackReader;
	workspace?: AddressWorkspace;
	random?: () => number;
	probeTimeoutMs?: number;
	stopTimeoutMs?: number;
	maintenanceIntervalMs?: number;
	logCheckIntervalMs?: number;
};

export type ChatRef = { id: string; topic?: string };

export type Connection = {
	secret: string;
	provider: ChatProvider;
	chats: [ChatRef, ...ChatRef[]];
};

export const SERVE_PROBE_TIMEOUT_MS = 10_000;
export const POLL_INTERVAL_MS = 100;

export function assertEnvName(name: string): EnvName {
	const match = ENV_NAMES.find((candidate) => candidate === name);
	if (match === undefined) {
		throw new DgCliError(`unknown env ${name}; use ${ENV_NAMES.join(" or ")}`);
	}
	return match;
}

export function savedEnvName(system: SystemSeams): EnvName {
	try {
		return loadConfig(channelReviewPaths("dev", system).configPath).env.default;
	} catch {
		return "dev";
	}
}

export function ioLog(io: DaemonIo): Log {
	return { info: io.err, warn: io.err, error: io.err };
}
