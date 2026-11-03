import {
	forgetLocalBootstrap,
	loadLocalBootstrap,
	localStorageOrMemory,
	sessionStorageOrMemory,
} from "../local";
import { renderOverwatchPage } from "./main";
import { createOverwatchApi, OverwatchHttpError } from "./overwatch";

const BOARD_POLL_MS = 5_000;
const EXPIRED_LABEL =
	"Session token missing or expired. Reopen this page from the chat link.";
const root = document.getElementById("app");

if (root) {
	const storage = localStorageOrMemory();
	const bootstrapStorage = sessionStorageOrMemory();
	const bootstrap = loadLocalBootstrap(window, bootstrapStorage);
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
		offlineLabel: () => (expired ? EXPIRED_LABEL : "Daemon unreachable"),
		connect: () => {
			if (!bootstrap || expired) return Promise.resolve(undefined);
			const api = createOverwatchApi(window.location.origin, bootstrap.token);
			return Promise.resolve({
				...api,
				getBoard: () => {
					if (expired) {
						return Promise.reject(new OverwatchHttpError(403, EXPIRED_LABEL));
					}
					return api.getBoard().catch((error: unknown) => {
						if (error instanceof OverwatchHttpError && error.status === 403) {
							expire();
						}
						throw error;
					});
				},
				sendAction: async (action) => {
					if (expired) return { ok: false, error: EXPIRED_LABEL };
					const result = await api.sendAction(action);
					if (!result.ok && result.status === 403) expire();
					return result;
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
}
