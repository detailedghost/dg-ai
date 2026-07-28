/**
 * Unit tests for registerTourState (lib/background/tour-state.ts): the whoami
 * answer used to scope tour state per-tab, and the tab-close cleanup that keeps
 * a closed tab's state (including a pending marker capture) from lingering.
 */
import { describe, expect, it, mock } from "bun:test";
import { registerTourState } from "@/lib/background/tour-state";

type MessageListener = (
	msg: { type?: string },
	sender: { tab?: { id?: number } },
	sendResponse: (response: unknown) => void,
) => void;
type RemovedListener = (tabId: number) => void;

function stubChrome(): {
	messageListeners: MessageListener[];
	removedListeners: RemovedListener[];
	storageRemove: ReturnType<typeof mock>;
} {
	const messageListeners: MessageListener[] = [];
	const removedListeners: RemovedListener[] = [];
	const storageRemove = mock(() => Promise.resolve());
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
		storage: { local: { remove: storageRemove } },
	};
	return { messageListeners, removedListeners, storageRemove };
}

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
});
