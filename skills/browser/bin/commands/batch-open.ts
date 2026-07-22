/**
 * `batch-open` — resolve PR/URL refs and open them in the default browser,
 * grouped into a named tab group via the `_tab_group` marker.
 */

import type { Command } from "commander";
import { tryOpen } from "../utils/lib";
import { addGroupMarker } from "../utils/marker";
import { loadConfig, resolveRef } from "../utils/refs";

type Opts = { repo?: string; group: string; print?: boolean };

export function registerBatchOpen(program: Command): void {
	program
		.command("batch-open")
		.description("open a batch of PRs/URLs in the default browser, grouped")
		.argument("<refs...>", "URL | owner/repo#num | alias#num | bare num")
		.option("-R, --repo <owner/repo>", "default repo for bare PR numbers")
		.option("-g, --group <name>", "tab group name", "PRs")
		.option("--print", "print the marked URLs instead of opening them")
		.action(async (refs: string[], opts: Opts) => {
			const cfg = loadConfig();
			// Marker groups these tabs into `group`; the index sets their order in it.
			const urls = refs.map((r, i) =>
				addGroupMarker(resolveRef(r, cfg, opts.repo), opts.group, i),
			);
			if (opts.print) {
				for (const u of urls) console.log(u);
				return;
			}
			for (const url of urls) {
				const ok = await tryOpen(url);
				console.log(`${ok ? "opened" : "FAILED"}: ${url}`);
			}
			console.log(
				`\n${urls.length} tab(s) requested — dg-ai-extension will group them into "${opts.group}".`,
			);
		});
}
