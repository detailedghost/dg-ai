import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register address without accessing a provider until the selected handler runs. */
export function registerAddress(program: Command): void {
	registerLazyRaw(program, {
		name: "address",
		description: "Review-thread, CI and Copilot operations for the address workflow",
		load: () => import("../address"),
	});
}
