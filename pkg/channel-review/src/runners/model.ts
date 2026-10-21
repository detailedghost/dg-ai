import type { ChannelConfig } from "../config";
import type { RunnerName } from "./types";

export type ResolvedModel = {
	model: string | undefined;
	source: "requested" | "configured" | "default";
};

export function resolveModel(
	name: RunnerName,
	requested: string | undefined,
	config: ChannelConfig,
): ResolvedModel {
	if (requested) return { model: requested, source: "requested" };
	const configured: Partial<Record<RunnerName, string>> = {
		claude: config.runner.claude.bedrock?.model,
		grok: config.runner.grok?.model,
	};
	const model = configured[name];
	return { model, source: model ? "configured" : "default" };
}
