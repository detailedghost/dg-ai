#!/usr/bin/env bun
/**
 * dg-browser — the /dg:browser CLI. Thin commander entry point; each subcommand
 * lives in its own feature module under commands/ and self-registers here.
 */

import { Command } from "commander";
import { registerBatchOpen } from "./commands/batch-open";
import { registerDemo } from "./commands/demo";
import { registerInstall } from "./commands/install";
import { registerLaunch } from "./commands/launch";
import { registerProto } from "./commands/proto";
import { registerRerun } from "./commands/rerun";

const program = new Command();
program
	.name("dg-browser")
	.description(
		"Group marked tabs, play guided tours, and compare live-page prototypes via the dg-ai-extension.",
	)
	.showHelpAfterError();

registerInstall(program);
registerBatchOpen(program);
registerLaunch(program);
registerDemo(program);
registerRerun(program);
registerProto(program);

program.parseAsync(process.argv).catch((err) => {
	console.error(`dg-browser: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
