import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

export function registerAdr(program: Command): void {
	registerLazyRaw(program, {
		name: "adr",
		description: "Create, index, search and lint architecture decision records",
		load: () => import("../adr"),
	});
}
