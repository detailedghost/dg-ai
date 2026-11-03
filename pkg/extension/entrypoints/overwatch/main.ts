import {
	type OverwatchPageHandle,
	type RenderOverwatchOptions,
	renderOverwatchPage as renderSharedOverwatchPage,
} from "@dg/pages";
import {
	connectOverwatchApi,
	createOverwatchApi,
	OverwatchHttpError,
} from "@dg/pages/board/overwatch";
import { browser } from "wxt/browser";
import { mountPairing } from "@/lib/features/pairing";
import { loadStoredBootstraps } from "@/lib/stored-bootstraps";
import "../options/style.css";
import "@dg/pages/board/style.css";

async function connectWithStoredToken(knownPort?: number) {
	const bootstraps = await loadStoredBootstraps();
	const candidates =
		knownPort === undefined
			? bootstraps
			: bootstraps.filter((candidate) => candidate.port === knownPort);
	let refusal: OverwatchHttpError | undefined;
	for (const bootstrap of candidates) {
		const api = createOverwatchApi(
			`http://127.0.0.1:${bootstrap.port}`,
			bootstrap.token,
		);
		try {
			await api.getBoard();
			return api;
		} catch (error) {
			if (error instanceof OverwatchHttpError && error.status === 403) {
				refusal = error;
			} else if (!(error instanceof TypeError)) {
				throw error;
			}
		}
	}
	if (refusal) throw refusal;
	return connectOverwatchApi(knownPort);
}

export function renderOverwatchPage(
	options: RenderOverwatchOptions,
): OverwatchPageHandle {
	const runtime =
		options.runtime ??
		(browser.runtime as unknown as RenderOverwatchOptions["runtime"]);
	return renderSharedOverwatchPage({
		connect: connectWithStoredToken,
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
