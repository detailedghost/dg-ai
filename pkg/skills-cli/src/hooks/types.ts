export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart";
export type HookRuntime = "claude" | "codex" | "opencode";

export interface HookInput {
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_response?: Record<string, unknown>;
	cwd?: string;
	session_id?: string;
}

export interface HookResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
	additionalContext?: string;
}

export interface CommandResult {
	status: number;
	stdout: string;
	stderr: string;
}

export type CommandRunner = (
	argv: string[],
	opts?: { cwd?: string },
) => Promise<CommandResult>;

export interface HookSeams {
	run: CommandRunner;
	which: (bin: string) => string | undefined;
	spawnDetached: (argv: string[]) => void;
	stdout: (text: string) => void;
	stderr: (text: string) => void;
}

export type HookEnv = Record<string, string | undefined>;

export interface HookContext {
	env: HookEnv;
	seams: HookSeams;
	sessionId: string;
	scratchDir: string;
	stateDir: string;
	setting(hookId: string, key: string): string;
	number(name: string, fallback: number): number;
	bypassed(name: string): boolean;
}

export type HookHandler = (
	input: HookInput,
	ctx: HookContext,
) => Promise<HookResult>;

export interface HookSettingSpec {
	values: readonly string[];
	default: string;
}

export interface HookDefinition {
	id: string;
	summary: string;
	event: HookEvent;
	matcher?: string;
	runtimes: HookRuntime[];
	settings?: Record<string, HookSettingSpec>;
	load: () => Promise<{ default: HookHandler }>;
}

export interface SettingsWriter {
	dir: string;
	file: string;
	check(): void;
	enable(defs: readonly HookDefinition[], launcher: string): Promise<string[]>;
	disable(ids?: readonly string[]): Promise<string[]>;
	enabled(): string[];
}
