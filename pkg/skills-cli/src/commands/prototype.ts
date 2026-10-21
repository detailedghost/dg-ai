import type { Command } from "commander";
import { main } from "../prototype";
import { registerRawCommand } from "../utils/legacy-command";

/** Register the local prototype commands with their raw parser so flags and statuses pass through unchanged. */
export function registerPrototype(program: Command): void {
	registerRawCommand(program, {
		name: "prototype",
		description:
			"Local prototype commands: ui, serve, wait, confirm, status, stop, and path helpers",
		run: main,
	});
}
