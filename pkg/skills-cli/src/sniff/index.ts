export {
	classifyEnvKey,
	extractCompose,
	extractDockerfile,
	extractEnv,
	extractRegistries,
	extractTerraform,
	extractToolchain,
	extractWorkflows,
	parseEnvFile,
} from "./extract";
export { main, USAGE } from "./main";
export {
	buildReport,
	mergeRequirements,
	sniff,
	sortRequirements,
} from "./report";
export type {
	Gap,
	GapKind,
	Phase,
	ReqType,
	Requirement,
	SniffReport,
} from "./types";
export { walkFiles } from "./walk";
