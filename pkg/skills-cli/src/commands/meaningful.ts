import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register the inert meaningful dispatcher while preserving its raw arguments. */
export function registerMeaningful(program: Command): void {
	registerLazyRaw(program, {
		name: "meaningful",
		description: "Reshape branch commits into reviewable groups",
		load: () => import("../meaningful"),
	});
}
