import { describe, expect, test } from "bun:test";
import { statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/video-stop/run";
import spec from "../../../src/pw/commands/video-stop/spec";

const scratch = useTempScratch();

describe("video-stop", () => {
	test("stops the screencast on the recorded tab and reports the file", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const file = path.join(scratch.dir, "v.webm");
		writeFileSync(file, "", { mode: 0o644 });
		ctx.state.video = { page: page as never, file };
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(["screencast.stop []"]);
		expect(ctx.state.video).toBeUndefined();
		expect(result.result).toBe(`- [Video](${file})`);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("fails when nothing is recording", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec))).rejects.toThrow("No video recording in progress");
	});
});
