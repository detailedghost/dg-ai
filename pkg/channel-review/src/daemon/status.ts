import { describeError, isRecord, withTimeout } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";
import { type ChannelConfig, type EnvName, loadConfig, resolveEnv } from "../config";
import { channelReviewPaths } from "../paths";
import { type PreflightReport, preflight } from "../providers/teams-relay";
import { createRunners } from "../runners";
import { RUNNER_NAMES, type Runner, type RunnerName } from "../runners/types";
import { createStateStore } from "../state";
import { isOurDaemon, readPidRecord } from "./pid";
import type { PlatformSeam } from "./platform";
import {
	assertEnvName,
	type DaemonIo,
	type ResolvedEnv,
	SERVE_PROBE_TIMEOUT_MS,
} from "./shared";

type PreflightCall = { config: ChannelConfig; env: ResolvedEnv };

type StatusSeams = {
	platform: PlatformSeam;
	io: DaemonIo;
	system?: SystemSeams;
	runners?: Record<RunnerName, Runner>;
	probeTimeoutMs?: number;
	preflight?: (call: PreflightCall) => Promise<PreflightReport>;
};

function hasError(report: Record<string, unknown>): boolean {
	const failed = (value: unknown): boolean =>
		Array.isArray(value)
			? value.some(failed)
			: isRecord(value) && "error" in value;
	return failed(report) || Object.values(report).some(failed);
}

async function runnerProbes(
	runners: Record<RunnerName, Runner>,
	timeoutMs: number,
): Promise<Record<RunnerName, string>> {
	const entries = await Promise.all(
		RUNNER_NAMES.map(async (name) => {
			try {
				const result = await withTimeout(runners[name].probe(), timeoutMs);
				if (result === undefined) return [name, "timeout"] as const;
				return [name, result.ok ? "ok" : result.code] as const;
			} catch {
				return [name, "error"] as const;
			}
		}),
	);
	return Object.fromEntries(entries) as Record<RunnerName, string>;
}

export async function status(
	options: { env?: string },
	seams: StatusSeams,
): Promise<number> {
	const { platform, io } = seams;
	const system = seams.system ?? {};
	let config: ChannelConfig | undefined;
	let configError: string | undefined;
	try {
		config = loadConfig(channelReviewPaths("dev", system).configPath);
	} catch (error) {
		configError = describeError(error);
	}

	let env: ResolvedEnv | undefined;
	let name: EnvName;
	try {
		name = assertEnvName(options.env ?? config?.env.default ?? "dev");
	} catch (error) {
		io.err(describeError(error));
		return 1;
	}
	try {
		if (config) env = resolveEnv(config, name);
	} catch (error) {
		configError = describeError(error);
		config = undefined;
	}
	const paths = channelReviewPaths(name, system);
	const record = readPidRecord(paths.pidPath);
	const running =
		record !== undefined && (await isOurDaemon(record.pid, platform));

	let lastEventIds: Record<string, string> = {};
	let current: unknown = null;
	try {
		const state = createStateStore(paths.statePath).get();
		lastEventIds = state.lastEventIds;
		current = state.current;
	} catch {
		lastEventIds = {};
	}

	const body: Record<string, unknown> = {
		env: name,
		running,
		pid: running ? (record?.pid ?? null) : null,
		startedAt: running ? (record?.startedAt ?? null) : null,
		chats: running ? (record?.chats ?? []) : [],
		lastEventIds,
		current,
		logPath: paths.logPath,
	};

	if (config === undefined || env === undefined) {
		body.preflight = { config: { error: configError } };
		io.out(JSON.stringify(body, null, 2));
		return 1;
	}

	body.address = `allowAnySender ${config.address.allowAnySender}, senderIds ${config.owner.senderIds.length}`;
	body.runners = await runnerProbes(
		seams.runners ?? createRunners(config),
		seams.probeTimeoutMs ?? SERVE_PROBE_TIMEOUT_MS,
	);
	let failed = false;
	if (!running) {
		const check =
			seams.preflight ??
			((call: PreflightCall) =>
				preflight({ ...call, fetch: globalThis.fetch }));
		try {
			const report = await check({ config, env });
			const { env: _env, ...checks } = report;
			body.preflight = checks;
			failed = hasError(checks);
		} catch (error) {
			body.preflight = { error: describeError(error) };
			failed = true;
		}
	}
	io.out(JSON.stringify(body, null, 2));
	return failed ? 1 : 0;
}
