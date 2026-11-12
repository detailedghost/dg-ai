import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Registers list, set, delete, grant and revoke; no subcommand prints a stored value or token. */
export function registerCredentials(program: Command): void {
	registerLazyRaw(program, {
		name: "credentials",
		description:
			"Manage secrets in dg-daemon's encrypted credential store; values are never printed.",
		load: () => import("../credentials/cli"),
	});
}
