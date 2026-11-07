/** True only for a message from an extension page that is not inside a tab, which is the popup. */
export function isPopupSender(sender: unknown, extensionRoot: string): boolean {
	if (typeof sender !== "object" || sender === null) return false;
	const { tab, url } = sender as { tab?: unknown; url?: unknown };
	return (
		tab === undefined && typeof url === "string" && url.startsWith(extensionRoot)
	);
}
