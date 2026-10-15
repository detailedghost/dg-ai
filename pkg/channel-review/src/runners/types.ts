import type { CrCode } from "../errors";

export const RUNNER_NAMES = ["claude", "codex", "copilot"] as const;

export type RunnerName = (typeof RUNNER_NAMES)[number];

type RunnerCode = Extract<CrCode, "CR-201" | "CR-202">;

type ProbeCode = RunnerCode | Extract<CrCode, "CR-206">;

export type RunTask =
	| { task: "thrash"; url: string; spice?: number; comment: boolean }
	| { task: "address"; noCi: boolean };

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
