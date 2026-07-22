/** Message types exchanged between the demo content script, background, and offscreen doc. */

export const MSG = {
	// background → offscreen
	startRecording: "dg-demo:start-recording",
	stopRecording: "dg-demo:stop-recording",
	// background → offscreen: play step N's pre-synthesized narration clip
	playStep: "dg-demo:play-step",
	// offscreen → background
	recordingData: "dg-demo:recording-data",
	// offscreen → background: capture is live; carries per-step hold durations (ms)
	recordingReady: "dg-demo:recording-ready",
	// background → content script
	videoPreparing: "dg-demo:video-preparing",
	// background → content script: prompt the user to review the recording
	videoReview: "dg-demo:video-review",
	// content script → background: request the recorded data URL
	requestVideoData: "dg-demo:request-video-data",
	// content script → background: user confirmed download
	videoConfirmDownload: "dg-demo:video-confirm-download",
	// content script → background: user discarded the recording
	videoDiscard: "dg-demo:video-discard",
	videoStart: "dg-demo:video-start",
	videoSaved: "dg-demo:video-saved",
	videoError: "dg-demo:video-error",
	// content script → background
	videoStop: "dg-demo:video-stop",
	// content script → background (which tab am I? → scope tour state per-tab)
	whoami: "dg-demo:whoami",
} as const;
