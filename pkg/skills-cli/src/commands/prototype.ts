import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register the local prototype commands with their raw parser so flags and statuses pass through unchanged. */
export function registerPrototype(program: Command): void {
	registerLazyRaw(program, {
		name: "prototype",
		description: "Local prototype commands: ui, serve, wait, confirm, status, stop, and path helpers",
		load: () => import("../prototype"),
	});
}
