// Public surface of the /proxy helper module. cli.ts and any future
// importer should only ever reach into this file, not the internals.

export { BACKENDS, type BackendName, findBackend } from "./backends";
export type {
	Backend,
	BuildArgsInput,
	Install,
	ParsedResult,
} from "./backends/types";
export { classifyFailure } from "./likely-cause";
export { resolvePersona, withPersona } from "./persona";
export { checkPreflight, type PreflightResult } from "./preflight";
export { proxyDir, runBackend } from "./spawn";

/** Flags shared by a proxy run and its plan. */
export interface ProxyOptions {
	prompt: string;
	subagent?: string;
	spec?: string;
	slice?: string;
	model?: string;
	effort?: string;
	cwd?: string;
}
