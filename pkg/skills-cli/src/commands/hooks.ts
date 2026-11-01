import type { Command } from "commander";
import { registerRawCommand } from "../utils/legacy-command";

/** Registers the hooks command with a lazy-loaded raw parser. */
export function registerHooks(program: Command): void {
	registerRawCommand(program, {
		name: "hooks",
		description: "Run and manage the opt-in hooks",
		run: async (argv) => (await import("../hooks/cli")).main(argv),
	});
}
