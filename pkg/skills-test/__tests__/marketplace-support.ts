import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { frontmatter, REPO_ROOT } from "./test-support";

export const MARKETPLACE_PATH = join(REPO_ROOT, ".claude-plugin", "marketplace.json");
export const DG_PLUGINS_DIR = join(REPO_ROOT, "plugins", "dg");
export const guardSentence = (plugin: string) =>
	new RegExp(`${plugin}[^\\n]*is not installed, skip`, "i");

export type MarketplaceSource =
	| string
	| { source: string; repo?: string; ref?: string; sha?: string };

export type MarketplacePlugin = {
	name: string;
	description?: string;
	source: MarketplaceSource;
	skills?: string[];
};

export type Marketplace = { name: string; plugins: MarketplacePlugin[] };

export function readMarketplace(path: string = MARKETPLACE_PATH): Marketplace {
	return JSON.parse(readFileSync(path, "utf8")) as Marketplace;
}

export function importedPlugins(marketplace: Marketplace): MarketplacePlugin[] {
	return marketplace.plugins.filter((plugin) => plugin.name !== "dg");
}

export function pinViolations(marketplace: Marketplace): string[] {
	const problems: string[] = [];
	const dg = marketplace.plugins.find((plugin) => plugin.name === "dg");
	if (!dg) problems.push("dg: entry missing");
	else if (dg.source !== ".") problems.push(`dg: source must be '.'`);
	for (const plugin of importedPlugins(marketplace)) {
		const source = plugin.source;
		if (typeof source === "string") {
			problems.push(`${plugin.name}: source must be a github object`);
			continue;
		}
		if (!/^[0-9a-f]{40}$/.test(source.sha ?? ""))
			problems.push(`${plugin.name}: sha must be 40 lowercase hex characters`);
		if (!source.ref) problems.push(`${plugin.name}: ref missing`);
	}
	return problems;
}

const TEXT_EXTENSIONS = /\.(md|ts|tsx|js|mjs|json|yaml|yml|html|css|astro)$/;

function textFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return entry === "node_modules" ? [] : textFiles(path);
		return TEXT_EXTENSIONS.test(path) ? [path] : [];
	});
}

function requiresNames(text: string, plugin: string): boolean {
	const block = /^requires:\s*([\s\S]*?)(?=^\S|(?![\s\S]))/m.exec(
		frontmatter(text),
	);
	if (!block) return false;
	return new RegExp(`(^|[^\\w-])${plugin}([^\\w-]|$)`).test(block[1] ?? "");
}

export function optionalPluginViolations(
	pluginNames: string[],
	pluginsDir: string = DG_PLUGINS_DIR,
): string[] {
	const problems: string[] = [];
	for (const file of textFiles(pluginsDir)) {
		const text = readFileSync(file, "utf8");
		for (const plugin of pluginNames) {
			const mentioned =
				text.includes(`/${plugin}:`) || text.includes(`${plugin}@detailedghost`);
			if (mentioned && !guardSentence(plugin).test(text))
				problems.push(`${file}: mentions ${plugin} without the guard sentence`);
			if (requiresNames(text, plugin))
				problems.push(`${file}: requires: names ${plugin}`);
		}
	}
	return problems;
}
