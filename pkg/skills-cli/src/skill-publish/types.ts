export interface ArgMapEntry {
	positional?: string;
	flag?: string;
	bool_flag?: string;
	as?: string;
}

export interface ToolSpec {
	name: string;
	description: string;
	slow?: boolean;
	poll_interval_hint?: number;
	timeout_ms?: number;
	inputSchema: Record<string, unknown>;
	arg_mapping?: ArgMapEntry[];
	resume_contract?: string;
	long_running?: boolean;
}

export interface Manifest {
	name: string;
	version: string;
	description: string;
	recipe: string;
	tools: ToolSpec[];
	concurrency?: "serial";
	stdout_size_cap?: number;
	prerequisites?: string[];
	min_client_version?: Record<string, string>;
	cli_path?: string;
	connection_aliases?: string[];
	local_env_vars?: string[];
	author_notes?: string;
	local_test_data?: string;
}

export const LOCAL_ZONE_FIELDS = new Set([
	"cli_path",
	"connection_aliases",
	"local_env_vars",
	"author_notes",
	"local_test_data",
]);

export interface PluginManifest {
	name: string;
	description: string;
	skills: string[];
	version?: string;
	owner?: string;
	keywords?: string[];
	category?: string;
}

export interface AnalyzeResult {
	publishable: boolean;
	issues: string[];
	routing: "bun-ts" | "native-addon";
}

export const CLI_VERSION = "0.1.0";
export const TEMPLATE_VERSION = "0.1.0";
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 120_000;
