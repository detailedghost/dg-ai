import type { Command } from "commander";
import { main } from "../spec";
import { registerRawCommand } from "../utils/legacy-command";

/** Register spec with its raw parser so every verb keeps its observed exit status. */
export function registerSpec(program: Command): void {
	registerRawCommand(program, {
		name: "spec",
		description:
			"Scaffold, validate, review and edit spec plan bundles for /spec orchestration",
		run: main,
	});
}
