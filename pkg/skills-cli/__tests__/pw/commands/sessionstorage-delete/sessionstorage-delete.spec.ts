import { describe, expect, test } from "bun:test";
import handler from "../../../../src/pw/commands/sessionstorage-delete/run";
import spec from "../../../../src/pw/commands/sessionstorage-delete/spec";
import { argsFor, fakeCtx, useTempScratch } from "../../../../src/pw/test-support";

const scratch = useTempScratch();

describe("sessionstorage-delete", () => {
	test("removes the key", async () => {
		const { ctx, page } = fakeCtx(scratch.dir);
		const result = await handler(ctx, argsFor(spec, "theme"));
		expect(page.evaluateArgs).toEqual([["sessionStorage", "theme"]]);
		expect(result.code).toBe('await page.evaluate(() => sessionStorage.removeItem("theme"));');
	});
});
