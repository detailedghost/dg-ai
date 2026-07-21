import { browser } from "wxt/browser";

/** The nine tab-group colors Chrome/Firefox accept. */
export type GroupColor =
	| "grey"
	| "blue"
	| "red"
	| "yellow"
	| "green"
	| "pink"
	| "purple"
	| "cyan"
	| "orange";

// Group name is per-invocation (from the URL marker); only the color is configured.
export type Config = { color: GroupColor };

export const DEFAULTS: Config = { color: "blue" };

export async function getConfig(): Promise<Config> {
	return (await browser.storage.sync.get(DEFAULTS)) as Config;
}

export async function setConfig(cfg: Config): Promise<void> {
	await browser.storage.sync.set(cfg);
}
