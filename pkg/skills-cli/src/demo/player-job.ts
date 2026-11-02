import type { TourScript } from "../utils/plan-format";
import type { LaunchPick } from "../pw/core/browser";

export type BrowserPlan =
	| { mode: "windows"; browser?: "chrome" | "msedge" }
	| { mode: "local"; headless: boolean; pick: LaunchPick; label: string };

export type NarrationChoice = "both" | "voice" | "captions";

export type PlayerJob = {
	slug: string;
	planPath: string;
	dir: string;
	video: boolean;
	startUrl: string;
	script: TourScript;
	plan?: BrowserPlan;
	out?: string;
	timeoutMin?: number;
	profile?: string;
	narration?: NarrationChoice;
	voice?: string;
};

/** What travels in the player argv: the plan reloads from planPath, so argv stays small and the script stays out of ps. */
export type PlayerArgv = Omit<PlayerJob, "script">;

export const DEFAULT_TIMEOUT_MIN = 30;
