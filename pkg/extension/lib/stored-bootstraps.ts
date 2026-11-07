import type { SessionBootstrap } from "@dg/common";
import { browser } from "wxt/browser";
import { createPairingStore } from "@/lib/background/pairing-store";

/** Pairings the background keeps in extension local storage. */
export function loadStoredBootstraps(): Promise<SessionBootstrap[]> {
	return createPairingStore({ storage: browser.storage }).list();
}
