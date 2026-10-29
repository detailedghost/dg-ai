import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register chain without running a handler or accessing a provider. */
export function registerChain(program: Command): void {
	registerLazyRaw(program, {
		name: "chain",
		description: "Render and wire dependent PR/MR stacks",
		load: () => import("../chain"),
	});
}
