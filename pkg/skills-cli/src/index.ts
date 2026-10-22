#!/usr/bin/env bun
/**
 * dg-skills — the /dg:browser CLI. Thin commander entry point; each subcommand
 * lives in its own feature module under commands/ and self-registers here.
 */

import { Command } from "commander";
import { registerAddress } from "./commands/address";
import { registerBatchOpen } from "./commands/batch-open";
import { registerBg } from "./commands/bg";
import { registerCatchup } from "./commands/catchup";
import { registerChain } from "./commands/chain";
import { registerChannelReview } from "./commands/channel-review";
import { registerClipboardImage } from "./commands/clipboard-image";
import { registerCredentials } from "./commands/credentials";
import { registerDb } from "./commands/db";
import { registerDemo } from "./commands/demo";
import { registerDepsUpgrade } from "./commands/deps-upgrade";
import { registerDoctor } from "./commands/doctor";
import { registerErd } from "./commands/erd";
import { registerFile } from "./commands/file";
import { registerInbox } from "./commands/inbox";
import { registerInstall } from "./commands/install";
import { registerJot } from "./commands/jot";
import { registerLaunch } from "./commands/launch";
import { registerMeaningful } from "./commands/meaningful";
import { registerMonolith } from "./commands/monolith";
import { registerOverwatchSnapshot } from "./commands/overwatch-snapshot";
import { registerProto } from "./commands/proto";
import { registerProxy } from "./commands/proxy";
import { registerPw } from "./commands/pw";
import { registerPwCode } from "./commands/pw-code";
import { registerRerun } from "./commands/rerun";
import { registerSniff } from "./commands/sniff";
import { registerSpec } from "./commands/spec";
import { registerStash } from "./commands/stash";
import { registerTestLive } from "./commands/test-live";
import { registerThrash } from "./commands/thrash";
import { registerVcsProvider } from "./commands/vcs-provider";
import { registerWorktree } from "./commands/worktree";
import {
	guardExtensionCommands,
	registerRequireExtension,
} from "./utils/cli-only";

const program = new Command();
program
	.name("dg-skills")
	.description(
		"Review inboxes, run channel reviews, group marked tabs, play guided tours, and compare live-page prototypes.",
	)
	.showHelpAfterError();

program.enablePositionalOptions();
guardExtensionCommands(program);
registerInbox(program);
registerChannelReview(program);
registerCredentials(program);
registerDb(program);
registerErd(program);
registerTestLive(program);
registerInstall(program);
registerBatchOpen(program);
registerLaunch(program);
registerDemo(program);
registerRerun(program);
registerStash(program);
registerAddress(program);
registerThrash(program);
registerChain(program);
registerCatchup(program);
registerFile(program);
registerDepsUpgrade(program);
registerMeaningful(program);
registerVcsProvider(program);
registerClipboardImage(program);
registerProto(program);
registerProxy(program);
registerPw(program);
registerPwCode(program);
registerOverwatchSnapshot(program);
registerWorktree(program);
registerSpec(program);
registerMonolith(program);
registerJot(program);
registerBg(program);
registerSniff(program);
registerDoctor(program);
registerRequireExtension(program);

program.parseAsync(process.argv).catch((err) => {
	console.error(`dg-skills: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
