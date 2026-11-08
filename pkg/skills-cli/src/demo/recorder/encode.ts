export const GEOMETRY = "1440,810,1:1,16:9";

export type RunResult = { status: number; stdout: string; stderr: string };

export type EncodeDeps = {
	which(name: string): string | null;
	run(cmd: string[]): RunResult;
};

const DEFAULT_DEPS: EncodeDeps = {
	which: (name) => Bun.which(name),
	run: (cmd) => {
		const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
		return {
			status: result.exitCode ?? 1,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	},
};

export type EncodeInput = {
	webm: string;
	out: string;
	/** Mono narration WAV whose offsets already count from `startMs`. */
	audio?: string;
	/** Lead-in to cut from the start of the recording. */
	startMs?: number;
};

export type EncodeResult =
	| { encoded: true; video: string; geometry: string }
	| { encoded: false; video: string };

const VIDEO_FILTER = "scale=1440:810:flags=lanczos,setsar=1,setdar=16/9,fps=30";

/** Encode the recording to an H.264 MP4 and check its geometry; without ffmpeg the webm stays. */
export function encodeMp4(input: EncodeInput, deps: EncodeDeps = DEFAULT_DEPS): EncodeResult {
	const ffmpeg = deps.which("ffmpeg");
	const ffprobe = deps.which("ffprobe");
	if (!ffmpeg || !ffprobe) return { encoded: false, video: input.webm };
	const trim = input.startMs && input.startMs > 0 ? ["-ss", String(input.startMs / 1000)] : [];
	const audioIn = input.audio ? ["-i", input.audio] : [];
	const audioOut = input.audio
		? ["-map", "0:v:0", "-map", "1:a:0", "-c:a", "aac", "-b:a", "128k", "-af", "apad", "-shortest"]
		: ["-an"];
	const encode = deps.run([
		ffmpeg, "-y", "-loglevel", "error",
		...trim, "-i", input.webm, ...audioIn,
		"-vf", VIDEO_FILTER,
		"-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p", "-r", "30",
		...audioOut,
		"-movflags", "+faststart", input.out,
	]);
	if (encode.status !== 0) throw new Error(`ffmpeg encode failed: ${encode.stderr.trim()}`);
	const probe = deps.run([
		ffprobe, "-v", "error", "-select_streams", "v:0",
		"-show_entries", "stream=width,height,sample_aspect_ratio,display_aspect_ratio",
		"-of", "csv=p=0", input.out,
	]);
	const geometry = probe.stdout.trim();
	if (geometry !== GEOMETRY) throw new Error(`bad geometry: ${geometry}`);
	return { encoded: true, video: input.out, geometry };
}
