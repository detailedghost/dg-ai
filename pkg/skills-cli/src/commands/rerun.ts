/**
 * `rerun` — replay a saved demo plan. Reads a `<name>.demo.md` (written by `demo`
 * or bundled in a recording's .zip), extracts its runnable TourScript, and plays
 * it in a local browser, or through the dg-ai-extension with --ext.
 */

import type { Command } from "commander";
import { findPlan } from "../demo/plan-file";
import { addExtOption } from "../utils/ext-flag";
import {
	addLocalOptions,
	type CommandOpts,
	type DemoDeps,
	dispatchPlay,
	loadScript,
} from "./demo";

export function registerRerun(
	program: Command,
	deps: Partial<DemoDeps> = {},
): void {
	addLocalOptions(addExtOption(program.command("rerun")))
		.description(
			"replay a saved demo plan (.md) in a local browser, or via the dg-ai-extension with --ext",
		)
		.argument(
			"<plan>",
			"path to a saved <name>.demo.md plan file, or its name under the demos dir",
		)
		.option(
			"--video",
			"record the replay to a video now, with no start screen",
		)
		.option("--print", "--ext only: print the marked URL instead of opening it")
		.action((plan: string, opts: CommandOpts) =>
			dispatchPlay("rerun", loadScript(findPlan(plan)), opts, deps),
		);
}
