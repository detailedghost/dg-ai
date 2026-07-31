/** Message types exchanged between the demo content script, background, and offscreen doc. */

export const MSG = {
	// background → offscreen
	startRecording: "dg-demo:start-recording",
	stopRecording: "dg-demo:stop-recording",
	// background → offscreen: play step N's pre-synthesized narration clip
	playStep: "dg-demo:play-step",
	// background → offscreen: load the narration model now, before the record gesture
	warmNarration: "dg-demo:warm-narration",
	// background → offscreen: make an object URL for a stored recording (service
	// workers have no URL.createObjectURL, so the download has to borrow one here)
	mintBlobUrl: "dg-demo:mint-blob-url",
	// background → offscreen: release an object URL once its download has settled
	revokeBlobUrl: "dg-demo:revoke-blob-url",
	// offscreen → background: the recording is written to IDB (or could not be)
	recordingSaved: "dg-demo:recording-saved",
	// offscreen → background: capture is live; carries per-step hold durations (ms)
	recordingReady: "dg-demo:recording-ready",
	// offscreen → background → content: local model/synthesis completion percentage
	narrationProgress: "dg-demo:narration-progress",
	// offscreen → background → content: step narration reached AudioBufferSourceNode.onended
	narrationComplete: "dg-demo:narration-complete",
	// background → content script
	videoPreparing: "dg-demo:video-preparing",
	// offscreen → background → content: clear overlay UI just before capture starts
	clearForCapture: "dg-demo:clear-for-capture",
	// background → content script: drop any overlay (so it isn't in the recording)
	videoClearUi: "dg-demo:video-clear-ui",
	// content → background → offscreen: overlay cleared + painted, safe to capture now
	captureCleared: "dg-demo:capture-cleared",
	// background → content script: the user discarded the recording in the review
	// tab, so rewind to the record prompt (or the editor) and let them try again
	videoRearm: "dg-demo:video-rearm",
	// content script → background: which shortcut did Chrome actually assign to the
	// record command? The manifest's suggested_key is only a request, not a fact.
	requestRecordShortcut: "dg-demo:request-record-shortcut",
	// review page → background: download this recording. Carries the recording's own
	// tab id — the sender is the review tab, whose id is a different thing entirely.
	videoConfirmDownload: "dg-demo:video-confirm-download",
	// review page → background: discard this recording (same tab-id caveat)
	videoDiscard: "dg-demo:video-discard",
	videoStart: "dg-demo:video-start",
	// background → content script: files are on disk; stand the tour down
	videoSaved: "dg-demo:video-saved",
	videoError: "dg-demo:video-error",
	// background → content script: the record gesture was declined, and why. Distinct
	// from videoError, which tears the tour down; this one leaves it running.
	videoBlocked: "dg-demo:video-blocked",
	// content script → background
	videoStop: "dg-demo:video-stop",
	// content script → background (which tab am I? → scope tour state per-tab)
	whoami: "dg-demo:whoami",
} as const;

/**
 * What the background answers a review-page button with.
 *
 * Declared here rather than beside the handler so the review page can type its
 * reply without importing the background feature module — which would drag the
 * whole recording orchestration into that page's bundle.
 */
export type DownloadResult =
	| { ok: true; folder: string }
	| { ok: false; error: string };
