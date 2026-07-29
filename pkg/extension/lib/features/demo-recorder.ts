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

import { partitionTourSteps, slugify } from "@dg/common";
import { getConfig } from "@/lib/config";
import { MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import { clampPercent } from "@/lib/narration-progress";
import { wait } from "@/utils/async";
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

/**
 * Grab the tab's capture stream id, retrying once past a leaked offscreen stream.
 *
 * getMediaStreamId has to be the first thing the record gesture reaches: awaiting
 * anything before it risks the invocation no longer counting, which surfaces as
 * "Extension has not been invoked for the current page" — indistinguishable from a
 * missing permission. So the stale-offscreen cleanup that used to run first now runs
 * only on the failure it exists for: a previous aborted recording can leave an
 * offscreen document holding a getUserMedia stream, and Chrome refuses to capture a
 * tab that already has one.
 *
 * This makes the function destructive, not just slow: its retry path closes the
 * shared offscreen document. If another tab is genuinely mid-recording, that
 * document's stream is live, so a failed first attempt here can and will tear it
 * down. Never call this speculatively for a start that might still be refused —
 * decide whether the start may proceed *before* calling this, never after.
 */
async function acquireStreamId(tabId: number): Promise<string> {
	try {
		return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
	} catch (err) {
		console.warn(
			"[dg-ai-extension] retrying capture without a stale offscreen doc",
			err,
		);
		await closeOffscreen();
		return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
	}
}

/**
 * Bounded retry for the offscreen handoff. Long enough to cover a document that
 * exists but has not run its module script yet; short enough not to strand the user.
 */
const HANDOFF_ATTEMPTS = 6;
const HANDOFF_BACKOFF_MS = 120;

/**
 * Deliver a message to the offscreen recorder, retrying until it acknowledges.
 *
 * `chrome.offscreen.createDocument` can resolve before the document's module script
 * has registered its onMessage listener, and Chrome rejects a send with no receiver
 * ("Could not establish connection"). Unawaited, that rejection vanished and left the
 * tour sitting on the preparation modal forever with nothing to show the user. The
 * offscreen listener acks every message it handles, so a resolved send means the
 * recorder genuinely has it — never a retry that double-starts or replays a clip.
 */
async function sendToOffscreen(msg: object): Promise<void> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= HANDOFF_ATTEMPTS; attempt++) {
		try {
			await chrome.runtime.sendMessage({ ...msg, target: "offscreen" });
			return;
		} catch (err) {
			lastError = err;
			if (attempt < HANDOFF_ATTEMPTS) await wait(HANDOFF_BACKOFF_MS * attempt);
		}
	}
	throw new Error(
		`the offscreen recorder never answered: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

/** Whether `tabId` still exists — a `chrome.tabs.get` rejection means it's gone. */
async function tabIsOpen(tabId: number): Promise<boolean> {
	try {
		await chrome.tabs.get(tabId);
		return true;
	} catch {
		return false;
	}
}

/** Whether video recording is supported here (offscreen + tabCapture are Chrome-only). */
export function videoRecordingSupported(): boolean {
	return (
		typeof chrome !== "undefined" &&
		!!chrome.offscreen &&
		!!chrome.tabCapture?.getMediaStreamId
	);
}

/**
 * Start recording `tabId` and hand the tour to the offscreen recorder.
 *
 * Must run in a user gesture, and `acquireStreamId` must be the first thing this
 * function awaits — nothing else, not a storage read, not a `chrome.tabs.get`
 * round trip, not the single-active check. Any await ahead of it risks the
 * invoking gesture no longer counting, which Chrome reports as "Extension has
 * not been invoked for the current page": indistinguishable from a missing
 * permission, and a bug this file has already shipped twice.
 *
 * The single-active check therefore cannot live here at all — it lives in the
 * caller (`maybeStartRecording`, via `activeRecordingRefusal`), which decides
 * whether this function should run before ever calling it. Calling
 * `acquireStreamId` speculatively for a start that might get refused is worse
 * than the gesture risk: see its doc comment for why.
 */
export async function startVideoRecording(
	tabId: number,
	script: TourScript,
	readConfig: typeof getConfig = getConfig,
): Promise<void> {
	const streamId = await acquireStreamId(tabId);
	await ensureOffscreen();
	const tour = script.title || "demo";
	const { voice, narration } = await readConfig();
	await chrome.storage.local.set({
		[ACTIVE_KEY]: {
			tabId,
			tour,
			hideBody: narration === "voice",
			planMarkdown: toPlanMarkdown(script),
		} satisfies ActiveRecording,
	});
	const narrate = narration !== "captions";
	// Paint the loading state before offscreen work begins so early progress
	// updates cannot arrive before the tab has mounted its progress bar.
	void chrome.tabs.sendMessage(tabId, {
		type: MSG.videoPreparing,
		narrate,
	});
	try {
		await sendToOffscreen({
			type: MSG.startRecording,
			streamId,
			steps: partitionTourSteps(script).tutorial,
			voice,
			narrate,
		});
	} catch (err) {
		// The recorder never got the tour, so drop the half-built state and let the
		// caller report it — a stale offscreen doc would block the next attempt.
		await cleanup();
		throw err;
	}
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

/** Relay local model/synthesis progress to the tab showing the preparation modal. */
export async function handleNarrationProgress(
	progress: number,
	label?: string,
): Promise<void> {
	const active = await getActive();
	if (active?.tabId != null)
		void chrome.tabs.sendMessage(active.tabId, {
			type: MSG.narrationProgress,
			progress: clampPercent(progress),
			label,
		});
}

/** Offscreen is about to start capture: tell the tour tab to clear any overlay first. */
export async function handleClearForCapture(): Promise<void> {
	const active = await getActive();
	if (active?.tabId != null)
		void chrome.tabs.sendMessage(active.tabId, { type: MSG.videoClearUi });
}

/** Relay a play-step cue from the content script to the offscreen recorder — ignored from any tab but the active recording's. */
export async function relayPlayStep(
	tabId: number,
	index: number,
): Promise<void> {
	const active = await getActive();
	if (active?.tabId !== tabId) return;
	try {
		await sendToOffscreen({ type: MSG.playStep, index });
	} catch (err) {
		// A lost cue costs one narration clip, so it must not tear down a live recording.
		console.warn("[dg-ai-extension] play-step cue not delivered", err);
	}
}

/** Tell the offscreen recorder to stop — ignored from any tab but the active recording's. */
export async function stopVideoRecording(tabId: number): Promise<void> {
	const active = await getActive();
	if (active?.tabId !== tabId) return;
	try {
		await sendToOffscreen({ type: MSG.stopRecording });
	} catch (err) {
		// Nothing will ever send recordingData now, so say so rather than hang the tour
		// on a recording that has already stopped being watched.
		void chrome.tabs.sendMessage(tabId, {
			type: MSG.videoError,
			error: err instanceof Error ? err.message : String(err),
		});
		await cleanup();
	}
}

/** Relay the tab's "overlay is gone" confirmation on to the waiting recorder. */
export async function relayCaptureCleared(): Promise<void> {
	try {
		await sendToOffscreen({ type: MSG.captureCleared });
	} catch (err) {
		// The recorder falls back to a timeout, so a lost confirmation only costs a delay.
		console.warn("[dg-ai-extension] capture-cleared relay failed", err);
	}
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
		const slug = slugify(active.tour ?? "demo");
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

/**
 * Tear down the active recording if the tab that just closed owned it.
 *
 * The content script dies with its tab, so a closed recording tab never sends
 * MSG.videoStop — without this, the offscreen doc keeps capturing a dead tab
 * forever, and ACTIVE_KEY (persisted in storage.local) locks out every future
 * start until storage is cleared by hand. Called from tour-state.ts's onRemoved.
 */
export async function handleRecordingTabClosed(tabId: number): Promise<void> {
	const active = await getActive();
	if (active?.tabId === tabId) await cleanup();
}

/**
 * Why `tabId` may not start a video recording right now, given the single
 * active-recording slot — or null when it may, exactly like `recordingRefusal`.
 *
 * Must be checked (and awaited to completion) by the caller *before*
 * `startVideoRecording`/`acquireStreamId` ever runs — see that function's doc
 * comment for why calling it speculatively is unsafe.
 *
 * A different tab that's still open holds the slot: refuse. A different tab
 * that's gone (crash or restart outran onRemoved's cleanup): the entry is
 * stale, so drop it with a single fast write and let the start proceed — not
 * `cleanup()`, which also awaits `closeOffscreen()` and would reintroduce the
 * same gesture risk one layer up. If a stream is genuinely still open,
 * `acquireStreamId`'s own retry is the machinery built to tear it down.
 */
export async function activeRecordingRefusal(
	tabId: number,
): Promise<string | null> {
	const existing = await getActive();
	if (!existing || existing.tabId === tabId) return null;
	if (await tabIsOpen(existing.tabId)) {
		return "Another tab is already recording a demo tour. Finish or discard it before starting a new one.";
	}
	await chrome.storage.local.remove(ACTIVE_KEY);
	return null;
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
