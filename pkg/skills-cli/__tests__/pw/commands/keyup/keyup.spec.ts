import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/keyup/run";
import spec from "../../../../src/pw/commands/keyup/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("keyup", () => {
	test("sends up for the key", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "Shift"));
		expect(page.calls).toEqual(['keyboard.up ["Shift"]']);
		expect(result).toEqual({
			code: 'await page.keyboard.up("Shift");',
			snapshot: true,
		});
	});
});
