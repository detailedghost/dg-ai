/**
 * `rerun` — replay a saved demo plan. Reads a `<name>.demo.md` (written by `demo`
 * or bundled in a recording's .zip), extracts its runnable TourScript, and hands
 * it back to the dg-ai-extension exactly like `demo` does.
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { extractScriptFromMarkdown, validate } from "../utils/plan-format";
import { playScript } from "./demo";

export function registerRerun(program: Command): void {
	program
		.command("rerun")
		.description("replay a saved demo plan (.md) via the dg-ai-extension")
		.argument("<plan>", "path to a saved <name>.demo.md plan file")
		.option(
			"--video",
			"record the replay to a video instead of a live walkthrough",
		)
		.option("--print", "print the marked URL instead of opening it")
		.action((planPath: string, opts: { video?: boolean; print?: boolean }) => {
			const script = validate(
				extractScriptFromMarkdown(readFileSync(planPath, "utf8")),
			);
			return playScript(script, opts);
		});
}
