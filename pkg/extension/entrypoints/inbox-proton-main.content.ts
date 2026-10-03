import { executeProtonPage } from "@/lib/features/inbox-proton";
import { installProtonSessionObserver } from "@/lib/features/inbox-proton-observer";
import type { InboxBrowserRequest } from "@dg/common";

/** Installs the account-bound MAIN observer and fixed operation entrypoint on supported Proton origins. */
export default defineContentScript({
	matches: ["https://mail.proton.me/*", "https://mail.protonmail.com/*"],
	runAt: "document_start",
	world: "MAIN",
	main() {
		if (Object.hasOwn(globalThis, "__dgInboxProtonV1")) return;
		const observer = installProtonSessionObserver(window);
		Object.defineProperty(globalThis, "__dgInboxProtonV1", {
			value: (request: InboxBrowserRequest) =>
				executeProtonPage(request, {
					origin: location.origin,
					headers: observer.getHeaders(),
					fetch: window.fetch.bind(window),
				}),
			writable: false,
			configurable: false,
		});
	},
});
