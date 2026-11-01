import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/mouseup/run";
import spec from "../../../../src/pw/commands/mouseup/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("mouseup", () => {
	test("defaults to the left button", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec));
		expect(page.calls).toEqual(['mouse.up [{"button":"left"}]']);
		expect(result.code).toBe("await page.mouse.up();");
	});

	test("passes another button through", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "right"));
		expect(page.calls).toEqual(['mouse.up [{"button":"right"}]']);
		expect(result.code).toBe('await page.mouse.up({"button":"right"});');
	});

	test("rejects an unknown button", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "back"))).rejects.toThrow("Unsupported button 'back'");
	});
});
