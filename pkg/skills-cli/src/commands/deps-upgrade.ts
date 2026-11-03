import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register dependency operations without reading state or spawning processes. */
export function registerDepsUpgrade(program: Command): void {
	registerLazyRaw(program, {
		name: "deps-upgrade",
		description: "Batch dependency upgrades, security audits and combined pull requests",
		load: () => import("../deps-upgrade"),
	});
}
