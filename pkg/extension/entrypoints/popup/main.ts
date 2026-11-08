import { findDaemonPort } from "@dg/pages/daemon-port";
import { browser } from "wxt/browser";
import { mountPopup, type PopupDeps } from "@/lib/features/popup";
import "../options/style.css";
import "./style.css";

const root = document.getElementById("app");
if (root) {
	mountPopup(root, {
		runtime: browser.runtime as unknown as PopupDeps["runtime"],
		findPort: () => findDaemonPort(),
		now: Date.now,
	});
}
