import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/video-chapter/run";
import spec from "../../../../src/pw/commands/video-chapter/spec";
import {
	argsFor,
	FakePage,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("video-chapter", () => {
	test("shows the chapter with its description and duration", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		ctx.state.video = {
			page: page as never,
			file: "/tmp/v.webm",
			recording: "/tmp/v.webm",
		};
		const result = await handler(
			ctx,
			argsFor(spec, "Intro", "--description=Welcome", "--duration=1500"),
		);
		expect(page.calls).toEqual([
			'screencast.showChapter ["Intro",{"description":"Welcome","duration":1500}]',
		]);
		expect(result.code).toBe(
			'await page.screencast.showChapter("Intro", {"description":"Welcome","duration":1500});',
		);
	});

	test("omits options that were not given", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		ctx.state.video = {
			page: page as never,
			file: "/tmp/v.webm",
			recording: "/tmp/v.webm",
		};
		await handler(ctx, argsFor(spec, "Intro"));
		expect(page.calls).toEqual(['screencast.showChapter ["Intro",{}]']);
	});

	test("rejects a duration that is not an integer", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(
			handler(ctx, argsFor(spec, "Intro", "--duration=soon")),
		).rejects.toThrow("Invalid --duration 'soon'");
	});
});

describe("video-chapter target", () => {
	test("marks the recorded tab even after another tab is selected", async () => {
		const { ctx, page, context } = fakeCtx(scratch.dir);
		const recorded = new FakePage();
		ctx.state.video = {
			page: recorded as never,
			file: "/tmp/v.webm",
			recording: "/tmp/v.webm",
		};
		context.pages().push(recorded as never);
		await handler(ctx, argsFor(spec, "Intro"));
		expect(recorded.calls).toEqual(['screencast.showChapter ["Intro",{}]']);
		expect(page.calls).toEqual([]);
	});

	test("fails when nothing is recording", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "Intro"))).rejects.toThrow(
			"No video recording in progress",
		);
	});
});

describe("video-chapter duration bounds", () => {
	test.each(["9".repeat(400), "9007199254740993"])(
		"rejects %p",
		async (value) => {
			const { ctx, page } = fakeCtx(scratch.dir);
			ctx.state.video = {
				page: page as never,
				file: "/tmp/v.webm",
				recording: "/tmp/v.webm",
			};
			await expect(
				handler(ctx, argsFor(spec, "Intro", `--duration=${value}`)),
			).rejects.toThrow("Invalid --duration");
		},
	);
});
