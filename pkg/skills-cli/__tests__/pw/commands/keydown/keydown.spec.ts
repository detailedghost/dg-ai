import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/keydown/run";
import spec from "../../../../src/pw/commands/keydown/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("keydown", () => {
	test("sends down for the key", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "Shift"));
		expect(page.calls).toEqual(['keyboard.down ["Shift"]']);
		expect(result).toEqual({
			code: 'await page.keyboard.down("Shift");',
			snapshot: true,
		});
	});

	test("accepts lowercase key names", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		await handler(ctx, argsFor(spec, "shift"));
		expect(page.calls).toEqual(['keyboard.down ["Shift"]']);
	});
});
