import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/select/run";
import spec from "../../../../src/pw/commands/select/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("select", () => {
	test("requires at least one value", () => {
		expect(() => argsFor(spec, "e5")).toThrow("Missing argument: <val>");
	});

	test("selects every given value", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "e5", "a", "b"));
		expect(page.locator("aria-ref=e5").calls).toEqual(['selectOption [["a","b"]]']);
		expect(result).toEqual({
			code: 'await page.locator(\'aria-ref=e5\').selectOption(["a","b"]);',
			snapshot: true,
		});
	});
});
