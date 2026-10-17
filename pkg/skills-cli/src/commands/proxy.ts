import type { Command } from "commander";
import { main } from "../proxy/cli";
import { registerRawCommand } from "../utils/legacy-command";

/** Register proxy without consuming its backend flags, help, or background subcommands. */
export function registerProxy(program: Command): void {
	registerRawCommand(program, {
		name: "proxy",
		description: "Delegate a prompt to an external AI backend",
		run: main,
	});
}
