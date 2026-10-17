// Shared contract every backends/<name>.ts implements. cli.ts and spawn.ts
// only ever talk to a Backend through this interface — never import a
// concrete backend module directly outside backends/index.ts's barrel.

export interface BuildArgsInput {
	prompt: string;
	model?: string;
	effort?: string;
	resume?: string;
}

export interface Install {
	// Shown to the user verbatim when the backend binary isn't on PATH.
	hint: string;
	command: string;
	url?: string;
}

export interface ParsedResult {
	sessionId: string | null;
	message: string;
}

export interface Backend {
	bin: string;
	buildArgs: (input: BuildArgsInput) => string[];
	// Called with the combined stdout text (JSONL) once the process exits.
	parseEvents: (stdout: string) => ParsedResult;
	install: Install;
}
