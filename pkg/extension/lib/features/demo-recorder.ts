/**
 * Background-side video-recording orchestration for demo tours (Chrome/Edge only).
 * Flow: user gesture (command) → getMediaStreamId for the tab → ensure the offscreen
 * recorder exists → hand it the stream + tour steps + narration voice/mode. The
 * offscreen doc synthesizes narration (unless captions-only), starts capture, and
 * replies `recordingReady` with per-step hold durations, which we forward to the
 * content script to start auto-play. On stop the recorder writes the video to IDB
 * itself and we open the review page in its own tab.
 *
 * Review is a separate extension page, not an overlay in the tour tab: the video is
 * a Blob, and only an extension-origin document can play the object URL for it. That
 * split is why the buttons send us the *recording's* tab id — the sender is the
 * review tab — and why finishing a review means messaging the tour tab about what to
 * do next (`videoSaved` to stand down, `videoRearm` to offer another take).
 *
 * Recording metadata lives in storage.local, not module globals: an MV3 service
 * worker can be suspended mid-tour, so globals may be gone when the recording data
 * finally arrives on a freshly-woken worker.
 */

import { partitionTourSteps, slugify } from "@dg/common";
import { getConfig } from "@/lib/config";
import { type DownloadResult, MSG } from "@/lib/demo-messages";
import type { TourScript } from "@/lib/demo-types";
import { clampPercent } from "@/lib/narration-progress";
import { wait } from "@/utils/async";
import { toPlanMarkdown } from "@/utils/plan-format";
import {
	getRecording,
	hasRecording,
	pruneStaleRecordings,
	removeRecording,
} from "@/utils/recording-db";

const OFFSCREEN_URL = "offscreen.html";
const REVIEW_URL = "review.html";
const ACTIVE_KEY = "demo_active_recording";
const REVIEW_TAB_KEY = "demo_review_tab";

type ActiveRecording = {
	tabId: number;
	hideBody: boolean;
};

/** Which review tab is showing which recording, so an abandoned review can be spotted. */
type ReviewTab = { reviewTabId: number; tabId: number };

