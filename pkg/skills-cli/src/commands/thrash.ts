import type { Command } from "commander";
import { registerLazyRaw } from "../utils/lazy-command";

/** Register thrash without reading diffs or accessing providers. */
export function registerThrash(program: Command): void {
	registerLazyRaw(program, {
		name: "thrash",
		description: "Diff, compile, post and tally tiered local or provider reviews",
		load: () => import("../thrash"),
	});
}
