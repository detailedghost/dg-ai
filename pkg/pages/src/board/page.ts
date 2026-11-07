import {
	exchangeChatCode,
	forgetLocalBootstrap,
	loadLocalBootstrap,
	localStorageOrMemory,
	SESSION_ENDED_TEXT,
	sessionStorageOrMemory,
} from "../local";
import { renderOverwatchPage } from "./main";
import { createOverwatchApi, OverwatchHttpError } from "./overwatch";

const BOARD_POLL_MS = 5_000;
const root = document.getElementById("app");

if (root) {
	void exchangeChatCode(window).then((exchanged) => {
	const storage = localStorageOrMemory();
	const bootstrapStorage = sessionStorageOrMemory();
	const bootstrap = loadLocalBootstrap(window, bootstrapStorage, exchanged);
	let expired = bootstrap === undefined;
	let pending = false;
	let poll: ReturnType<typeof setInterval> | undefined;

	const expire = (): void => {
		expired = true;
		clearInterval(poll);
		if (bootstrap) forgetLocalBootstrap(bootstrapStorage, bootstrap.token);
	};

	const handle = renderOverwatchPage({
		root,
		runtime: { storage },
		offlineLabel: () => (expired ? SESSION_ENDED_TEXT : "Daemon unreachable"),
		connect: () => {
			if (!bootstrap || expired) return Promise.resolve(undefined);
			const api = createOverwatchApi(window.location.origin, bootstrap.token);
			return Promise.resolve({
				...api,
				getBoard: () => {
					if (expired) {
						return Promise.reject(new OverwatchHttpError(403, SESSION_ENDED_TEXT));
					}
					return api.getBoard().catch((error: unknown) => {
						if (error instanceof OverwatchHttpError && error.status === 403) {
							expire();
						}
						throw error;
					});
				},
				sendAction: async (action) => {
					if (expired) return { ok: false, error: SESSION_ENDED_TEXT };
					const result = await api.sendAction(action);
					if (result.ok || result.status !== 403) return result;
					expire();
					return { ...result, error: SESSION_ENDED_TEXT };
				},
			});
		},
	});
	if (!expired) {
		poll = setInterval(() => {
			if (pending) return;
			pending = true;
			void handle.refresh().finally(() => {
				pending = false;
			});
		}, BOARD_POLL_MS);
	}
	handle.ready.catch((error: unknown) => {
		console.error("[dg-overwatch] could not render the board:", error);
	});
	});
}
