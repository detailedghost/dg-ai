/** `dg-skills sync claude` — Claude is the sync source, not a destination; this target never writes. */

import { existsSync } from "node:fs";
import {
	mergeSkillSources,
	resolveClaudeSkillsRoot,
	resolvePluginSkillsRoot,
} from "./roots";
import type { SyncContext, SyncTarget } from "./types";
import { SyncReport } from "./types";

export type ClaudeFlags = Record<string, never>;

const NOT_A_DESTINATION =
	"claude is a source for sync, not a destination; run 'dg-skills sync <copilot|opencode|codex|pi|grok> apply' instead";

function readOnlyReport(ctx: SyncContext): SyncReport {
	const report = new SyncReport();
	const pluginRoot = resolvePluginSkillsRoot(ctx);
	const localRoot = resolveClaudeSkillsRoot(ctx);
	const merge = mergeSkillSources(pluginRoot, existsSync(localRoot) ? localRoot : null);

	report.info(
		"Claude Code loads the dg plugin's skills and agents directly; no destination-side sync is needed or performed for this target.",
	);
	report.info(`dg plugin skills root: ${pluginRoot ?? "(not found)"}`);
	report.info(`local Claude skills root: ${localRoot}`);
	report.info(`skills: ${merge.sources.length} merged source(s) (${merge.shadowed.length} shadowed by the plugin)`);
	for (const name of merge.shadowed) {
		report.warn(`plugin skill '${name}' shadows a local copy under the Claude skills directory; local copy left untouched`);
	}

	const pluginExists = pluginRoot !== null && existsSync(pluginRoot);
	const localExists = existsSync(localRoot);
	if (!pluginExists && !localExists) {
		report.fail("no skill sources found: checked the dg plugin tree and the Claude skills directory");
	}
	return report;
}

function refuse(): SyncReport {
	const report = new SyncReport();
	report.fail(NOT_A_DESTINATION);
	return report;
}

export const claudeTarget: SyncTarget<ClaudeFlags> = {
	id: "claude",
	usage: "sync claude <probe|verify> (apply/dry-run refuse: claude is a source, not a destination)",
	parseFlags(argv) {
		if (argv.length > 0) return { error: `unknown option: ${argv[0]}` };
		return { flags: {} };
	},
	probe: (ctx) => Promise.resolve(readOnlyReport(ctx)),
	dryRun: () => Promise.resolve(refuse()),
	apply: () => Promise.resolve(refuse()),
	verify: (ctx) => Promise.resolve(readOnlyReport(ctx)),
};
