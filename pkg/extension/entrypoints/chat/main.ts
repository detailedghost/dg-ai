import {
	emitRedacted,
	type SessionBootstrap,
	validateSessionBootstrap,
} from "@dg/common";
import {
	CHAT_SESSION_KEY_PREFIX,
	type ChatPageOptions,
	type PositionArea,
	renderChatPage as renderSharedChatPage,
} from "@dg/pages";
import { browser } from "wxt/browser";
import { mountPairing, type PairingOptions } from "@/lib/features/pairing";
import "../options/style.css";
import "@dg/pages/chat/style.css";

type ExtensionRuntime = {
	onMessage: { addListener(listener: (message: unknown) => void): void };
	sendMessage(message: unknown): Promise<unknown>;
};

export type ExtensionChatPageOptions = Omit<
	ChatPageOptions,
	"runtime" | "mountPairing" | "positionArea"
> & {
	pairing?: Omit<PairingOptions, "initialConnected" | "variant">;
};

const chromeLocalArea: PositionArea = {
	get: (keys) => chrome.storage.local.get(keys),
	set: (items) => chrome.storage.local.set(items),
	remove: (keys) => chrome.storage.local.remove(keys),
};

async function loadStoredBootstraps(): Promise<SessionBootstrap[]> {
	const stored = await (
		browser.storage.session as unknown as {
			get(): Promise<Record<string, unknown>>;
		}
	).get();
	const bootstraps: SessionBootstrap[] = [];
	for (const [key, value] of Object.entries(stored)) {
		if (!key.startsWith(CHAT_SESSION_KEY_PREFIX)) continue;
		try {
			bootstraps.push(validateSessionBootstrap(value));
		} catch {}
	}
	return bootstraps;
}

export function renderChatPage(
	options: ExtensionChatPageOptions = {},
): Promise<void> {
	const { pairing, ...pageOptions } = options;
	const runtime = browser.runtime as unknown as ExtensionRuntime;
	const sendMessage = (message: unknown) => runtime.sendMessage(message);
	return renderSharedChatPage({
		loadBootstraps: loadStoredBootstraps,
		positionArea: chromeLocalArea,
		runtime: {
			sendMessage,
			onMessage: {
				addListener: (listener) => runtime.onMessage.addListener(listener),
			},
		},
		mountPairing: (host, mountOptions) =>
			mountPairing(host, {
				variant: "entry",
				...mountOptions,
				runtime: { sendMessage },
				...pairing,
				onDaemon: mountOptions.onDaemon,
			}),
		...pageOptions,
	});
}

if (typeof document !== "undefined") {
	const autoRoot = document.getElementById("app");
	if (autoRoot) {
		void renderChatPage({ root: autoRoot }).catch((error) => {
			emitRedacted(
				(line) => console.error(line),
				`[dg-chat] could not render the chat page: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
	}
}
