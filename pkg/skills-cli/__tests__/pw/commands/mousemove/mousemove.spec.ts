import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/mousemove/run";
import spec from "../../../../src/pw/commands/mousemove/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("mousemove", () => {
	test("moves the mouse", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "10", "20.5"));
		expect(page.calls).toEqual(["mouse.move [10,20.5]"]);
		expect(result.code).toBe("await page.mouse.move(10, 20.5);");
	});

	test("rejects a coordinate that is not a number", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "left", "20"))).rejects.toThrow("Invalid x 'left'");
	});
});
