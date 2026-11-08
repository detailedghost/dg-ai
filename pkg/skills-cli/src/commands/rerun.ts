/**
 * `rerun` — replay a saved demo plan. Reads a `<name>.demo.md` (written by `demo`
 * or bundled in a recording's .zip), extracts its runnable TourScript, and plays
 * it in a local browser, or through the dg-ai-extension with --ext.
 */

import type { Command } from "commander";
import type { CommandOpts, DemoDeps } from "../demo/cli";
import { addExtOption } from "../utils/ext-flag";
import { addLocalOptions } from "./demo";

export function registerRerun(
	program: Command,
	deps: Partial<DemoDeps> = {},
): void {
	addLocalOptions(addExtOption(program.command("rerun")))
		.description(
			"record a saved demo plan (.md) to an MP4 in a local browser, or replay it via the dg-ai-extension with --ext",
		)
		.argument(
			"<plan>",
			"path to a saved <name>.demo.md plan file, or its name under the demos dir",
		)
		.option(
			"--video",
			"--ext: start in video mode; local mode always records",
		)
		.option("--print", "--ext only: print the marked URL instead of opening it")
		.action(async (plan: string, opts: CommandOpts) => {
			const { runRerun } = await import("../demo/cli");
			await runRerun(plan, opts, deps);
		});
}
