import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register stash with its raw parser so scope flags and usage-error exit 1 remain intact. */
export function registerStash(program: Command): void {
	registerLazyRaw(program, {
		name: "stash",
		description: "Print an artifact path and create its parent directory",
		load: () => import("../stash"),
	});
}
