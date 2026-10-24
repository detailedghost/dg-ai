import type { Command } from "commander";
import { testLiveSpec } from "../test-live";
import { registerLegacyCommand } from "../utils/legacy-command";

export function registerTestLive(program: Command): void {
	registerLegacyCommand(program, testLiveSpec);
}
