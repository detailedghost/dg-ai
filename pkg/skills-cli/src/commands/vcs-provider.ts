import type { Command } from "commander";
import { registerLegacyCommand } from "../utils/legacy-command";
import { commandSpec } from "../vcs-provider";

/** Register the provider compatibility dispatcher without detecting a provider during import or registration. */
export function registerVcsProvider(program: Command): void {
	registerLegacyCommand(program, commandSpec);
}
