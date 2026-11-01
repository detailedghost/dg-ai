/**
 * `batch-open` — resolve PR/URL refs and open them in the default browser,
 * grouped into a named tab group via the `_tab_group` marker.
 */

import { newBatchId } from "@dg/common";
import { tryOpen } from "@dg/common/node";
import type { Command } from "commander";
import { addExtOption } from "../utils/ext-flag";
import { addGroupMarker } from "../utils/marker";
import { loadConfig, resolveRef } from "../utils/refs";

type Opts = {
	repo?: string;
	group?: string;
	print?: boolean;
	ext?: boolean;
};

const DEFAULT_GROUP = "PRs";

export function registerBatchOpen(program: Command): void {
	addExtOption(
		program
			.command("batch-open")
			.description("open a batch of PRs/URLs in the default browser")
			.argument("<refs...>", "URL | owner/repo#num | alias#num | bare num")
			.option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
			.option("-g, --group <name>", "tab group name (needs --ext)")
			.option("--print", "print the URLs instead of opening them"),
	).action(async (refs: string[], opts: Opts) => {
		const cfg = loadConfig();
		const group = opts.group ?? DEFAULT_GROUP;
		if (!opts.ext && opts.group !== undefined) {
			console.error("batch-open: --group needs --ext; opening plain tabs");
		}
		const batch = opts.ext ? newBatchId() : "";
		const urls = refs.map((r, i) => {
			const url = resolveRef(r, cfg, opts.repo);
			return opts.ext ? addGroupMarker(url, group, i, batch) : url;
		});
		if (opts.print) {
			for (const u of urls) console.log(u);
			return;
		}
		for (const url of urls) {
			const ok = await tryOpen(url);
			console.log(`${ok ? "opened" : "FAILED"}: ${url}`);
		}
		console.log(
			opts.ext
				? `\n${urls.length} tab(s) requested — dg-ai-extension will group them into "${group}".`
				: `\n${urls.length} tab(s) opened`,
		);
	});
}
