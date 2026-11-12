import type { Command } from "commander";
import type { BatchOpenOptions } from "../batch-open/cli";
import { addExtOption } from "../utils/ext-flag";

export function registerBatchOpen(program: Command): void {
	addExtOption(
		program
			.command("batch-open")
			.description("open a batch of PRs/URLs in the default browser")
			.argument("<refs...>", "URL | owner/repo#num | alias#num | bare num")
			.option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
			.option("-g, --group <name>", "tab group name (needs --ext)")
			.option("--print", "print the URLs instead of opening them"),
	).action(async (refs: string[], opts: BatchOpenOptions) => {
		const { runBatchOpen } = await import("../batch-open/cli");
		await runBatchOpen(refs, opts);
	});
}
