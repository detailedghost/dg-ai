import type { Command } from "commander";
import type { LaunchOptions } from "../launch/cli";
import { addExtOption } from "../utils/ext-flag";

export function registerLaunch(program: Command): void {
	addExtOption(program.command("launch"))
		.description(
			"cold-start a Chromium browser with the extension side-loaded + open a batch (needs --ext)",
		)
		.argument("[refs...]", "URL | owner/repo#num | alias#num | bare num")
		.option("-b, --browser <key>", "browser key (see --list)")
		.option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
		.option("-g, --group <name>", "tab group name", "PRs")
		.option("--list", "list detected browsers and exit")
		.option("--dry-run", "print the launch command without running it")
		.action(async (refs: string[], opts: LaunchOptions) => {
			const { runLaunch } = await import("../launch/cli");
			process.exitCode = await runLaunch(refs, opts);
		});
}
