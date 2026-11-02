import type { TourStep } from "@dg/common";
import type { TourMessage, TourNarrator } from "../host";
import { NarrationProgressTracker } from "../narration-progress";
import { holdFor } from "../video-timing";
import { loadKokoro } from "./kokoro";

function toBase64(samples: Float32Array): string {
	const bytes = new Uint8Array(
		samples.buffer,
		samples.byteOffset,
		samples.byteLength,
	);
	let binary = "";
	for (let at = 0; at < bytes.length; at += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
	return btoa(binary);
}

const nextMacrotask = (): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, 0));

const refused = (ack: unknown): boolean =>
	typeof ack === "object" &&
	ack !== null &&
	"accepted" in ack &&
	ack.accepted === false;

/** Speaks each step's body through Kokoro and hands the clips to the host, which owns the audio file. */
export function createNarrator(
	assetBase: string,
	send: (msg: TourMessage) => Promise<unknown>,
): TourNarrator {
	const clips = new Map<number, number>();
	return {
		clipMs: (index) => clips.get(index),
		async prepare(steps: TourStep[], voice, report) {
			const durations = steps.map((step) => holdFor(step, null));
			const narrated = steps.filter((step) => (step.body ?? "").trim()).length;
			const tracker = new NarrationProgressTracker();
			const label = "Loading local voice model";
			report(0, label);
			const tts = await loadKokoro(assetBase, (info) =>
				report(tracker.model(info), label),
			);
			report(tracker.modelReady(), "Voice model ready");
			let completed = 0;
			let unvoiced = 0;
			try {
				for (const [index, step] of steps.entries()) {
					const text = (step.body ?? "").trim();
					if (!text) continue;
					await nextMacrotask();
					const clip = await tts.generate(text, { voice });
					const ack = await send({
						kind: "clip",
						index,
						sampleRate: clip.sampling_rate,
						pcm: toBase64(clip.audio),
					});
					completed++;
					if (refused(ack)) {
						unvoiced++;
					} else {
						const ms = (clip.audio.length / clip.sampling_rate) * 1000;
						clips.set(index, ms);
						durations[index] = holdFor(step, ms);
					}
					report(
						tracker.synthesis(completed, narrated),
						`Synthesizing step ${completed} of ${narrated}`,
					);
				}
			} catch (error) {
				clips.clear();
				throw error;
			}
			report(
				tracker.ready(),
				unvoiced
					? `Narration partial: ${narrated - unvoiced} of ${narrated} steps voiced`
					: "Narration ready",
			);
			return durations;
		},
	};
}
