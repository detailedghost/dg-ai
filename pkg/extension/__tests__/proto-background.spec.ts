import { afterEach, expect, it, mock } from "bun:test";
import { registerProto } from "@/lib/background/proto";
import {
	PROTO_CAPTURE_PREVIEW,
	PROTO_SAVE_VERDICT,
} from "@/lib/features/prototype";

const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
const consoleErrorDescriptor = Object.getOwnPropertyDescriptor(
	console,
	"error",
);

afterEach(() => {
	if (chromeDescriptor) {
		Object.defineProperty(globalThis, "chrome", chromeDescriptor);
	} else {
		Reflect.deleteProperty(globalThis, "chrome");
	}
	if (consoleErrorDescriptor) {
		Object.defineProperty(console, "error", consoleErrorDescriptor);
	}
});

type ProtoListener = (
	message: unknown,
	sender: { tab?: { id?: number; windowId?: number } },
	sendResponse: (response: unknown) => void,
) => boolean | undefined;

type DownloadDelta = {
	id: number;
	state?: { current: string };
	error?: { current: string };
};

function downloadChanges() {
	let listener: ((delta: DownloadDelta) => void) | undefined;
	const addListener = mock((callback: (delta: DownloadDelta) => void) => {
		listener = callback;
	});
	const removeListener = mock((callback: (delta: DownloadDelta) => void) => {
		if (listener === callback) listener = undefined;
	});
	return {
		addListener,
		emit(delta: DownloadDelta) {
			listener?.(delta);
		},
		hasListener() {
			return listener !== undefined;
		},
		onChanged: { addListener, removeListener },
		removeListener,
	};
}

function installChrome(
	value: object,
	options: { previewDownloadTimeoutMs?: number } = {},
): ProtoListener {
	let listener: ProtoListener | undefined;
	const api = {
		runtime: {
			onMessage: {
				addListener(callback: ProtoListener) {
					listener = callback;
				},
			},
		},
		...value,
	};
	Object.defineProperty(globalThis, "chrome", {
		configurable: true,
		value: api,
	});
	registerProto({ ...options, browserApi: api as never });
	if (!listener) throw new Error("prototype listener was not registered");
	return listener;
}

it("observes asynchronous verdict download rejection", async () => {
	const failure = new Error("download rejected");
	const download = mock(() => Promise.reject(failure));
	const logged = mock(() => {});
	Object.defineProperty(console, "error", {
		configurable: true,
		value: logged,
	});
	const listener = installChrome({ downloads: { download } });
	listener(
		{
			type: PROTO_SAVE_VERDICT,
			verdict: {
				slug: "account-summary",
				action: "approve",
				selectedKey: "compact",
				ts: 1,
			},
		},
		{},
		() => {},
	);
	await Promise.resolve();
	await Promise.resolve();

	expect(download).toHaveBeenCalledTimes(1);
	expect(logged).toHaveBeenCalledWith(
		"[dg-ai-extension] verdict download failed:",
		failure,
	);
});

it("supports callback-only verdict downloads without reporting a false failure", async () => {
	const download = mock(
		(_options: unknown, callback: (downloadId: number) => void) => {
			callback(11);
		},
	);
	const logged = mock(() => {});
	Object.defineProperty(console, "error", {
		configurable: true,
		value: logged,
	});
	const listener = installChrome({ downloads: { download } });

	listener(
		{
			type: PROTO_SAVE_VERDICT,
			verdict: {
				slug: "account-summary",
				action: "approve",
				selectedKey: "compact",
				ts: 1,
			},
		},
		{},
		() => {},
	);
	await Promise.resolve();

	expect(download).toHaveBeenCalledTimes(1);
	expect(logged).not.toHaveBeenCalled();
});

