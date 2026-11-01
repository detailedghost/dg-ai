import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import handler, {
	parseSize,
} from "../../../../src/pw/commands/video-start/run";
import spec from "../../../../src/pw/commands/video-start/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("parseSize", () => {
	test("parses WIDTHxHEIGHT", () => {
		expect(parseSize(undefined)).toBeUndefined();
		expect(parseSize("800x600")).toEqual({ width: 800, height: 600 });
	});

	test.each(["800", "axb", "0x5", "800x"])(
		"rejects %p with a usage error",
		(value) => {
			expect(() => parseSize(value)).toThrow("Invalid --size");
		},
	);
});

describe("video-start", () => {
	test("starts the screencast on the current tab and remembers it", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(
			ctx,
			argsFor(spec, "demo.webm", "--size=640x480"),
		);
		const recording = ctx.state.video?.recording as string;
		expect(path.dirname(path.dirname(recording))).toBe(scratch.dir);
		expect(statSync(path.dirname(recording)).mode & 0o777).toBe(0o700);
		expect(page.calls).toEqual([
			`screencast.start [{"path":"${recording}","size":{"width":640,"height":480}}]`,
		]);
		expect(ctx.state.video?.file).toBe(`${scratch.dir}/demo.webm`);
		expect(result.code).toContain(`"path":"${scratch.dir}/demo.webm"`);
		expect(result.result).toBe(
			`Video recording started: ${scratch.dir}/demo.webm`,
		);
	});

	test("prints the ffmpeg install hint instead of a stack trace when ffmpeg is missing", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		page.screencast.returns["start"] = new Error(
			"Executable doesn't exist at /home/u/.cache/ms-playwright/ffmpeg-1011/ffmpeg-linux",
		);
		const { describeError } = await import("../../../../src/pw/core/dispatch");
		const error = await handler(ctx, argsFor(spec)).catch(
			(caught: unknown) => caught,
		);
		expect(describeError(error)).toBe(
			"Playwright ffmpeg is not installed. run: bunx playwright-core install ffmpeg",
		);
		expect(ctx.state.video).toBeUndefined();
	});

	test("keeps an existing recording and leaves no staging dir when start fails", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const file = path.join(scratch.dir, "keep.webm");
		writeFileSync(file, "old");
		page.screencast.returns["start"] = new Error(
			"Executable doesn't exist at /x/ffmpeg",
		);
		await handler(ctx, argsFor(spec, "keep.webm")).catch(() => undefined);
		expect(readFileSync(file, "utf8")).toBe("old");
		expect(
			readdirSync(scratch.dir).filter((name) => name.startsWith(".pw-")),
		).toEqual([]);
	});

	test("refuses to record twice", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		ctx.state.video = { page: page as never, file: "x", recording: "x" };
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow(
			"A video is already recording",
		);
	});
});
