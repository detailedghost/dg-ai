/**
 * Offscreen recorder. The service worker can't use MediaRecorder or WebAudio (no
 * DOM), so this runs here: background hands us a tabCapture streamId plus the tour
 * steps + narration voice. We synthesize each step's narration with Kokoro up
 * front, then record the tab's video mixed with a WebAudio track we play the
 * narration into — advancing in lock-step with the content script (playStep). On
 * stop we write the webm straight to IndexedDB. Chrome-only (offscreen + tabCapture).
 *
 * This document is also where object URLs for finished recordings are minted: the
 * service worker that drives the download has no URL.createObjectURL of its own.
 */

import {
	presetFor,
	recorderOptions,
	tabCaptureConstraints,
} from "@/lib/capture-quality";
import { MSG } from "@/lib/demo-messages";
import { NarrationProgressTracker } from "@/lib/narration-progress";
import { holdFor } from "@/lib/video-timing";
import { loadKokoro, narrationLoaded } from "@/utils/kokoro";
import { getRecording, saveRecording } from "@/utils/recording-db";

type Step = { body?: string; advance?: unknown };

/** Everything the stored entry needs beyond the bytes, handed over at start. */
type RecordingTarget = { tabId: number; slug: string; planMarkdown: string };

/** Quality name as it arrives on the wire — coerced, never indexed with directly. */
type QualityName = string | undefined;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
// Guards against a second start() (e.g. shortcut pressed twice) clobbering state.
let starting = false;
// A stop that arrives before the recorder exists — honored once setup finishes.
let stopRequested = false;
let audioCtx: AudioContext | null = null;
let narrationDest: MediaStreamAudioDestinationNode | null = null;
let stepBuffers: (AudioBuffer | null)[] = [];

/**
 * Acknowledge every message this document acts on.
 *
 * The sender retries an undelivered handoff, and "delivered" has to be unambiguous:
 * without an ack it can only infer delivery from a resolved send, which some Chrome
 * versions turn into a rejection when no listener replies — a false negative that
 * would re-send a start or replay a narration clip. Ack first, then do the work; the
 * sender only needs to know the recorder heard it.
 */
chrome.runtime.onMessage.addListener(
	(
		msg: {
			type?: string;
			target?: string;
			streamId?: string;
			steps?: Step[];
			voice?: string;
			narrate?: boolean;
			index?: number;
			tabId?: number;
			slug?: string;
			planMarkdown?: string;
			url?: string;
			quality?: string;
		},
		_sender,
		sendResponse,
	) => {
		if (msg?.target !== "offscreen") return;
		if (msg.type === MSG.startRecording && msg.streamId) {
			sendResponse({ ok: true });
			void start(
				msg.streamId,
				msg.steps ?? [],
				msg.voice,
				msg.narrate !== false,
				{
					tabId: msg.tabId ?? -1,
					slug: msg.slug || "demo",
					planMarkdown: msg.planMarkdown ?? "",
				},
				msg.quality,
			);
		} else if (msg.type === MSG.mintBlobUrl && typeof msg.tabId === "number") {
			// The one handler whose answer *is* the payload, so it cannot ack up front
			// like the rest; returning true holds the channel open until it resolves.
			void mintBlobUrl(msg.tabId).then((url) => sendResponse({ url }));
			return true;
		} else if (msg.type === MSG.revokeBlobUrl && msg.url) {
			sendResponse({ ok: true });
			URL.revokeObjectURL(msg.url);
		} else if (msg.type === MSG.stopRecording) {
			sendResponse({ ok: true });
			stop();
		} else if (msg.type === MSG.playStep && typeof msg.index === "number") {
			sendResponse({ ok: true });
			playStep(msg.index);
		} else if (msg.type === MSG.warmNarration) {
			sendResponse({ ok: true });
			// Failures are the recorder's problem to re-hit and report, not the warm-up's.
			void loadKokoro().catch(() => {});
		}
	},
);

