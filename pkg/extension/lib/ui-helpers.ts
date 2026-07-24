/** Shared accent color for extension-owned overlays. */
export const ACCENT = "#6ea8fe";

/** Create an HTML element and assign the supplied inline style properties. */
export function createEl<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	style: Partial<CSSStyleDeclaration> = {},
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	Object.assign(node.style, style);
	return node;
}
