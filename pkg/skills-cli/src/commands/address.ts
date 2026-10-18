import type { Command } from "commander";
import { main } from "../address";
import { registerRawCommand } from "../utils/legacy-command";

/** Register address without accessing a provider until the selected handler runs. */
export function registerAddress(program: Command): void {
	registerRawCommand(program, {
		name: "address",
		description: "Review-thread, CI and Copilot operations for the address workflow",
		run: main,
	});
}
