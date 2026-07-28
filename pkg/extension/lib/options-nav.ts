/**
 * Routing for the settings page, which is split into three views — Settings,
 * Privacy, and Kudos — rather than one long scroll. The page opens in a small
 * options_ui dialog, so a single column of stacked panels buried the controls.
 *
 * Kept out of the entrypoint deliberately: entrypoints/options/main.ts wires DOM
 * listeners at module scope, so it cannot be imported from a test.
 */
export const PAGES = ["settings", "privacy", "kudos"] as const;
export type PageId = (typeof PAGES)[number];

/**
 * Map a location hash to the page it selects, falling back to Settings.
 *
 * Bare `#privacy` is accepted alongside `#/privacy` so the anchor links that
 * predate routing — and any bookmark using them — still land on the right view.
 */
export function resolvePage(hash: string): PageId {
	const raw = hash.replace(/^#\/?/, "").trim().toLowerCase();
	return (PAGES as readonly string[]).includes(raw)
		? (raw as PageId)
		: "settings";
}
