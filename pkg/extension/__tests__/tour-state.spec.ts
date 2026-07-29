/**
 * Unit tests for registerTourState (lib/background/tour-state.ts): the whoami
 * answer used to scope tour state per-tab, and the tab-close cleanup that keeps
 * a closed tab's state (including a pending marker capture and, via
 * handleRecordingTabClosed, an active video recording) from lingering.
 */
import { describe, expect, it, mock } from "bun:test";
import { registerTourState } from "@/lib/background/tour-state";

type MessageListener = (
	msg: { type?: string },
	sender: { tab?: { id?: number } },
	sendResponse: (response: unknown) => void,
) => void;
type RemovedListener = (tabId: number) => void;

function stubChrome(
	// biome-ignore lint/suspicious/noExplicitAny: minimal chrome.* stub for this test only
	storageData: Record<string, any> = {},
): {
	messageListeners: MessageListener[];
	removedListeners: RemovedListener[];
	storageRemove: ReturnType<typeof mock>;
	closeDocument: ReturnType<typeof mock>;
} {
	const messageListeners: MessageListener[] = [];
	const removedListeners: RemovedListener[] = [];
	const storageRemove = mock((keys: string | string[]) => {
		for (const k of Array.isArray(keys) ? keys : [keys]) delete storageData[k];
		return Promise.resolve();
	});
	const closeDocument = mock(async () => undefined);
	// biome-ignore lint/suspicious/noExplicitAny: minimal chrome.* stub for this test only
	(globalThis as any).chrome = {
		runtime: {
			onMessage: {
				addListener: (fn: MessageListener) => messageListeners.push(fn),
			},
		},
		tabs: {
			onRemoved: {
				addListener: (fn: RemovedListener) => removedListeners.push(fn),
			},
		},
		offscreen: { closeDocument },
		storage: {
			local: {
				remove: storageRemove,
				get: mock((key: string) =>
					Promise.resolve({ [key]: storageData[key] }),
				),
			},
		},
	};
	return { messageListeners, removedListeners, storageRemove, closeDocument };
}

/** Let handleRecordingTabClosed's async chain (storage read + cleanup) settle. */
const settle = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

describe("registerTourState", () => {
	it("answers whoami with the sender's tab id", () => {
		const { messageListeners } = stubChrome();
		registerTourState();

		const sendResponse = mock((_response: unknown) => undefined);
		messageListeners[0](
			{ type: "dg-demo:whoami" },
			{ tab: { id: 7 } },
			sendResponse,
		);

		expect(sendResponse).toHaveBeenCalledWith({ tabId: 7 });
	});

	it("ignores unrelated message types", () => {
		const { messageListeners } = stubChrome();
		registerTourState();

		const sendResponse = mock((_response: unknown) => undefined);
		messageListeners[0](
			{ type: "some-other-message" },
			{ tab: { id: 7 } },
			sendResponse,
		);

		expect(sendResponse).not.toHaveBeenCalled();
	});

	it("clears the tour, recording, edit, and pending-marker keys for a closed tab", () => {
		const { removedListeners, storageRemove } = stubChrome();
		registerTourState();

		removedListeners[0](7);

		expect(storageRemove).toHaveBeenCalledWith([
			"demo_tour:7",
			"demo_recording:7",
			"demo_edit:7",
			"demo_pending:7",
		]);
	});

	// The regression this covers: without this wiring, closing the recording tab
	// leaves ACTIVE_KEY pointed at a dead tab, locking out every future recording.
	it("tears down the active recording when the tab holding it closes", async () => {
		const storageData = {
			demo_active_recording: {
				tabId: 7,
				tour: "t",
				hideBody: false,
				planMarkdown: "",
			},
		};
		const { removedListeners, storageRemove, closeDocument } =
			stubChrome(storageData);
		registerTourState();

		removedListeners[0](7);
		await settle();

		expect(storageRemove).toHaveBeenCalledWith("demo_active_recording");
		expect(closeDocument).toHaveBeenCalled();
	});

	it("leaves the active recording alone when a different tab closes", async () => {
		const storageData = {
			demo_active_recording: {
				tabId: 7,
				tour: "t",
				hideBody: false,
				planMarkdown: "",
			},
		};
		const { removedListeners, storageRemove, closeDocument } =
			stubChrome(storageData);
		registerTourState();

		removedListeners[0](99);
		await settle();

		expect(storageRemove).not.toHaveBeenCalledWith("demo_active_recording");
		expect(closeDocument).not.toHaveBeenCalled();
	});
});
