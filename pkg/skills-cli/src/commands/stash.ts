import type { Command } from "commander";
import { main } from "../stash";
import { registerRawCommand } from "../utils/legacy-command";

/** Register stash with its raw parser so scope flags and usage-error exit 1 remain intact. */
export function registerStash(program: Command): void {
	registerRawCommand(program, {
		name: "stash",
		description: "Print an artifact path and create its parent directory",
		run: main,
	});
}
