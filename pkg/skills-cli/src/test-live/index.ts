import type { CommandSpec } from "../utils/legacy-command";
import { runCleanup } from "./cleanup";
import { runSetup } from "./setup";

const description = `Temporarily deploy the current branch, wait for it to go live, then drop the temp commits.

GitHub only. Hard stops: on main/master, or no .github/workflows in the current directory.`;

export function createTestLiveSpec(): CommandSpec {
	return {
		name: "test-live",
		description,
		subcommands: {
			setup: {
				description: "Patch workflow_dispatch if needed, trigger the deploy, and watch until it is live.",
				args: ["env"],
				run: (args) => runSetup(args),
			},
			cleanup: {
				description: "Drop the temp workflow_dispatch commit, preserving any later commits.",
				run: () => runCleanup(),
			},
		},
	};
}

export const testLiveSpec = createTestLiveSpec();
