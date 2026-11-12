import { envReference, type TourScript, type TourStep } from "@dg/common";
import type { LaunchPick } from "../pw/core/browser";

export type BrowserPlan =
	| { mode: "windows"; browser?: "chrome" | "msedge" }
	| { mode: "local"; headless: boolean; pick: LaunchPick; label: string };

export type PlayerJob = {
	slug: string;
	planPath: string;
	dir: string;
	startUrl: string;
	script: TourScript;
	plan?: BrowserPlan;
	out?: string;
	timeoutMin?: number;
	profile?: string;
	narration?: boolean;
};

/** What travels in the player argv: the plan reloads from planPath, so argv stays small and the script stays out of ps. */
export type PlayerArgv = Omit<PlayerJob, "script">;

export const DEFAULT_TIMEOUT_MIN = 30;

export const SETUP_NEEDS_PERSON =
	"demo: the plan has setup steps that need a person; use --windows or --wsl-headed, or set includeSetup: true";

export class SetupRefusedError extends Error {
	readonly exitCode = 2;
	constructor() {
		super(SETUP_NEEDS_PERSON);
	}
}

export class EnvRefusedError extends Error {
	readonly exitCode = 2;
	constructor(variable: string) {
		super(`demo: set $${variable} or move the login to ## Setup`);
	}
}

export type Env = Record<string, string | undefined>;

/** Env variables named by the fill actions of these steps that are unset or empty, in step order. */
export function unsetFillVariables(steps: TourStep[], env: Env): string[] {
	const names = steps.flatMap((step) => {
		const name =
			step.action?.do === "fill" ? envReference(step.action.value) : undefined;
		return name && !env[name] ? [name] : [];
	});
	return [...new Set(names)];
}

export const setupNeedsPerson = (script: TourScript, env: Env): boolean =>
	script.setup !== undefined &&
	!script.setup.includeInTour &&
	unsetFillVariables(script.setup.steps, env).length > 0;
