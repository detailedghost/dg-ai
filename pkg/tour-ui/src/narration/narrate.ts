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
			for (const [index, step] of steps.entries()) {
				const text = (step.body ?? "").trim();
				if (!text) continue;
				await nextMacrotask();
				const clip = await tts.generate(text, { voice });
				await send({
					kind: "clip",
					index,
					sampleRate: clip.sampling_rate,
					pcm: toBase64(clip.audio),
				});
				const ms = (clip.audio.length / clip.sampling_rate) * 1000;
				clips.set(index, ms);
				durations[index] = holdFor(step, ms);
				completed++;
				report(
					tracker.synthesis(completed, narrated),
					`Synthesizing step ${completed} of ${narrated}`,
				);
			}
			report(tracker.ready(), "Narration ready");
			return durations;
		},
	};
}
