import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/video-chapter/run";
import spec from "../../../../src/pw/commands/video-chapter/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("video-chapter", () => {
	test("shows the chapter with its description and duration", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "Intro", "--description=Welcome", "--duration=1500"));
		expect(page.calls).toEqual(['screencast.showChapter ["Intro",{"description":"Welcome","duration":1500}]']);
		expect(result.code).toBe('await page.screencast.showChapter("Intro", {"description":"Welcome","duration":1500});');
	});

	test("omits options that were not given", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "Intro"));
		expect(page.calls).toEqual(['screencast.showChapter ["Intro",{}]']);
	});

	test("rejects a duration that is not an integer", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "Intro", "--duration=soon"))).rejects.toThrow("Invalid --duration 'soon'");
	});
});
