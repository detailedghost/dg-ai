import type { Command } from "commander";
import { jotSpec } from "../jot";
import { registerLegacyCommand } from "../utils/legacy-command";

/** Register jot with the compatibility dispatcher; help, usage exit 2 and handler exit 1 stay legacy. */
export function registerJot(program: Command): void {
	registerLegacyCommand(program, jotSpec);
}
