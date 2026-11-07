/** Stderr hint after start. The bootstrap URL stays on stdout, and this line has no token. */
export function cliNextStep(sessionId: string): string {
	return `dg-agent: session ${sessionId} is ready. Next: open the DeeGee popup and run dg-agent pair <code>.`;
}
