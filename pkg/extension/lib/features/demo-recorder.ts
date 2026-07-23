/**
 * Background-side video-recording orchestration for demo tours (Chrome/Edge only).
 * Flow: user gesture (command) → getMediaStreamId for the tab → ensure the offscreen
 * recorder exists → hand it the stream + tour steps + narration voice/mode. The
 * offscreen doc synthesizes narration (unless captions-only), starts capture, and
 * replies `recordingReady` with per-step hold durations, which we forward to the
 * content script to start auto-play. On stop the recording is saved to IDB for user
 * review; the user either confirms download or discards and re-records.
 *
 * Recording metadata lives in storage.local, not module globals: an MV3 service
 * worker can be suspended mid-tour, so globals may be gone when the recording data
 * finally arrives on a freshly-woken worker.
 */

import { getConfig } from "@/lib/config";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import { toPlanMarkdown } from "@/utils/plan-format";
import {
	getRecording,
	pruneStaleRecordings,
	removeRecording,
	saveRecording,
} from "@/utils/recording-db";
import { zipStore } from "@/utils/zip";

const OFFSCREEN_URL = "offscreen.html";
const ACTIVE_KEY = "demo_active_recording";

type ActiveRecording = {
	tabId: number;
	tour: string;
	hideBody: boolean;
	planMarkdown: string;
};

/** Whether video recording is supported here (offscreen + tabCapture are Chrome-only). */
export function videoRecordingSupported(): boolean {
	return (
		typeof chrome !== "undefined" &&
		!!chrome.offscreen &&
		!!chrome.tabCapture?.getMediaStreamId
	);
}

/** Start recording `tabId` and hand the tour to the offscreen recorder. Must run in a user gesture. */
export async function startVideoRecording(
	tabId: number,
	script: TourScript,
): Promise<void> {
	// Close any stale offscreen doc before acquiring the stream. A previous
	// failed recording may have left one open with an active getUserMedia stream,
	// causing getMediaStreamId to fail with "Cannot capture a tab with an active
	// stream". closeOffscreen() is a no-op if nothing is open.
	await closeOffscreen();
	// getMediaStreamId consumes the user gesture — call it first, before the
	// slower offscreen-document setup, or the gesture window can lapse.
	const streamId = await chrome.tabCapture.getMediaStreamId({
		targetTabId: tabId,
	});
	await ensureOffscreen();
	const tour = script.title || "demo";
	const { voice, narration } = await getConfig();
	await chrome.storage.local.set({
		[ACTIVE_KEY]: {
			tabId,
			tour,
			hideBody: narration === "voice",
			planMarkdown: toPlanMarkdown(script),
		} satisfies ActiveRecording,
	});
	chrome.runtime.sendMessage({
		type: MSG.startRecording,
		target: "offscreen",
		streamId,
		steps: script.steps ?? [],
		voice,
		narrate: narration !== "captions",
	});
	// Notify the tab immediately so it can show a loading state while Kokoro
	// synthesizes narration (which can take up to a minute on first use).
	void chrome.tabs.sendMessage(tabId, { type: MSG.videoPreparing });
}

/** Offscreen reports capture is live: cue the tour tab to auto-play with these holds. */
export async function handleRecordingReady(durations: number[]): Promise<void> {
	const active = await getActive();
	if (active?.tabId != null)
		void chrome.tabs.sendMessage(active.tabId, {
			type: MSG.videoStart,
			durations,
			hideBody: active.hideBody,
		});
}

/** Offscreen is about to start capture: tell the tour tab to clear any overlay first. */
export async function handleClearForCapture(): Promise<void> {
	const active = await getActive();
	if (active?.tabId != null)
		void chrome.tabs.sendMessage(active.tabId, { type: MSG.videoClearUi });
}

/** Relay a play-step cue from the content script to the offscreen recorder. */
export function relayPlayStep(index: number): void {
	chrome.runtime.sendMessage({
		type: MSG.playStep,
		target: "offscreen",
		index,
	});
}

