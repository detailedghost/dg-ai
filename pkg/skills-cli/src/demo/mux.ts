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
	wav: string;
	out: string;
	timeoutMs?: number;
};

/** Mixes the voice into the video when ffmpeg can; otherwise both files stay and the result is a sidecar. */
export async function muxNarration(
	input: MuxInput,
	deps: MuxDeps = defaultMuxDeps,
): Promise<{ audio: Extract<NonNullable<DemoResult["audio"]>, "muxed" | "sidecar"> }> {
	const ffmpeg = deps.which("ffmpeg");
	if (!ffmpeg) {
		console.log(
			`ffmpeg not found: video and voice saved separately (${input.video}, ${input.wav})`,
		);
		return { audio: "sidecar" };
	}
	const code = await deps.spawn(
		[
			ffmpeg,
			"-y",
			"-nostdin",
			"-i",
			input.video,
			"-i",
			input.wav,
			"-c:v",
			"copy",
			"-c:a",
			"libopus",
			"-af",
			"apad",
			"-shortest",
			input.out,
		],
		input.timeoutMs,
	);
	if (code !== 0) {
		rmSync(input.out, { force: true });
		console.log(
			`ffmpeg failed (exit ${code}): video and voice saved separately (${input.video}, ${input.wav})`,
		);
		return { audio: "sidecar" };
	}
	return { audio: "muxed" };
}