async function start(
	streamId: string,
	steps: Step[],
	voice: string | undefined,
	narrate: boolean,
	target: RecordingTarget,
	quality: QualityName,
): Promise<void> {
	// Double-start guard: ignore a second start while one is in flight or active.
	if (starting || recorder) return;
	starting = true;
	const preset = presetFor(quality);
	stopRequested = false;
	let videoStream: MediaStream | null = null;
	try {
		// Acquire the tab stream BEFORE synthesizing narration. The streamId from
		// getMediaStreamId is only valid for a few seconds; Kokoro model loading can
		// take 10-30 s on first use, which easily expires it. getUserMedia here holds
		// the capture open regardless of how long TTS preparation takes.
		videoStream = await navigator.mediaDevices.getUserMedia(
			tabCaptureConstraints(streamId, preset),
		);
		// Stop asked for before capture was ready → tear down, never record.
		if (stopRequested) {
			teardown(videoStream);
			starting = false;
			abort();
			return;
		}

		// Captions-only mode records silently — skip Kokoro (no model load) entirely.
		let durations: number[];
		if (narrate) {
			audioCtx = new AudioContext();
			await resumeAudio(audioCtx);
			narrationDest = audioCtx.createMediaStreamDestination();
			// Synthesize all narration; a failure degrades to a silent video.
			durations = await synthAll(steps, voice, audioCtx);
		} else {
			durations = steps.map((s) => holdFor(s, null));
			reportNarrationProgress(100, "Recording ready");
		}
		// Stop might arrive while Kokoro is loading / synthesizing.
		if (stopRequested) {
			teardown(videoStream);
			starting = false;
			abort();
			return;
		}

		// TTS is done — clear the tab's overlay and wait for a clean painted frame
		// before capturing, so the "preparing narration" modal never lands in the video.
		await waitForClearFrame();
		if (stopRequested) {
			teardown(videoStream);
			starting = false;
			abort();
			return;
		}

		const mixed = new MediaStream([
			...videoStream.getVideoTracks(),
			...(narrationDest ? narrationDest.stream.getAudioTracks() : []),
		]);
		chunks = [];
		// Encode at the size actually captured, not MediaRecorder's 2.5 Mbps VP8 default.
		const { width, height } =
			videoStream.getVideoTracks()[0]?.getSettings() ?? {};
		recorder = new MediaRecorder(
			mixed,
			recorderOptions(mixed.getAudioTracks().length > 0, width, height, preset),
		);
		const capture = videoStream;
		recorder.ondataavailable = (e) => {
			if (e.data.size) chunks.push(e.data);
		};
		recorder.onstop = () => {
			teardown(capture);
			void persist(new Blob(chunks, { type: "video/webm" }), target);
		};
		recorder.start();
		starting = false;
		// Stop arrived during setup → honor it now that the recorder exists.
		if (stopRequested) {
			stop();
			return;
		}
		// Capture is genuinely live now — tell background (which cues the content
		// script) with the per-step hold durations so visuals track the narration.
		chrome.runtime.sendMessage({
			type: MSG.recordingReady,
			target: "background",
			durations,
		});
	} catch (e) {
		console.error("[dg-ai-extension] recorder start failed", e);
		if (videoStream) teardown(videoStream);
		starting = false;
		abort();
	}
}

/**
 * Store the finished recording and tell background it is there.
 *
 * The bytes stop here — background reads them back out of IndexedDB when it needs a
 * URL, so nothing this size ever crosses a runtime message. A failed write is
 * reported rather than swallowed: the review tab would otherwise open on a recording
 * that does not exist.
 */
async function persist(blob: Blob, target: RecordingTarget): Promise<void> {
	let error: string | undefined;
	try {
		await saveRecording({ ...target, blob, createdAt: Date.now() });
	} catch (e) {
		console.error("[dg-ai-extension] could not store the recording", e);
		error = "the recording could not be stored";
	}
	chrome.runtime.sendMessage({
		type: MSG.recordingSaved,
		target: "background",
		saved: !error,
		...(error ? { error } : {}),
	});
}

/** An object URL for a stored recording, for the service worker to download from. */
async function mintBlobUrl(tabId: number): Promise<string | null> {
	try {
		const entry = await getRecording(tabId);
		return entry ? URL.createObjectURL(entry.blob) : null;
	} catch (e) {
		console.error("[dg-ai-extension] could not read the stored recording", e);
		return null;
	}
}

function stop(): void {
	if (recorder) {
		recorder.stop();
		recorder = null;
	} else {
		// start() hasn't finished creating the recorder yet — flag for it to honor.
		stopRequested = true;
	}
}

/**
 * Ask the tour tab to remove its overlay and resolve once it confirms a clean frame
 * was painted (MSG.captureCleared), or after a fallback timeout. Gates recorder.start()
 * so the "preparing narration" modal is never captured.
 */
function waitForClearFrame(): Promise<void> {
	return new Promise((resolve) => {
		const done = (): void => {
			clearTimeout(timer);
			chrome.runtime.onMessage.removeListener(onMsg);
			resolve();
		};
		const onMsg = (m: { type?: string; target?: string }): void => {
			if (m?.target === "offscreen" && m.type === MSG.captureCleared) done();
		};
		const timer = setTimeout(done, 1500);
		chrome.runtime.onMessage.addListener(onMsg);
		chrome.runtime.sendMessage({
			type: MSG.clearForCapture,
			target: "background",
		});
	});
}

