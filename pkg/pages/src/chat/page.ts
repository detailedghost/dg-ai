import { emitRedacted } from "@dg/common";
import {
	forgetLocalBootstrap,
	loadLocalBootstrap,
	localStorageOrMemory,
	sessionStorageOrMemory,
} from "../local";
import { createChatClient } from "./chat-client";
import { renderChatPage } from "./main";

const root = document.getElementById("app");

if (root) {
	const storage = localStorageOrMemory();
	const bootstrapStorage = sessionStorageOrMemory();
	const bootstrap = loadLocalBootstrap(window, bootstrapStorage);
	const token = bootstrap?.token ?? "";
	renderChatPage({
		root,
		runtime: { storage },
		assetOrigin: window.location.origin,
		createClient: () =>
			createChatClient({
				openSocket: (url) => {
					const socket = new WebSocket(
						`${url}?token=${encodeURIComponent(token)}`,
					);
					let opened = false;
					socket.addEventListener("open", () => {
						opened = true;
					});
					socket.addEventListener("close", () => {
						if (!opened) forgetLocalBootstrap(bootstrapStorage);
					});
					return socket;
				},
			}),
		loadBootstraps: () => Promise.resolve(bootstrap ? [bootstrap] : []),
	}).catch((error: unknown) => {
		emitRedacted(
			(line) => console.error(line),
			`[dg-chat] could not render the chat page: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}
