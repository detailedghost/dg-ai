import { expect, mock, test } from "bun:test";
import { CHAT_DEFAULT_PORT, type SessionBootstrap } from "@dg/common";
import { MSG } from "@/lib/chat-messages";

mock.module("wxt/browser", () => ({ browser: {} }));

const { registerChat } = await import("@/lib/background/chat");

function makeBootstrap(overrides: Partial<SessionBootstrap> = {}): SessionBootstrap {
	return {
		port: CHAT_DEFAULT_PORT,
		sessionId: "sess-harness",
		token: "tok-harness-secret-value",
		agentIdentity: "claude",
		...overrides,
	};
}

test("the toolbar opens the side panel instead of a new tab when the browser allows it", async () => {
	const sideOpen = mock(() => Promise.resolve());
	const tabsCreate = mock(() => Promise.resolve());
	let onClicked: ((tab?: chrome.tabs.Tab) => void) | undefined;
	registerChat({
		browserApi: {
			action: {
				onClicked: {
					addListener(cb) {
						onClicked = cb;
					},
				},
			},
			runtime: {
				onMessage: { addListener() {} },
				getURL: (path) => `chrome-extension://test/${path}`,
				getManifest: () => ({ version: "1.12.0" }),
				sendMessage: () => Promise.resolve(undefined),
			},
			tabs: { create: tabsCreate },
			storage: { session: { set: () => Promise.resolve(), remove: () => Promise.resolve() } },
			sidePanel: { open: sideOpen },
		},
		maybeStartRecording: () => Promise.resolve(false),
	});

	onClicked?.({ id: 4 } as chrome.tabs.Tab);
	await Promise.resolve();
	await Promise.resolve();

	expect(sideOpen).toHaveBeenCalledWith({ tabId: 4 });
	expect(tabsCreate).not.toHaveBeenCalled();
});

test("an attach reply that fails does not echo a stored session token", async () => {
	const bootstrap = makeBootstrap();
	let listener:
		| ((
				message: unknown,
				sender: unknown,
				sendResponse: (response: unknown) => void,
		  ) => boolean | undefined)
		| undefined;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = mock((input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/healthz")) {
			return Promise.resolve(
				Response.json({ daemon: "dg-daemon", instanceId: "test-instance" }),
			);
		}
		return Promise.resolve(new Response(`nope ${bootstrap.token}`, { status: 404 }));
	}) as unknown as typeof fetch;
	try {
		registerChat({
			browserApi: {
				action: { onClicked: { addListener() {} } },
				runtime: {
					onMessage: {
						addListener(cb) {
							listener = cb;
						},
					},
					getURL: (path) => `chrome-extension://test/${path}`,
					getManifest: () => ({ version: "1.12.0" }),
					sendMessage: () => Promise.resolve(undefined),
				},
				tabs: { create: () => Promise.resolve() },
				storage: {
					session: {
						set: () => Promise.resolve(),
						remove: () => Promise.resolve(),
						get: () => Promise.resolve({ ["chat_session:" + bootstrap.sessionId]: bootstrap }),
					},
				},
			},
			openSocket: () => ({
				send() {},
				close() {},
				addEventListener() {},
			}),
		});
		const sendResponse = mock(() => undefined);
		listener?.(
			{ type: MSG.sessionAttach, all: true, code: "123456" },
			{ url: "chrome-extension://test/chat.html" },
			sendResponse,
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const calls = sendResponse.mock.calls as unknown as unknown[][];
		const reply = calls[0]?.[0] as { error?: string } | undefined;
		expect(reply?.error).not.toContain(bootstrap.token);
		expect(reply?.error).toContain("[redacted]");
	} finally {
		globalThis.fetch = originalFetch;
	}
});
