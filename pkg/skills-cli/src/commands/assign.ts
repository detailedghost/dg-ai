import type { Command } from "commander";
import { main } from "../assign";
import { registerRawCommand } from "../utils/legacy-command";

/** Register assign with its raw parser so resolve keeps its observed exit statuses. */
export function registerAssign(program: Command): void {
	registerRawCommand(program, {
		name: "assign",
		description: "Resolve agent tiers for a plan's slice layer",
		run: main,
	});
}
