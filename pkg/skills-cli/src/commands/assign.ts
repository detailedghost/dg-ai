import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register assign with its raw parser so resolve keeps its observed exit statuses. */
export function registerAssign(program: Command): void {
	registerLazyRaw(program, {
		name: "assign",
		description: "Resolve agent tiers for a plan's slice layer",
		load: () => import("../assign"),
	});
}
