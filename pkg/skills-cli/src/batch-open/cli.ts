/**
 * `batch-open` — resolve PR/URL refs and open them in the default browser,
 * grouped into a named tab group via the `_tab_group` marker.
 */

import { newBatchId } from "@dg/common";
import { tryOpen } from "@dg/common/node";
import { addGroupMarker } from "../utils/marker";
import { loadConfig, resolveRef } from "../utils/refs";

export type BatchOpenOptions = {
	repo?: string;
	group?: string;
	print?: boolean;
	ext?: boolean;
};

const DEFAULT_GROUP = "PRs";

export async function runBatchOpen(refs: string[], opts: BatchOpenOptions): Promise<void> {
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
}
