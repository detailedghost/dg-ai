import type { Command } from "commander";
import { main } from "../chain";
import { registerRawCommand } from "../utils/legacy-command";

/** Register chain without running a handler or accessing a provider. */
export function registerChain(program: Command): void {
	registerRawCommand(program, {
		name: "chain",
		description: "Render and wire dependent PR/MR stacks",
		run: main,
	});
}
