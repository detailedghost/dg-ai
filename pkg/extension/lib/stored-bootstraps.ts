import { type SessionBootstrap, validateSessionBootstrap } from "@dg/common";
import { CHAT_SESSION_KEY_PREFIX } from "@dg/pages/chat-messages";
import { browser } from "wxt/browser";

/** Session bootstraps the background keeps in extension session storage. */
export async function loadStoredBootstraps(): Promise<SessionBootstrap[]> {
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
