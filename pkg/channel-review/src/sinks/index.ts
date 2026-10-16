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
