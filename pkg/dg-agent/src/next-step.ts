/** Stderr hint after start or attach. The bootstrap URL stays on stdout, and this line has no token. */
export function cliNextStep(
	kind: "registered" | "claimed" | "attached",
	sessionId: string,
): string {
	if (kind === "registered") {
		return `dg-agent: session ${sessionId} is ready. Next: open the extension side panel and choose Connect.`;
	}
	if (kind === "claimed") {
		return `dg-agent: attached to the session the extension is waiting on (${sessionId}). Next: dg-agent recv --block.`;
	}
	return `dg-agent: claimed session ${sessionId}. Next: dg-agent recv --block. In the side panel choose Connect if it is not already on this session.`;
}
