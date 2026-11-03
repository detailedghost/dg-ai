import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Registers the checklist that /dg:stat renders by default, plus --long, --plain and --json views. */
export function registerStat(program: Command): void {
	registerLazyRaw(program, {
		name: "stat",
		description:
			"Track a priority-ordered checklist of agent and user work, for /dg:stat",
		load: () => import("../stat/cli"),
	});
}
