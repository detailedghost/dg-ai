import type { Command } from "commander";
import { main } from "../thrash";
import { registerRawCommand } from "../utils/legacy-command";

/** Register thrash without reading diffs or accessing providers. */
export function registerThrash(program: Command): void {
	registerRawCommand(program, {
		name: "thrash",
		description: "Diff, compile, post and tally tiered local or provider reviews",
		run: main,
	});
}
