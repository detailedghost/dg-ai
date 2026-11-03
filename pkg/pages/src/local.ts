import { type SessionBootstrap, validateSessionBootstrap } from "@dg/common";
import { readChatBootstrap, stripChatMarker } from "./chat-marker";
import { browserStorage, memoryStorage, type PageStorage } from "./runtime";

const STORED_BOOTSTRAP_KEY = "dg_local_bootstrap";

export const SESSION_ENDED_TEXT =
	"Your session has ended, so run dg-agent start --open again to get a new link.";
const REFUSED_TOKENS_KEY = "dg_local_refused";

function refusedTokens(storage: PageStorage): string[] {
	try {
		const parsed: unknown = JSON.parse(storage.get(REFUSED_TOKENS_KEY) ?? "[]");
		return Array.isArray(parsed)
			? parsed.filter((token): token is string => typeof token === "string")
			: [];
	} catch {
		return [];
	}
}

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

export function forgetLocalBootstrap(
	storage: PageStorage,
	token: string,
): void {
	storage.set(STORED_BOOTSTRAP_KEY, "");
	const refused = refusedTokens(storage);
	if (!refused.includes(token)) {
		storage.set(REFUSED_TOKENS_KEY, JSON.stringify([...refused, token]));
	}
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
	const refused = refusedTokens(storage);
	const presented =
		fromHref ??
		(navigation === undefined ? undefined : readChatBootstrap(navigation));
	const fresh =
		presented && !refused.includes(presented.token) ? presented : undefined;
	if (fresh) {
		storeLocalBootstrap(storage, fresh);
		return fresh;
	}
	const stored = storage.get(STORED_BOOTSTRAP_KEY);
	if (!stored) return undefined;
	try {
		const bootstrap = validateSessionBootstrap(JSON.parse(stored));
		return refused.includes(bootstrap.token) ? undefined : bootstrap;
	} catch {
		return undefined;
	}
}
