import { describe, expect, mock, spyOn, test } from "bun:test";
import {
	CHAT_PROTOCOL_VERSION,
	OVERWATCH_SESSION_ID,
	type ChatFrame,
	type SessionBootstrap,
} from "@dg/common";
import { MSG } from "@dg/pages/chat-messages";
import { readChatBootstrap } from "@dg/pages/chat-marker";
import { createPages, type PagesBrowserApi } from "@/lib/background/pages";
import { flushMicrotasks, makeBootstrap } from "./utils/relay-harness";

type OpenTab = { id?: number; windowId?: number; url?: string };

function makeApi(tabs: OpenTab[] = []) {
	const clickListeners: Array<(tab?: chrome.tabs.Tab) => void> = [];
	const tabsCreate = mock((_props: { url: string }) => Promise.resolve());
	const tabsQuery = mock((_info: object) => Promise.resolve(tabs));
	const tabsUpdate = mock(
		(_id: number, _props: { url?: string; active: boolean }) =>
			Promise.resolve(),
	);
	const tabsReload = mock((_id: number) => Promise.resolve());
	const windowsUpdate = mock((_id: number, _props: { focused: boolean }) =>
		Promise.resolve(),
	);
	const sendMessage = mock((_message: unknown) => Promise.resolve(undefined));
	const openOptionsPage = mock(() => Promise.resolve());
	const onClicked = {
		addListener: mock((cb: (tab?: chrome.tabs.Tab) => void) => {
			clickListeners.push(cb);
		}),
	};
	const api = {
		action: { onClicked },
		runtime: {
			getURL: (path: string) => `chrome-extension://test-ext/${path}`,
			sendMessage,
			openOptionsPage,
		},
		tabs: {
			create: tabsCreate,
			query: tabsQuery,
			update: tabsUpdate,
			reload: tabsReload,
		},
		windows: { update: windowsUpdate },
	} as unknown as PagesBrowserApi;
	return {
		api,
		onClicked,
		clickListeners,
		tabsCreate,
		tabsQuery,
		tabsUpdate,
		tabsReload,
		windowsUpdate,
		sendMessage,
		openOptionsPage,
	};
}

function overwatchOpen(requestId = "open-1"): ChatFrame {
	return {
		type: "overwatch-open",
		sessionId: OVERWATCH_SESSION_ID,
		protocolVersion: CHAT_PROTOCOL_VERSION,
		requestId,
	} as ChatFrame;
}

async function open(
	setup: ReturnType<typeof makeApi>,
	bootstrap: SessionBootstrap | undefined,
	frame: ChatFrame = overwatchOpen(),
) {
	const sendCompletion = mock((_r: unknown) => undefined);
	const pages = createPages({ browserApi: setup.api });
	pages.onFrame(frame, { sendCompletion, bootstrap });
	await flushMicrotasks();
	return sendCompletion;
}

