import type { ConfigTransport } from "@/lib/config";
import { failStatus, flashStatus } from "@/lib/ui-helpers";

export type MountAssetDirectoryPanelOptions = {
	transport: ConfigTransport;
};

export function mountAssetDirectoryPanel(
	container: HTMLElement,
	options: MountAssetDirectoryPanelOptions,
): void {
	const doc = container.ownerDocument;
	const { transport } = options;

	const panel = doc.createElement("div");
	panel.className = "panel";

	const heading = doc.createElement("h2");
	heading.className = "sec-h";
	heading.textContent = "Asset directory";
	panel.appendChild(heading);

	const note = doc.createElement("p");
	note.className = "note";
	note.textContent =
		"Where the agent stages assets it shows you in chat. Daemon-authoritative — not synced across machines.";
	panel.appendChild(note);

	const label = doc.createElement("label");
	label.className = "lbl";
	label.textContent = "Directory";
	panel.appendChild(label);

	const input = doc.createElement("input");
	input.className = "field";
	input.type = "text";
	input.disabled = true;
	input.setAttribute("data-asset-directory-input", "");
	panel.appendChild(input);

	const status = doc.createElement("div");
	status.className = "status";
	status.setAttribute("role", "status");
	status.setAttribute("data-asset-directory-status", "");
	panel.appendChild(status);

	const hint = doc.createElement("p");
	hint.className = "note";
	hint.hidden = true;
	hint.setAttribute("data-asset-directory-hint", "");
	panel.appendChild(hint);

	container.appendChild(panel);

	async function load(): Promise<void> {
		const result = await transport.getAssetDirectory();
		if (result.status === "ok") {
			input.value = result.value;
			input.disabled = false;
			hint.hidden = true;
			hint.textContent = "";
		} else {
			input.disabled = true;
			hint.hidden = false;
			hint.textContent =
				"The dg-daemon daemon is not running — start a chat session to configure this.";
		}
	}

	input.addEventListener("change", () => {
		void (async () => {
			const result = await transport.setAssetDirectory(input.value);
			if (result.ok) flashStatus(status, "Saved ✓");
			else failStatus(status, result.error);
		})();
	});

	void load();
}
