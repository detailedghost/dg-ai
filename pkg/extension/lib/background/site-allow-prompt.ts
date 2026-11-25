import { describeError } from "@dg/common";
import type { AgentTabsStorage } from "./agent-tabs";
import { isOwnPageSender } from "./popup-sender";
import type { SessionControl } from "./session-control";
import { siteOf } from "./site-key";
import { allowedPage } from "./tab-guards";

export type SiteAllowRequest = { sessionId: string; siteKey: string };
export type SiteAllowAnswer = "allow" | "deny";

export const SITE_ALLOW_TIMEOUT_MS = 60_000;
export const SITE_ALLOW_PAGE = "/site-allow.html";
export const SITE_ALLOW_MSG = {
	get: "dg-site-allow:get",
	answer: "dg-site-allow:answer",
} as const;

export class PhiCaptureRefusedError extends Error {
	constructor(site: string) {
		super(`${site} is flagged as PHI for this session; snapshot and screenshot are refused there.`);
	}
}

export type SiteAllowWindows = {
	open(url: string): Promise<number | undefined>;
	close(windowId: number): Promise<void>;
	onRemoved(listener: (windowId: number) => void): void;
};

type Pending = {
	request: SiteAllowRequest;
	resolve(answer: SiteAllowAnswer, phi: boolean): void;
	windowId?: number;
};

const phiPrefix = (sessionId: string) => `agentWindowPhi:${sessionId}:`;
const phiKey = (sessionId: string, siteKey: string) => `${phiPrefix(sessionId)}${siteKey}`;

/** Asks the person to allow each new site per session before the agent window loads it. */
export function createSiteAllow({
	control,
	storage,
	windows,
	pageUrl,
	navigate,
	timeoutMs = SITE_ALLOW_TIMEOUT_MS,
	newId = () => crypto.randomUUID(),
}: {
	control: Pick<SessionControl, "allowed" | "allow">;
	storage: Pick<AgentTabsStorage, "session">;
	windows: SiteAllowWindows;
	pageUrl(path: string): string;
	navigate(sessionId: string, url: string): Promise<void>;
	timeoutMs?: number;
	newId?: () => string;
}) {
	const pending = new Map<string, Pending>();
	const asking = new Map<string, Promise<SiteAllowAnswer>>();

	windows.onRemoved((windowId) => {
		for (const entry of pending.values()) if (entry.windowId === windowId) entry.resolve("deny", false);
	});

	function prompt(request: SiteAllowRequest): Promise<{ answer: SiteAllowAnswer; phi: boolean }> {
		const id = newId();
		return new Promise((resolve) => {
			const timer = setTimeout(() => entry.resolve("deny", false), timeoutMs);
			const entry: Pending = {
				request,
				resolve(answer, phi) {
					if (pending.get(id) !== entry) return;
					pending.delete(id);
					clearTimeout(timer);
					resolve({ answer, phi: answer === "allow" && phi });
					if (entry.windowId !== undefined) void windows.close(entry.windowId).catch(() => undefined);
				},
			};
			pending.set(id, entry);
			windows
				.open(pageUrl(`${SITE_ALLOW_PAGE}?id=${encodeURIComponent(id)}`))
				.then((windowId) => {
					if (windowId === undefined) entry.resolve("deny", false);
					else if (pending.get(id) === entry) entry.windowId = windowId;
					else void windows.close(windowId).catch(() => undefined);
				})
				.catch((error: unknown) => {
					console.warn("[dg-ai-extension] site allow window failed", describeError(error));
					entry.resolve("deny", false);
				});
		});
	}

	async function ask({ sessionId, siteKey }: SiteAllowRequest): Promise<SiteAllowAnswer> {
		const { answer, phi } = await prompt({ sessionId, siteKey });
		if (answer !== "allow") return "deny";
		if (phi) await storage.session.set({ [phiKey(sessionId, siteKey)]: true });
		await control.allow(sessionId, siteKey);
		if (await control.allowed(sessionId, siteKey)) return "allow";
		if (phi) await storage.session.remove(phiKey(sessionId, siteKey));
		return "deny";
	}

	async function requestSiteAllow(request: SiteAllowRequest): Promise<SiteAllowAnswer> {
		if (await control.allowed(request.sessionId, request.siteKey)) return "allow";
		const key = `${request.sessionId}\n${request.siteKey}`;
		let held = asking.get(key);
		if (!held) {
			held = ask(request);
			asking.set(key, held);
			void held.then(
				() => asking.delete(key),
				() => asking.delete(key),
			);
		}
		return held;
	}

	return {
		requestSiteAllow,

		/** Loads the url in the session's agent window only after the person allows its site. */
		async openSite({ sessionId, url }: { sessionId: string; url: string }): Promise<SiteAllowAnswer> {
			if (!allowedPage(url)) throw new Error(`${url} is not a web page the agent may open.`);
			const answer = await requestSiteAllow({ sessionId, siteKey: siteOf(url).key });
			if (answer === "allow") await navigate(sessionId, url);
			return answer;
		},

		async assertCaptureAllowed(sessionId: string, url: string): Promise<void> {
			const { key } = siteOf(url);
			if ((await storage.session.get(phiKey(sessionId, key)))[phiKey(sessionId, key)] === true)
				throw new PhiCaptureRefusedError(key);
		},

		async forget(sessionId: string): Promise<void> {
			const prefix = phiPrefix(sessionId);
			const keys = Object.keys(await storage.session.get(null)).filter((key) => key.startsWith(prefix));
			await Promise.all(keys.map((key) => storage.session.remove(key)));
		},

		/** What the prompt page shows; undefined once answered or expired. */
		show(id: string): SiteAllowRequest | undefined {
			return pending.get(id)?.request;
		},

		answer(id: string, allow: boolean, phi = false): void {
			pending.get(id)?.resolve(allow ? "allow" : "deny", phi);
		},
	};
}

export type SiteAllow = ReturnType<typeof createSiteAllow>;

type SiteAllowRuntime = {
	id?: string;
	getURL(path: string): string;
	onMessage: {
		addListener(
			listener: (message: unknown, sender: unknown, sendResponse: (reply: unknown) => void) => unknown,
		): void;
	};
};

/** Answers the prompt page; only the extension's own site-allow page may read or answer a request. */
export function registerSiteAllow({ siteAllow, runtime }: { siteAllow: SiteAllow; runtime: SiteAllowRuntime }): void {
	const page = runtime.getURL(SITE_ALLOW_PAGE);
	runtime.onMessage.addListener((message, sender, sendResponse) => {
		const { type, id, allow, phi } = (message ?? {}) as Record<string, unknown>;
		if (type !== SITE_ALLOW_MSG.get && type !== SITE_ALLOW_MSG.answer) return undefined;
		if (!isOwnPageSender(sender, runtime.id, page) || typeof id !== "string") {
			sendResponse(undefined);
			return undefined;
		}
		if (type === SITE_ALLOW_MSG.get) sendResponse(siteAllow.show(id));
		else {
			siteAllow.answer(id, allow === true, phi === true);
			sendResponse(true);
		}
		return undefined;
	});
}
