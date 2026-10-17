import type { Command } from "commander";
import { main } from "../deps-upgrade";
import { registerRawCommand } from "../utils/legacy-command";

/** Register dependency operations without reading state or spawning processes. */
export function registerDepsUpgrade(program: Command): void {
	registerRawCommand(program, {
		name: "deps-upgrade",
		description: "Batch dependency upgrades, security audits and combined pull requests",
		run: main,
	});
}
