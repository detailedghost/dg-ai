import { describe, expect, test } from "bun:test";
import { argsFor, fakeCtx, useTempScratch } from "../../../src/pw/test-support";
import handler from "../../../src/pw/commands/resize/run";
import spec from "../../../src/pw/commands/resize/spec";

const scratch = useTempScratch();

describe("resize", () => {
	test("sets the viewport size", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "800", "600"));
		expect(page.calls).toEqual(['setViewportSize [{"width":800,"height":600}]']);
		expect(result.code).toBe("await page.setViewportSize({ width: 800, height: 600 });");
	});

	test("rejects a size that is not a positive integer with a usage error", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "wide", "600"))).rejects.toThrow("Invalid size 'wide'");
		await expect(handler(ctx, argsFor(spec, "0", "600"))).rejects.toThrow("Invalid size '0'");
	});
});
