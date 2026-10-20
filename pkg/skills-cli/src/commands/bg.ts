import type { Command } from "commander";
import { bgSpec } from "../bg";
import { registerLegacyCommand } from "../utils/legacy-command";

/** Register bg with the compatibility dispatcher; help, usage exit 2 and handler exit 1 stay legacy. */
export function registerBg(program: Command): void {
	registerLegacyCommand(program, bgSpec);
}
