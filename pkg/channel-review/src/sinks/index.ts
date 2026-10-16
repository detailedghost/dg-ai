import type { ChannelConfig } from "../config";
import { createDatadogSink, type DatadogDeps } from "./datadog";
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
	datadog: ["DATADOG_API_KEY", "DATADOG_APP_KEY"],
	sentry: ["SENTRY_AUTH_TOKEN", "SENTRY_ORG"],
} as const;

export function missingEnvByProvider(
	config: ChannelConfig,
	env: Record<string, string | undefined>,
): Record<string, string[]> {
	const { enabled, providers } = config.errorWatch;
	if (!enabled) return {};
	const missing: Record<string, string[]> = {};
	for (const [name, names] of Object.entries(REQUIRED_ENV)) {
		if (!providers[name as keyof typeof REQUIRED_ENV].enabled) continue;
		const absent = names.filter((key) => !env[key]);
		if (absent.length > 0) missing[name] = absent;
	}
	return missing;
}
