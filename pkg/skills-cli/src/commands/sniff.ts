import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register sniff with its raw parser so extra arguments stay ignored and root errors exit 1. */
export function registerSniff(program: Command): void {
	registerLazyRaw(program, {
		name: "sniff",
		description: "Inventory the secrets, config and tooling a repo needs to run",
		load: () => import("../sniff"),
	});
}
