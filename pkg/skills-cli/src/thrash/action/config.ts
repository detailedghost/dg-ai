import {
	type Flag,
	oneOf,
	readEnvFlag,
	text,
	trueOrFalse,
	wholeNumber,
} from "@dg/common";

export const BACKENDS = ["copilot", "codex", "pi", "opencode", "grok"] as const;
export type Backend = (typeof BACKENDS)[number];

export const VERDICT_MODES = [
	"auto",
	"approve",
	"request-changes",
	"comment",
] as const;
export type VerdictMode = (typeof VERDICT_MODES)[number];

export interface Config {
	spice: number;
	reviewRules: string;
	policy: string;
	verdict: VerdictMode;
	backend: Backend;
	model: string;
	agentFile: string;
	promptFile: string;
	heading: string;
	botLogin: string;
	maxComments?: number;
	sass: boolean;
	improvements: boolean;
	dryRun: boolean;
	failOnRequestChanges: boolean;
	unsafeAllowShell: boolean;
	reviewForks: boolean;
}

type Env = Record<string, string | undefined>;

function input<T>(env: Env, name: string, flag: Flag<T>): T | undefined {
	return readEnvFlag(
		env,
		`THRASHLEY_${name.toUpperCase().replaceAll("-", "_")}`,
		flag,
		`input ${name}`,
	);
}

export function readConfig(env: Env): Config {
	const backend = input(env, "backend", oneOf(BACKENDS)) ?? "copilot";
	const unsafeAllowShell =
		input(env, "unsafe-allow-shell", trueOrFalse) ?? false;
	if (backend !== "copilot" && !unsafeAllowShell) {
		throw new Error(
			`backend ${backend} cannot run without shell tools; set unsafe-allow-shell: true only for repos whose PR authors you trust`,
		);
	}
	return {
		spice: input(env, "spice", wholeNumber(1, 5)) ?? 2,
		reviewRules: input(env, "review-rules", text) ?? "docs/code_review.md",
		policy: input(env, "policy", text) ?? ".github/thrashley.yml",
		verdict: input(env, "verdict", oneOf(VERDICT_MODES)) ?? "auto",
		backend,
		model: input(env, "model", text) ?? "",
		agentFile: input(env, "agent-file", text) ?? "",
		promptFile: input(env, "prompt-file", text) ?? "",
		heading: input(env, "heading", text) ?? "Code Review",
		botLogin: input(env, "bot-login", text) ?? "github-actions[bot]",
		maxComments: input(env, "max-comments", wholeNumber(0, 100)),
		sass: input(env, "sass", trueOrFalse) ?? false,
		improvements: input(env, "improvements", trueOrFalse) ?? false,
		dryRun: input(env, "dry-run", trueOrFalse) ?? false,
		failOnRequestChanges:
			input(env, "fail-on-request-changes", trueOrFalse) ?? true,
		unsafeAllowShell,
		reviewForks: input(env, "review-forks", trueOrFalse) ?? false,
	};
}
