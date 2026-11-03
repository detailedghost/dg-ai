import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register the raw catchup parser without accessing Git or project files. */
export function registerCatchup(program: Command): void {
	registerLazyRaw(program, {
		name: "catchup",
		description: "Rebase onto origin's default branch, verify, and push",
		load: () => import("../catchup"),
	});
}
