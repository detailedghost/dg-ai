import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import {
	activeVersions,
	formatMegabytes,
	listDgPluginVersions,
	type PluginCacheVersion,
	type PrunePlan,
	planPluginCachePrune,
	reinspectPluginVersion,
} from "@dg/common/node";

export type PruneOptions = {
	home: string;
	now: number;
	keep: boolean;
	log: (line: string) => void;
	beforeRemove?: (version: PluginCacheVersion) => void;
};

function summaryLine(plan: PrunePlan): string {
	if (plan.remove.length === 0) {
		const kept = plan.keep
			.filter((k) => k.reason === "unknown state" || k.reason === "could not remove")
			.map((k) => `${k.version.version} (${k.reason})`)
			.join(", ");
		return kept ? `plugin cache: nothing to remove; kept ${kept}` : "plugin cache: nothing to remove";
	}
	const bytes = plan.remove.reduce((sum, v) => sum + v.bytes, 0);
	const removed = plan.remove.map((v) => v.version).join(", ");
	const kept = plan.keep.map((k) => `${k.version.version} (${k.reason})`).join(", ");
	return `plugin cache: removed ${removed} (${formatMegabytes(bytes)})${kept ? `; kept ${kept}` : ""}`;
}

function freshRemoveVerdict(home: string, version: PluginCacheVersion, now: number): string | undefined {
	const active = activeVersions(home);
	if (!active) return "installed_plugins.json unreadable";
	if (!existsSync(version.path)) return "gone";
	return planPluginCachePrune([reinspectPluginVersion(version)], active, now).keep[0]?.reason;
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
	const keep = [...plan.keep];
	const removed: PluginCacheVersion[] = [];
	for (const version of plan.remove) {
		opts.beforeRemove?.(version);
		const reason = freshRemoveVerdict(opts.home, version, opts.now);
		if (reason !== undefined) {
			if (reason !== "gone") keep.push({ version, reason });
			continue;
		}
		if (!isOwnedVersionDir(opts.home, version)) continue;
		try {
			rmSync(version.path, { recursive: true, force: true });
			removed.push(version);
		} catch {
			keep.push({ version, reason: "could not remove" });
		}
	}
	const result = { keep, remove: removed };
	opts.log(summaryLine(result));
	return result;
}
