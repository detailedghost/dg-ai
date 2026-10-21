import type { Command } from "commander";
import { dbSpec } from "../db";
import { registerLegacyCommand } from "../utils/legacy-command";

export function registerDb(program: Command): void {
	registerLegacyCommand(program, dbSpec);
}
