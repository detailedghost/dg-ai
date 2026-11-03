import { type SessionBootstrap, validateSessionBootstrap } from "@dg/common";
import { readChatBootstrap, stripChatMarker } from "./chat-marker";
import { browserStorage, memoryStorage, type PageStorage } from "./runtime";

const STORED_BOOTSTRAP_KEY = "dg_local_bootstrap";

export function localStorageOrMemory(): PageStorage {
	try {
		return browserStorage(window.localStorage);
	} catch {
		return memoryStorage();
	}
}

export function sessionStorageOrMemory(): PageStorage {
	try {
		return browserStorage(window.sessionStorage);
	} catch {
		return memoryStorage();
	}
}

export function storeLocalBootstrap(
	storage: PageStorage,
	bootstrap: SessionBootstrap,
): void {
	storage.set(STORED_BOOTSTRAP_KEY, JSON.stringify(bootstrap));
}

export function forgetLocalBootstrap(storage: PageStorage): void {
	storage.set(STORED_BOOTSTRAP_KEY, "");
}

/** Strips the fragment after reading it; an installed extension may strip it first, so the navigation entry keeps the original URL. */
export function loadLocalBootstrap(
	win: Window,
	storage: PageStorage,
): SessionBootstrap | undefined {
	const navigation = win.performance
		.getEntriesByType("navigation")
		.at(0)?.name;
	const fromHref = readChatBootstrap(win.location.href);
	if (fromHref) {
		win.history.replaceState(
			win.history.state,
			"",
			stripChatMarker(win.location.href),
		);
	}
	const fresh =
		fromHref ??
		(navigation === undefined ? undefined : readChatBootstrap(navigation));
	if (fresh) {
		storeLocalBootstrap(storage, fresh);
		return fresh;
	}
	const stored = storage.get(STORED_BOOTSTRAP_KEY);
	if (!stored) return undefined;
	try {
		return validateSessionBootstrap(JSON.parse(stored));
	} catch {
		return undefined;
	}
}
