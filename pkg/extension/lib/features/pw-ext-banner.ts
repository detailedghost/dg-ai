/** Message a banner Stop click sends to the worker. */
export const PW_EXT_STOP_MESSAGE = "dg-pw-ext:stop";

/** Self-contained isolated-world banner that says an agent drives the tab, with a Stop button; the text sits in a closed shadow root. */
export function pwExtBanner(show: boolean): void {
	const KEY = "__dgPwExtBanner";
	const STOP = "dg-pw-ext:stop";
	const slot = globalThis as unknown as Record<string, HTMLElement | undefined>;
	const existing = slot[KEY];
	if (!show) {
		existing?.remove();
		slot[KEY] = undefined;
		return;
	}
	if (existing?.isConnected) return;
	const host = document.createElement("dg-agent-banner");
	const root = host.attachShadow({ mode: "closed" });
	const bar = document.createElement("div");
	bar.setAttribute("role", "status");
	Object.assign(bar.style, {
		position: "fixed",
		right: "16px",
		bottom: "16px",
		zIndex: "2147483647",
		display: "flex",
		gap: "12px",
		alignItems: "center",
		padding: "8px 12px",
		borderRadius: "8px",
		background: "#1f2937",
		color: "#f9fafb",
		font: "14px system-ui, sans-serif",
		boxShadow: "0 2px 8px rgba(0, 0, 0, 0.3)",
	});
	const label = document.createElement("span");
	label.textContent = "Agent is driving this tab";
	const button = document.createElement("button");
	button.type = "button";
	button.textContent = "Stop";
	Object.assign(button.style, {
		font: "inherit",
		padding: "4px 10px",
		borderRadius: "6px",
		border: "0",
		background: "#dc2626",
		color: "#ffffff",
		cursor: "pointer",
	});
	button.addEventListener("click", (event) => {
		if (!event.isTrusted) return;
		host.remove();
		slot[KEY] = undefined;
		void chrome.runtime.sendMessage({ type: STOP });
	});
	bar.append(label, button);
	root.append(bar);
	(document.body ?? document.documentElement).append(host);
	slot[KEY] = host;
}