/** Tell the offscreen recorder to stop; it replies with the data via handleRecordingData. */
export function stopVideoRecording(): void {
	chrome.runtime.sendMessage({ type: MSG.stopRecording, target: "offscreen" });
}

/** Save the finished recording to IDB and prompt the tab to show the review modal. */
export async function handleRecordingData(dataUrl: string): Promise<void> {
	const active = await getActive();
	const tabId = active?.tabId ?? null;
	const notify = (msg: object): void => {
		if (tabId != null) void chrome.tabs.sendMessage(tabId, msg);
	};

	// Empty payload = the recorder aborted before producing any video.
	if (!dataUrl) {
		notify({ type: MSG.videoError, error: "recording did not start" });
		await cleanup();
		return;
	}

	if (tabId != null && active) {
		const slug =
			(active.tour ?? "demo").replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() ||
			"demo";
		void pruneStaleRecordings();
		await saveRecording({
			tabId,
			dataUrl,
			slug,
			planMarkdown: active.planMarkdown,
			createdAt: Date.now(),
		});
	}
	await cleanup();
	notify({ type: MSG.videoReview });
}

/** Read the IDB entry, zip it, trigger download, then clean up IDB. */
export async function confirmDownload(tabId: number): Promise<void> {
	const notify = (msg: object): void => {
		void chrome.tabs.sendMessage(tabId, msg);
	};
	const entry = await getRecording(tabId);
	if (!entry) {
		notify({ type: MSG.videoError, error: "no recording found" });
		return;
	}
	const { slug, dataUrl, planMarkdown } = entry;
	const zip = zipStore([
		{ name: `${slug}.webm`, data: base64ToBytes(dataUrl.split(",")[1] ?? "") },
		{ name: `${slug}.demo.md`, data: new TextEncoder().encode(planMarkdown) },
	]);
	const filename = `dg-demo/${slug}/${slug}.zip`;
	const zipUrl = `data:application/zip;base64,${bytesToBase64(zip)}`;

	// Wrap callback in a Promise so the caller can await the full operation,
	// including the IDB removal that follows the download callback.
	return new Promise<void>((resolve) => {
		chrome.downloads.download({ url: zipUrl, filename }, () => {
			const failed = !!chrome.runtime.lastError;
			notify(
				failed
					? { type: MSG.videoError, error: chrome.runtime.lastError?.message }
					: { type: MSG.videoSaved, filename },
			);
			// Remove the IDB entry regardless of success/failure so a stale
			// recording can't linger after the user has acted on it.
			void removeRecording(tabId).finally(resolve);
		});
	});
}

/** Remove the IDB entry without notifying the tab (user chose to discard). */
export async function discardRecording(tabId: number): Promise<void> {
	await removeRecording(tabId);
}

/** Reply to a MSG.requestVideoData round-trip with the stored dataUrl (or null). */
export async function handleRequestVideoData(
	tabId: number,
	sendResponse: (data: { dataUrl: string | null }) => void,
): Promise<void> {
	const entry = await getRecording(tabId);
	sendResponse({ dataUrl: entry?.dataUrl ?? null });
}

async function getActive(): Promise<ActiveRecording | undefined> {
	const got = await chrome.storage.local.get(ACTIVE_KEY);
	return got[ACTIVE_KEY] as ActiveRecording | undefined;
}

async function cleanup(): Promise<void> {
	await chrome.storage.local.remove(ACTIVE_KEY);
	await closeOffscreen();
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

function bytesToBase64(bytes: Uint8Array): string {
	let bin = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk)
		bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
	return btoa(bin);
}

async function ensureOffscreen(): Promise<void> {
	const contexts = await chrome.runtime.getContexts({
		contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
	});
	if (contexts.length > 0) return;
	await chrome.offscreen.createDocument({
		url: OFFSCREEN_URL,
		reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
		justification: "Recording the demo tour to a video file.",
	});
}

async function closeOffscreen(): Promise<void> {
	try {
		await chrome.offscreen.closeDocument();
	} catch {
		// no offscreen doc to close — fine
	}
}
