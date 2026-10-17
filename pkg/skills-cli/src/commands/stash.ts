import type { Command } from "commander";
import { main } from "../stash";
import { registerRawCommand } from "../utils/legacy-command";

export function registerStash(program: Command): void {
	registerRawCommand(program, {
		name: "stash",
		description: "Print an artifact path and create its parent directory",
		run: main,
	});
}
