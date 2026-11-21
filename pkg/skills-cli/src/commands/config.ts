import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Registers config path, get, set and edit for config.toml. */
export function registerConfig(program: Command): void {
	registerLazyRaw(program, {
		name: "config",
		description: "Read and change dg settings in config.toml",
		load: () => import("../config/cli"),
	});
}
