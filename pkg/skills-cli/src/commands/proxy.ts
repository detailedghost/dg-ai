import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register proxy without consuming its backend flags, help, or background subcommands. */
export function registerProxy(program: Command): void {
	registerLazyRaw(program, {
		name: "proxy",
		description: "Delegate a prompt to an external AI backend",
		load: () => import("../proxy/cli"),
	});
}
