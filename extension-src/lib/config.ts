import { browser } from "wxt/browser";

/** The nine tab-group colors Chrome/Firefox accept. */
export type GroupColor = "grey" | "blue" | "red" | "yellow" | "green" | "pink" | "purple" | "cyan" | "orange";

export type GroupConfig = {
	patterns: string[];
	title: string;
	color: GroupColor;
};

// Permissive default pattern (any GitHub PR); scope it per-org in the Options page.
export const DEFAULTS: GroupConfig = {
	patterns: ["*://github.com/*/*/pull/*"],
	title: "PRs",
	color: "blue",
};

export async function getConfig(): Promise<GroupConfig> {
	return (await browser.storage.sync.get(DEFAULTS)) as GroupConfig;
}

export async function setConfig(cfg: GroupConfig): Promise<void> {
	await browser.storage.sync.set(cfg);
}