describe("createPages overwatch-open", () => {
	test("opens the daemon board with the first confirmed bootstrap in the fragment", async () => {
		const setup = makeApi();
		const bootstrap = makeBootstrap({ port: 4320 });
		const sendCompletion = await open(setup, bootstrap);

		expect(setup.tabsCreate).toHaveBeenCalledTimes(1);
		const url = (setup.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		const parsed = new URL(url);
		expect(parsed.origin).toBe("http://127.0.0.1:4320");
		expect(parsed.pathname).toBe("/board");
		expect(readChatBootstrap(url)).toEqual(bootstrap);
		expect(sendCompletion).toHaveBeenCalledWith({
			requestId: "open-1",
			ok: true,
		});
	});

	test("never opens an extension page", async () => {
		const setup = makeApi();
		await open(setup, makeBootstrap());
		const url = (setup.tabsCreate.mock.calls[0]?.[0] as { url: string }).url;
		expect(url).not.toContain("chrome-extension://");
		expect(url).not.toContain("overwatch.html");
	});

	test("navigates an open board tab to the bootstrap-bearing URL, reloads and focuses it, and creates none", async () => {
		const setup = makeApi([
			{ id: 41, windowId: 7, url: "http://127.0.0.1:4317/board" },
		]);
		const bootstrap = makeBootstrap({ port: 4317 });
		const sendCompletion = await open(setup, bootstrap);

		const [tabId, props] = setup.tabsUpdate.mock.calls[0] ?? [];
		expect(tabId).toBe(41);
		expect(props?.active).toBe(true);
		expect(new URL(props?.url ?? "").pathname).toBe("/board");
		expect(readChatBootstrap(props?.url ?? "")).toEqual(bootstrap);
		expect(setup.tabsReload).toHaveBeenCalledWith(41);
		expect(setup.windowsUpdate).toHaveBeenCalledWith(7, { focused: true });
		expect(setup.tabsCreate).not.toHaveBeenCalled();
		expect(sendCompletion).toHaveBeenCalledWith({
			requestId: "open-1",
			ok: true,
		});
	});

	test("finds the open board by origin and path, not by a URL pattern carrying the marker", async () => {
		const setup = makeApi([
			{ id: 41, windowId: 7, url: "http://127.0.0.1:4317/board?tab=2" },
		]);
		await open(setup, makeBootstrap({ port: 4317 }));

		const queries = setup.tabsQuery.mock.calls.map(([info]) =>
			JSON.stringify(info),
		);
		for (const query of queries) expect(query).not.toContain("_chat");
		expect(setup.tabsUpdate.mock.calls[0]?.[0]).toBe(41);
		expect(setup.tabsCreate).not.toHaveBeenCalled();
	});

	test("ignores board tabs on another port and other local pages", async () => {
		const setup = makeApi([
			{ id: 1, windowId: 1, url: "http://127.0.0.1:4999/board" },
			{ id: 2, windowId: 1, url: "http://127.0.0.1:4317/chat" },
			{ id: 3, windowId: 1, url: "https://example.com/board" },
			{ id: 4, windowId: 1 },
		]);
		await open(setup, makeBootstrap({ port: 4317 }));

		expect(setup.tabsUpdate).not.toHaveBeenCalled();
		expect(setup.tabsCreate).toHaveBeenCalledTimes(1);
	});

	test("reports a tab creation failure to the daemon", async () => {
		const setup = makeApi();
		setup.tabsCreate.mockImplementation(() =>
			Promise.reject(new Error("tab failed")),
		);
		const log = spyOn(console, "error").mockImplementation(() => undefined);
		try {
			const sendCompletion = await open(setup, makeBootstrap());
			expect(sendCompletion).toHaveBeenCalledWith({
				requestId: "open-1",
				ok: false,
				error: "tab failed",
			});
		} finally {
			log.mockRestore();
		}
	});

	test("opens nothing when no bootstrap is confirmed", async () => {
		const setup = makeApi();
		const sendCompletion = await open(setup, undefined);

		expect(setup.tabsCreate).not.toHaveBeenCalled();
		expect(setup.tabsUpdate).not.toHaveBeenCalled();
		expect(sendCompletion).not.toHaveBeenCalled();
	});

	test("does not forward an overwatch-state frame to extension pages", async () => {
		const setup = makeApi();
		const sendCompletion = await open(setup, makeBootstrap(), {
			type: "overwatch-state",
			sessionId: OVERWATCH_SESSION_ID,
			protocolVersion: CHAT_PROTOCOL_VERSION,
		} as unknown as ChatFrame);

		expect(setup.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: MSG.overwatchState }),
		);
		expect(sendCompletion).not.toHaveBeenCalled();
		expect(setup.tabsCreate).not.toHaveBeenCalled();
	});
});

describe("createPages without a toolbar click handler", () => {
	test("exposes no action click registration and adds no click listener", () => {
		const setup = makeApi();

		const pages = createPages({ browserApi: setup.api } as never);

		expect(pages).not.toHaveProperty("registerActionClick");
		expect(setup.onClicked.addListener).not.toHaveBeenCalled();
	});
});
