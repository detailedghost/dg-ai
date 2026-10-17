import type { Command } from "commander";
import { main } from "../meaningful";
import { registerRawCommand } from "../utils/legacy-command";

/** Register the inert meaningful dispatcher while preserving its raw arguments. */
export function registerMeaningful(program: Command): void {
	registerRawCommand(program, {
		name: "meaningful",
		description: "Reshape branch commits into reviewable groups",
		run: main,
	});
}
