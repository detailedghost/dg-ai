#!/usr/bin/env bun
/**
 * dg-skills — the /dg:browser CLI. Thin commander entry point; each subcommand
 * lives in its own feature module under commands/ and self-registers here.
 */

import { Command } from "commander";
import { registerBatchOpen } from "./commands/batch-open";
import { registerDemo } from "./commands/demo";
import { registerInbox } from "./commands/inbox";
import { registerInstall } from "./commands/install";
import { registerLaunch } from "./commands/launch";
import { registerOverwatchSnapshot } from "./commands/overwatch-snapshot";
import { registerProto } from "./commands/proto";
import { registerRerun } from "./commands/rerun";

const program = new Command();
program
	.name("dg-skills")
	.description(
		"Review inboxes, group marked tabs, play guided tours, and compare live-page prototypes.",
	)
	.showHelpAfterError();

program.enablePositionalOptions();
registerInbox(program);
registerInstall(program);
registerBatchOpen(program);
registerLaunch(program);
registerDemo(program);
registerRerun(program);
registerProto(program);
registerOverwatchSnapshot(program);

program.parseAsync(process.argv).catch((err) => {
	console.error(`dg-skills: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
