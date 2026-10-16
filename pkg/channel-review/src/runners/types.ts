import type { CrCode } from "../errors";

export const RUNNER_NAMES = ["claude", "codex", "copilot", "grok"] as const;

export type RunnerName = (typeof RUNNER_NAMES)[number];

/** Headless stdout formats of the xAI Grok Build CLI (`grok --output-format`). */
export const GROK_OUTPUT_FORMATS = ["plain", "json", "streaming-json"] as const;

export type GrokOutputFormat = (typeof GROK_OUTPUT_FORMATS)[number];

type RunnerCode = Extract<CrCode, "CR-201" | "CR-202">;

type ProbeCode = RunnerCode | Extract<CrCode, "CR-206">;

export type RunTask =
	| { task: "thrash"; url: string; spice?: number; comment: boolean }
	| { task: "address"; noCi: boolean }
	| { task: "fix"; reportPath: string }
	| { task: "deps"; cooldownDays: number };

export type Runner = {
	name: RunnerName;
	probe(): Promise<{ ok: true } | { ok: false; code: ProbeCode }>;
	run(request: RunTask & {
		cwd: string;
		timeoutMs: number;
		logPath: string;
		signal: AbortSignal;
		onSpawn?: (pid: number) => void;
	}): Promise<{
		status: number | null;
		signal: string | null;
		timedOut: boolean;
		aborted: boolean;
		code?: RunnerCode;
	}>;
};
