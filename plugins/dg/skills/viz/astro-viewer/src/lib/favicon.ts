/**
 * Shared favicon swapper: find-or-create the page's <link rel="icon"> and set
 * its href. Every consumer's icon is an SVG data URI, so the type is set
 * unconditionally rather than threaded through as a parameter.
 */
export function setFaviconHref(href: string): void {
	let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.type = "image/svg+xml";
	link.href = href;
}

export const FAVICON_WAITING =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.2"/><circle cx="16" cy="16" r="9.5" fill="none" stroke="#22c55e" stroke-width="1.5" opacity="0.45"/><circle cx="16" cy="16" r="5" fill="#22c55e"/></svg>',
	);

export const FAVICON_CLEAR =
	"data:image/svg+xml," +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="4.5" fill="#9ca3af"/></svg>',
	);
