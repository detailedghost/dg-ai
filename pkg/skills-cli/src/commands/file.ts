import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register file without running a handler or accessing a provider. */
export function registerFile(program: Command): void {
	registerLazyRaw(program, {
		name: "file",
		description: "Create, list, view and group provider issues",
		load: () => import("../file"),
	});
}
