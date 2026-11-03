import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import marketplace from "../../../../.claude-plugin/marketplace.json" with { type: "json" };

export type RecommendedPlugin = {
	name: string;
	repo: string;
	sha: string;
	skills?: string[];
};

type RunResult = { status: number | null; stdout: string; stderr: string };
export type Runner = (argv: string[]) => RunResult;

type MarketplaceEntry = {
	name: string;
	source: string | { repo: string; sha: string };
	skills?: string[];
};

const PIN = /^[0-9a-f]{40}$/;

export function firstLine(text: string): string {
	return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? "";
}

export function recommendedPlugins(): RecommendedPlugin[] {
	return (marketplace.plugins as MarketplaceEntry[]).flatMap((entry) => {
		if (entry.name === "dg" || typeof entry.source !== "object") return [];
		if (!PIN.test(entry.source.sha)) {
			throw new Error(`marketplace pin for ${entry.name} is not a full commit sha`);
		}
		return [
			{
				name: entry.name,
				repo: entry.source.repo,
				sha: entry.source.sha,
				skills: entry.skills,
			},
		];
	});
}

/** The installed bundle version when it differs from the running one, whose embedded pins are then stale. */
export function bundleChangedTo(running: string, installed: string | undefined): string | undefined {
	if (running === "dev" || !installed || installed === running) return undefined;
	return installed;
}

export const runSync: Runner =([program, ...args]) => {
	const result = spawnSync(program, args, { encoding: "utf8" });
	if (result.error) throw result.error;
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
};

function installedShas(home: string): Map<string, string[]> {
	const configDir = process.env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	const file = join(configDir, "plugins", "installed_plugins.json");
	if (!existsSync(file)) return new Map();
	try {
		const doc = JSON.parse(readFileSync(file, "utf8")) as {
			plugins?: Record<string, { scope?: string; gitCommitSha?: string }[]>;
		};
		return new Map(
			Object.entries(doc.plugins ?? {}).map(([ref, entries]) => [
				ref,
				(entries ?? []).flatMap((entry) =>
					entry.gitCommitSha && (entry.scope === undefined || entry.scope === "user") ? [entry.gitCommitSha] : [],
				),
			]),
		);
	} catch {
		return new Map();
	}
}

function currentSha(shas: string[] | undefined, pin: string): string | undefined {
	if (!shas?.length) return undefined;
	return shas.includes(pin) ? pin : shas[0];
}

const MARKETPLACE = "detailedghost";

function refreshMarketplace(run: Runner): void {
	try {
		if (run(["claude", "plugin", "marketplace", "update", MARKETPLACE]).status === 0) return;
		run(["claude", "plugin", "marketplace", "add", "detailedghost/dg-ai"]);
	} catch {
		return;
	}
}

function installOne(plugin: RecommendedPlugin, home: string, before: string | undefined, run: Runner): string {
	const ref = `${plugin.name}@${MARKETPLACE}`;
	const short = plugin.sha.slice(0, 7);
	if (before === plugin.sha) return `${plugin.name} already at ${short}.`;
	if (before) {
		const removed = run(["claude", "plugin", "uninstall", ref]);
		if (removed.status !== 0) {
			return `⚠ ${plugin.name} skipped: ${firstLine(removed.stderr) || `exit ${removed.status}`}`;
		}
	}
	const added = run(["claude", "plugin", "install", ref, "--json"]);
	if (added.status !== 0) {
		const reason = firstLine(added.stderr) || `exit ${added.status}`;
		return before
			? `⚠ ${plugin.name} removed: reinstall failed: ${reason}`
			: `⚠ ${plugin.name} skipped: ${reason}`;
	}
	const after = currentSha(installedShas(home).get(ref), plugin.sha);
	if (after === undefined) return `⚠ ${plugin.name} installed, but its commit could not be verified`;
	if (after !== plugin.sha) {
		const mismatch = `installed ${after.slice(0, 7)}, expected ${short}`;
		const removed = run(["claude", "plugin", "uninstall", ref]);
		return removed.status === 0
			? `⚠ ${plugin.name} removed: ${mismatch}`
			: `⚠ ${plugin.name} skipped: ${mismatch}; uninstall failed: ${firstLine(removed.stderr) || `exit ${removed.status}`}`;
	}
	return `${plugin.name} ${before ? "updated to" : "installed at"} ${short}.`;
}

export function installRecommendedForClaude(
	plugins: RecommendedPlugin[],
	home: string,
	run: Runner,
	log: (line: string) => void,
): void {
	const installed = installedShas(home);
	const stale = plugins.some(
		(plugin) => currentSha(installed.get(`${plugin.name}@${MARKETPLACE}`), plugin.sha) !== plugin.sha,
	);
	if (stale) refreshMarketplace(run);
	for (const plugin of plugins) {
		try {
			const before = currentSha(installed.get(`${plugin.name}@${MARKETPLACE}`), plugin.sha);
			log(installOne(plugin, home, before, run));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			log(`⚠ ${plugin.name} skipped: ${firstLine(reason)}`);
		}
	}
}
