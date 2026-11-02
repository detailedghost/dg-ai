import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assembleNarrationWav,
	clipFile,
	writeNarrationWav,
} from "../src/demo/narration";

const RATE = 24_000;

type Decoded = { channels: number; sampleRate: number; samples: Float32Array };

function decode(wav: Uint8Array): Decoded {
	const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
	const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
	expect(tag(0)).toBe("RIFF");
	expect(tag(8)).toBe("WAVE");
	let format = { code: 0, channels: 0, sampleRate: 0, bits: 0 };
	let at = 12;
	while (at + 8 <= wav.length) {
		const size = view.getUint32(at + 4, true);
		if (tag(at) === "fmt ") {
			format = {
				code: view.getUint16(at + 8, true),
				channels: view.getUint16(at + 10, true),
				sampleRate: view.getUint32(at + 12, true),
				bits: view.getUint16(at + 22, true),
			};
		}
		if (tag(at) === "data") {
			const bytes = format.bits / 8;
			const count = size / bytes;
			const samples = new Float32Array(count);
			for (let i = 0; i < count; i++) {
				const pos = at + 8 + i * bytes;
				samples[i] =
					format.code === 3
						? view.getFloat32(pos, true)
						: view.getInt16(pos, true) / 32768;
			}
			return {
				channels: format.channels,
				sampleRate: format.sampleRate,
				samples,
			};
		}
		at += 8 + size + (size % 2);
	}
	throw new Error("no data chunk");
}

const tone = (seconds: number): Float32Array =>
	new Float32Array(Math.round(seconds * RATE)).fill(0.5);

describe("assembleNarrationWav", () => {
	const first = tone(1);
	const second = tone(0.5);
	const offsetSecond = 4200;
	const wav = assembleNarrationWav([
		{ offsetMs: 0, sampleRate: RATE, pcm: first },
		{ offsetMs: offsetSecond, sampleRate: RATE, pcm: second },
	]);
	const decoded = decode(wav);
	const secondStart = Math.round((offsetSecond * RATE) / 1000);

	test("writes a 24 kHz mono file", () => {
		expect(decoded.channels).toBe(1);
		expect(decoded.sampleRate).toBe(RATE);
	});

	test("is as long as the last offset plus the last clip", () => {
		expect(decoded.samples.length).toBe(secondStart + second.length);
	});

	test("places each clip at its offset and fills the gap with silence", () => {
		expect(decoded.samples[0]).toBeCloseTo(0.5, 2);
		expect(decoded.samples[first.length - 1]).toBeCloseTo(0.5, 2);
		expect(decoded.samples[first.length]).toBe(0);
		expect(decoded.samples[secondStart - 1]).toBe(0);
		expect(decoded.samples[secondStart]).toBeCloseTo(0.5, 2);
		expect(decoded.samples[decoded.samples.length - 1]).toBeCloseTo(0.5, 2);
	});

	test("orders clips by offset whatever order they arrive in", () => {
		const shuffled = decode(
			assembleNarrationWav([
				{ offsetMs: offsetSecond, sampleRate: RATE, pcm: second },
				{ offsetMs: 0, sampleRate: RATE, pcm: first },
			]),
		);
		expect(shuffled.samples).toEqual(decoded.samples);
	});
});

describe("writeNarrationWav", () => {
	test("drops a truncated clip file and keeps the rest", () => {
		const root = mkdtempSync(join(tmpdir(), "dg-wav-"));
		try {
			const clips = join(root, "clips");
			mkdirSync(clips);
			writeFileSync(clipFile(clips, 0), Buffer.from(new Float32Array([0.5]).buffer));
			writeFileSync(clipFile(clips, 1), Buffer.from([1, 2, 3]));
			const out = join(root, "voice.wav");
			const offsets = new Map([
				[0, 0],
				[1, 100],
			]);
			expect(writeNarrationWav({ clipsDir: clips, offsets, out })).toBe(true);
			expect(Bun.file(out).size).toBe(44 + 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
