import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/dblclick/run";
import spec from "../../../../src/pw/commands/dblclick/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("dblclick", () => {
	test("double clicks with the default button", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e5"));
		expect(page.locator("aria-ref=e5").calls).toEqual(['dblclick [{"button":"left","modifiers":[]}]']);
		expect(result).toEqual({
			code: "await page.locator('aria-ref=e5').dblclick();",
			snapshot: true,
		});
	});

	test("passes the button and modifiers", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "#row", "right", "--modifiers=Shift"));
		expect(page.locator("#row").calls).toEqual(['dblclick [{"button":"right","modifiers":["Shift"]}]']);
		expect(result.code).toBe('await page.locator(\'#row\').dblclick({"button":"right","modifiers":["Shift"]});');
	});
});
