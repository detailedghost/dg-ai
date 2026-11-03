import {
	type OverwatchPageHandle,
	type RenderOverwatchOptions,
	renderOverwatchPage as renderSharedOverwatchPage,
} from "@dg/pages";
import { browser } from "wxt/browser";
import { mountPairing } from "@/lib/features/pairing";
import "../options/style.css";
import "@dg/pages/board/style.css";

export function renderOverwatchPage(
	options: RenderOverwatchOptions,
): OverwatchPageHandle {
	const runtime =
		options.runtime ??
		(browser.runtime as unknown as RenderOverwatchOptions["runtime"]);
	return renderSharedOverwatchPage({
		...options,
		runtime,
		mountPairing: (host, mountOptions) =>
			mountPairing(host, {
				variant: "entry",
				...mountOptions,
				runtime: { sendMessage: (message) => runtime?.sendMessage?.(message) as Promise<unknown> },
			}),
	});
}

if (typeof document !== "undefined") {
	const root = document.querySelector<HTMLElement>("#app");
	if (root) {
		void renderOverwatchPage({ root }).ready.catch((error) => {
			console.error("[dg-overwatch] could not render the board:", error);
		});
	}
}
