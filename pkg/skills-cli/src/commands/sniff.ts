import type { Command } from "commander";
import { main } from "../sniff";
import { registerRawCommand } from "../utils/legacy-command";

/** Register sniff with its raw parser so extra arguments stay ignored and root errors exit 1. */
export function registerSniff(program: Command): void {
	registerRawCommand(program, {
		name: "sniff",
		description:
			"Inventory the secrets, config and tooling a repo needs to run",
		run: main,
	});
}
