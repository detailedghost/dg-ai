import type { ChannelConfig } from "../config";
import { createDatadogSink, type DatadogDeps, datadogAuthHeaders } from "./datadog";
import { createSentrySink } from "./sentry";
import type { ErrorSink } from "./types";

export type SinkDeps = Omit<DatadogDeps, "config" | "env">;

export function createSinks(
	config: ChannelConfig,
	env: Record<string, string | undefined>,
	deps: SinkDeps,
): ErrorSink[] {
	const { enabled, providers } = config.errorWatch;
	if (!enabled) return [];
	const sinks: ErrorSink[] = [];
	if (providers.datadog.enabled) sinks.push(createDatadogSink({ ...deps, config, env }));
	if (providers.sentry.enabled) sinks.push(createSentrySink({ ...deps, config, env }));
	return sinks;
}

const REQUIRED_ENV = {
	datadog: (env: Record<string, string | undefined>) => {
		const auth = datadogAuthHeaders(env);
		return "missing" in auth ? auth.missing : [];
	},
	sentry: (env: Record<string, string | undefined>) =>
		["SENTRY_AUTH_TOKEN", "SENTRY_ORG"].filter((key) => !env[key]),
};

export function missingEnvByProvider(
	config: ChannelConfig,
	env: Record<string, string | undefined>,
): Record<string, string[]> {
	const { enabled, providers } = config.errorWatch;
	if (!enabled) return {};
	const missing: Record<string, string[]> = {};
	for (const [name, check] of Object.entries(REQUIRED_ENV)) {
		if (!providers[name as keyof typeof REQUIRED_ENV].enabled) continue;
		const absent = check(env);
		if (absent.length > 0) missing[name] = absent;
	}
	return missing;
}
