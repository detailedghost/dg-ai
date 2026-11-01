import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/mousewheel/run";
import spec from "../../../../src/pw/commands/mousewheel/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("mousewheel", () => {
	test("scrolls by the given deltas", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "0", "-120"));
		expect(page.calls).toEqual(["mouse.wheel [0,-120]"]);
		expect(result.code).toBe("await page.mouse.wheel(0, -120);");
	});

	test("rejects a delta that is not a number", async () => {
		const { ctx } = fakeCtx(scratch.dir);
		await expect(handler(ctx, argsFor(spec, "0", "down"))).rejects.toThrow(
			"Invalid dy 'down'",
		);
	});
});