/** Fire-and-forget a message at a tab that may already have closed. */
function notifyTab(tabId: number, msg: object): void {
	void Promise.resolve(chrome.tabs.sendMessage(tabId, msg)).catch(() => {});
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

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
export const HANDOFF_ATTEMPTS = 6;
export const HANDOFF_BACKOFF_MS = 120;

/**
 * Deliver a message to the offscreen recorder, retrying until it acknowledges, and
 * hand back whatever it answered with.
 *
 * `chrome.offscreen.createDocument` can resolve before the document's module script
 * has registered its onMessage listener, and Chrome rejects a send with no receiver
 * ("Could not establish connection"). Unawaited, that rejection vanished and left the
 * tour sitting on the preparation modal forever with nothing to show the user. The
 * offscreen listener acks every message it handles, so a resolved send means the
 * recorder genuinely has it — never a retry that double-starts or replays a clip.
 */
async function sendToOffscreen<T = void>(msg: object): Promise<T | undefined> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= HANDOFF_ATTEMPTS; attempt++) {
		try {
			return (await chrome.runtime.sendMessage({
				...msg,
				target: "offscreen",
			})) as T;
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

/**
 * Load the narration model before the user reaches the record gesture.
 *
 * The tour arms its record prompt well ahead of the keypress — usually a whole
 * user-paced setup phase ahead — so paying the 10-30 s first-run model load here spends
 * time the user was already going to spend reading. Combined with the offscreen document
 * now surviving a finished recording, the load happens once per browser session instead
 * of once per recording.
 *
 * Silent (captions-only) mode never synthesizes anything, so warming it would fetch
 * ~90 MB of weights nothing will read. Every failure is swallowed: the recorder still
 * has its own load path and its own degrade-to-silent fallback, and a warm-up that
 * could abort a tour would be worse than no warm-up at all.
 */
export async function warmNarration(
	readConfig: typeof getConfig = getConfig,
): Promise<void> {
	try {
		if ((await readConfig()).narration === "captions") return;
		await ensureOffscreen();
		await sendToOffscreen({ type: MSG.warmNarration });
	} catch (err) {
		console.warn("[dg-ai-extension] narration warm-up skipped", err);
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
	const { voice, narration, videoQuality } = await readConfig();
	await chrome.storage.local.set({
		[ACTIVE_KEY]: {
			tabId,
			hideBody: narration === "voice",
		} satisfies ActiveRecording,
	});
	const narrate = narration !== "captions";
	// Paint the loading state before offscreen work begins so early progress
	// updates cannot arrive before the tab has mounted its progress bar.
	notifyTab(tabId, { type: MSG.videoPreparing, narrate });
	try {
		await sendToOffscreen({
			type: MSG.startRecording,
			streamId,
			steps: partitionTourSteps(script).tutorial,
			voice,
			narrate,
			// The recorder writes the finished entry itself, so it needs every field
			// that entry carries — nothing comes back here but a "saved" flag.
			tabId,
			slug: slugify(tour),
			planMarkdown: toPlanMarkdown(script),
			quality: videoQuality,
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
		notifyTab(active.tabId, {
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
		notifyTab(active.tabId, {
			type: MSG.narrationProgress,
			progress: clampPercent(progress),
			label,
		});
}

/** Relay a finished narration clip to the active tour tab. */
export async function handleNarrationComplete(index: number): Promise<void> {
	const active = await getActive();
	if (active?.tabId != null)
		notifyTab(active.tabId, { type: MSG.narrationComplete, index });
}

/** Offscreen is about to start capture: tell the tour tab to clear any overlay first. */
export async function handleClearForCapture(): Promise<void> {
	const active = await getActive();
	if (active?.tabId != null)
		notifyTab(active.tabId, { type: MSG.videoClearUi });
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
		// Nothing will ever report a saved recording now, so say so rather than hang the
		// tour on a recording that has already stopped being watched.
		notifyTab(tabId, { type: MSG.videoError, error: errorText(err) });
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

/**
 * The recorder finished: free the slot and put the recording in front of the user.
 *
 * Nothing but a flag arrives here — the video is already in IDB, written by the
 * document that encoded it.
 */
export async function handleRecordingSaved(
	saved: boolean,
	error?: string,
): Promise<void> {
	const active = await getActive();
	const tabId = active?.tabId ?? null;

	if (!saved) {
		if (tabId != null)
			notifyTab(tabId, {
				type: MSG.videoError,
				error: error ?? "recording did not start",
			});
		// An abort tore its own stream down and left the document healthy — keep it warm.
		await releaseSlot();
		return;
	}
	void pruneStaleRecordings();
	await releaseSlot();
	if (tabId != null) await openReviewTab(tabId);
}

/**
 * Open the review page in its own tab and remember which recording it is showing.
 *
 * The pairing is what lets an abandoned review be detected later: without it, a tour
 * tab whose review tab was closed unanswered would sit in its recording state with no
 * route back to the record prompt.
 */
async function openReviewTab(tabId: number): Promise<void> {
	try {
		const tab = await chrome.tabs.create({
			url: chrome.runtime.getURL(`${REVIEW_URL}?tab=${tabId}`),
		});
		if (tab.id != null)
			await chrome.storage.local.set({
				[REVIEW_TAB_KEY]: {
					reviewTabId: tab.id,
					tabId,
				} satisfies ReviewTab,
			});
	} catch (err) {
		// No review tab means no way to reach the recording, so re-arm rather than
		// leave the tour frozen on a capture the user can never act on.
		notifyTab(tabId, { type: MSG.videoError, error: errorText(err) });
	}
}

/** Trigger a `chrome.downloads.download`, resolving once Chrome has accepted it. */
function downloadFile(
	filename: string,
	url: string,
): Promise<{ error?: string; downloadId?: number }> {
	return new Promise((resolve) => {
		chrome.downloads.download({ url, filename }, (downloadId) => {
			resolve({ error: chrome.runtime.lastError?.message, downloadId });
		});
	});
}

/** Ceiling on how long an object URL is held open waiting for its download to end. */
const DOWNLOAD_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Wait for a download to reach a terminal state.
 *
 * `chrome.downloads.download`'s callback fires when the download is *created*, not
 * when its bytes have been read, so it is not a safe moment to release the object URL
 * the bytes are coming from — a large file would be truncated. `interrupted` counts as
 * settled too: a failed download that still holds the URL open is a leak, not a retry.
 */
function downloadSettled(downloadId: number): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			chrome.downloads.onChanged.removeListener(onChanged);
			resolve();
		};
		const onChanged = (delta: chrome.downloads.DownloadDelta): void => {
			if (delta.id !== downloadId) return;
			const state = delta.state?.current;
			if (state === "complete" || state === "interrupted") done();
		};
		const timer = setTimeout(done, DOWNLOAD_SETTLE_TIMEOUT_MS);
		chrome.downloads.onChanged.addListener(onChanged);
	});
}

/** Release the video's object URL once Chrome is finished reading from it. */
async function revokeWhenSettled(
	url: string,
	downloadId?: number,
): Promise<void> {
	if (downloadId != null) await downloadSettled(downloadId);
	try {
		await sendToOffscreen({ type: MSG.revokeBlobUrl, url });
	} catch (err) {
		// Costs one object URL until the offscreen document closes — never the download.
		console.warn("[dg-ai-extension] could not release the recording url", err);
	}
}

/**
 * Download the video and its plan, and stand the tour tab down.
 *
 * The video never passes through here as data: the offscreen document mints an object
 * URL from the stored Blob, and this hands that string to the downloads API. A failure
 * deliberately *keeps* the IDB entry so the review tab's Download button can simply be
 * pressed again — dropping it would cost the user the whole recording.
 */
export async function confirmDownload(tabId: number): Promise<DownloadResult> {
	const entry = await getRecording(tabId);
	if (!entry) return { ok: false, error: "no recording found" };
	const { slug, planMarkdown } = entry;
	const folder = `dg-demo/${slug}`;
	const planUrl = `data:text/markdown;charset=utf-8,${encodeURIComponent(planMarkdown)}`;

	let url: string | undefined;
	try {
		await ensureOffscreen();
		url =
			(
				await sendToOffscreen<{ url: string | null }>({
					type: MSG.mintBlobUrl,
					tabId,
				})
			)?.url ?? undefined;
	} catch (err) {
		return {
			ok: false,
			error: `the recorder never answered: ${errorText(err)}`,
		};
	}
	if (!url) return { ok: false, error: "the recording is no longer available" };

	const [video, plan] = await Promise.all([
		downloadFile(`${folder}/${slug}.webm`, url),
		downloadFile(`${folder}/${slug}.demo.md`, planUrl),
	]);
	// Not awaited: a multi-minute download must not keep the review tab waiting to
	// hear whether its click worked. Revoking is bookkeeping, not part of the answer.
	void revokeWhenSettled(url, video.downloadId);

	const error = video.error ?? plan.error;
	if (error) return { ok: false, error };

	await removeRecording(tabId);
	await chrome.storage.local.remove(REVIEW_TAB_KEY);
	notifyTab(tabId, { type: MSG.videoSaved, filename: folder });
	return { ok: true, folder };
}

/**
 * Drop the recording and offer the tour tab another take.
 *
 * The re-arm decision itself belongs to the content script — returning to the editor
 * or rewinding to step 1 both need page context — so this only pulls its trigger. It
 * fires whether or not an entry was there: a tour tab left in its recording state is
 * the one outcome that strands the user with no way to record again.
 */
export async function discardRecording(
	tabId: number,
): Promise<{ ok: boolean }> {
	const existed = await hasRecording(tabId);
	await removeRecording(tabId);
	await chrome.storage.local.remove(REVIEW_TAB_KEY);
	notifyTab(tabId, { type: MSG.videoRearm });
	return { ok: existed };
}

/**
 * The review tab closed. Re-arm its tour tab if the user never chose.
 *
 * A recording that was downloaded or discarded is already gone from IDB, so a
 * surviving entry means the review was abandoned — including the download-failed case,
 * where the entry is kept on purpose. The entry itself is left alone: it is keyed by
 * the tour tab's id, so the next recording overwrites it, and pruning catches the rest.
 */
export async function handleReviewTabClosed(
	closedTabId: number,
): Promise<void> {
	const pairing = (await chrome.storage.local.get(REVIEW_TAB_KEY))[
		REVIEW_TAB_KEY
	] as ReviewTab | undefined;
	if (pairing?.reviewTabId !== closedTabId) return;
	await chrome.storage.local.remove(REVIEW_TAB_KEY);
	if (await hasRecording(pairing.tabId))
		notifyTab(pairing.tabId, { type: MSG.videoRearm });
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

/**
 * Free the single-recording slot but leave the offscreen document running.
 *
 * That document is where the narration model lives, cached for the document's lifetime —
 * so tearing it down after every recording is exactly what made every recording pay the
 * model load again. A recorder that finished has already stopped its capture tracks, so
 * the document left behind holds no stream to block the next start. `cleanup` (which does
 * close it) stays for the paths where the document is unresponsive or still capturing a
 * tab that no longer exists.
 */
async function releaseSlot(): Promise<void> {
	await chrome.storage.local.remove(ACTIVE_KEY);
}

async function cleanup(): Promise<void> {
	await chrome.storage.local.remove(ACTIVE_KEY);
	await closeOffscreen();
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
