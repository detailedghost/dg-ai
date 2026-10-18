import { describeError, isRecord, withTimeout } from "@dg/common";
import type { SystemSeams } from "@dg/common/node";
import {
	type ChannelConfig,
	type EnvName,
	loadConfig,
	resolveEnv,
} from "../config";
import {
	type CredentialSource,
	createGrantCredentialSource,
	localSecretName,
	resolveSecrets,
} from "../credentials";
import { channelReviewPaths } from "../paths";
import { type PreflightReport, preflight } from "../providers/teams-relay";
import { createRunners } from "../runners";
import { RUNNER_NAMES, type Runner, type RunnerName } from "../runners/types";
import { missingEnvByProvider } from "../sinks";
import { type ChannelState, readStateSnapshot } from "../state";
import { isOurDaemon, readPidRecord } from "./pid";
import type { PlatformSeam } from "./platform";
import {
	assertEnvName,
	type DaemonIo,
	type ResolvedEnv,
	SERVE_PROBE_TIMEOUT_MS,
} from "./shared";

type PreflightCall = {
	config: ChannelConfig;
	env: ResolvedEnv;
	secret?: string;
};

type StatusSeams = {
	platform: PlatformSeam;
	io: DaemonIo;
	system?: SystemSeams;
	runners?: Record<RunnerName, Runner>;
	probeTimeoutMs?: number;
	preflight?: (call: PreflightCall) => Promise<PreflightReport>;
	env?: Record<string, string | undefined>;
	credentials?: CredentialSource;
};

function automationReport(
	config: ChannelConfig,
	state: ChannelState | undefined,
	env: Record<string, string | undefined>,
) {
	const { errorWatch, deps } = config;
	const providers = Object.fromEntries(
		Object.entries(errorWatch.providers).map(([name, provider]) => {
			const entry = state?.sinks[name];
			return [
				name,
				{
					enabled: provider.enabled,
					lastPollAt: entry?.lastPollAt ?? null,
					lastError: entry?.lastError ?? null,
					counts: entry?.counts ?? {},
				},
			];
		}),
	);
	return {
		errorWatch: {
			enabled: errorWatch.enabled,
			providers,
			missingEnv: Object.values(missingEnvByProvider(config, env)).flat(),
		},
		deps: {
			enabled: deps.enabled,
			repos: deps.repos.length,
			lastRun: Object.fromEntries(
				Object.entries(state?.deps.lastRun ?? {}).map(([repo, run]) => [
					repo,
					{ at: run.at, result: run.result },
				]),
			),
			watchingPrs: Object.keys(state?.prWatch ?? {}).length,
		},
	};
}

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
	let snapshot: ChannelState | undefined;
	let stateError: string | undefined;
	try {
		snapshot = readStateSnapshot(paths);
		lastEventIds = snapshot.lastEventIds;
		current = snapshot.current;
	} catch (error) {
		stateError = describeError(error);
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

	if (stateError) body.state = { error: stateError };

	if (config === undefined || env === undefined) {
		body.preflight = { config: { error: configError } };
		io.out(JSON.stringify(body, null, 2));
		return 1;
	}

	body.address = `allowAnySender ${config.address.allowAnySender}, senderIds ${config.owner.senderIds.length}`;
	const secrets = await resolveSecrets({
		envName: name,
		env: seams.env ?? process.env,
		source: seams.credentials ?? createGrantCredentialSource(system),
	});
	body.credentials = {
		...secrets.secrets,
		...(secrets.warning ? { warning: secrets.warning } : {}),
	};
	Object.assign(body, automationReport(config, snapshot, secrets.env));
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
			const report = await check({
				config,
				env,
				secret: secrets.env[localSecretName(name)],
			});
			const { env: _env, ...checks } = report;
			body.preflight = checks;
			failed = hasError(checks);
		} catch (error) {
			body.preflight = { error: describeError(error) };
			failed = true;
		}
	}
	io.out(JSON.stringify(body, null, 2));
	return failed || stateError ? 1 : 0;
}