/** Play step `index`'s narration clip into the recorded audio track (if any). */
function playStep(index: number): void {
	const buf = stepBuffers[index];
	if (!buf || !audioCtx || !narrationDest) return;
	// Chrome can re-suspend an idle context mid-recording, which would silence the rest.
	if (audioCtx.state === "suspended") void audioCtx.resume();
	const src = audioCtx.createBufferSource();
	src.buffer = buf;
	src.connect(narrationDest);
	relayNarrationCompletionOnEnd(src, index);
	src.start();
}

export function relayNarrationCompletionOnEnd(
	source: AudioBufferSourceNode,
	index: number,
): void {
	source.onended = () => {
		chrome.runtime.sendMessage({
			type: MSG.narrationComplete,
			target: "background",
			index,
		});
	};
}

/**
 * Start the audio clock, without which the recording is silent.
 *
 * An AudioContext constructed outside a user gesture starts `suspended`, and a
 * suspended context renders nothing into its destination — so the narration track
 * mixed into the video carries silence while every clip appears to play fine. An
 * offscreen document never has a gesture, so this is the normal case here, not an edge
 * case. Failure is reported but not fatal: a silent video still beats no video.
 */
async function resumeAudio(ctx: AudioContext): Promise<void> {
	if (ctx.state !== "suspended") return;
	try {
		await ctx.resume();
	} catch (e) {
		console.warn(
			"[dg-ai-extension] could not start the audio clock; video will be silent",
			e,
		);
	}
	if (ctx.state === "suspended")
		console.warn(
			"[dg-ai-extension] audio context still suspended; narration will not be recorded",
		);
}

/**
 * Synthesize narration for every step and return each step's hold duration (ms).
 * A step's duration is its clip length + tail, plus any numeric `advance` as dwell
 * time after the voice. If Kokoro fails, we return default holds and record silent.
 */
async function synthAll(
	steps: Step[],
	voice: string | undefined,
	ctx: AudioContext,
): Promise<number[]> {
	const durations = steps.map((s) => holdFor(s, null));
	stepBuffers = steps.map(() => null);
	const narrated = steps.filter((step) => (step.body ?? "").trim()).length;
	const tracker = new NarrationProgressTracker();
	let lastReported = -1;
	const report = (progress: number, label: string): void => {
		if (progress === lastReported) return;
		lastReported = progress;
		reportNarrationProgress(progress, label);
	};
	try {
		// A warm-up already finished loading emits no further progress, so credit it up
		// front rather than showing a bar that cannot move.
		report(
			narrationLoaded() ? tracker.modelReady() : 0,
			narrationLoaded() ? "Voice model ready" : "Loading local voice model",
		);
		const tts = await loadKokoro((info) => {
			report(tracker.model(info), "Loading local voice model");
		});
		report(tracker.modelReady(), "Voice model ready");
		let completed = 0;
		for (let i = 0; i < steps.length; i++) {
			const text = (steps[i]?.body ?? "").trim();
			if (!text) continue;
			const clip = await tts.generate(text, { voice: voice || "af_heart" });
			const buf = ctx.createBuffer(1, clip.audio.length, clip.sampling_rate);
			buf.getChannelData(0).set(clip.audio);
			stepBuffers[i] = buf;
			durations[i] = holdFor(steps[i], buf.duration * 1000);
			completed++;
			report(
				tracker.synthesis(completed, narrated),
				`Synthesizing step ${completed} of ${narrated}`,
			);
		}
		report(tracker.ready(), "Narration ready");
	} catch (e) {
		console.warn(
			"[dg-ai-extension] narration synthesis failed; recording silent video",
			e,
		);
		report(tracker.ready(), "Starting without narration");
	}
	return durations;
}

function reportNarrationProgress(progress: number, label: string): void {
	chrome.runtime.sendMessage({
		type: MSG.narrationProgress,
		target: "background",
		progress,
		label,
	});
}

/** Tell background the recording aborted (no data) so it can clean up + notify. */
function abort(): void {
	void audioCtx?.close();
	audioCtx = null;
	narrationDest = null;
	stepBuffers = [];
	chrome.runtime.sendMessage({
		type: MSG.recordingSaved,
		target: "background",
		saved: false,
		error: "recording did not start",
	});
}

/** Stop all tracks and release the audio graph. */
function teardown(stream: MediaStream): void {
	for (const track of stream.getTracks()) track.stop();
	void audioCtx?.close();
	audioCtx = null;
	narrationDest = null;
	stepBuffers = [];
	recorder = null;
}
