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
	dryRun: boolean;
	failOnRequestChanges: boolean;
	unsafeAllowShell: boolean;
	reviewForks: boolean;
}

type Env = Record<string, string | undefined>;

function read(env: Env, name: string): string {
	return (env[`THRASHLEY_${name}`] ?? "").trim();
}

function flag(env: Env, name: string, fallback: boolean): boolean {
	const raw = read(env, name).toLowerCase();
	if (raw === "") return fallback;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new Error(
		`input ${name.toLowerCase().replaceAll("_", "-")} must be true or false, got "${raw}"`,
	);
}

function oneOf<T extends string>(
	env: Env,
	name: string,
	allowed: readonly T[],
	fallback: T,
): T {
	const raw = read(env, name) || fallback;
	if (!(allowed as readonly string[]).includes(raw)) {
		throw new Error(
			`input ${name.toLowerCase().replaceAll("_", "-")} must be one of ${allowed.join(", ")}, got "${raw}"`,
		);
	}
	return raw as T;
}

function wholeNumber(
	env: Env,
	name: string,
	min: number,
	max: number,
): number | undefined {
	const raw = read(env, name);
	if (raw === "") return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new Error(
			`input ${name.toLowerCase().replaceAll("_", "-")} must be a whole number from ${min} to ${max}, got "${raw}"`,
		);
	}
	return value;
}

export function readConfig(env: Env): Config {
	const backend = oneOf(env, "BACKEND", BACKENDS, "copilot");
	const unsafeAllowShell = flag(env, "UNSAFE_ALLOW_SHELL", false);
	if (backend !== "copilot" && !unsafeAllowShell) {
		throw new Error(
			`backend ${backend} cannot run without shell tools; set unsafe-allow-shell: true only for repos whose PR authors you trust`,
		);
	}
	return {
		spice: wholeNumber(env, "SPICE", 1, 5) ?? 2,
		reviewRules: read(env, "REVIEW_RULES") || "docs/code_review.md",
		policy: read(env, "POLICY") || ".github/thrashley.yml",
		verdict: oneOf(env, "VERDICT", VERDICT_MODES, "auto"),
		backend,
		model: read(env, "MODEL"),
		agentFile: read(env, "AGENT_FILE"),
		promptFile: read(env, "PROMPT_FILE"),
		heading: read(env, "HEADING") || "Code Review",
		botLogin: read(env, "BOT_LOGIN") || "github-actions[bot]",
		maxComments: wholeNumber(env, "MAX_COMMENTS", 0, 100),
		sass: flag(env, "SASS", false),
		dryRun: flag(env, "DRY_RUN", false),
		failOnRequestChanges: flag(env, "FAIL_ON_REQUEST_CHANGES", true),
		unsafeAllowShell,
		reviewForks: flag(env, "REVIEW_FORKS", false),
	};
}
