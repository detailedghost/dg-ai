import { lstatSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
	activeVersions,
	formatMegabytes,
	listDgPluginVersions,
	type PluginCacheVersion,
	type PrunePlan,
	planPluginCachePrune,
} from "@dg/common/node";

export type PruneOptions = {
	home: string;
	now: number;
	keep: boolean;
	log: (line: string) => void;
	beforeRemove?: (version: PluginCacheVersion) => void;
};

function summaryLine(plan: PrunePlan): string {
	const unknown = plan.keep.filter((k) => k.reason === "unknown state");
	if (plan.remove.length === 0) {
		return unknown.length
			? `plugin cache: nothing to remove; kept ${unknown.map((k) => `${k.version.version} (unknown state)`).join(", ")}`
			: "plugin cache: nothing to remove";
	}
	const bytes = plan.remove.reduce((sum, v) => sum + v.bytes, 0);
	const removed = plan.remove.map((v) => v.version).join(", ");
	const kept = plan.keep.map((k) => `${k.version.version} (${k.reason})`).join(", ");
	return `plugin cache: removed ${removed} (${formatMegabytes(bytes)})${kept ? `; kept ${kept}` : ""}`;
}

function isOwnedVersionDir(home: string, version: PluginCacheVersion): boolean {
	const cache = join(home, ".claude", "plugins", "cache");
	try {
		if (!lstatSync(version.path).isDirectory()) return false;
		const expected = join(realpathSync(cache), relative(cache, version.path));
		return realpathSync(version.path) === expected;
	} catch {
		return false;
	}
}

export function prunePluginCache(opts: PruneOptions): PrunePlan | undefined {
	if (opts.keep) return undefined;
	const active = activeVersions(opts.home);
	if (!active) {
		opts.log("plugin cache: skipped (installed_plugins.json unreadable)");
		return undefined;
	}
	const plan = planPluginCachePrune(listDgPluginVersions(opts.home), active, opts.now);
	const removed: PluginCacheVersion[] = [];
	for (const version of plan.remove) {
		opts.beforeRemove?.(version);
		if (!isOwnedVersionDir(opts.home, version)) continue;
		rmSync(version.path, { recursive: true, force: true });
		removed.push(version);
	}
	opts.log(summaryLine({ keep: plan.keep, remove: removed }));
	return { keep: plan.keep, remove: removed };
}