it("skips preview capture when the sender tab is no longer active", async () => {
	const query = mock(async () => [{ id: 99 }]);
	const captureVisibleTab = mock(() => {});
	const download = mock(async () => 1);
	const listener = installChrome({
		downloads: { download },
		tabs: { captureVisibleTab, query },
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const response = await new Promise<unknown>((resolve) => {
		expect(
			listener(
				{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
				{ tab: { id: 7, windowId: 3 } },
				resolve,
			),
		).toBe(true);
	});

	expect(response).toEqual({
		saved: false,
		reason: "prototype tab is no longer active",
	});
	expect(query).toHaveBeenCalledWith(
		{ active: true, windowId: 3 },
		expect.any(Function),
	);
	expect(captureVisibleTab).not.toHaveBeenCalled();
	expect(download).not.toHaveBeenCalled();
});

it("supports callback-only query, capture, and preview download APIs", async () => {
	const changes = downloadChanges();
	const query = mock(
		(_queryInfo: unknown, callback: (tabs: Array<{ id: number }>) => void) => {
			callback([{ id: 7 }]);
		},
	);
	const captureVisibleTab = mock(
		(
			_windowId: number,
			_options: unknown,
			callback: (dataUrl: string) => void,
		) => {
			callback("data:image/png;base64,cHJldmlldw==");
		},
	);
	const download = mock(
		(_options: unknown, callback: (downloadId: number) => void) => {
			callback(17);
			changes.emit({ id: 17, state: { current: "complete" } });
		},
	);
	const listener = installChrome({
		downloads: { download, onChanged: changes.onChanged },
		tabs: { captureVisibleTab, query },
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const response = await new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			resolve,
		);
	});

	expect(response).toEqual({ saved: true });
	expect(query).toHaveBeenCalledTimes(2);
	expect(captureVisibleTab).toHaveBeenCalledTimes(1);
	expect(download).toHaveBeenCalledTimes(1);
	expect(changes.hasListener()).toBe(false);
});

it("supports Firefox-shaped Promise-only query, capture, and download APIs", async () => {
	const changes = downloadChanges();
	const query = mock((_queryInfo: unknown, callback?: unknown) => {
		if (callback !== undefined) throw new TypeError("too many arguments");
		return Promise.resolve([{ id: 7 }]);
	});
	const captureVisibleTab = mock(
		(_windowId: number, _options: unknown, callback?: unknown) => {
			if (callback !== undefined) throw new TypeError("too many arguments");
			return Promise.resolve("data:image/png;base64,cHJldmlldw==");
		},
	);
	const download = mock((_options: unknown, callback?: unknown) => {
		if (callback !== undefined) throw new TypeError("too many arguments");
		changes.emit({ id: 29, state: { current: "complete" } });
		return Promise.resolve(29);
	});
	const listener = installChrome({
		downloads: { download, onChanged: changes.onChanged },
		tabs: { captureVisibleTab, query },
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const response = await Promise.race([
		new Promise<unknown>((resolve) => {
			listener(
				{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
				{ tab: { id: 7, windowId: 3 } },
				resolve,
			);
		}),
		new Promise((resolve) =>
			setTimeout(
				() => resolve({ saved: false, reason: "timed out in test" }),
				20,
			),
		),
	]);

	expect(response).toEqual({ saved: true });
	expect(query).toHaveBeenCalledTimes(4);
	expect(captureVisibleTab).toHaveBeenCalledTimes(2);
	expect(download).toHaveBeenCalledTimes(2);
	expect(changes.hasListener()).toBe(false);
});

it("degrades gracefully when download completion tracking is unavailable", async () => {
	const download = mock(async () => 1);
	const listener = installChrome({
		downloads: { download },
		tabs: {
			captureVisibleTab(
				_windowId: number,
				_options: unknown,
				callback: (dataUrl: string) => void,
			) {
				callback("data:image/png;base64,cHJldmlldw==");
			},
			query: async () => [{ id: 7 }],
		},
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const response = await new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			resolve,
		);
	});

	expect(response).toEqual({
		saved: false,
		reason: "prototype preview download completion tracking is unsupported",
	});
	expect(download).not.toHaveBeenCalled();
});

it("waits for the matching preview download to complete before responding", async () => {
	const changes = downloadChanges();
	const query = mock(async () => [{ id: 7 }]);
	const captureVisibleTab = mock(
		(
			windowId: number,
			_options: unknown,
			callback: (dataUrl: string) => void,
		) => {
			expect(windowId).toBe(3);
			callback("data:image/png;base64,cHJldmlldw==");
		},
	);
	const download = mock(async () => {
		expect(changes.hasListener()).toBe(true);
		return 17;
	});
	const listener = installChrome({
		downloads: { download, onChanged: changes.onChanged },
		tabs: { captureVisibleTab, query },
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	let responded = false;
	const responsePromise = new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			(response) => {
				responded = true;
				resolve(response);
			},
		);
	});
	for (let attempt = 0; attempt < 10 && !changes.hasListener(); attempt += 1) {
		await Promise.resolve();
	}
	expect(changes.hasListener()).toBe(true);
	expect(responded).toBe(false);

	changes.emit({ id: 99, state: { current: "complete" } });
	changes.emit({ id: 17, state: { current: "in_progress" } });
	await Promise.resolve();
	expect(responded).toBe(false);

	changes.emit({ id: 17, state: { current: "complete" } });
	const response = await responsePromise;

	expect(response).toEqual({ saved: true });
	expect(query).toHaveBeenCalledTimes(2);
	expect(captureVisibleTab).toHaveBeenCalledTimes(1);
	expect(download).toHaveBeenCalledWith(
		{
			url: "data:image/png;base64,cHJldmlldw==",
			filename: "dg-proto/account-summary/preview.png",
			conflictAction: "overwrite",
		},
		expect.any(Function),
	);
	expect(changes.removeListener).toHaveBeenCalledTimes(1);
	expect(changes.hasListener()).toBe(false);
});

it("handles completion before the preview download ID promise resolves", async () => {
	const changes = downloadChanges();
	const query = mock(async () => [{ id: 7 }]);
	const captureVisibleTab = mock(
		(
			_windowId: number,
			_options: unknown,
			callback: (dataUrl: string) => void,
		) => callback("data:image/png;base64,cHJldmlldw=="),
	);
	const download = mock(() => {
		changes.emit({ id: 23, state: { current: "complete" } });
		return Promise.resolve(23);
	});
	const listener = installChrome({
		downloads: { download, onChanged: changes.onChanged },
		tabs: { captureVisibleTab, query },
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const response = await new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			resolve,
		);
	});

	expect(response).toEqual({ saved: true });
	expect(changes.removeListener).toHaveBeenCalledTimes(1);
	expect(changes.hasListener()).toBe(false);
});

it("reports preview download startup rejection and removes its listener", async () => {
	const changes = downloadChanges();
	const download = mock(() => Promise.reject(new Error("download rejected")));
	const listener = installChrome({
		downloads: { download, onChanged: changes.onChanged },
		tabs: {
			captureVisibleTab(
				_windowId: number,
				_options: unknown,
				callback: (dataUrl: string) => void,
			) {
				callback("data:image/png;base64,cHJldmlldw==");
			},
			query: async () => [{ id: 7 }],
		},
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const response = await new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			resolve,
		);
	});

	expect(response).toEqual({ saved: false, reason: "download rejected" });
	expect(changes.removeListener).toHaveBeenCalledTimes(1);
	expect(changes.hasListener()).toBe(false);
});

it("reports interrupted preview downloads and removes its listener", async () => {
	const changes = downloadChanges();
	const listener = installChrome({
		downloads: {
			download: async () => 31,
			onChanged: changes.onChanged,
		},
		tabs: {
			captureVisibleTab(
				_windowId: number,
				_options: unknown,
				callback: (dataUrl: string) => void,
			) {
				callback("data:image/png;base64,cHJldmlldw==");
			},
			query: async () => [{ id: 7 }],
		},
		windows: { WINDOW_ID_CURRENT: -2 },
	});

	const responsePromise = new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			resolve,
		);
	});
	for (let attempt = 0; attempt < 10 && !changes.hasListener(); attempt += 1) {
		await Promise.resolve();
	}
	expect(changes.hasListener()).toBe(true);
	changes.emit({
		id: 31,
		state: { current: "interrupted" },
		error: { current: "NETWORK_FAILED" },
	});

	expect(await responsePromise).toEqual({
		saved: false,
		reason: "prototype preview download 31 was interrupted: NETWORK_FAILED",
	});
	expect(changes.removeListener).toHaveBeenCalledTimes(1);
	expect(changes.hasListener()).toBe(false);
});

it("times out stalled preview downloads and removes its listener", async () => {
	const changes = downloadChanges();
	const listener = installChrome(
		{
			downloads: {
				download: async () => 47,
				onChanged: changes.onChanged,
			},
			tabs: {
				captureVisibleTab(
					_windowId: number,
					_options: unknown,
					callback: (dataUrl: string) => void,
				) {
					callback("data:image/png;base64,cHJldmlldw==");
				},
				query: async () => [{ id: 7 }],
			},
			windows: { WINDOW_ID_CURRENT: -2 },
		},
		{ previewDownloadTimeoutMs: 10 },
	);

	const response = await new Promise<unknown>((resolve) => {
		listener(
			{ type: PROTO_CAPTURE_PREVIEW, slug: "account-summary" },
			{ tab: { id: 7, windowId: 3 } },
			resolve,
		);
	});

	expect(response).toEqual({
		saved: false,
		reason: "timed out waiting for prototype preview download 47 to complete",
	});
	expect(changes.removeListener).toHaveBeenCalledTimes(1);
	expect(changes.hasListener()).toBe(false);
});
