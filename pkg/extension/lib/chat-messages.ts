/** Chat-scoped IPC message keys — sibling to demo-messages.ts, not an addition to it. */
export const MSG = {
	// content → background: storage.session and tabs.create aren't available
	// to content scripts, so the background does both.
	markerCaptured: "dg-chat:marker-captured",
} as const;
