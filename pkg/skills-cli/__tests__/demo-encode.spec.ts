import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EncodeDeps, encodeMp4, GEOMETRY } from "../src/demo/recorder/encode";

setDefaultTimeout(60_000);

type Call = string[];

function deps(probe: string, status = 0): EncodeDeps & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		which: (name) => `/usr/bin/${name}`,
		run: (cmd) => {
			calls.push(cmd);
			return cmd[0]?.endsWith("ffprobe")
				? { status: 0, stdout: `${probe}\n`, stderr: "" }
				: { status, stdout: "", stderr: status ? "boom" : "" };
		},
	};
}

describe("encodeMp4", () => {
	test("encodes H.264 1440x810 at 30 fps and returns the probed geometry", () => {
		const d = deps(GEOMETRY);
		const result = encodeMp4({ webm: "/r/raw.webm", out: "/o/demo.mp4" }, d);
		expect(result).toEqual({ encoded: true, video: "/o/demo.mp4", geometry: GEOMETRY });
		const ffmpeg = d.calls[0]?.join(" ") ?? "";
		for (const part of ["-c:v libx264", "-crf 20", "-pix_fmt yuv420p", "-r 30", "+faststart", "scale=1440:810", "-an"])
			expect(ffmpeg).toContain(part);
	});

	test("trims the lead-in and muxes AAC narration padded to the video", () => {
		const d = deps(GEOMETRY);
		encodeMp4({ webm: "/r/raw.webm", out: "/o/demo.mp4", audio: "/r/voice.wav", startMs: 1250 }, d);
		const ffmpeg = d.calls[0]?.join(" ") ?? "";
		expect(ffmpeg).toContain("-ss 1.25 -i /r/raw.webm -i /r/voice.wav");
		expect(ffmpeg).toContain("-c:a aac");
		expect(ffmpeg).toContain("apad");
		expect(ffmpeg).toContain("-shortest");
		expect(ffmpeg).not.toContain("-an");
	});

	test("throws bad geometry when ffprobe disagrees", () => {
		expect(() => encodeMp4({ webm: "/r/raw.webm", out: "/o/demo.mp4" }, deps("1280,720,1:1,16:9"))).toThrow(
			"bad geometry: 1280,720,1:1,16:9",
		);
	});

	test("throws with ffmpeg's stderr when the encode fails", () => {
		expect(() => encodeMp4({ webm: "/r/raw.webm", out: "/o/demo.mp4" }, deps(GEOMETRY, 1))).toThrow("boom");
	});

	test("keeps the webm when ffmpeg is missing", () => {
		const d = { ...deps(GEOMETRY), which: () => null };
		expect(encodeMp4({ webm: "/r/raw.webm", out: "/o/demo.mp4" }, d)).toEqual({ encoded: false, video: "/r/raw.webm" });
		expect(d.calls).toEqual([]);
	});
});

describe("encodeMp4 with the real ffmpeg", () => {
	test.skipIf(!Bun.which("ffmpeg") || !Bun.which("ffprobe"))("writes an MP4 that passes the geometry check", () => {
		const dir = mkdtempSync(join(tmpdir(), "dg-encode-"));
		try {
			const webm = join(dir, "raw.webm");
			const gen = Bun.spawnSync([
				"ffmpeg", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=size=1440x810:rate=25:duration=2",
				"-c:v", "libvpx-vp9", "-deadline", "realtime", webm,
			]);
			expect(gen.exitCode).toBe(0);
			const out = join(dir, "demo.mp4");
			expect(encodeMp4({ webm, out })).toEqual({ encoded: true, video: out, geometry: GEOMETRY });
			expect(existsSync(out)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
