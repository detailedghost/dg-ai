import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";
import { main } from "../viz";

/** Register viz without starting the viewer or touching the skill tree. */
export function registerViz(program: Command): void {
	registerRawCommand(program, {
		name: "viz",
		description:
			"Render plan, recap and code-review boards in a local Astro viewer",
		run: main,
	});
}
