import { emitRedacted, type SessionBootstrap } from "@dg/common";
import { createOverwatchApi, OverwatchHttpError } from "../board/overwatch";
import {
	attachLocalSession,
	forgetLocalBootstrap,
	loadLocalBootstraps,
	localStorageOrMemory,
	SESSION_ENDED_TEXT,
	sessionStorageOrMemory,
	storeLocalBootstrap,
} from "../local";
import { type ChatClient, createChatClient } from "./chat-client";
import { type ChatPageController, renderChatPage } from "./main";

const root = document.getElementById("app");

if (root) {
	const storage = localStorageOrMemory();
	const bootstrapStorage = sessionStorageOrMemory();
	const bootstraps = loadLocalBootstraps(window, bootstrapStorage);
	const heldTokens = new Map(
		bootstraps.map((bootstrap) => [bootstrap.sessionId, bootstrap.token]),
	);
	const hadSession = bootstraps.length > 0;
	let client: ChatClient | undefined;
	let controller: ChatPageController | undefined;
	let rendered = false;
	let ended: HTMLElement | undefined;
	const showEnded = (): void => {
		if (!rendered || !hadSession || ended || heldTokens.size > 0) return;
		ended = document.createElement("p");
		ended.className = "chat-session-ended";
		ended.setAttribute("role", "alert");
		ended.textContent = SESSION_ENDED_TEXT;
		root.prepend(ended);
	};
	const forgetIfRefused = (token: string): void => {
		createOverwatchApi(window.location.origin, token)
			.getBoard()
			.catch((error: unknown) => {
				if (!(error instanceof OverwatchHttpError) || error.status !== 403) {
					return;
				}
				for (const [sessionId, held] of heldTokens) {
					if (held === token) controller?.dropSession(sessionId);
				}
			});
	};
	renderChatPage({
		root,
		runtime: { storage },
		pruneStalePositions: false,
		assetOrigin: window.location.origin,
		createClient: () => {
			client = createChatClient({
				openSocket: (url, held) => {
					const token = held.values().next().value ?? "";
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
			});
			return client;
		},
		loadBootstraps: () => Promise.resolve(bootstraps),
		attachSession: (sessionId, held) =>
			attachLocalSession(window.location.origin, sessionId, held),
		onHeldAdopted: (bootstrap: SessionBootstrap) => {
			heldTokens.set(bootstrap.sessionId, bootstrap.token);
			storeLocalBootstrap(bootstrapStorage, bootstrap);
		},
		onHeldEnded: (bootstrap: SessionBootstrap) => {
			heldTokens.delete(bootstrap.sessionId);
			forgetLocalBootstrap(bootstrapStorage, bootstrap.token);
			client?.forgetSession(bootstrap.sessionId);
			showEnded();
		},
		onController: (next) => {
			controller = next;
		},
	})
		.then(() => {
			rendered = true;
			showEnded();
		})
		.catch((error: unknown) => {
			emitRedacted(
				(line) => console.error(line),
				`[dg-chat] could not render the chat page: ${error instanceof Error ? error.message : String(error)}`,
			);
		});
}
