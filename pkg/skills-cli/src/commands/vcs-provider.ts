import type { Command } from "commander";
import { commandSpec } from "../vcs-provider";
import { registerLegacyCommand } from "../utils/legacy-command";

/** Register the provider compatibility dispatcher without detecting a provider during import or registration. */
export function registerVcsProvider(program: Command): void {
	registerLegacyCommand(program, commandSpec);
}
