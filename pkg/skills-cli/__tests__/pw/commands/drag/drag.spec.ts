import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/drag/run";
import spec from "../../../../src/pw/commands/drag/spec";
import {
	argsFor,
	fakeCtx,
	useTempScratch,
} from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("drag", () => {
	test("drags the start element onto the end element", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e3", "#drop"));
		expect(page.locator("aria-ref=e3").calls).toHaveLength(1);
		expect(page.locator("aria-ref=e3").calls[0]).toStartWith("dragTo");
		expect(result.code).toBe(
			"await page.locator('aria-ref=e3').dragTo(page.locator('#drop'));",
		);
		expect(result.snapshot).toBe(true);
	});
});
