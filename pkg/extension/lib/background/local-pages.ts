import {
	type ChatFrame,
	type SessionBootstrap,
	describeError,
	emitRedacted,
} from "@dg/common";
import { localPageUrl } from "@dg/pages/chat-marker";

export type PagesBrowserApi = {
	runtime: {
		getURL(path: string): string;
		sendMessage(message: unknown): Promise<unknown>;
	};
	tabs: {
		create(props: { url: string }): unknown;
		query?(queryInfo: { url?: string }): Promise<
			{ id?: number; windowId?: number; url?: string }[]
		>;
		update?(
			tabId: number,
			props: { url?: string; active?: boolean },
		): unknown;
		reload?(tabId: number): unknown;
	};
	windows?: {
		update(windowId: number, props: { focused: boolean }): unknown;
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

export function originAndPath(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return parsed.origin + parsed.pathname;
	} catch {
		return undefined;
	}
}

export async function openLocalPage(
	api: OverwatchBrowserApi,
	{ url, query }: { url: string; query: { url?: string } },
): Promise<void> {
	const page = originAndPath(url);
	const tabs = api.tabs.query ? await api.tabs.query(query) : [];
	const existing = tabs.find(
		(tab) => tab.id !== undefined && originAndPath(tab.url) === page,
	);
	if (existing?.id === undefined || !api.tabs.update || !api.tabs.reload) {
		await api.tabs.create({ url });
		return;
	}
	await api.tabs.update(existing.id, { url, active: true });
	await api.tabs.reload(existing.id);
	if (existing.windowId !== undefined) {
		await api.windows?.update(existing.windowId, { focused: true });
	}
}

export async function handleOverwatchFrame(
	frame: ChatFrame,
	api: OverwatchBrowserApi,
	bootstrap: SessionBootstrap | undefined,
): Promise<OverwatchOpenCompletion | undefined> {
	if (frame.type !== "overwatch-open" || !bootstrap) return undefined;
	const url = localPageUrl({
		port: bootstrap.port,
		path: "/board",
		bootstrap,
	});
	await openLocalPage(api, { url, query: {} });
	return { requestId: frame.requestId, ok: true };
}

export async function handleOverwatchFrameSafely(
	frame: ChatFrame,
	api: OverwatchBrowserApi,
	{
		bootstrap,
		complete,
	}: {
		bootstrap: SessionBootstrap | undefined;
		complete: (result: OverwatchOpenCompletion) => void;
	},
): Promise<void> {
	try {
		const result = await handleOverwatchFrame(frame, api, bootstrap);
		if (result) complete(result);
	} catch (error) {
		if (frame.type === "overwatch-open") {
			complete({
				requestId: frame.requestId,
				ok: false,
				error: describeError(error),
			});
		}
		emitRedacted(
			(line) => console.error(line),
			`[dg-ai-extension] overwatch frame failed: ${describeError(error)}`,
		);
	}
}

export function createPages({ browserApi: api }: { browserApi: PagesBrowserApi }) {
	return {
		onFrame(
			frame: ChatFrame,
			{
				sendCompletion,
				bootstrap,
			}: {
				sendCompletion: (result: OverwatchOpenCompletion) => void;
				bootstrap: SessionBootstrap | undefined;
			},
		): void {
			void handleOverwatchFrameSafely(frame, api, {
				bootstrap,
				complete: sendCompletion,
			});
		},
	};
}
