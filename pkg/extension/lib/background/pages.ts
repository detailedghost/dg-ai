import { type ChatFrame, emitRedacted } from "@dg/common";
import { MSG } from "@dg/pages/chat-messages";

export const CHAT_PAGE_PATH = "chat.html";
export const OVERWATCH_PAGE_PATH = "overwatch.html";

type ActionApi = {
	onClicked: {
		addListener(listener: (tab?: chrome.tabs.Tab) => void): void;
	};
};

export type PagesBrowserApi = {
	action?: ActionApi;
	browserAction?: ActionApi;
	runtime: {
		getURL(path: string): string;
		sendMessage(message: unknown): Promise<unknown>;
	};
	tabs: {
		create(props: { url: string }): unknown;
		query?(queryInfo: {
			url: string;
		}): Promise<{ id?: number; windowId?: number }[]>;
		update?(tabId: number, props: { active: boolean }): unknown;
	};
	windows?: {
		update(windowId: number, props: { focused: boolean }): unknown;
	};
	sidePanel?: {
		open(options: { tabId?: number }): Promise<void>;
	};
};

export type OverwatchBrowserApi = Pick<
	PagesBrowserApi,
	"runtime" | "tabs" | "windows"
>;

export type OverwatchOpenCompletion = {
	requestId: string;
	ok: boolean;
	error?: string;
};

export async function handleOverwatchFrame(
	frame: ChatFrame,
	api: OverwatchBrowserApi,
): Promise<OverwatchOpenCompletion | undefined> {
	if (frame.type === "overwatch-state") {
		await api.runtime
			.sendMessage({ type: MSG.overwatchState, frame })
			.catch(() => undefined);
		return undefined;
	}
	if (frame.type !== "overwatch-open") return undefined;
	const url = api.runtime.getURL(OVERWATCH_PAGE_PATH);
	const matches = api.tabs.query ? await api.tabs.query({ url }) : [];
	const existing = matches[0];
	if (existing?.id !== undefined && api.tabs.update) {
		await api.tabs.update(existing.id, { active: true });
		if (existing.windowId !== undefined && api.windows) {
			await api.windows.update(existing.windowId, { focused: true });
		}
		return { requestId: frame.requestId, ok: true };
	}
	await api.tabs.create({ url });
	return { requestId: frame.requestId, ok: true };
}

export async function handleOverwatchFrameSafely(
	frame: ChatFrame,
	api: OverwatchBrowserApi,
	complete: (result: OverwatchOpenCompletion) => void = () => undefined,
): Promise<void> {
	try {
		const result = await handleOverwatchFrame(frame, api);
		if (result) complete(result);
	} catch (error) {
		if (frame.type === "overwatch-open") {
			complete({
				requestId: frame.requestId,
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
		emitRedacted(
			(line) => console.error(line),
			`[dg-ai-extension] overwatch frame failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function resolveActionApi(api: PagesBrowserApi): ActionApi {
	const action = api.action ?? api.browserAction;
	if (!action) throw new Error("no action or browserAction API available");
	return action;
}

export function createPages({
	browserApi: api,
	maybeStartRecording,
}: {
	browserApi: PagesBrowserApi;
	maybeStartRecording: (tab?: chrome.tabs.Tab) => Promise<boolean>;
}) {
	async function presentChat(tab?: { id?: number }): Promise<void> {
		if (api.sidePanel) {
			try {
				await api.sidePanel.open(
					tab?.id !== undefined ? { tabId: tab.id } : {},
				);
				return;
			} catch {
				// Opening the side panel needs a user gesture Chrome will accept.
			}
		}
		const url = api.runtime.getURL(CHAT_PAGE_PATH);
		const matches = api.tabs.query ? await api.tabs.query({ url }) : [];
		const existing = matches[0];
		if (existing?.id !== undefined && api.tabs.update) {
			await api.tabs.update(existing.id, { active: true });
			if (existing.windowId !== undefined && api.windows) {
				await api.windows.update(existing.windowId, { focused: true });
			}
			return;
		}
		await api.tabs.create({ url });
	}

	return {
		presentChat,
		onFrame(
			frame: ChatFrame,
			sendCompletion: (result: OverwatchOpenCompletion) => void,
		): void {
			void handleOverwatchFrameSafely(frame, api, sendCompletion);
		},
		registerActionClick(): void {
			resolveActionApi(api).onClicked.addListener((tab) => {
				void (async () => {
					if (await maybeStartRecording(tab)) return;
					await presentChat(tab);
				})();
			});
		},
	};
}
