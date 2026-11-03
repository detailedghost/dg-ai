import { emitRedacted, type SessionBootstrap } from "@dg/common";
import {
	forgetLocalBootstrap,
	loadLocalBootstrap,
	localStorageOrMemory,
	sessionStorageOrMemory,
	storeLocalBootstrap,
} from "../local";
import { createOverwatchApi, OverwatchHttpError } from "../board/overwatch";
import { createChatClient } from "./chat-client";
import { renderChatPage } from "./main";

const root = document.getElementById("app");

if (root) {
	const storage = localStorageOrMemory();
	const bootstrapStorage = sessionStorageOrMemory();
	const bootstrap = loadLocalBootstrap(window, bootstrapStorage);
	let live = bootstrap;
	const heldBootstrap = (
		held: ReadonlyMap<string, string>,
	): SessionBootstrap | undefined => {
		if (!live || held.get(live.sessionId) === live.token) return live;
		const first = held.entries().next();
		if (first.done) return live;
		const [sessionId, token] = first.value;
		live = { ...live, sessionId, token };
		storeLocalBootstrap(bootstrapStorage, live);
		return live;
	};
	const forgetIfRefused = (token: string): void => {
		createOverwatchApi(window.location.origin, token)
			.getBoard()
			.catch((error: unknown) => {
				if (error instanceof OverwatchHttpError && error.status === 403) {
					forgetLocalBootstrap(bootstrapStorage);
				}
			});
	};
	renderChatPage({
		root,
		runtime: { storage },
		assetOrigin: window.location.origin,
		createClient: () =>
			createChatClient({
				heldSessionsOnly: true,
				openSocket: (url, held) => {
					const token = heldBootstrap(held)?.token ?? "";
					const socket = new WebSocket(
						`${url}?token=${encodeURIComponent(token)}`,
					);
					let opened = false;
					socket.addEventListener("open", () => {
						opened = true;
					});
					socket.addEventListener("close", () => {
						if (!opened) forgetIfRefused(token);
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
