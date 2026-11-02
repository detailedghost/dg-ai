/** Shared accent color for extension-owned overlays. */
export const ACCENT = "#6ea8fe";

/** Type stack for chrome and prose on every extension-owned surface. */
export const SANS =
	'-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

/** Type stack for machine text — identifiers, paths, command output. */
export const MONO =
	'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

/** Create an HTML element and assign the supplied inline style properties. */
export function createEl<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	style: Partial<CSSStyleDeclaration> = {},
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	Object.assign(node.style, style);
	return node;
}

/** Show a status message, clearing it automatically after a short delay. */
export function flashStatus(status: HTMLElement, message: string): void {
	status.classList.remove("err");
	status.textContent = message;
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
}

/** Show a status message flagged as an error via the shared `err` class. */
export function failStatus(status: HTMLElement, message: string): void {
	status.classList.add("err");
	status.textContent = message;
}
