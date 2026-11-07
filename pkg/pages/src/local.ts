import {
	CHAT_ATTACH_PATH,
	CHAT_EXCHANGE_PATH,
	type SessionBootstrap,
	tryValidateSessionBootstrap,
} from "@dg/common";
import { readChatCode, stripChatMarker } from "./chat-marker";
import { browserStorage, memoryStorage, type PageStorage } from "./runtime";

const LEGACY_BOOTSTRAP_KEY = "dg_local_bootstrap";
const HELD_BOOTSTRAPS_KEY = "dg_local_bootstraps";
const HELD_BOOTSTRAPS_MAX = 16;

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

function readHeld(storage: PageStorage): SessionBootstrap[] {
	try {
		const parsed: unknown = JSON.parse(
			storage.get(HELD_BOOTSTRAPS_KEY) ?? "[]",
		);
		if (!Array.isArray(parsed)) return [];
		return parsed.flatMap((entry) => tryValidateSessionBootstrap(entry) ?? []);
	} catch {
		return [];
	}
}

function readLegacy(storage: PageStorage): SessionBootstrap | undefined {
	const stored = storage.get(LEGACY_BOOTSTRAP_KEY);
	if (!stored) return undefined;
	try {
		return tryValidateSessionBootstrap(JSON.parse(stored));
	} catch {
		return undefined;
	}
}

function withEntry(
	held: SessionBootstrap[],
	entry: SessionBootstrap,
	refused: readonly string[],
): SessionBootstrap[] {
	const known = held.some((item) => item.sessionId === entry.sessionId);
	const next = known
		? held.map((item) => (item.sessionId === entry.sessionId ? entry : item))
		: [...held, entry];
	if (next.length <= HELD_BOOTSTRAPS_MAX) return next;
	const dead = next.findIndex(
		(item) =>
			item.sessionId !== entry.sessionId && refused.includes(item.token),
	);
	return next.filter((_, index) => index !== Math.max(dead, 0));
}

export function storeLocalBootstraps(
	storage: PageStorage,
	bootstraps: SessionBootstrap[],
): void {
	storage.set(HELD_BOOTSTRAPS_KEY, JSON.stringify(bootstraps));
}

export function storeLocalBootstrap(
	storage: PageStorage,
	bootstrap: SessionBootstrap,
): void {
	storeLocalBootstraps(
		storage,
		withEntry(readHeld(storage), bootstrap, refusedTokens(storage)),
	);
}

export function forgetLocalBootstrap(
	storage: PageStorage,
	token: string,
): void {
	storeLocalBootstraps(
		storage,
		readHeld(storage).filter((entry) => entry.token !== token),
	);
	const refused = refusedTokens(storage);
	if (!refused.includes(token)) {
		storage.set(REFUSED_TOKENS_KEY, JSON.stringify([...refused, token]));
	}
}

export function loadLocalBootstraps(
	win: Window,
	storage: PageStorage,
	exchanged?: SessionBootstrap,
): SessionBootstrap[] {
	const refused = refusedTokens(storage);
	const pagePort = Number(win.location.port);
	const samePort = (entry: SessionBootstrap) => entry.port === pagePort;
	const legacy = readLegacy(storage);
	let held = readHeld(storage).filter(samePort);
	if (legacy && samePort(legacy)) held = withEntry(held, legacy, refused);
	if (exchanged && samePort(exchanged)) {
		held = withEntry(held, exchanged, refused);
	}
	held = held.filter((entry) => !refused.includes(entry.token));
	if (legacy || exchanged) storeLocalBootstraps(storage, held);
	if (legacy) storage.remove(LEGACY_BOOTSTRAP_KEY);
	const selected = exchanged
		? held.find((entry) => entry.sessionId === exchanged.sessionId)
		: undefined;
	return selected
		? [selected, ...held.filter((entry) => entry !== selected)]
		: held;
}

export function loadLocalBootstrap(
	win: Window,
	storage: PageStorage,
	exchanged?: SessionBootstrap,
): SessionBootstrap | undefined {
	return loadLocalBootstraps(win, storage, exchanged).at(0);
}

/** Strips a one-time code from the address and trades it with the daemon for the session bootstrap. */
export async function exchangeChatCode(
	win: Window,
	fetchFn: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<SessionBootstrap | undefined> {
	const code = readChatCode(win.location.href);
	if (code === undefined) return undefined;
	win.history.replaceState(win.history.state, "", stripChatMarker(win.location.href));
	try {
		const response = await fetchFn(`${win.location.origin}${CHAT_EXCHANGE_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code }),
		});
		return response.ok ? tryValidateSessionBootstrap(await response.json()) : undefined;
	} catch {
		return undefined;
	}
}

export type LocalAttachResult =
	| {
			status: "attached";
			bootstrap: SessionBootstrap;
			refused: SessionBootstrap[];
	  }
	| {
			status: "not-active" | "failed";
			message: string;
			refused: SessionBootstrap[];
	  }
	| { status: "ended"; refused: SessionBootstrap[] };

async function readAttachedBootstrap(
	response: Response,
): Promise<SessionBootstrap | undefined> {
	try {
		const body: unknown = await response.json();
		const sessions = (body as { sessions?: unknown }).sessions;
		return Array.isArray(sessions) ? tryValidateSessionBootstrap(sessions[0]) : undefined;
	} catch {
		return undefined;
	}
}

/** Asks the daemon for one unheld session with each held token in turn. */
export async function attachLocalSession(
	origin: string,
	sessionId: string,
	held: SessionBootstrap[],
): Promise<LocalAttachResult> {
	const refused: SessionBootstrap[] = [];
	for (const bearer of held) {
		let response: Response;
		try {
			response = await fetch(`${origin}${CHAT_ATTACH_PATH}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${bearer.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ intent: "attach", sessionId }),
			});
		} catch {
			return {
				status: "failed",
				message: "Could not reach the daemon.",
				refused,
			};
		}
		if (response.status === 403) {
			refused.push(bearer);
			continue;
		}
		if (!response.ok) {
			const message = await response.text().catch(() => "");
			return {
				status: response.status === 404 ? "not-active" : "failed",
				message: message || "Could not attach that session.",
				refused,
			};
		}
		const bootstrap = await readAttachedBootstrap(response);
		return bootstrap
			? { status: "attached", bootstrap, refused }
			: {
					status: "failed",
					message: "The daemon sent an unreadable answer.",
					refused,
				};
	}
	return refused.length === held.length
		? { status: "ended", refused }
		: {
				status: "failed",
				message: "Could not attach that session. Try again.",
				refused,
			};
}
