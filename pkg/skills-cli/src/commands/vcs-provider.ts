import type { Command } from "commander";
import { commandSpec } from "../vcs-provider";
import { registerLegacyCommand } from "../utils/legacy-command";

export function registerVcsProvider(program: Command): void {
	registerLegacyCommand(program, commandSpec);
}
