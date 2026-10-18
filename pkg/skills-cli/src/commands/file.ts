import type { Command } from "commander";
import { main } from "../file";
import { registerRawCommand } from "../utils/legacy-command";

/** Register file without running a handler or accessing a provider. */
export function registerFile(program: Command): void {
	registerRawCommand(program, {
		name: "file",
		description: "Create, list, view and group provider issues",
		run: main,
	});
}
