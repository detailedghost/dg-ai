// Shared contract every backends/<name>.ts implements. cli.ts and spawn.ts
// only ever talk to a Backend through this interface — never import a
// concrete backend module directly outside backends/index.ts's barrel.

/** Normalized prompt and optional backend overrides; resume carries a backend-owned session ID. */
export interface BuildArgsInput {
	prompt: string;
	model?: string;
	effort?: string;
	resume?: string;
	/** Deny shell, network, and built-in MCP tools; only backends with `supportsNoShell` honor it. */
	noShell?: boolean;
}

/** User-facing installation guidance returned when the selected executable is unavailable. */
export interface Install {
	// Shown to the user verbatim when the backend binary isn't on PATH.
	hint: string;
	command: string;
	url?: string;
}

/** Backend-normalized final message and nullable session ID extracted from its output stream. */
export interface ParsedResult {
	sessionId: string | null;
	message: string;
}

/** Adapt argv and stdout parsing for one executable; parsing does not decide whether execution succeeded. */
export interface Backend {
	bin: string;
	/** Build direct executable argv; the caller never passes it through a shell. */
	buildArgs: (input: BuildArgsInput) => string[];
	/** Parse complete stdout after exit, retaining a nullable session when the backend emits none. */
	parseEvents: (stdout: string) => ParsedResult;
	install: Install;
	supportsNoShell?: boolean;
}
