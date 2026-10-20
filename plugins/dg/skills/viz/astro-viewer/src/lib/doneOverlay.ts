/**
 * Runtime half of DoneOverlay.astro — shared by PrDecisionSection and ReviewSection,
 * the two boards whose <script> is a real ES module (import-capable). PrototypeSwitcher
 * intentionally keeps its own inline copy of this same pattern: it's a dependency-free,
 * drop-in-copyable prototype template (see its own header comment), and its script is a
 * classic is:inline block that can't `import` this module anyway.
 */

import { setFaviconHref } from "./favicon.ts";

const DONE_FAVICON_HREF =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
			'<text x="50" y="54" font-size="80" text-anchor="middle" dominant-baseline="central">✅</text></svg>',
	);

export function setDoneFavicon(): void {
	setFaviconHref(DONE_FAVICON_HREF);
}

/** Reveals a DoneOverlay by id, fills its message, and swaps the tab to the done favicon. */
export function showDoneOverlay(id: string, message: string, tone?: "approve" | "neutral"): void {
	const msgEl = document.getElementById(`${id}Msg`);
	if (msgEl) msgEl.textContent = message;
	const el = document.getElementById(id);
	if (tone) el?.setAttribute("data-tone", tone);
	el?.classList.remove("hidden");
	setDoneFavicon();
}
