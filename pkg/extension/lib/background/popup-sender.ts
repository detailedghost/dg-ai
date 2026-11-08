/** True for a message from any extension page, in a tab or not. */
export function isExtensionPageSender(
	sender: unknown,
	extensionRoot: string,
): boolean {
	if (typeof sender !== "object" || sender === null) return false;
	const { url } = sender as { url?: unknown };
	return typeof url === "string" && url.startsWith(extensionRoot);
}

/** True only for a message from an extension page that is not inside a tab, which is the popup. */
export function isPopupSender(sender: unknown, extensionRoot: string): boolean {
	return (
		isExtensionPageSender(sender, extensionRoot) &&
		(sender as { tab?: unknown }).tab === undefined
	);
}
