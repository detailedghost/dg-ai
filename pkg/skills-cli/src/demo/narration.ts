export type Clip = { offsetMs: number; sampleRate: number; pcm: Float32Array };

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

const startSample = (clip: Clip): number =>
	Math.round((clip.offsetMs * clip.sampleRate) / 1000);

/** A mono 16-bit WAV with each clip mixed in at its offset and silence between. */
export function assembleNarrationWav(clips: Clip[]): Uint8Array {
	const first = clips[0];
	if (!first) throw new Error("no narration clips to assemble");
	const rate = first.sampleRate;
	if (clips.some((clip) => clip.sampleRate !== rate))
		throw new Error("narration clips use different sample rates");
	const total = clips.reduce((end, c) => Math.max(end, startSample(c) + c.pcm.length), 0);
	const mix = new Float32Array(total);
	for (const clip of [...clips].sort((a, b) => a.offsetMs - b.offsetMs)) {
		const start = startSample(clip);
		const pcm = clip.pcm;
		for (let i = 0; i < pcm.length; i++)
			mix[start + i] = (mix[start + i] ?? 0) + (pcm[i] ?? 0);
	}
	const dataBytes = total * BYTES_PER_SAMPLE;
	const wav = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
	const view = new DataView(wav.buffer);
	const tag = (at: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
	};
	tag(0, "RIFF");
	view.setUint32(4, 36 + dataBytes, true);
	tag(8, "WAVE");
	tag(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * BYTES_PER_SAMPLE, true);
	view.setUint16(32, BYTES_PER_SAMPLE, true);
	view.setUint16(34, 16, true);
	tag(36, "data");
	view.setUint32(40, dataBytes, true);
	for (let i = 0; i < mix.length; i++) {
		const clamped = Math.max(-1, Math.min(1, mix[i] ?? 0));
		view.setInt16(
			WAV_HEADER_BYTES + i * BYTES_PER_SAMPLE,
			Math.round(clamped * 32767),
			true,
		);
	}
	return wav;
}
