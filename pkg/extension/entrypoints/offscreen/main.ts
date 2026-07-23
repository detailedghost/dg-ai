/**
 * Offscreen recorder. The service worker can't use MediaRecorder or WebAudio (no
 * DOM), so this runs here: background hands us a tabCapture streamId plus the tour
 * steps + narration voice. We synthesize each step's narration with Kokoro up
 * front, then record the tab's video mixed with a WebAudio track we play the
 * narration into — advancing in lock-step with the content script (playStep). On
 * stop we send the webm back for download. Chrome-only (offscreen + tabCapture).
 */

import { MSG } from "@/lib/demo-messages";
import { loadKokoro } from "@/utils/kokoro";

type Step = { body?: string; advance?: unknown };

const DEFAULT_VIDEO_MS = 3500;
// Silence appended after a clip's audio so narration isn't clipped by the advance.
const TAIL_GAP_MS = 700;

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
// Guards against a second start() (e.g. shortcut pressed twice) clobbering state.
let starting = false;
// A stop that arrives before the recorder exists — honored once setup finishes.
let stopRequested = false;
let audioCtx: AudioContext | null = null;
let narrationDest: MediaStreamAudioDestinationNode | null = null;
let stepBuffers: (AudioBuffer | null)[] = [];

chrome.runtime.onMessage.addListener(
	(msg: {
		type?: string;
		target?: string;
		streamId?: string;
		steps?: Step[];
		voice?: string;
		narrate?: boolean;
		index?: number;
	}) => {
		if (msg?.target !== "offscreen") return;
		if (msg.type === MSG.startRecording && msg.streamId)
			void start(
				msg.streamId,
				msg.steps ?? [],
				msg.voice,
				msg.narrate !== false,
			);
		else if (msg.type === MSG.stopRecording) stop();
		else if (msg.type === MSG.playStep && typeof msg.index === "number")
			playStep(msg.index);
	},
);

async function start(
	streamId: string,
	steps: Step[],
	voice: string | undefined,
	narrate: boolean,
): Promise<void> {
	// Double-start guard: ignore a second start while one is in flight or active.
	if (starting || recorder) return;
	starting = true;
	stopRequested = false;
	let videoStream: MediaStream | null = null;
	try {
		// Acquire the tab stream BEFORE synthesizing narration. The streamId from
		// getMediaStreamId is only valid for a few seconds; Kokoro model loading can
		// take 10-30 s on first use, which easily expires it. getUserMedia here holds
		// the capture open regardless of how long TTS preparation takes.
		videoStream = await navigator.mediaDevices.getUserMedia({
			audio: false,
			// Non-standard tab-capture constraint shape — not in lib.dom types.
			video: {
				mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
			} as unknown as MediaTrackConstraints,
		});
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
			narrationDest = audioCtx.createMediaStreamDestination();
			// Synthesize all narration; a failure degrades to a silent video.
			durations = await synthAll(steps, voice, audioCtx);
		} else {
			durations = steps.map((s) => holdFor(s, null));
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
		recorder = new MediaRecorder(mixed, { mimeType: "video/webm" });
		const capture = videoStream;
		recorder.ondataavailable = (e) => {
			if (e.data.size) chunks.push(e.data);
		};
		recorder.onstop = async () => {
			teardown(capture);
			const blob = new Blob(chunks, { type: "video/webm" });
			chrome.runtime.sendMessage({
				type: MSG.recordingData,
				target: "background",
				dataUrl: await blobToDataUrl(blob),
			});
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
	const src = audioCtx.createBufferSource();
	src.buffer = buf;
	src.connect(narrationDest);
	src.start();
}

/**
 * Synthesize narration for every step and return each step's hold duration (ms).
 * A step's duration is its clip length + tail, floored by any numeric `advance`.
 * If Kokoro fails, we return default holds and record a silent video.
 */
async function synthAll(
	steps: Step[],
	voice: string | undefined,
	ctx: AudioContext,
): Promise<number[]> {
	const durations = steps.map((s) => holdFor(s, null));
	stepBuffers = steps.map(() => null);
	try {
		const tts = await loadKokoro();
		for (let i = 0; i < steps.length; i++) {
			const text = (steps[i]?.body ?? "").trim();
			if (!text) continue;
			const clip = await tts.generate(text, { voice: voice || "af_heart" });
			const buf = ctx.createBuffer(1, clip.audio.length, clip.sampling_rate);
			buf.getChannelData(0).set(clip.audio);
			stepBuffers[i] = buf;
			durations[i] = holdFor(steps[i], buf.duration * 1000);
		}
	} catch (e) {
		console.warn(
			"[dg-ai-extension] narration synthesis failed; recording silent video",
			e,
		);
	}
	return durations;
}

/** How long to hold a step: max(narration + tail, numeric advance / default). */
function holdFor(step: Step, audioMs: number | null): number {
	const base =
		typeof step?.advance === "number" ? step.advance : DEFAULT_VIDEO_MS;
	if (audioMs == null) return base;
	return Math.max(base, Math.round(audioMs + TAIL_GAP_MS));
}

/** Tell background the recording aborted (no data) so it can clean up + notify. */
function abort(): void {
	void audioCtx?.close();
	audioCtx = null;
	narrationDest = null;
	stepBuffers = [];
	chrome.runtime.sendMessage({
		type: MSG.recordingData,
		target: "background",
		dataUrl: "",
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

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const fr = new FileReader();
		fr.onload = () => resolve(fr.result as string);
		fr.onerror = reject;
		fr.readAsDataURL(blob);
	});
}
