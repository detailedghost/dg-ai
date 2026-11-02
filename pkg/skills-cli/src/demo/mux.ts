import { rmSync } from "node:fs";
import type { DemoResult } from "./result";

export type MuxDeps = {
	which(name: string): string | null;
	spawn(argv: string[], timeoutMs?: number): Promise<number>;
};

const DEFAULT_TIMEOUT_MS = 60_000;

export const defaultMuxDeps: MuxDeps = {
	which: (name) => Bun.which(name),
	spawn: async (argv, timeoutMs = DEFAULT_TIMEOUT_MS) => {
		const child = Bun.spawn(argv, {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const timer = setTimeout(() => child.kill(), timeoutMs);
		try {
			return await child.exited;
		} finally {
			clearTimeout(timer);
		}
	},
};

export type MuxInput = {
	video: string;
	wav?: string;
	startMs?: number;
	out: string;
	timeoutMs?: number;
};

export type MuxOutcome = {
	audio: Extract<NonNullable<DemoResult["audio"]>, "muxed" | "sidecar" | "none">;
	trimmed: boolean;
};

const MIN_TRIM_MS = 1000;

export const needsTrim = (startMs: number | undefined): startMs is number =>
	startMs !== undefined && startMs >= MIN_TRIM_MS;

const seconds = (ms: number): string => (ms / 1000).toFixed(3);

const REENCODE = [
	"-c:v",
	"libvpx-vp9",
	"-b:v",
	"0",
	"-crf",
	"32",
	"-deadline",
	"realtime",
	"-cpu-used",
	"8",
];

function argvFor(ffmpeg: string, input: MuxInput, trim: boolean): string[] {
	const seek = trim ? ["-ss", seconds(input.startMs ?? 0)] : [];
	const inputs = [...seek, "-i", input.video];
	if (!input.wav)
		return [ffmpeg, "-y", "-nostdin", ...inputs, ...REENCODE, input.out];
	return [
		ffmpeg,
		"-y",
		"-nostdin",
		...inputs,
		...seek,
		"-i",
		input.wav,
		...(trim ? REENCODE : ["-c:v", "copy"]),
		"-c:a",
		"libopus",
		"-af",
		"apad",
		"-shortest",
		input.out,
	];
}

/**
 * Cuts the lead-in and mixes the voice in one ffmpeg run, as each applies.
 * A cut re-encodes the video because stream copy can only start on a keyframe.
 */
export async function muxVideo(
	input: MuxInput,
	deps: MuxDeps = defaultMuxDeps,
): Promise<MuxOutcome> {
	const trim = needsTrim(input.startMs);
	const kept: MuxOutcome["audio"] = input.wav ? "sidecar" : "none";
	const ffmpeg = deps.which("ffmpeg");
	if (!ffmpeg) {
		if (input.wav)
			console.log(
				`ffmpeg not found: video and voice saved separately (${input.video}, ${input.wav})`,
			);
		if (trim)
			console.log(
				`the video includes the start screen and setup time; with ffmpeg, trim it: ffmpeg -ss ${seconds(input.startMs ?? 0)} -i ${input.video} <trimmed>.webm`,
			);
		return { audio: kept, trimmed: false };
	}
	const code = await deps.spawn(argvFor(ffmpeg, input, trim), input.timeoutMs);
	if (code !== 0) {
		rmSync(input.out, { force: true });
		console.log(
			input.wav
				? `ffmpeg failed (exit ${code}): video and voice saved separately (${input.video}, ${input.wav})`
				: `ffmpeg failed (exit ${code}): video saved untrimmed (${input.video})`,
		);
		return { audio: kept, trimmed: false };
	}
	return { audio: input.wav ? "muxed" : "none", trimmed: trim };
}
