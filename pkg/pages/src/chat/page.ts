import { emitRedacted, type SessionBootstrap } from "@dg/common";
import {
	forgetLocalBootstrap,
	loadLocalBootstrap,
	localStorageOrMemory,
	sessionStorageOrMemory,
	storeLocalBootstrap,
} from "../local";
import { createOverwatchApi, OverwatchHttpError } from "../board/overwatch";
import { type ChatClient, createChatClient } from "./chat-client";
import { renderChatPage } from "./main";

const root = document.getElementById("app");

if (root) {
	const storage = localStorageOrMemory();
	const bootstrapStorage = sessionStorageOrMemory();
	const bootstrap = loadLocalBootstrap(window, bootstrapStorage);
	let live = bootstrap;
	let client: ChatClient | undefined;
	let heldSessions: ReadonlyMap<string, string> = new Map();
	const adoptHeld = (
		held: ReadonlyMap<string, string>,
	): SessionBootstrap | undefined => {
		const first = held.entries().next();
		if (first.done || !bootstrap) return undefined;
		const [sessionId, token] = first.value;
		live = { ...bootstrap, sessionId, token };
		storeLocalBootstrap(bootstrapStorage, live);
		return live;
	};
	const heldBootstrap = (
		held: ReadonlyMap<string, string>,
	): SessionBootstrap | undefined => {
		if (live && held.get(live.sessionId) === live.token) return live;
		return adoptHeld(held);
	};
	const dropLive = (sessionId?: string): void => {
		if (!live || (sessionId !== undefined && live.sessionId !== sessionId)) {
			return;
		}
		const dropped = live;
		live = undefined;
		forgetLocalBootstrap(bootstrapStorage, dropped.token);
		client?.forgetSession(dropped.sessionId);
		adoptHeld(heldSessions);
	};
	const forgetIfRefused = (token: string): void => {
		createOverwatchApi(window.location.origin, token)
			.getBoard()
			.catch((error: unknown) => {
				if (error instanceof OverwatchHttpError && error.status === 403) {
					if (live?.token === token) dropLive();
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
				heldSessionsOnly: true,
				openSocket: (url, held) => {
					heldSessions = held;
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
			});
			client.onFrame((frame) => {
				if (
					frame.type === "session-closed" ||
					(frame.type === "error" && frame.code === "invalid-session")
				) {
					dropLive(frame.sessionId);
				}
			});
			return client;
		},
		loadBootstraps: () => Promise.resolve(bootstrap ? [bootstrap] : []),
	}).catch((error: unknown) => {
		emitRedacted(
			(line) => console.error(line),
			`[dg-chat] could not render the chat page: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
}
